#!/usr/bin/env node
'use strict';

/**
 * Preregistered advanced-factor study.
 *
 * Selection is geography x horizon x side. The first three folds are
 * development OOS; their winner is frozen for the fourth untouched holdout.
 * Production logic is never modified.
 */
process.env.PORT = process.env.PORT || '3991';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-advanced-factor-'));

const {
  UNIVERSES, MARKETS, INDEX, SPECS, num, mean, sma, atr, ret, priorExtreme,
  dateKey, baselineSignal
} = require('./backtest-factor-combinations');
const { fetchOHLCV, sectorEtfForSymbol } = require('../server');
const { applyCosts } = require('../lib/research/cost-model');
const { summarizeReturns } = require('../lib/research/performance');
const {
  buildCrossSectionalSnapshots,
  snapshotAt,
  indexByDate,
  commodityProxyAt,
} = require('../lib/research/factor-snapshot');
const {
  betaLowerBound,
  blendHierarchicalPrior,
  penalizedSelectionScore,
} = require('../lib/research/bayesian-expectancy');
const {
  buildDateAlignedFolds,
  commonTrailingDates,
  assertFoldIsolation,
  improvesWinRateAndPnl,
} = require('../lib/research/walk-forward-optimizer');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const PER_MARKET = Math.max(10, Number(args.perMarket) || 80);
const TRAIN_BARS = Math.max(378, Number(args.trainBars) || 504);
const VALIDATION_BARS = Math.max(63, Number(args.validationBars) || 126);
const TEST_BARS = Math.max(63, Number(args.testBars) || 126);
const FOLDS = 4;
const NOTIONAL = Math.max(1000, Number(args.notional) || 10000);
const RANGE = '10y';
const SELECTION_MODE = args.selection || 'absolute';
const OUTPUT_FILE = args.output || 'backtest-advanced-factor-results.json';

const EXIT_PROFILES = {
  tight: {
    short: { stopAtr: 1.0, targetAtr: 0.75, maxHold: 10 },
    medium: { stopAtr: 1.5, targetAtr: 1.1, maxHold: 30 },
    long: { stopAtr: 2.0, targetAtr: 1.5, maxHold: 90 }
  },
  balanced: {
    short: { stopAtr: 1.4, tp1Atr: 1.0, targetAtr: 2.2, partialFraction: 0.5, maxHold: 15 },
    medium: { stopAtr: 2.0, tp1Atr: 1.4, targetAtr: 3.0, partialFraction: 0.5, maxHold: 45 },
    long: { stopAtr: 3.0, tp1Atr: 2.0, targetAtr: 4.0, partialFraction: 0.5, maxHold: 126 }
  },
  wide: {
    short: { stopAtr: 2.0, targetAtr: 3.0, maxHold: 20 },
    medium: { stopAtr: 2.5, targetAtr: 4.0, maxHold: 63 },
    long: { stopAtr: 4.0, targetAtr: 6.0, maxHold: 180 }
  }
};

