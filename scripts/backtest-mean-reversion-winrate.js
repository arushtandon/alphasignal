#!/usr/bin/env node
'use strict';

/**
 * Preregistered, backtest-only high-win-rate mean-reversion study.
 * It is deliberately independent from recommendation and live bracket paths.
 */
process.env.PORT = process.env.PORT || '3995';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-mean-reversion-'));

const { fetchOHLCV, buildMarketRegime, sectorEtfForSymbol } = require('../server');
const { US_CORE, STATIC_GROUPS } = require('../universe');
const { buildDateAlignedFolds, assertFoldIsolation, runNestedSelection } = require('../lib/research/walk-forward-optimizer');
const { summarizeReturns } = require('../lib/research/performance');
const { signalAt, simulateTrade } = require('../lib/research/mean-reversion');

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const PER_MARKET = Math.max(5, Number(args.perMarket) || 80);
const RANGE = String(args.range || '10y');
const NOTIONAL = Math.max(1000, Number(args.notional) || 10000);
const OUTPUT = String(args.output || 'backtest-mean-reversion-winrate-results.json');
const US_EXTRA = ['PFE','BMY','AMGN','MDLZ','CL','MO','PM','LOW','TJX','HON','UPS','RTX','LMT','DE','MMM','UNP','SHW','FCX','NEM','NUE','NEE','DUK','SO','D','AEP','PLD','AMT','EQIX','SPG','CVS','CI','MDT','SYK','ZTS','ADP','CB','MMC','ICE','CME','SCHW','AXP','BLK'];
const UNIVERSES = {
  US: [...new Set([...US_CORE, ...US_EXTRA])], HK: [...new Set(STATIC_GROUPS.HSI)],
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)], UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)], France: [...new Set(STATIC_GROUPS.CAC40)],
  Commodities: [...new Set(STATIC_GROUPS.COMMODITIES)],
};
const INDEX = { US: 'SPY', HK: 'EWH', Japan: 'EWJ', UK: 'EWU', Germany: 'EWG', France: 'EWQ', Commodities: 'DBC' };
const EMBARGO = { short: 20, medium: 63 };

