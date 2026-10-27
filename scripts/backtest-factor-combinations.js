#!/usr/bin/env node
'use strict';

/**
 * Walk-forward US/UK factor-combination study.
 *
 * Research only: this script never changes production recommendation rules.
 * Entries use the next open, costs/borrow are included, and model selection is
 * performed inside each market/fold before the following out-of-sample period.
 *
 * Usage:
 *   node scripts/backtest-factor-combinations.js --perMarket=80
 */
process.env.PORT = process.env.PORT || '3993';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-factor-bt-'));

const { fetchOHLCV, sectorEtfForSymbol } = require('../server');
const { applyCosts } = require('../lib/research/cost-model');
const { summarizeReturns } = require('../lib/research/performance');
const { US_CORE, STATIC_GROUPS } = require('../universe');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const perMarket = Math.max(20, Number(args.perMarket) || 80);
const notional = Math.max(1000, Number(args.notional) || 10000);
const entryStep = Math.max(1, Number(args.entryStep) || 2);
const trainBars = Math.max(378, Number(args.trainBars) || 504);
const testBars = Math.max(63, Number(args.testBars) || 126);

const US_EXTRA = [
  'PFE','BMY','AMGN','MDLZ','CL','MO','PM','LOW','TJX','HON','UPS','RTX','LMT','DE',
  'MMM','UNP','SHW','FCX','NEM','NUE','NEE','DUK','SO','D','AEP','PLD','AMT','EQIX',
  'SPG','CVS','CI','MDT','SYK','ZTS','ADP','CB','MMC','ICE','CME','SCHW','AXP','BLK'
];
const UNIVERSES = {
  US: [...new Set(US_CORE.concat(US_EXTRA))],
  HK: [...new Set(STATIC_GROUPS.HSI)],
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)],
  UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)],
  France: [...new Set(STATIC_GROUPS.CAC40)],
  Commodities: [...new Set(STATIC_GROUPS.COMMODITIES)]
};
const MARKETS = Object.keys(UNIVERSES);
const INDEX = {
  US: 'SPY',
  HK: 'EWH',
  Japan: 'EWJ',
  UK: 'EWU',
  Germany: 'EWG',
  France: 'EWQ',
  Commodities: 'DBC'
};

const SPECS = {
  short: { warmup: 220, breakout: 20, maxHold: 20, stopAtr: 2, trailAtr: 2.5 },
  medium: { warmup: 240, breakout: 55, maxHold: 63, stopAtr: 2.5, trailAtr: 3.5 },
  long: { warmup: 275, breakout: 120, maxHold: 180, stopAtr: 4, trailAtr: 5 }
};

