#!/usr/bin/env node
'use strict';

process.env.PORT = process.env.PORT || '3997';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-usjp-regime-'));

const { fetchOHLCV, buildMarketRegime, sectorEtfForSymbol } = require('../server');
const { US_CORE, STATIC_GROUPS } = require('../universe');
const { buildDateAlignedFolds, assertFoldIsolation } = require('../lib/research/walk-forward-optimizer');
const { summarizeReturns } = require('../lib/research/performance');
const { signalAt, simulateTrade } = require('../lib/research/mean-reversion');
const { classifyCell } = require('../lib/research/omitted-geo-rescue');

const RANGE = '10y';
const NOTIONAL = 10000;
const OUTPUT = path.join(__dirname, 'backtest-usjp-regime-stabilize-results.json');
const US_EXTRA = ['PFE','BMY','AMGN','MDLZ','CL','MO','PM','LOW','TJX','HON','UPS','RTX','LMT','DE','MMM','UNP','SHW','FCX','NEM','NUE','NEE','DUK','SO','D','AEP','PLD','AMT','EQIX','SPG','CVS','CI','MDT','SYK','ZTS','ADP','CB','MMC','ICE','CME','SCHW','AXP','BLK'];
const MARKETS = {
  US: { universe: [...new Set([...US_CORE, ...US_EXTRA])], benchmark: 'SPY' },
  Japan: { universe: [...new Set(STATIC_GROUPS.NIKKEI225)], benchmark: 'EWJ' },
};
const MODELS = {
  US: {
    short: { trigger: 'rsi2_lt_5', target: 'prior_close', timeStopBars: 3, stopAtr: 2, partial: false },
    medium: { trigger: 'close_below_lower_bb20_2', target: 'one_atr', timeStopBars: 21, stopAtr: 2.5, partial: true },
  },
  Japan: {
    short: { trigger: 'close_below_lower_bb20_2', target: 'one_atr', timeStopBars: 10, stopAtr: 2.5, partial: true },
    medium: { trigger: 'close_below_lower_bb20_2', target: 'one_atr', timeStopBars: 21, stopAtr: 2.5, partial: false },
  },
};
const VARIANTS = [
  { id: 'baseline' },
  { id: 'vol_skip_top20', volQuantile: 0.8 },
  { id: 'vol_skip_top30', volQuantile: 0.7 },
  { id: 'ma50_flat_or_up', slope: true },
  { id: 'vol_skip_top20_and_ma50_flat_or_up', volQuantile: 0.8, slope: true },
  { id: 'vol_skip_top30_and_ma50_flat_or_up', volQuantile: 0.7, slope: true },
];
const EMBARGO = { short: 20, medium: 63 };

function dateOf(bar) { return new Date(bar.t * 1000).toISOString().slice(0, 10); }
function inRange(date, range) { return date >= range.from && date <= range.to; }
function mapLimit(values, limit, operation) {
  let next = 0; const output = new Array(values.length);
  return Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; output[index] = await operation(values[index], index); }
  })).then(() => output);
}
function metrics(trades) {
  const summary = summarizeReturns(trades.map(t => t.ret));
  const wins = trades.filter(t => t.ret > 0); const losses = trades.filter(t => t.ret <= 0);
  return {
    ...summary,
    pnlUsd: +(trades.reduce((sum, t) => sum + t.ret * NOTIONAL, 0)).toFixed(2),
    avgWinPct: wins.length ? +(wins.reduce((sum, t) => sum + t.ret, 0) / wins.length * 100).toFixed(3) : null,
    avgLossPct: losses.length ? +(losses.reduce((sum, t) => sum + t.ret, 0) / losses.length * 100).toFixed(3) : null,
  };
}
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function benchmarkRegimes(bars) {
  const values = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let i = 270; i < bars.length; i++) {
    const returns = [];
    for (let j = i - 19; j <= i; j++) returns.push(closes[j] / closes[j - 1] - 1);
    const vol = Math.sqrt(mean(returns.map(r => (r - mean(returns)) ** 2)));
    const history = [];
    for (let j = i - 251; j <= i; j++) {
      const sample = [];
      for (let k = j - 19; k <= j; k++) sample.push(closes[k] / closes[k - 1] - 1);
      history.push(Math.sqrt(mean(sample.map(r => (r - mean(sample)) ** 2))));
    }
    const sorted = history.slice().sort((a, b) => a - b);
    const ma50 = mean(closes.slice(i - 49, i + 1));
    const priorMa50 = mean(closes.slice(i - 59, i - 9));
    values.set(dateOf(bars[i]), { vol, q80: sorted[Math.floor((sorted.length - 1) * 0.8)], q70: sorted[Math.floor((sorted.length - 1) * 0.7)], slopeFlatOrUp: ma50 >= priorMa50 });
  }
  return values;
}
function passesVariant(benchmarkMap, date, variant) {
  const r = benchmarkMap.get(date);
  if (!r) return false;
  if (variant.volQuantile && r.vol >= (variant.volQuantile === 0.8 ? r.q80 : r.q70)) return false;
  return !(variant.slope && !r.slopeFlatOrUp);
}
function nonOverlapping(trades, range) {
  const locked = new Map();
  return trades.filter(t => inRange(t.signalDate, range) && inRange(t.exitDate, range))
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.symbol.localeCompare(b.symbol))
    .filter(t => {
      const until = locked.get(t.symbol) ?? -1;
      if (t.entryIndex <= until) return false;
      locked.set(t.symbol, t.exitIndex);
      return true;
    });
}
function pValue(trades) {
  const n = trades.length; const wins = trades.filter(t => t.ret > 0).length;
  let probability = 2 ** -n; let tail = 0;
  for (let i = 0; i <= n; i++) { if (i >= wins) tail += probability; if (i < n) probability *= (n - i) / (i + 1); }
  return Math.min(1, tail);
}
function applyMtc(cells) {
  const ordered = cells.map(cell => ({ cell, p: pValue(cell._holdoutTrades) })).sort((a, b) => a.p - b.p);
  let passing = 0;
  ordered.forEach((row, index) => { if (row.p <= ((index + 1) / ordered.length) * 0.05) passing = index + 1; });
  ordered.forEach((row, index) => { row.cell.mtcPass = index < passing; row.cell.holdoutWinRatePValue = +row.p.toFixed(6); });
}