// Frozen at preregistration: baseline + ten singles + fifteen combinations.
const CANDIDATES = [
  { id: 'baseline', factors: [] },
  { id: 'expectancy', factors: ['expectancy'] },
  { id: 'rs10', factors: ['rs10'] },
  { id: 'rs15', factors: ['rs15'] },
  { id: 'rs20', factors: ['rs20'] },
  { id: 'breadth', factors: ['breadth'] },
  { id: 'adx_vol', factors: ['adxVol'] },
  { id: 'retest', factors: ['retest'] },
  { id: 'ma_distance', factors: ['maDistance'] },
  { id: 'execution', factors: ['execution'] },
  { id: 'commodity_proxy', factors: ['commodity'] },
  { id: 'quality_core', factors: ['expectancy', 'rs20', 'execution'] },
  { id: 'standalone_trend', signalMode: 'trend', factors: ['rs20', 'breadth', 'adxVol', 'maDistance'] },
  { id: 'standalone_retest', signalMode: 'retest', factors: ['expectancy', 'retest', 'execution'] },
  { id: 'execution_quality', factors: ['maDistance', 'execution'] },
  { id: 'standalone_mean_reversion', signalMode: 'meanReversion', factors: ['maDistance', 'execution'] },
  { id: 'rs_breadth', factors: ['rs15', 'breadth'] },
  { id: 'rs_expectancy', factors: ['rs20', 'expectancy'] },
  { id: 'expectancy_execution', factors: ['expectancy', 'execution'] },
  { id: 'expectancy_retest', factors: ['expectancy', 'retest'] },
  { id: 'trend_retest', factors: ['breadth', 'adxVol', 'retest'] },
  { id: 'rs_trend_execution', factors: ['rs20', 'adxVol', 'maDistance', 'execution'] },
  { id: 'breadth_trend_execution', factors: ['breadth', 'adxVol', 'execution'] },
  { id: 'conservative_all_quality', factors: ['expectancy', 'rs20', 'breadth', 'adxVol', 'maDistance', 'execution'] },
  { id: 'standalone_commodity_proxy', signalMode: 'commodity', factors: ['commodity', 'adxVol', 'execution'] },
  { id: 'commodity_expectancy', factors: ['commodity', 'expectancy', 'execution'] }
];

function trueRange(bars, i) {
  const b = bars[i], pc = num(bars[i - 1]?.c);
  if (!b || num(b.h) == null || num(b.l) == null) return null;
  return pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
}