function dateOf(bar) { return new Date(bar.t * 1000).toISOString().slice(0, 10); }
function inRange(date, range) { return date >= range.from && date <= range.to; }
function mapLimit(values, limit, operation) {
  let next = 0;
  const output = new Array(values.length);
  return Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index], index);
    }
  })).then(() => output);
}
function candidates(horizon) {
  const timeStops = horizon === 'short' ? [3, 5, 10] : [10, 21];
  const output = [];
  for (const trigger of ['rsi2_lt_5', 'close_below_lower_bb20_2', 'williams_r10_lt_minus_95']) {
    for (const target of ['prior_close', 'one_atr', 'ma20']) {
      for (const timeStopBars of timeStops) for (const stopAtr of [2, 2.5]) for (const partial of [false, true]) {
        output.push({ id: `${trigger}__${target}__t${timeStopBars}__sl${stopAtr}__${partial ? 'partial' : 'full'}`, trigger, target, timeStopBars, stopAtr, partial });
      }
    }
  }
  return output;
}
function metrics(trades) {
  const summary = summarizeReturns(trades.map(trade => trade.ret));
  const winners = trades.filter(trade => trade.ret > 0);
  const losers = trades.filter(trade => trade.ret <= 0);
  return {
    ...summary,
    pnlUsd: +(trades.reduce((sum, trade) => sum + trade.ret * NOTIONAL, 0)).toFixed(2),
    avgWinPct: winners.length ? +(winners.reduce((sum, trade) => sum + trade.ret, 0) / winners.length * 100).toFixed(3) : null,
    avgLossPct: losers.length ? +(losers.reduce((sum, trade) => sum + trade.ret, 0) / losers.length * 100).toFixed(3) : null,
  };
}
function buildSignalIndices(contexts, marketRegime) {
  const bySymbolAndTrigger = new Map();
  const triggers = ['rsi2_lt_5', 'close_below_lower_bb20_2', 'williams_r10_lt_minus_95'];
  for (const context of contexts) {
    for (const trigger of triggers) {
      const indices = [];
      for (let i = 200; i < context.bars.length - 2; i++) {
        if (signalAt(context.bars, i, { trigger }, marketRegime, context.sectorBars, context.sectorIndex)) indices.push(i);
      }
      bySymbolAndTrigger.set(`${context.symbol}:${trigger}`, indices);
    }
  }
  return bySymbolAndTrigger;
}
function buildTradeOpportunities(contexts, candidate, signalIndices) {
  const trades = [];
  for (const context of contexts) {
    for (const i of signalIndices.get(`${context.symbol}:${candidate.trigger}`) || []) {
      const signalDate = dateOf(context.bars[i]);
      const trade = simulateTrade(context.bars, i, candidate, context);
      if (!trade) continue;
      const exitDate = dateOf(context.bars[trade.exitIndex]);
      trades.push({ ...trade, symbol: context.symbol, signalDate, exitDate });
    }
  }
  return trades;
}
function nonOverlapping(trades, range) {
  const locked = new Map();
  return trades
    .filter(trade => inRange(trade.signalDate, range) && inRange(trade.exitDate, range))
    .sort((left, right) => left.signalDate.localeCompare(right.signalDate) || left.symbol.localeCompare(right.symbol))
    .filter(trade => {
      const until = locked.get(trade.symbol) ?? -1;
      if (trade.entryIndex <= until) return false;
      locked.set(trade.symbol, trade.exitIndex);
      return true;
    });
}
function pValueWinRate(trades) {
  const n = trades.length;
  if (!n) return 1;
  const wins = trades.filter(trade => trade.ret > 0).length;
  const z = (wins - n * 0.5) / Math.sqrt(n * 0.25);
  // One-sided normal tail; adequate only for multiplicity screening, not an edge claim.
  return 0.5 * (1 - erf(z / Math.sqrt(2)));
}
function erf(x) {
  const sign = x < 0 ? -1 : 1; const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a));
}
function applyMtc(cells) {
  const ranked = cells.map(cell => ({ cell, p: pValueWinRate(cell.holdoutTrades || []) })).sort((a, b) => a.p - b.p);
  const m = ranked.length;
  let accepted = 0;
  ranked.forEach((row, index) => { if (row.p <= ((index + 1) / m) * 0.05) accepted = index + 1; });
  ranked.forEach((row, index) => { row.cell.holdoutWinRatePValue = +row.p.toFixed(6); row.cell.mtcPass = index < accepted; });
}
function status(cell) {
  const m = cell.holdout;
  const checks = {
    developmentSample: cell.development.trades >= 30,
    holdoutSample: m.trades >= 30,
    holdoutWinRate: m.winRate >= 60,
    holdoutProfitFactor: m.profitFactor >= 1.3,
    holdoutPnl: m.pnlUsd > 0,
    foldStability: cell.stableDevelopmentFolds >= 2,
    multipleTesting: cell.mtcPass === true,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

async function main() {
  const cache = new Map();
  const load = symbol => {
    if (!cache.has(symbol)) cache.set(symbol, fetchOHLCV(symbol, RANGE, '1d').catch(() => null));
    return cache.get(symbol);
  };
  const benchmarks = new Map();
  await mapLimit(Object.values(INDEX), 4, async symbol => {
    const bars = await load(symbol);
    if (Array.isArray(bars) && bars.length > 900) benchmarks.set(symbol, bars);
  });
  const contexts = {};
  for (const [market, universe] of Object.entries(UNIVERSES)) {
    const valid = [];
    for (let start = 0; start < universe.length && valid.length < PER_MARKET; start += 6) {
      const batch = await mapLimit(universe.slice(start, start + 6), 6, async symbol => {
        process.stdout.write(`\rLoading ${market} ${symbol}`.padEnd(65));
        const bars = await load(symbol);
        if (!Array.isArray(bars) || bars.length < 900) return null;
        const sectorBars = await load(sectorEtfForSymbol(symbol));
        const usableSector = Array.isArray(sectorBars) && sectorBars.length >= 250 ? sectorBars : benchmarks.get(INDEX[market]);
        return { market, symbol, bars, sectorBars: usableSector, sectorIndex: new Map(usableSector.map((bar, index) => [dateOf(bar), index])) };
      });
      valid.push(...batch.filter(Boolean));
    }
    contexts[market] = valid.slice(0, PER_MARKET);
  }
  console.log(`\nLoaded ${Object.entries(contexts).map(([market, data]) => `${market}=${data.length}`).join(', ')}`);

  const cells = [];
  for (const [market, marketContexts] of Object.entries(contexts)) {
    const benchmark = benchmarks.get(INDEX[market]);
    if (!benchmark || !marketContexts.length) continue;
    const marketRegime = buildMarketRegime(benchmark);
    const signalIndices = buildSignalIndices(marketContexts, marketRegime);
    for (const horizon of ['short', 'medium']) {
      const folds = buildDateAlignedFolds(benchmark.map(dateOf), { folds: 4, trainBars: 504, validationBars: 126, testBars: 126, embargoBars: EMBARGO[horizon] });
      if (folds.length !== 4) continue;
      assertFoldIsolation(folds);
      const registry = candidates(horizon);
      const opportunitiesByCandidate = new Map();
      const cacheByCandidateAndRange = new Map();
      const evaluate = (candidate, range) => {
        const key = `${candidate.id}:${range.from}:${range.to}`;
        if (!opportunitiesByCandidate.has(candidate.id)) {
          opportunitiesByCandidate.set(candidate.id, buildTradeOpportunities(marketContexts, candidate, signalIndices));
        }
        if (!cacheByCandidateAndRange.has(key)) {
          cacheByCandidateAndRange.set(key, nonOverlapping(opportunitiesByCandidate.get(candidate.id), range));
        }
        return metrics(cacheByCandidateAndRange.get(key));
      };
      const fallback = registry[0];
      const nested = runNestedSelection({
        folds, candidates: registry, fallback,
        evaluateValidation: (candidate, range) => {
          const value = evaluate(candidate, range);
          const qualifies = value.trades >= 12 && value.winRate >= 60 && value.profitFactor >= 1.3 && value.pnlUsd > 0;
          return { metrics: value, score: qualifies ? value.winRate * 1000000 + Math.min(value.profitFactor, 20) * 1000 + value.pnlUsd / 100 : -Infinity };
        },
        evaluateTest: (candidate, range) => evaluate(candidate, range),
      });
      // Re-evaluate every development test with the single frozen winner.
      // Fold-local selected candidates are only used to select that winner and
      // must never be used to inflate its stability.
      const developmentTests = folds.slice(0, -1).map(fold => evaluate(nested.frozen, fold.test));
      // Preserve the complete per-fold test metrics and derive pooled figures from reruns.
      const pooledDevTrades = folds.slice(0, -1).flatMap(fold => {
        const range = fold.test;
        const key = `${nested.frozen.id}:${range.from}:${range.to}`;
        return cacheByCandidateAndRange.get(key) || [];
      });
      const holdoutTrades = cacheByCandidateAndRange.get(`${nested.frozen.id}:${nested.holdoutFold.test.from}:${nested.holdoutFold.test.to}`) || [];
      const cell = {
        market, horizon, side: 'buy', frozenModel: nested.frozen, folds,
        development: metrics(pooledDevTrades),
        developmentFoldTests: developmentTests,
        stableDevelopmentFolds: developmentTests.filter(item => item.trades >= 12 && item.winRate >= 60 && item.profitFactor >= 1.3 && item.pnlUsd > 0).length,
        holdout: metrics(holdoutTrades),
        holdoutTrades,
        highWinLowPfReject: nested.holdout.winRate >= 60 && nested.holdout.profitFactor < 1.3,
        candidatesTested: registry.length,
      };
      cells.push(cell);
      console.log(`${market} ${horizon}: ${nested.frozen.id} | holdout n=${cell.holdout.trades} WR=${cell.holdout.winRate} PF=${cell.holdout.profitFactor} PnL=${cell.holdout.pnlUsd}`);
    }
  }
  applyMtc(cells);
  cells.forEach(cell => { cell.status = status(cell); delete cell.holdoutTrades; });
  const report = {
    generatedAt: new Date().toISOString(), study: 'mean-reversion-winrate-v1',
    methodology: { preregistration: 'docs/mean-reversion-winrate-preregistration.md', data: 'Yahoo daily OHLCV', costs: '$10k notional; existing cost model', folds: '504/126/126 × 4', embargo: EMBARGO, pointInTimeFundamentals: false, liveRulesChanged: false },
    loadedPerMarket: Object.fromEntries(Object.entries(contexts).map(([market, value]) => [market, value.length])),
    candidates: { short: candidates('short'), medium: candidates('medium') }, cells,
  };
  const output = path.join(__dirname, OUTPUT);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`Wrote ${output}`);
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