// Candidate models are fixed before this run. Inapplicable factors are ignored
// by factorPass rather than silently changing the baseline definition.
const MODELS = [
  { id: 'baseline', factors: [] },
  { id: 'relative_strength', factors: ['rs'] },
  { id: 'donchian_expansion', factors: ['donchian'] },
  { id: 'rs_donchian', factors: ['rs', 'donchian'] },
  { id: 'ma200_retest', factors: ['ma200Retest'] },
  { id: 'rs_ma200_retest', factors: ['rs', 'ma200Retest'] },
  { id: 'triple_bearish', factors: ['tripleBear'] },
  { id: 'triple_bearish_donchian', factors: ['tripleBear', 'donchian'] },
  { id: 'triple_bearish_retest', factors: ['tripleBear', 'ma200Retest'] },
  { id: 'long_momentum_quality', factors: ['longMomentum'] },
  { id: 'long_momentum_rs', factors: ['longMomentum', 'rs'] },
  { id: 'all_applicable_price_factors', factors: ['rs', 'donchian', 'tripleBear', 'ma200Retest', 'longMomentum'] }
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function mean(xs) {
  const a = xs.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function sma(bars, i, n, field = 'c') {
  if (!bars || i - n + 1 < 0) return null;
  return mean(bars.slice(i - n + 1, i + 1).map(b => num(b[field])));
}
function trueRange(bars, i) {
  const b = bars[i], pc = num(bars[i - 1]?.c);
  if (!b || num(b.h) == null || num(b.l) == null) return null;
  return pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
}
function atr(bars, i, n = 14) {
  if (i - n + 1 < 1) return null;
  return mean(Array.from({ length: n }, (_, k) => trueRange(bars, i - k)));
}
function priorExtreme(bars, i, n, field, mode) {
  const xs = bars.slice(Math.max(0, i - n), i).map(b => num(b[field])).filter(Number.isFinite);
  return xs.length ? (mode === 'max' ? Math.max(...xs) : Math.min(...xs)) : null;
}
function ret(bars, i, n) {
  const a = num(bars?.[i]?.c), b = num(bars?.[i - n]?.c);
  return a > 0 && b > 0 ? a / b - 1 : null;
}
function dateKey(bar) {
  const raw = bar?.date ?? bar?.d ?? bar?.t ?? bar?.time;
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw > 1e12 ? raw : raw * 1000).toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}
function dateIndex(bars) {
  const out = new Map();
  (bars || []).forEach((bar, i) => { const d = dateKey(bar); if (d) out.set(d, i); });
  return out;
}
function alignedIndex(stock, i, benchmarkIndex) {
  return benchmarkIndex.get(dateKey(stock[i]));
}
function benchmarkRet(stock, i, benchmark, benchmarkIndex, n) {
  const bi = alignedIndex(stock, i, benchmarkIndex);
  return bi == null ? null : ret(benchmark, bi, n);
}

function baselineSignal(bars, i, horizon, side) {
  const sell = side === 'sell';
  const close = num(bars[i]?.c);
  if (!(close > 0)) return false;
  if (horizon === 'short') {
    const level = priorExtreme(bars, i, 20, sell ? 'l' : 'h', sell ? 'min' : 'max');
    const ma50 = sma(bars, i, 50);
    return sell ? close < level && close < ma50 : close > level && close > ma50;
  }
  if (horizon === 'medium') {
    const level = priorExtreme(bars, i, 55, sell ? 'l' : 'h', sell ? 'min' : 'max');
    const ma50 = sma(bars, i, 50), ma200 = sma(bars, i, 200);
    return sell ? close < level && ma50 < ma200 && close < ma200
      : close > level && ma50 > ma200 && close > ma200;
  }
  const start = num(bars[i - 252]?.c), skip = num(bars[i - 21]?.c), ma200 = sma(bars, i, 200);
  if (!(start > 0) || !(skip > 0) || !(ma200 > 0)) return false;
  const momentum12to1 = skip / start - 1;
  return sell ? momentum12to1 < 0 && close < ma200 : momentum12to1 > 0 && close > ma200;
}

function featuresAt(bars, i, side, marketBars, marketIndex, sectorBars, sectorIndex) {
  const sell = side === 'sell';
  const close = num(bars[i]?.c), open = num(bars[i]?.o), high = num(bars[i]?.h);
  const ma50 = sma(bars, i, 50), ma200 = sma(bars, i, 200);
  const stockRets = [20, 60, 120].map(n => ret(bars, i, n));
  const marketRets = [20, 60, 120].map(n => benchmarkRet(bars, i, marketBars, marketIndex, n));
  const sectorRets = [20, 60, 120].map(n => benchmarkRet(bars, i, sectorBars, sectorIndex, n));
  const relVotes = stockRets.map((r, k) => r != null && marketRets[k] != null && sectorRets[k] != null
    && (sell ? r < marketRets[k] && r < sectorRets[k] : r > marketRets[k] && r > sectorRets[k]))
    .filter(Boolean).length;
  const mbi = alignedIndex(bars, i, marketIndex), sbi = alignedIndex(bars, i, sectorIndex);
  const marketBear = mbi != null && num(marketBars[mbi]?.c) < sma(marketBars, mbi, 50)
    && sma(marketBars, mbi, 50) < sma(marketBars, mbi, 200);
  const sectorBear = sbi != null && num(sectorBars[sbi]?.c) < sma(sectorBars, sbi, 50)
    && sma(sectorBars, sbi, 50) < sma(sectorBars, sbi, 200);
  const stockBear = close < ma50 && ma50 < ma200;
  const n = 20;
  const level = priorExtreme(bars, i, n, sell ? 'l' : 'h', sell ? 'min' : 'max');
  const a14 = atr(bars, i, 14), a60 = atr(bars, i, 60);
  const v20 = sma(bars, i - 1, 20, 'v'), volume = num(bars[i]?.v);
  const donchian = level != null && (sell ? close < level : close > level)
    && a14 > a60 * 1.05 && volume > v20 * 1.2;
  const retestWindow = bars.slice(Math.max(0, i - 5), i + 1);
  const touchedMa200 = ma200 > 0 && retestWindow.some(b => num(b.h) >= ma200 * 0.985 && num(b.l) <= ma200 * 1.025);
  const failedMa200Retest = sell && close < ma200 && touchedMa200 && close < open && high >= ma200 * 0.975;
  const high52 = priorExtreme(bars, i + 1, 252, 'h', 'max');
  const mom126 = ret(bars, i, 126), mom252 = ret(bars, i, 252);
  const weeklyTrend = ma50 > ma200 && ret(bars, i, 105) > 0;
  const longMomentum = !sell && mom126 > 0.05 && mom252 > 0.10 && weeklyTrend
    && high52 > 0 && close >= high52 * 0.85;
  return {
    rs: relVotes >= 2,
    tripleBear: sell && stockBear && marketBear && sectorBear,
    donchian,
    ma200Retest: failedMa200Retest,
    longMomentum
  };
}

function applicableFactor(name, horizon, side) {
  if (name === 'tripleBear') return horizon === 'medium' && side === 'sell';
  if (name === 'ma200Retest') return side === 'sell' && horizon !== 'short';
  if (name === 'longMomentum') return horizon === 'long' && side === 'buy';
  return true;
}
function modelApplies(model, horizon, side) {
  return model.factors.some(f => applicableFactor(f, horizon, side)) || model.id === 'baseline';
}
function factorPass(model, f, horizon, side) {
  return model.factors.every(name => !applicableFactor(name, horizon, side) || f[name]);
}

function simulateTrade(bars, entryIndex, side, horizon, exitCalibration = null) {
  const spec = SPECS[horizon], sell = side === 'sell';
  const entry = num(bars[entryIndex]?.o) || num(bars[entryIndex - 1]?.c);
  const entryAtr = atr(bars, entryIndex - 1, 20);
  if (!(entry > 0) || !(entryAtr > 0)) return null;
  let stop = exitCalibration
    ? entry * (sell ? 1 + exitCalibration.stopPct : 1 - exitCalibration.stopPct)
    : (sell ? entry + spec.stopAtr * entryAtr : entry - spec.stopAtr * entryAtr);
  const target = exitCalibration
    ? entry * (sell ? 1 - exitCalibration.targetPct : 1 + exitCalibration.targetPct) : null;
  let favorable = entry, mae = 0, mfe = 0;
  const maxHold = exitCalibration ? exitCalibration.maxHold : spec.maxHold;
  const end = Math.min(entryIndex + maxHold, bars.length - 1);
  for (let j = entryIndex; j <= end; j++) {
    const b = bars[j], high = num(b?.h), low = num(b?.l), close = num(b?.c), open = num(b?.o) || close;
    if (high == null || low == null || close == null) continue;
    const favorableRet = sell ? (entry - low) / entry : (high - entry) / entry;
    const adverseRet = sell ? (high - entry) / entry : (entry - low) / entry;
    mfe = Math.max(mfe, favorableRet);
    mae = Math.max(mae, adverseRet);
    if (sell ? high >= stop : low <= stop) {
      const fill = sell ? Math.max(open, stop) : Math.min(open, stop);
      return { entry, exit: fill, exitIndex: j, status: 'stop', mae, mfe };
    }
    if (target != null && (sell ? low <= target : high >= target)) {
      const fill = sell ? Math.min(open, target) : Math.max(open, target);
      return { entry, exit: fill, exitIndex: j, status: 'target', mae, mfe };
    }
    if (exitCalibration) continue;
    const currentAtr = atr(bars, j, 20) || entryAtr;
    favorable = sell ? Math.min(favorable, low) : Math.max(favorable, high);
    const candidate = sell ? favorable + spec.trailAtr * currentAtr : favorable - spec.trailAtr * currentAtr;
    stop = sell ? Math.min(stop, candidate) : Math.max(stop, candidate);
    const maExit = horizon === 'short' ? sma(bars, j, 20)
      : horizon === 'medium' ? sma(bars, j, 50) : sma(bars, j, 200);
    if (maExit > 0 && (sell ? close > maExit : close < maExit)) {
      return { entry, exit: close, exitIndex: j, status: 'trend_exit', mae, mfe };
    }
  }
  return { entry, exit: num(bars[end]?.c) || entry, exitIndex: end, status: 'time_exit', mae, mfe };
}

function candidateTrades(ctx, horizon, side, model, from, to, exitCalibration = null) {
  const { symbol, market, bars, marketBars, marketIndex, sectorBars, sectorIndex } = ctx;
  const rows = [];
  let i = Math.max(SPECS[horizon].warmup, from);
  while (i < Math.min(to, bars.length - 2)) {
    if (!baselineSignal(bars, i, horizon, side)) { i += entryStep; continue; }
    const f = featuresAt(bars, i, side, marketBars, marketIndex, sectorBars, sectorIndex);
    if (!factorPass(model, f, horizon, side)) { i += entryStep; continue; }
    const trade = simulateTrade(bars, i + 1, side, horizon, exitCalibration);
    if (!trade) { i += entryStep; continue; }
    const gross = side === 'sell' ? (trade.entry - trade.exit) / trade.entry : (trade.exit - trade.entry) / trade.entry;
    const entryDate = dateKey(bars[i + 1]), exitDate = dateKey(bars[trade.exitIndex]);
    const heldDays = entryDate && exitDate
      ? Math.max(0, (new Date(exitDate) - new Date(entryDate)) / 86400000) : 0;
    const costed = applyCosts(gross, { symbol, market, side, holdDays: heldDays });
    rows.push({
      symbol, market, horizon, side, model: model.id, ret: costed.netReturn,
      grossRet: gross, entryDate, exitDate, heldDays,
      heldBars: Math.max(0, trade.exitIndex - (i + 1)), status: trade.status,
      mae: trade.mae, mfe: trade.mfe
    });
    i = Math.max(i + entryStep, trade.exitIndex + 1);
  }
  return rows;
}

function percentile(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
}
function metrics(rows) {
  const s = summarizeReturns(rows.map(r => r.ret));
  const pnl = rows.reduce((sum, r) => sum + r.ret * notional, 0);
  return {
    trades: s.trades, winRate: s.winRate, avgReturnPct: s.avgReturnPct,
    profitFactor: s.profitFactor, netPnlUsdAtFixedNotional: +pnl.toFixed(2),
    medianMaePct: percentile(rows.map(r => r.mae * 100), 0.5),
    p75MaePct: percentile(rows.map(r => r.mae * 100), 0.75),
    medianMfePct: percentile(rows.map(r => r.mfe * 100), 0.5),
    p75MfePct: percentile(rows.map(r => r.mfe * 100), 0.75)
  };
}
function selectionScore(rows) {
  const m = metrics(rows);
  if (m.trades < 20 || !Number.isFinite(m.profitFactor)) return -Infinity;
  return (m.avgReturnPct || 0) + 0.35 * (m.profitFactor - 1) + 0.002 * ((m.winRate || 0) - 50);
}

function calibrateExits(rows, horizon) {
  const winners = rows.filter(r => r.ret > 0);
  const source = winners.length >= 10 ? winners : rows;
  const bounds = {
    short: { stop: [0.015, 0.07], target: [0.03, 0.14], hold: [5, 20] },
    medium: { stop: [0.025, 0.10], target: [0.05, 0.22], hold: [15, 63] },
    long: { stop: [0.04, 0.15], target: [0.08, 0.35], hold: [40, 180] }
  }[horizon];
  const clamp = (value, range) => Math.max(range[0], Math.min(range[1], value));
  const stopPct = clamp((percentile(source.map(r => r.mae), 0.75) || bounds.stop[0]) * 1.1, bounds.stop);
  const rawTarget = percentile(source.map(r => r.mfe), 0.5) || stopPct * 1.5;
  const targetPct = clamp(Math.max(rawTarget, stopPct * 1.5), bounds.target);
  const maxHold = Math.round(clamp(percentile(source.map(r => r.heldBars), 0.75) || SPECS[horizon].maxHold, bounds.hold));
  return { stopPct, targetPct, maxHold, trainedTrades: rows.length, trainedWinners: winners.length };
}

async function main() {
  const cache = new Map(), benchCache = new Map();
  async function load(sym) {
    if (cache.has(sym)) return cache.get(sym);
    const bars = await fetchOHLCV(sym, '5y', '1d').catch(() => null);
    // Require enough history for the same three train/test folds in every
    // geography. A recent listing must not shorten (or erase) an entire
    // market's out-of-sample window through the market-level minimum length.
    const requiredBars = trainBars + testBars * 3 + 300;
    const value = Array.isArray(bars) && bars.length >= requiredBars ? bars : null;
    cache.set(sym, value);
    return value;
  }
  async function loadBench(sym) {
    if (benchCache.has(sym)) return benchCache.get(sym);
    const bars = await fetchOHLCV(sym, '5y', '1d').catch(() => null);
    benchCache.set(sym, Array.isArray(bars) ? bars : null);
    return benchCache.get(sym);
  }

  const contexts = Object.fromEntries(MARKETS.map(market => [market, []]));
  for (const market of MARKETS) {
    const marketBars = await loadBench(INDEX[market]);
    for (const symbol of UNIVERSES[market]) {
      if (contexts[market].length >= perMarket) break;
      process.stdout.write(`\rLoading ${market} ${symbol}`.padEnd(48));
      const bars = await load(symbol);
      if (!bars || !marketBars) continue;
      const sectorSymbol = sectorEtfForSymbol(symbol);
      const sectorBars = await loadBench(sectorSymbol) || marketBars;
      contexts[market].push({
        symbol, market, bars, marketBars, marketIndex: dateIndex(marketBars),
        sectorSymbol, sectorBars, sectorIndex: dateIndex(sectorBars)
      });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  console.log(`\nLoaded ${MARKETS.map(market => `${market}=${contexts[market].length}`).join(', ')}`);

  const foldResults = [], calibratedFoldResults = [], allModelFoldResults = [], selections = [];
  for (const market of MARKETS) {
    if (!contexts[market].length) continue;
    const minLength = Math.min(...contexts[market].map(c => c.bars.length));
    const firstTest = Math.max(300, minLength - (trainBars + testBars * 3));
    for (let testStart = firstTest + trainBars, fold = 1; testStart + testBars <= minLength; testStart += testBars, fold++) {
      for (const horizon of Object.keys(SPECS)) {
        for (const side of ['buy', 'sell']) {
          const candidates = MODELS.filter(m => modelApplies(m, horizon, side));
          const trainByModel = new Map();
          for (const model of candidates) {
            const rows = contexts[market].flatMap(c => {
              const offset = c.bars.length - minLength;
              return candidateTrades(c, horizon, side, model, firstTest + offset, testStart + offset);
            });
            trainByModel.set(model.id, rows);
          }
          const selected = candidates.slice().sort((a, b) =>
            selectionScore(trainByModel.get(b.id)) - selectionScore(trainByModel.get(a.id)))[0];
          const testByModel = new Map();
          for (const model of candidates) {
            const rows = contexts[market].flatMap(c => {
              const offset = c.bars.length - minLength;
              return candidateTrades(c, horizon, side, model, testStart + offset, testStart + testBars + offset);
            });
            testByModel.set(model.id, rows);
            allModelFoldResults.push(...rows.map(r => ({ ...r, fold })));
          }
          const testRows = testByModel.get(selected.id);
          const exitCalibration = calibrateExits(trainByModel.get(selected.id), horizon);
          const calibratedRows = contexts[market].flatMap(c => {
            const offset = c.bars.length - minLength;
            return candidateTrades(c, horizon, side, selected, testStart + offset,
              testStart + testBars + offset, exitCalibration);
          });
          selections.push({
            market, fold, horizon, side, selectedModel: selected.id,
            train: metrics(trainByModel.get(selected.id)), test: metrics(testRows),
            exitCalibration, calibratedExitTest: metrics(calibratedRows)
          });
          foldResults.push(...testRows.map(r => ({ ...r, fold, selectedModel: selected.id })));
          calibratedFoldResults.push(...calibratedRows.map(r => ({ ...r, fold, selectedModel: selected.id })));
        }
      }
    }
  }

  const aggregate = [];
  const calibratedExitAggregate = [];
  for (const market of [...MARKETS, 'combined']) {
    for (const horizon of Object.keys(SPECS)) {
      for (const side of ['buy', 'sell']) {
        const rows = foldResults.filter(r => (market === 'combined' || r.market === market)
          && r.horizon === horizon && r.side === side);
        aggregate.push({ market, horizon, side, metrics: metrics(rows) });
        const calibratedRows = calibratedFoldResults.filter(r => (market === 'combined' || r.market === market)
          && r.horizon === horizon && r.side === side);
        calibratedExitAggregate.push({ market, horizon, side, metrics: metrics(calibratedRows) });
      }
    }
  }
  const modelFrequency = {};
  for (const s of selections) {
    const key = `${s.market}:${s.horizon}:${s.side}`;
    modelFrequency[key] ||= {};
    modelFrequency[key][s.selectedModel] = (modelFrequency[key][s.selectedModel] || 0) + 1;
  }
  const modelComparison = [];
  for (const market of [...MARKETS, 'combined']) {
    for (const horizon of Object.keys(SPECS)) {
      for (const side of ['buy', 'sell']) {
        for (const model of MODELS.filter(m => modelApplies(m, horizon, side))) {
          const rows = allModelFoldResults.filter(r => (market === 'combined' || r.market === market)
            && r.horizon === horizon && r.side === side && r.model === model.id);
          modelComparison.push({ market, horizon, side, model: model.id, metrics: metrics(rows) });
        }
      }
    }
  }
  // Geographic holdout: freeze the model using US data only, then report every
  // other market for that exact model. Holdout performance never participates
  // in selection.
  const crossMarketValidation = [];
  for (const horizon of Object.keys(SPECS)) {
    for (const side of ['buy', 'sell']) {
      const candidates = MODELS.filter(m => modelApplies(m, horizon, side));
      const selected = candidates.slice().sort((a, b) => {
        const aRows = allModelFoldResults.filter(r => r.market === 'US'
          && r.horizon === horizon && r.side === side && r.model === a.id);
        const bRows = allModelFoldResults.filter(r => r.market === 'US'
          && r.horizon === horizon && r.side === side && r.model === b.id);
        return selectionScore(bRows) - selectionScore(aRows);
      })[0];
      const usRows = allModelFoldResults.filter(r => r.market === 'US'
        && r.horizon === horizon && r.side === side && r.model === selected.id);
      crossMarketValidation.push({
        horizon, side, selectedOnUS: selected.id,
        usCalibrationMetrics: metrics(usRows),
        holdoutMetrics: Object.fromEntries(MARKETS.filter(market => market !== 'US').map(market => [
          market,
          metrics(allModelFoldResults.filter(r => r.market === market
            && r.horizon === horizon && r.side === side && r.model === selected.id))
        ]))
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      markets: MARKETS, requestedPerMarket: perMarket,
      loadedPerMarket: Object.fromEntries(MARKETS.map(market => [market, contexts[market].length])),
      trainBars, testBars, entryStep, nextOpenEntry: true, costsAndShortBorrow: true,
      strictMarketSeparation: true,
      selection: 'Each market/horizon/side selects on trailing training data; metrics aggregate only following OOS folds.',
      geographicHoldout: 'A second validation freezes each model using US results only, then evaluates that exact model on every other market.',
      earningsRevisionFactor: {
        tested: false,
        reason: 'No point-in-time analyst-estimate history or authenticated provider is available. Current estimates would create look-ahead bias.'
      },
      limitations: [
        'Current static constituents create survivorship bias and exclude delisted names.',
        'Sector classification is current/static; price bars are historical and date-aligned.',
        'Fixed-notional trade sums do not enforce a shared overlapping-position capital limit.'
      ]
    },
    models: MODELS,
    modelFrequency,
    selections,
    aggregate,
    calibratedExitAggregate,
    modelComparison,
    crossMarketValidation,
    maeMfeByBracket: aggregate.filter(r => r.market === 'combined')
  };
  const out = path.join(__dirname, 'backtest-factor-combinations-results.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Wrote ${out}`);
  for (const row of aggregate.filter(r => r.market === 'combined')) {
    const m = row.metrics;
    console.log(`${row.horizon.padEnd(6)} ${row.side.padEnd(4)} n=${String(m.trades).padStart(4)} WR=${m.winRate ?? '—'}% avg=${m.avgReturnPct ?? '—'}% PF=${m.profitFactor ?? '—'} PnL=$${m.netPnlUsdAtFixedNotional}`);
  }
}

module.exports = {
  UNIVERSES,
  MARKETS,
  INDEX,
  SPECS,
  MODELS,
  num,
  mean,
  sma,
  atr,
  ret,
  priorExtreme,
  dateKey,
  dateIndex,
  alignedIndex,
  benchmarkRet,
  baselineSignal,
  featuresAt,
  applicableFactor,
  modelApplies,
  factorPass,
  simulateTrade,
  candidateTrades,
  percentile,
  metrics,
  selectionScore,
  calibrateExits
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(2);
  });
}