function adxAt(bars, i, length = 14) {
  if (i < length * 2) return null;
  const tr = [], plus = [], minus = [];
  for (let k = i - length * 2 + 1; k <= i; k++) {
    const b = bars[k], p = bars[k - 1];
    if (!b || !p) return null;
    const up = b.h - p.h, down = p.l - b.l;
    tr.push(trueRange(bars, k));
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let start = 0; start <= length; start++) {
    const trN = mean(tr.slice(start, start + length));
    const pdi = trN > 0 ? 100 * mean(plus.slice(start, start + length)) / trN : 0;
    const mdi = trN > 0 ? 100 * mean(minus.slice(start, start + length)) / trN : 0;
    dx.push(pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  return mean(dx.slice(-length));
}

function breakoutRetest(bars, i, side, horizon) {
  const sell = side === 'sell';
  const n = horizon === 'short' ? 20 : horizon === 'medium' ? 55 : 120;
  for (let breakout = Math.max(n, i - 6); breakout < i; breakout++) {
    const level = priorExtreme(bars, breakout, n, sell ? 'l' : 'h', sell ? 'min' : 'max');
    if (!(level > 0)) continue;
    const broke = sell ? bars[breakout].c < level : bars[breakout].c > level;
    if (!broke) continue;
    const tolerance = 0.012;
    const touched = bars.slice(breakout + 1, i + 1).some(b => sell
      ? b.h >= level * (1 - tolerance)
      : b.l <= level * (1 + tolerance));
    const confirmed = sell
      ? bars[i].c < level && bars[i].c < bars[i].o
      : bars[i].c > level && bars[i].c > bars[i].o;
    if (touched && confirmed) return true;
  }
  return false;
}

function buildCrossSectionalMaps(contexts) {
  return buildCrossSectionalSnapshots(contexts);
}

function advancedFeatures(ctx, i, side, horizon, crossMap, proxies) {
  const pointInTime = snapshotAt(ctx, i, side, horizon, crossMap, proxies, {
    execution: {
      minDollarVolume: ctx.market === 'US' ? 5e7
        : ctx.market === 'Commodities' ? 5e6
          : ctx.market === 'HK' || ctx.market === 'Japan' ? 1e8 : 1e7,
      maxGapAtr: 1,
      maxSpreadProxy: 0.08,
    },
  });
  const close = num(ctx.bars[i]?.c);
  const sell = side === 'sell';
  const max20 = horizon === 'short' ? 0.06 : horizon === 'medium' ? 0.10 : 0.20;
  const max50 = horizon === 'short' ? 0.10 : horizon === 'medium' ? 0.15 : 0.25;
  return {
    rsPercentile: pointInTime.rsPercentile,
    breadth: sell
      ? pointInTime.breadth50 <= 0.45 && pointInTime.breadth200 <= 0.50
      : pointInTime.breadth50 >= 0.55 && pointInTime.breadth200 >= 0.50,
    adxVol: pointInTime.adx != null && pointInTime.atrPercentile != null
      && (horizon === 'short' ? pointInTime.adx >= 15 && pointInTime.adx <= 40 : pointInTime.adx >= 20)
      && pointInTime.atrPercentile >= 0.15 && pointInTime.atrPercentile <= 0.90,
    retest: pointInTime.retest.pass,
    maDistance: Number.isFinite(pointInTime.ma20Distance)
      && Number.isFinite(pointInTime.ma50Distance)
      && Math.abs(pointInTime.ma20Distance) <= max20
      && Math.abs(pointInTime.ma50Distance) <= max50,
    execution: pointInTime.execution.pass,
    commodity: pointInTime.commodity.pass,
    diagnostics: { close, ...pointInTime }
  };
}

function simulateExit(bars, entryIndex, side, horizon, exitName) {
  const spec = EXIT_PROFILES[exitName][horizon];
  const sell = side === 'sell';
  const entry = num(bars[entryIndex]?.o) || num(bars[entryIndex - 1]?.c);
  const entryAtr = atr(bars, entryIndex - 1, 14);
  if (!(entry > 0) || !(entryAtr > 0)) return null;
  const stop = entry + (sell ? 1 : -1) * spec.stopAtr * entryAtr;
  const target = entry + (sell ? -1 : 1) * spec.targetAtr * entryAtr;
  const tp1 = spec.tp1Atr
    ? entry + (sell ? -1 : 1) * spec.tp1Atr * entryAtr
    : null;
  if (!(stop > 0) || !(target > 0)) return null;
  const end = Math.min(bars.length - 1, entryIndex + spec.maxHold);
  let tp1Fill = null;
  for (let i = entryIndex; i <= end; i++) {
    const b = bars[i], open = num(b.o) || num(b.c);
    const activeStop = tp1Fill == null ? stop : entry;
    if (sell ? b.h >= activeStop : b.l <= activeStop) {
      const fill = sell ? Math.max(open, activeStop) : Math.min(open, activeStop);
      const blended = tp1Fill == null
        ? fill
        : spec.partialFraction * tp1Fill + (1 - spec.partialFraction) * fill;
      return { exit: blended, exitIdx: i, status: tp1Fill == null ? 'stop' : 'tp1_breakeven', entry };
    }
    if (sell ? b.l <= target : b.h >= target) {
      const fill = sell ? Math.min(open, target) : Math.max(open, target);
      const firstFill = tp1Fill == null && tp1 != null
        ? (sell ? Math.min(open, tp1) : Math.max(open, tp1))
        : tp1Fill;
      const blended = firstFill == null
        ? fill
        : spec.partialFraction * firstFill + (1 - spec.partialFraction) * fill;
      return { exit: blended, exitIdx: i, status: firstFill == null ? 'target' : 'tp1_runner_target', entry };
    }
    if (tp1Fill == null && tp1 != null && (sell ? b.l <= tp1 : b.h >= tp1)) {
      tp1Fill = sell ? Math.min(open, tp1) : Math.max(open, tp1);
    }
  }
  const finalFill = num(bars[end]?.c) || entry;
  return {
    exit: tp1Fill == null
      ? finalFill
      : spec.partialFraction * tp1Fill + (1 - spec.partialFraction) * finalFill,
    exitIdx: end,
    status: tp1Fill == null ? 'time' : 'tp1_runner_time',
    entry,
  };
}

function signalModes(ctx, i, side, horizon, proxies) {
  const sell = side === 'sell';
  const close = num(ctx.bars[i]?.c);
  const open = num(ctx.bars[i]?.o);
  const ma20 = sma(ctx.bars, i, 20);
  const ma50 = sma(ctx.bars, i, 50);
  const ma200 = sma(ctx.bars, i, 200);
  const priorClose = num(ctx.bars[i - 1]?.c);
  const priorMa20 = sma(ctx.bars, i - 1, 20);
  const currentAtr = atr(ctx.bars, i, 14);
  const momentum = ret(ctx.bars, i, horizon === 'long' ? 120 : horizon === 'medium' ? 60 : 20);
  const adx = adxAt(ctx.bars, i);
  const trend = sell
    ? close < ma50 && ma50 < ma200 && momentum < 0 && priorClose >= priorMa20 && close < ma20
    : close > ma50 && ma50 > ma200 && momentum > 0 && priorClose <= priorMa20 && close > ma20;
  const meanReversion = adx != null && adx < 20 && currentAtr > 0 && ma20 > 0
    && (sell
      ? close > ma20 + 1.5 * currentAtr && close < open
      : close < ma20 - 1.5 * currentAtr && close > open);
  return {
    baseline: baselineSignal(ctx.bars, i, horizon, side),
    trend,
    retest: breakoutRetest(ctx.bars, i, side, horizon),
    meanReversion,
    commodity: ctx.market === 'Commodities'
      && commodityProxyAt(ctx, i, side, proxies).pass
      && (sell
        ? close < priorExtreme(ctx.bars, i, 20, 'l', 'min')
        : close > priorExtreme(ctx.bars, i, 20, 'h', 'max')),
  };
}

function buildEvents(contexts, horizon, side, crossMap, proxies) {
  const events = [];
  for (const ctx of contexts) {
    const from = Math.max(SPECS[horizon].warmup, 275);
    for (let i = from; i < ctx.bars.length - 2; i += 2) {
      const signals = signalModes(ctx, i, side, horizon, proxies);
      if (!Object.values(signals).some(Boolean)) continue;
      const outcomes = {};
      for (const exitName of Object.keys(EXIT_PROFILES)) {
        const trade = simulateExit(ctx.bars, i + 1, side, horizon, exitName);
        if (!trade) continue;
        const gross = side === 'sell'
          ? (trade.entry - trade.exit) / trade.entry
          : (trade.exit - trade.entry) / trade.entry;
        const entryDate = dateKey(ctx.bars[i + 1]), exitDate = dateKey(ctx.bars[trade.exitIdx]);
        const heldDays = entryDate && exitDate
          ? Math.max(0, (new Date(exitDate) - new Date(entryDate)) / 86400000) : 0;
        const costed = applyCosts(gross, { symbol: ctx.symbol, market: ctx.market, side, holdDays: heldDays });
        outcomes[exitName] = {
          ret: costed.netReturn, grossRet: gross, exitIdx: trade.exitIdx,
          exitDate, status: trade.status
        };
      }
      events.push({
        symbol: ctx.symbol,
        market: ctx.market,
        horizon,
        side,
        signalIdx: i,
        entryIdx: i + 1,
        entryDate: dateKey(ctx.bars[i + 1]),
        signals,
        features: advancedFeatures(ctx, i, side, horizon, crossMap, proxies),
        outcomes
      });
    }
  }
  return events.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));
}

