#!/usr/bin/env node
'use strict';

// Backtest-only rescue study. It uses only the standalone price-only MR entry,
// never the FMP-dependent production entry path.
process.env.PORT = process.env.PORT || '3996';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-rescue-'));

const { buildMarketRegime, fetchOHLCV, sectorEtfForSymbol } = require('../server');
const { STATIC_GROUPS } = require('../universe');
const { buildDateAlignedFolds, assertFoldIsolation, runNestedSelection } = require('../lib/research/walk-forward-optimizer');
const { summarizeReturns } = require('../lib/research/performance');
const { EXTERNAL_SNAPSHOT_REQUIREMENTS, dedupeCommodityUniverse } = require('../lib/research/omitted-geo-rescue-universes');
const { factorEligibility, classifyCell } = require('../lib/research/omitted-geo-rescue');
const { signalAt, simulateTrade } = require('../lib/research/mean-reversion');

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const RANGE = '10y';
const NOTIONAL = 10000;
const OUTPUT = path.join(__dirname, 'backtest-omitted-geo-rescue-results.json');
const LIMIT = Math.max(1, Number(args.limit) || Infinity);
const MARKET = {
  France: { symbols: STATIC_GROUPS.CAC40, benchmark: 'EWQ', expanded: false },
  Germany: { symbols: STATIC_GROUPS.DAX, benchmark: 'EWG', expanded: false },
  HK: { symbols: STATIC_GROUPS.HSI, benchmark: 'EWH', expanded: false },
  UK: { symbols: STATIC_GROUPS.FTSE100, benchmark: 'EWU', expanded: false },
  Commodities: { symbols: dedupeCommodityUniverse(STATIC_GROUPS.COMMODITIES), benchmark: 'DBC', expanded: true },
};
const EMBARGO = { short: 20, medium: 63, long: 180 };
const HOLDOUT_CUTOFF = null; // trailing fold; known overlap risk is reported.