async function main() {
  const cache = new Map();
  const load = symbol => {
    if (!cache.has(symbol)) cache.set(symbol, fetchOHLCV(symbol, RANGE, '1d').catch(() => null));
    return cache.get(symbol);
  };
  const cells = [];
  for (const [market, spec] of Object.entries(MARKETS)) {
    const benchmark = await load(spec.benchmark);
    const contexts = (await mapLimit(spec.universe, 6, async symbol => {
      const bars = await load(symbol);
      if (!Array.isArray(bars) || bars.length < 1500) return null;
      const sectorBars = await load(sectorEtfForSymbol(symbol));
      const usableSector = Array.isArray(sectorBars) && sectorBars.length >= 250 ? sectorBars : benchmark;
      return { market, symbol, bars, sectorBars: usableSector, sectorIndex: new Map(usableSector.map((bar, index) => [dateOf(bar), index])) };
    })).filter(Boolean).slice(0, 80);
    const tide = buildMarketRegime(benchmark);
    const regimes = benchmarkRegimes(benchmark);
    for (const horizon of ['short', 'medium']) {
      const model = { ...MODELS[market][horizon], id: `${market}_${horizon}_frozen` };
      const folds = buildDateAlignedFolds(benchmark.map(dateOf), { folds: 4, trainBars: 504, validationBars: 126, testBars: 126, embargoBars: EMBARGO[horizon] });
      assertFoldIsolation(folds);
      const all = [];
      for (const context of contexts) for (let i = 270; i < context.bars.length - 2; i++) {
        if (!signalAt(context.bars, i, model, tide, context.sectorBars, context.sectorIndex)) continue;
        const trade = simulateTrade(context.bars, i, model, context);
        if (trade) all.push({ ...trade, symbol: context.symbol, signalDate: dateOf(context.bars[i]), exitDate: dateOf(context.bars[trade.exitIndex]) });
      }
      for (const variant of VARIANTS) {
        const filtered = all.filter(trade => passesVariant(regimes, trade.signalDate, variant));
        const devTrades = folds.slice(0, -1).flatMap(fold => nonOverlapping(filtered, fold.test));
        const devFolds = folds.slice(0, -1).map(fold => metrics(nonOverlapping(filtered, fold.test)));
        const holdoutTrades = nonOverlapping(filtered, folds.at(-1).test);
        cells.push({
          market, horizon, side: 'buy', model: model.id, variant: variant.id, folds,
          development: metrics(devTrades), developmentFoldTests: devFolds,
          stableDevelopmentFolds: devFolds.filter(m => m.winRate >= 60 && m.profitFactor >= 1.3 && m.pnlUsd > 0).length,
          holdout: metrics(holdoutTrades), _holdoutTrades: holdoutTrades,
        });
      }
    }
  }
  applyMtc(cells);
  cells.forEach(cell => {
    cell.sampleConfidence = classifyCell(cell);
    cell.status = cell.sampleConfidence.promotable ? 'CANDIDATE_ONLY_OVERLAP_RISK' : 'REJECTED_OR_UNSTABLE';
    delete cell._holdoutTrades;
  });
  fs.writeFileSync(OUTPUT, JSON.stringify({
    generatedAt: new Date().toISOString(), study: 'usjp-regime-stabilize-v1',
    methodology: { preregistration: 'docs/usjp-regime-stabilize-preregistration.md', holdoutValidity: 'OVERLAP_RISK', pointInTimeFundamentals: false, liveRulesChanged: false },
    variants: VARIANTS, cells,
  }, null, 2));
  console.log(`Wrote ${OUTPUT}`);
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