function modelFactorPass(model, event, side) {
  const f = event.features;
  const sell = side === 'sell';
  const signalMode = model.signalMode || 'baseline';
  if (!event.signals?.[signalMode]) return false;
  for (const factor of model.factors) {
    if (factor === 'expectancy') continue;
    if (factor === 'rs10' && !(sell ? f.rsPercentile <= 0.10 : f.rsPercentile >= 0.90)) return false;
    if (factor === 'rs15' && !(sell ? f.rsPercentile <= 0.15 : f.rsPercentile >= 0.85)) return false;
    if (factor === 'rs20' && !(sell ? f.rsPercentile <= 0.20 : f.rsPercentile >= 0.80)) return false;
    if (factor === 'breadth' && !f.breadth) return false;
    if (factor === 'adxVol' && !f.adxVol) return false;
    if (factor === 'retest' && !f.retest) return false;
    if (factor === 'maDistance' && !f.maDistance) return false;
    if (factor === 'execution' && !f.execution) return false;
    if (factor === 'commodity' && !f.commodity) return false;
  }
  return true;
}

const SIGNAL_EVENT_CACHE = new WeakMap();
function eventsForModel(events, model) {
  let byMode = SIGNAL_EVENT_CACHE.get(events);
  if (!byMode) {
    byMode = new Map();
    SIGNAL_EVENT_CACHE.set(events, byMode);
  }
  const mode = model.signalMode || 'baseline';
  if (!byMode.has(mode)) byMode.set(mode, events.filter(event => event.signals?.[mode]));
  return byMode.get(mode);
}