function dateOf(bar) { return new Date(Number(bar.t) * 1000).toISOString().slice(0, 10); }
function inRange(date, range) { return date >= range.from && date <= range.to; }
function mapLimit(values, limit, operation) {
  let cursor = 0; const output = new Array(values.length);
  return Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const i = cursor++; output[i] = await operation(values[i], i); }
  })).then(() => output);
}
function metrics(trades) {
  const summary = summarizeReturns(trades.map(t => t.ret));
  const wins = trades.filter(t => t.ret > 0);
  const losses = trades.filter(t => t.ret <= 0);
  return {
    ...summary,
    pnlUsd: +(trades.reduce((sum, t) => sum + t.ret * NOTIONAL, 0)).toFixed(2),
    avgWinPct: wins.length ? +(wins.reduce((sum, t) => sum + t.ret, 0) / wins.length * 100).toFixed(3) : null,
    avgLossPct: losses.length ? +(losses.reduce((sum, t) => sum + t.ret, 0) / losses.length * 100).toFixed(3) : null,
  };
}
function nonOverlapping(events, range) {
  const locked = new Map();
  return events.filter(e => inRange(e.signalDate, range) && inRange(e.exitDate, range))
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.symbol.localeCompare(b.symbol))
    .filter(e => {
      const last = locked.get(e.symbol) ?? -1;
      if (e.entryIndex <= last) return false;
      locked.set(e.symbol, e.exitIndex);
      return true;
    });
}
function eventDate(ts) { return new Date(Number(ts)).toISOString().slice(0, 10); }
function liquidityMaps(contexts) {
  const byDate = new Map();
  for (const context of contexts) {
    for (let i = 20; i < context.bars.length; i++) {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += Number(context.bars[j].c) * Number(context.bars[j].v);
      const date = dateOf(context.bars[i]);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ symbol: context.symbol, dollarVolume: sum / 20 });
    }
  }
  const pass = new Set();
  for (const [date, rows] of byDate) {
    const ranked = rows.filter(row => Number.isFinite(row.dollarVolume)).sort((a, b) => b.dollarVolume - a.dollarVolume);
    const count = Math.max(1, Math.ceil(ranked.length * 0.1));
    ranked.slice(0, count).forEach(row => pass.add(`${date}:${row.symbol}`));
  }
  return pass;
}
function mrCandidates(horizon, requireLiquidity = false) {
  const timeStops = horizon === 'short' ? [3, 5, 10] : [10, 21];
  const output = [];
  for (const trigger of ['rsi2_lt_5', 'close_below_lower_bb20_2', 'williams_r10_lt_minus_95']) {
    for (const target of ['prior_close', 'one_atr', 'ma20']) {
      for (const timeStopBars of timeStops) for (const stopAtr of [2, 2.5]) for (const partial of [false, true]) {
        output.push({
          id: `${trigger}__${target}__t${timeStopBars}__sl${stopAtr}__${partial ? 'partial' : 'full'}${requireLiquidity ? '__top_liquidity' : ''}`,
          trigger, target, timeStopBars, stopAtr, partial, requireLiquidity,
        });
      }
    }
  }
  return output;
}
function signalIndices(contexts, marketRegime) {
  const out = new Map();
  for (const context of contexts) for (const trigger of ['rsi2_lt_5', 'close_below_lower_bb20_2', 'williams_r10_lt_minus_95']) {
    const indices = [];
    for (let i = 200; i < context.bars.length - 2; i++) {
      if (signalAt(context.bars, i, { trigger }, marketRegime, context.sectorBars, context.sectorIndex)) indices.push(i);
    }
    out.set(`${context.symbol}:${trigger}`, indices);
  }
  return out;
}
function mrOpportunities(contexts, candidate, indices, liquidity) {
  const output = [];
  for (const context of contexts) for (const i of indices.get(`${context.symbol}:${candidate.trigger}`) || []) {
    const signalDate = dateOf(context.bars[i]);
    if (candidate.requireLiquidity && !liquidity.has(`${signalDate}:${context.symbol}`)) continue;
    const trade = simulateTrade(context.bars, i, candidate, context);
    if (trade) output.push({ ...trade, symbol: context.symbol, signalDate, exitDate: dateOf(context.bars[trade.exitIndex]) });
  }
  return output;
}
function pValue(events) {
  const n = events.length; const wins = events.filter(e => e.ret > 0).length;
  if (!n) return 1;
  let probability = 2 ** -n; let tail = 0;
  for (let i = 0; i <= n; i++) { if (i >= wins) tail += probability; if (i < n) probability *= (n - i) / (i + 1); }
  return Math.min(1, tail);
}
function applyMtc(cells) {
  const ordered = cells.map(cell => ({ cell, p: pValue(cell._holdoutEvents) })).sort((a, b) => a.p - b.p);
  let cutoff = 0;
  ordered.forEach((row, index) => { if (row.p <= ((index + 1) / ordered.length) * 0.05) cutoff = index + 1; });
  ordered.forEach((row, index) => { row.cell.mtcPass = index < cutoff; row.cell.holdoutWinRatePValue = +row.p.toFixed(6); });
}