function evaluateCandidate(events, model, exitName, range, priorMean) {
  const candidateEvents = eventsForModel(events, model);
  const selected = [];
  const histories = new Map();
  const cellCounts = { wins: 0, losses: 0 };
  const closedCellWindow = [];
  let pendingCellHistory = [];
  const blockedUntil = new Map();
  for (const event of candidateEvents) {
    if (pendingCellHistory.length) {
      const stillOpen = [];
      for (const trade of pendingCellHistory) {
        if (trade.exitDate < event.entryDate) {
          if (trade.ret > 0) cellCounts.wins++;
          else cellCounts.losses++;
          closedCellWindow.push(trade);
          if (closedCellWindow.length > 500) {
            const expired = closedCellWindow.shift();
            if (expired.ret > 0) cellCounts.wins--;
            else cellCounts.losses--;
          }
        } else stillOpen.push(trade);
      }
      pendingCellHistory = stillOpen;
    }
    const outcome = event.outcomes[exitName];
    if (!outcome || !modelFactorPass(model, event, event.side)) continue;
    const blocked = blockedUntil.get(event.symbol);
    if (blocked && event.entryDate <= blocked) continue;
    const history = histories.get(event.symbol) || [];
    const closed = history.slice(-100);
    if (model.factors.includes('expectancy')) {
      const count = rows => ({
        wins: rows.filter(t => t.ret > 0).length,
        losses: rows.filter(t => t.ret <= 0).length,
      });
      const prior = blendHierarchicalPrior({
        geography: cellCounts,
        cell: count(closed),
      }, {
        baseAlpha: priorMean * 20,
        baseBeta: (1 - priorMean) * 20,
      });
      const lower = betaLowerBound(0, 0, { alpha: prior.alpha, beta: prior.beta });
      const histSummary = summarizeReturns(closed.map(t => t.ret));
      if (closed.length >= 5 && (lower < 0.50 || histSummary.profitFactor < 1.05 || histSummary.avgReturnPct <= 0)) {
        continue;
      }
    }
    const row = { ...event, ...outcome, model: model.id, exitProfile: exitName };
    history.push(row);
    pendingCellHistory.push(row);
    histories.set(event.symbol, history);
    blockedUntil.set(event.symbol, outcome.exitDate);
    if (event.entryDate >= range.from && event.entryDate <= range.to) selected.push(row);
  }
  return selected;
}

function metrics(rows) {
  const s = summarizeReturns(rows.map(r => r.ret));
  const wins = rows.filter(r => r.ret > 0).length;
  const n = rows.length;
  const p = n ? wins / n : 0;
  const z = 1.96;
  const denominator = 1 + z * z / Math.max(1, n);
  const centre = (p + z * z / (2 * Math.max(1, n))) / denominator;
  const margin = n
    ? z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator
    : 0;
  return {
    trades: s.trades,
    wins,
    winRate: s.winRate,
    winRateInterval95: n
      ? [+(100 * Math.max(0, centre - margin)).toFixed(1), +(100 * Math.min(1, centre + margin)).toFixed(1)]
      : [null, null],
    avgReturnPct: s.avgReturnPct,
    profitFactor: s.profitFactor,
    pnlUsd: +(rows.reduce((sum, row) => sum + row.ret * NOTIONAL, 0)).toFixed(2)
  };
}

function scoreRows(rows, factorCount) {
  const m = metrics(rows);
  if (m.trades < 12 || !(m.pnlUsd > 0) || !(m.avgReturnPct > 0) || !(m.profitFactor >= 1.3)) return -Infinity;
  const lower = betaLowerBound(m.wins, m.trades - m.wins, { alpha: 15, beta: 15 });
  if (lower < 0.5) return -Infinity;
  return penalizedSelectionScore({
    lowerBound: lower,
    expectancy: m.avgReturnPct / 100,
    trades: m.trades,
    complexity: factorCount,
  }, {
    minSample: 30,
    complexityPenalty: 0.0005,
    smallSamplePenalty: 0.005,
    expectancyWeight: 1,
  }).score + 0.02 * Math.log(m.profitFactor);
}

function buildFolds(contexts, horizon) {
  const embargo = SPECS[horizon].maxHold;
  const timeline = commonTrailingDates(contexts, dateKey);
  const folds = buildDateAlignedFolds(timeline, {
    folds: FOLDS,
    trainBars: TRAIN_BARS,
    validationBars: VALIDATION_BARS,
    testBars: TEST_BARS,
    embargoBars: embargo,
  });
  assertFoldIsolation(folds);
  return folds;
}

function aggregateMetrics(rowsByFold) {
  return metrics(rowsByFold.flat());
}

function stabilityPass(foldMetrics) {
  return foldMetrics.filter(m => m.trades > 0 && m.pnlUsd > 0 && m.avgReturnPct > 0 && m.profitFactor >= 1.3).length >= 2;
}

function promotionDecision(developmentRows, holdoutRows, developmentFoldMetrics) {
  const development = metrics(developmentRows), holdout = metrics(holdoutRows);
  const checks = {
    developmentSample: development.trades >= 30,
    holdoutSample: holdout.trades >= 30,
    developmentWinRate: development.winRate >= 65,
    holdoutWinRate: holdout.winRate >= 65,
    developmentProfitFactor: development.profitFactor >= 1.3,
    holdoutProfitFactor: holdout.profitFactor >= 1.3,
    positiveDevelopment: development.pnlUsd > 0 && development.avgReturnPct > 0,
    positiveHoldout: holdout.pnlUsd > 0 && holdout.avgReturnPct > 0,
    stable: stabilityPass(developmentFoldMetrics)
  };
  return { pass: Object.values(checks).every(Boolean), checks, development, holdout };
}