async function main() {
  const cache = new Map();
  const load = symbol => {
    if (!cache.has(symbol)) cache.set(symbol, fetchOHLCV(symbol, RANGE, '1d').catch(() => null));
    return cache.get(symbol);
  };
  const cells = [];
  const sourceStatus = { ...EXTERNAL_SNAPSHOT_REQUIREMENTS };
  for (const [market, spec] of Object.entries(MARKET)) {
    const benchmark = await load(spec.benchmark);
    if (!Array.isArray(benchmark) || benchmark.length < 1700) continue;
    const contexts = (await mapLimit(spec.symbols, 6, async symbol => {
      const bars = await load(symbol);
      if (!Array.isArray(bars) || bars.length < 1700) return null;
      const sectorBars = await load(sectorEtfForSymbol(symbol));
      const usableSector = Array.isArray(sectorBars) && sectorBars.length >= 250 ? sectorBars : benchmark;
      return {
        symbol, bars, market,
        sectorBars: usableSector,
        sectorIndex: new Map(usableSector.map((bar, index) => [dateOf(bar), index])),
      };
    })).filter(Boolean).slice(0, LIMIT);
    const marketRegime = buildMarketRegime(benchmark);
    const liquidity = liquidityMaps(contexts);
    const indices = signalIndices(contexts, marketRegime);
    const timeline = benchmark.map(dateOf);
    // The frozen standalone MR registry has only short and medium exits.
    // A long-horizon variant would be a new, unregistered strategy.
    for (const horizon of ['short', 'medium']) {
      const folds = buildDateAlignedFolds(timeline, { folds: 4, trainBars: 504, validationBars: 126, testBars: 126, embargoBars: EMBARGO[horizon] });
      if (folds.length !== 4) continue;
      assertFoldIsolation(folds);
      const includeLiquidityVariant = horizon === 'short' && (market === 'UK' || market === 'HK');
      const candidates = [
        ...mrCandidates(horizon, false),
        ...(includeLiquidityVariant ? mrCandidates(horizon, true) : []),
      ];
      const cached = new Map();
      const evaluate = (candidate, range) => {
        const key = `${candidate.id}:${range.from}:${range.to}`;
        if (!cached.has(key)) cached.set(key, nonOverlapping(mrOpportunities(contexts, candidate, indices, liquidity), range));
        return metrics(cached.get(key));
      };
      const nested = runNestedSelection({
        folds, candidates, fallback: candidates[0],
        evaluateValidation: (candidate, range) => {
          const value = evaluate(candidate, range);
          const qualifies = value.trades >= 12 && value.winRate >= 60 && value.profitFactor >= 1.3 && value.pnlUsd > 0;
          return { metrics: value, score: qualifies ? value.winRate * 1e6 + value.profitFactor * 1e3 + value.pnlUsd / 100 : -Infinity };
        },
        evaluateTest: (candidate, range) => evaluate(candidate, range),
      });
      const developmentFoldTests = folds.slice(0, -1).map(fold => evaluate(nested.frozen, fold.test));
      const developmentEvents = folds.slice(0, -1).flatMap(fold => cached.get(`${nested.frozen.id}:${fold.test.from}:${fold.test.to}`) || []);
      const holdoutEvents = cached.get(`${nested.frozen.id}:${nested.holdoutFold.test.from}:${nested.holdoutFold.test.to}`) || [];
      cells.push({
        market, horizon, side: 'buy', frozenModel: nested.frozen.id, folds,
        requestedUniverse: spec.symbols.length, loadedUniverse: contexts.length,
        universeExpansion: spec.expanded ? 'COMPLETED' : 'BLOCKED_REQUIRES_DATED_CONSTITUENT_SNAPSHOT',
        development: metrics(developmentEvents), developmentFoldTests,
        stableDevelopmentFolds: developmentFoldTests.filter(m => m.winRate >= 60 && m.profitFactor >= 1.3 && m.pnlUsd > 0).length,
        holdout: metrics(holdoutEvents), _holdoutEvents: holdoutEvents,
        factorEligibility: {
          liquidity_top_decile: factorEligibility('liquidity_top_decile', horizon, { market }),
          hk_southbound_flow: factorEligibility('hk_southbound_flow', horizon, { market }),
          hk_ah_discount: factorEligibility('hk_ah_discount', horizon, { market }),
          uk_revenue_partition: factorEligibility('uk_revenue_partition', horizon, { market }),
          uk_weak_gbp: factorEligibility('uk_weak_gbp', horizon, { market }),
          earnings_fundamental: factorEligibility('earnings_fundamental', horizon, { market, fmpPointInTime: false }),
        },
      });
    }
  }
  applyMtc(cells);
  cells.forEach(cell => { cell.sampleConfidence = classifyCell(cell); delete cell._holdoutEvents; });
  const report = {
    generatedAt: new Date().toISOString(), study: 'omitted-geo-rescue-v1',
    methodology: {
      preregistration: 'docs/omitted-geo-rescue-rerun-preregistration.md',
      holdoutCutoff: HOLDOUT_CUTOFF,
      holdoutValidity: 'OVERLAP_RISK: trailing 126-session fold overlaps prior studies because no newer clean 126-session period exists',
      liveRulesChanged: false,
      fmpPointInTimeVerified: false,
    },
    sourceStatus, commodityAdditions: MARKET.Commodities.symbols.filter(s => !STATIC_GROUPS.COMMODITIES.includes(s)), cells,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(`Wrote ${OUTPUT}`);
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