async function main() {
  const cache = new Map(), proxyCache = new Map();
  async function load(symbol) {
    if (cache.has(symbol)) return cache.get(symbol);
    const bars = await fetchOHLCV(symbol, RANGE, '1d').catch(() => null);
    // Four folds plus the 180-bar long-horizon embargo need a common history.
    // Exclude recent listings instead of allowing one short history to erase a
    // geography's long cells.
    const value = Array.isArray(bars) && bars.length >= 1800 ? bars : null;
    cache.set(symbol, value);
    return value;
  }
  async function loadProxy(symbol) {
    if (proxyCache.has(symbol)) return proxyCache.get(symbol);
    const bars = await fetchOHLCV(symbol, RANGE, '1d').catch(() => null);
    const value = Array.isArray(bars) ? { bars, index: indexByDate(bars) } : null;
    proxyCache.set(symbol, value);
    return value;
  }

  const proxies = new Map();
  for (const symbol of ['SPY', 'EWH', 'EWJ', 'EWU', 'EWG', 'EWQ', 'DBC', 'USO', 'BNO', 'CL=F', 'BZ=F']) {
    const value = await loadProxy(symbol);
    if (value) proxies.set(symbol, value);
  }

  const contexts = Object.fromEntries(MARKETS.map(market => [market, []]));
  for (const market of MARKETS) {
    for (const symbol of UNIVERSES[market]) {
      if (contexts[market].length >= PER_MARKET) break;
      process.stdout.write(`\rLoading ${market} ${symbol}`.padEnd(52));
      const bars = await load(symbol);
      if (!bars) continue;
      const benchmark = proxies.get(INDEX[market]);
      const sectorSymbol = sectorEtfForSymbol(symbol);
      const sector = await loadProxy(sectorSymbol) || benchmark;
      contexts[market].push({
        market, symbol, bars, sectorSymbol,
        marketBars: benchmark?.bars || null,
        marketIndex: benchmark?.index || null,
        sectorBars: sector?.bars || null,
        sectorIndex: sector?.index || null
      });
    }
  }
  console.log(`\nLoaded ${MARKETS.map(m => `${m}=${contexts[m].length}`).join(', ')}`);

  const cells = [];
  for (const market of MARKETS) {
    if (!contexts[market].length) continue;
    const crossMap = buildCrossSectionalMaps(contexts[market]);
    for (const horizon of ['short', 'medium', 'long']) {
      const folds = buildFolds(contexts[market], horizon);
      if (folds.length !== FOLDS) continue;
      for (const side of ['buy', 'sell']) {
        process.stdout.write(`\rOptimizing ${market} ${horizon} ${side}`.padEnd(58));
        const events = buildEvents(contexts[market], horizon, side, crossMap, proxies);
        // Neutral fixed prior: a prior estimated through the final fold would
        // leak holdout outcomes into earlier gates.
        const priorMean = 0.5;
        const development = [];
        const choiceCounts = new Map();
        for (const fold of folds.slice(0, -1)) {
          const baselineValidationRows = evaluateCandidate(
            events, CANDIDATES[0], 'balanced', fold.validation, priorMean);
          const baselineValidation = metrics(baselineValidationRows);
          let best = null;
          for (const model of CANDIDATES) {
            if (market !== 'Commodities' && model.factors.includes('commodity')) continue;
            for (const exitName of Object.keys(EXIT_PROFILES)) {
              const rows = evaluateCandidate(events, model, exitName, fold.validation, priorMean);
              const validation = metrics(rows);
              let score = scoreRows(rows, model.factors.length);
              if (SELECTION_MODE === 'dual-improvement') {
                const isCurrentBaseline = model.id === 'baseline' && exitName === 'balanced';
                const improvesBoth = improvesWinRateAndPnl(validation, baselineValidation);
                if (isCurrentBaseline || !improvesBoth) score = -Infinity;
              }
              if (!best || score > best.score) best = { model, exitName, score, validation };
            }
          }
          if (!best || !Number.isFinite(best.score)) {
            best = {
              model: CANDIDATES[0], exitName: 'balanced', score: -Infinity,
              validation: metrics(evaluateCandidate(events, CANDIDATES[0], 'balanced', fold.validation, priorMean))
            };
          }
          const testRows = evaluateCandidate(events, best.model, best.exitName, fold.test, priorMean);
          development.push({
            fold: fold.fold, model: best.model.id, exitProfile: best.exitName,
            validation: best.validation, test: metrics(testRows), rows: testRows
          });
          const key = `${best.model.id}|${best.exitName}`;
          const count = choiceCounts.get(key) || { count: 0, score: 0, model: best.model, exitName: best.exitName };
          count.count++;
          count.score += Number.isFinite(best.score) ? best.score : -999;
          choiceCounts.set(key, count);
        }
        const frozen = [...choiceCounts.values()].sort((a, b) => b.count - a.count || b.score - a.score)[0]
          || { model: CANDIDATES[0], exitName: 'balanced' };
        const holdoutFold = folds[FOLDS - 1];
        const holdoutRows = evaluateCandidate(events, frozen.model, frozen.exitName, holdoutFold.test, priorMean);
        const developmentRows = development.flatMap(row => row.rows);
        const baselineDev = folds.slice(0, -1).flatMap(fold =>
          evaluateCandidate(events, CANDIDATES[0], 'balanced', fold.test, priorMean));
        const baselineHoldout = evaluateCandidate(events, CANDIDATES[0], 'balanced', holdoutFold.test, priorMean);
        const baseline = { development: metrics(baselineDev), holdout: metrics(baselineHoldout) };
        const promotion = promotionDecision(developmentRows, holdoutRows, development.map(row => row.test));
        if (SELECTION_MODE === 'dual-improvement') {
          promotion.checks.improvesDevelopmentWinRate =
            promotion.development.winRate > baseline.development.winRate;
          promotion.checks.improvesDevelopmentPnl =
            promotion.development.pnlUsd > baseline.development.pnlUsd;
          promotion.checks.improvesHoldoutWinRate =
            promotion.holdout.winRate > baseline.holdout.winRate;
          promotion.checks.improvesHoldoutPnl =
            promotion.holdout.pnlUsd > baseline.holdout.pnlUsd;
          if (frozen.model.id === 'baseline' && frozen.exitName === 'balanced') {
            promotion.checks.improvesDevelopmentWinRate = false;
            promotion.checks.improvesDevelopmentPnl = false;
            promotion.checks.improvesHoldoutWinRate = false;
            promotion.checks.improvesHoldoutPnl = false;
          }
          promotion.pass = Object.values(promotion.checks).every(Boolean);
        }
        cells.push({
          market, horizon, side, priorMean,
          frozenModel: frozen.model.id, frozenExitProfile: frozen.exitName,
          factors: frozen.model.factors,
          baseline,
          development: development.map(({ rows, ...row }) => row),
          promotion,
          folds
        });
      }
    }
  }
  console.log('');

  const pValues = cells.map(cell => {
    const h = cell.promotion.holdout;
    if (!h.trades) return 1;
    const p0 = 0.5, observed = h.wins / h.trades;
    const se = Math.sqrt(p0 * (1 - p0) / h.trades);
    const z = se > 0 ? (observed - p0) / se : 0;
    // One-sided normal-tail approximation, adequate for multiplicity reporting.
    return 0.5 * erfc(z / Math.SQRT2);
  });
  const adjusted = benjaminiHochberg(pValues);
  cells.forEach((cell, i) => {
    cell.multiplicity = { rawP: pValues[i], bhAdjustedP: adjusted[i], significantAt05: adjusted[i] <= 0.05 };
    cell.promotion.pass = cell.promotion.pass && cell.multiplicity.significantAt05;
    cell.status = cell.promotion.pass ? 'PASS' : 'PAUSED_UNSUPPORTED';
  });

  const report = {
    generatedAt: new Date().toISOString(),
    preregistration: SELECTION_MODE === 'dual-improvement'
      ? 'docs/geography-side-dual-improvement-preregistration.md'
      : 'docs/factor-walk-forward-preregistration.md',
    methodology: {
      markets: MARKETS,
      loadedPerMarket: Object.fromEntries(MARKETS.map(m => [m, contexts[m].length])),
      range: RANGE, folds: FOLDS, trainBars: TRAIN_BARS, validationBars: VALIDATION_BARS,
      testBars: TEST_BARS, horizonEmbargoBars: Object.fromEntries(Object.entries(SPECS).map(([h, s]) => [h, s.maxHold])),
      nextOpen: true, stopFirst: true, costs: true, currentFundamentals: false,
      winRateTargetPct: 65, minProfitFactor: 1.3, minDevelopmentTrades: 30, minHoldoutTrades: 30,
      commodityData: 'Price/ETF/calendar proxies only; no actual inventory surprise or verified futures curve.',
      selectionMode: SELECTION_MODE
    },
    candidates: CANDIDATES,
    exitProfiles: EXIT_PROFILES,
    cells
  };
  const out = path.join(__dirname, OUTPUT_FILE);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Wrote ${out}`);
  for (const cell of cells) {
    const m = cell.promotion.holdout;
    console.log(`${cell.market.padEnd(11)} ${cell.horizon.padEnd(6)} ${cell.side.padEnd(4)} ${cell.frozenModel.padEnd(28)} ${cell.frozenExitProfile.padEnd(8)} n=${String(m.trades).padStart(3)} WR=${String(m.winRate ?? '—').padStart(5)} PF=${String(m.profitFactor ?? '—').padStart(5)} PnL=$${String(m.pnlUsd).padStart(9)} ${cell.status}`);
  }
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
function erfc(x) { return 1 - erf(x); }
function benjaminiHochberg(values) {
  const ranked = values.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = Array(values.length).fill(1);
  let next = 1;
  for (let rank = ranked.length; rank >= 1; rank--) {
    const row = ranked[rank - 1];
    next = Math.min(next, row.p * ranked.length / rank);
    out[row.i] = Math.min(1, next);
  }
  return out;
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
