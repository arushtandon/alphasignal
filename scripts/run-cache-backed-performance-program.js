#!/usr/bin/env node
'use strict';

/**
 * Cache-backed Parts B--E runner. This is research-only: statement reads are
 * local, and the only live-engine seam used is backtestSignal's existing
 * decision-date fundamentalsAt/fmpAt injection.
 */
process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const assert = require('node:assert/strict');
process.chdir(path.join(__dirname, '..'));

const {
  backtestSignal, buildMarketRegime, dailyToWeeklyBars, fetchOHLCV,
} = require('../server');
const { STATIC_GROUPS } = require('../universe');
const { scoreAtDecision } = require('../lib/research/pit-quality');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { summarizeReturns } = require('../lib/research/performance');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');

const args = Object.fromEntries(process.argv.slice(2).filter(v => v.startsWith('--')).map(v => {
  const [key, value] = v.slice(2).split('=');
  return [key, value || '1'];
}));
const ROOT = process.cwd();
const PARENT_CPU_SLOTS = os.availableParallelism?.() || os.cpus().length;
const CPU_RESERVE = 2;
const CACHE_ROOT = path.join(ROOT, 'data', 'research', 'fmp');
const US_UNIVERSE_SNAPSHOT = loadUsUniverseSnapshot(CACHE_ROOT);
const FX_CACHE_ROOT = path.join(ROOT, 'data', 'research', 'fx');
const OUTPUT = path.resolve(ROOT, args.output || 'scripts/cache-backed-performance-program-results.json');
const READOUT = path.resolve(ROOT, args.readout || 'scripts/cache-backed-performance-program-readout.md');
const CHECKPOINT = path.resolve(ROOT, args.checkpoint || 'scripts/cache-backed-performance-program-checkpoint.json');
const RANGE = args.range || '10y';
const PER_MARKET = Math.max(0, Number(args.perMarket) || 0); // 0 means full cached universe.
const NOTIONAL = Math.max(1000, Number(args.notional) || 10000);
const WORKERS = Math.max(1, Math.min(
  Math.max(1, PARENT_CPU_SLOTS - CPU_RESERVE),
  Number(args.workers) || Math.max(1, PARENT_CPU_SLOTS - CPU_RESERVE),
));
const RETRY_BASE_MS = Math.max(50, Number(args.retryBaseMs) || 500);
const RETRY_ATTEMPTS = Math.max(1, Number(args.retryAttempts) || 5);
const WORKER_EPIPE_RETRIES = Math.max(0, Math.min(10, Number(args.workerEpipeRetries) || 3));
const WORKER_EPIPE_RETRY_BASE_MS = Math.max(25, Number(args.workerEpipeRetryBaseMs) || 250);
const WORKER_EPIPE_RETRY_MAX_MS = Math.max(WORKER_EPIPE_RETRY_BASE_MS, Number(args.workerEpipeRetryMaxMs) || 4000);
const STAGE = String(args.stage || 'all').toLowerCase();
if (!['1', '2', 'all'].includes(STAGE)) throw new Error('--stage must be 1, 2, or all');
const AGGREGATE_ONLY = args.aggregateOnly === '1';
const STAGE2_REVIEW_APPROVED = args.stage2AfterStage1Review === '1';
const RERUN_STAGE2_HORIZON = args.rerunStage2Horizon || null;
const BRIDGE_LOG_DIR = path.join(ROOT, 'ibkr-bridge', 'logs');
const WORKER_ROOT = path.resolve(ROOT, args.workerRoot || `${path.relative(ROOT, CHECKPOINT)}.workers`);
const FOLDS = 4;
const EMBARGO = { short: 20, medium: 63, long: 180 };
const HORIZONS = ['short', 'medium', 'long'];
const UNIVERSES = {
  US: US_UNIVERSE_SNAPSHOT.candidateSymbols,
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)],
  'Hong Kong': [...new Set(STATIC_GROUPS.HSI)],
  UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)],
  France: [...new Set(STATIC_GROUPS.CAC40)],
};
const REQUESTED_MARKETS = args.markets
  ? args.markets.split(',').map(value => value.trim()).filter(Boolean)
  : Object.keys(UNIVERSES);
const REQUESTED_SYMBOLS = args.symbols
  ? new Set(args.symbols.split(',').map(value => value.trim()).filter(Boolean))
  : null;
const ACTIVE_UNIVERSES = Object.fromEntries(REQUESTED_MARKETS.map(market => {
  if (!UNIVERSES[market]) throw new Error(`Unknown market "${market}". Expected one of: ${Object.keys(UNIVERSES).join(', ')}`);
  return [market, UNIVERSES[market]];
}));
const BENCHMARK = { US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH', UK: 'EWU', Germany: 'EWG', France: 'EWQ' };
const LISTING = {
  US: { currency: 'USD', scale: 1 },
  Japan: { currency: 'JPY', scale: 1 },
  'Hong Kong': { currency: 'HKD', scale: 1 },
  UK: { currency: 'GBP', scale: 0.01 }, // Yahoo LSE prices are GBp.
  Germany: { currency: 'EUR', scale: 1 },
  France: { currency: 'EUR', scale: 1 },
};
const FX_SPECS = {
  GBP: { direct: ['GBPUSD=X'], inverse: [] },
  EUR: { direct: ['EURUSD=X'], inverse: [] },
  HKD: { direct: ['HKDUSD=X'], inverse: ['USDHKD=X', 'USDKHD=X'] },
  JPY: { direct: ['JPYUSD=X'], inverse: ['USDJPY=X'] },
};

function dateOf(bar) {
  const n = Number(bar?.t);
  return n ? new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10) : null;
}
function inResearchUniverse(market, symbol, date) {
  return market !== 'US' || membershipAt(US_UNIVERSE_SNAPSHOT, date).has(symbol);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function cacheName(symbol) { return symbol.replace(/[^A-Za-z0-9]+/g, '_'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function msSince(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function timing(ms) { return +ms.toFixed(1); }
function latestBridgeLog() {
  if (!fs.existsSync(BRIDGE_LOG_DIR)) return null;
  return fs.readdirSync(BRIDGE_LOG_DIR)
    .filter(file => /^bridge-\d{4}-\d{2}-\d{2}\.log$/.test(file))
    .sort().at(-1) || null;
}
async function pauseForBridgeHealth() {
  const file = latestBridgeLog();
  if (!file) return;
  const full = path.join(BRIDGE_LOG_DIR, file);
  const size = fs.statSync(full).size;
  const tail = fs.readFileSync(full, 'utf8').slice(Math.max(0, size - 65536));
  const failures = /(connection (?:closed|lost|refused|reset)|not connected|socket.*(?:closed|error)|timing.*(?:fail|error|out)|timeout|pacing violation)/i;
  if (!failures.test(tail)) return;
  const pauseMs = Math.max(1000, Number(args.bridgePauseMs) || 30000);
  console.warn(`Bridge-health pause: ${file} contains a recent connection/timing failure; waiting ${Math.round(pauseMs / 1000)}s.`);
  await sleep(pauseMs);
}
async function fetchPriceWithRetry(symbol, range = RANGE, interval = '1d') {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    await pauseForBridgeHealth();
    try {
      const bars = await fetchOHLCV(symbol, range, interval);
      if (Array.isArray(bars) && bars.length) return bars;
      lastError = new Error('empty price response');
    } catch (error) {
      lastError = error;
    }
    if (attempt < RETRY_ATTEMPTS) {
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`Price retry ${attempt}/${RETRY_ATTEMPTS} for ${symbol}: ${lastError.message}; waiting ${delay}ms.`);
      await sleep(delay);
    }
  }
  console.warn(`Price unavailable for ${symbol} after ${RETRY_ATTEMPTS} attempts: ${lastError?.message || 'unknown error'}.`);
  return null;
}
function readCheckpoint() {
  try { return readJson(CHECKPOINT); } catch (_) { return { version: 1, symbols: {}, timings: {} }; }
}
function writeCheckpoint(checkpoint) {
  fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
  const temp = `${CHECKPOINT}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`);
  // Windows can transiently hold the destination open (Defender/indexing and
  // editors commonly do this). Retain atomic replacement and retry rather than
  // losing a completed worker checkpoint after its result was acknowledged.
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      fs.renameSync(temp, CHECKPOINT);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === 20) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { fs.unlinkSync(temp); } catch (_) { /* preserve original checkpoint */ }
  throw lastError;
}
function reportProgress(progress, completed, total) {
  const elapsedMs = msSince(progress.started);
  const average = completed ? elapsedMs / completed : 0;
  const etaMs = completed >= 20 ? average * (total - completed) : null;
  const eta = etaMs == null ? 'learning first 20 symbols' : `ETA ${Math.ceil(etaMs / 60000)}m`;
  console.log(`[progress] ${completed}/${total} symbols; elapsed ${(elapsedMs / 60000).toFixed(1)}m; ${eta}`);
}
async function assertGoldenExitReplay(context, market, horizon, marketSeries, provider, entryIndexes, timingCollector) {
  if (args.golden !== context.symbol) return;
  const defaultTime = horizon === 'short' ? 5 : horizon === 'medium' ? 15 : 40;
  const variant = exitVariants(horizon).find(row => row.tp1R == null && row.stopCapPct == null && row.timeBars === defaultTime && row.tp1Only);
  const common = {
    symbol: context.symbol, market, marketSeries, windowBars: context.bars.length, entryStep: 2,
    allowOverlapping: true, closedOnly: true, stopFirst: true, fundamentalsAt: provider,
    researchExitVariant: variant, timingCollector,
  };
  const slow = await backtestSignal(context.bars, horizon, dailyToWeeklyBars(context.bars), null, common);
  const optimized = await backtestSignal(context.bars, horizon, dailyToWeeklyBars(context.bars), null, {
    ...common, entryIndexes,
  });
  assert.deepStrictEqual(optimized, slow, `golden exit replay diverged for ${context.symbol} ${horizon}`);
  console.log(`Golden equality passed: ${context.symbol} ${horizon} slow === optimized.`);
}
function asPriceMap(bars, inverse = false) {
  const map = new Map();
  for (const bar of bars || []) {
    const date = dateOf(bar);
    const close = Number(bar?.c);
    if (!date || !(close > 0)) continue;
    map.set(date, inverse ? 1 / close : close);
  }
  return map;
}
async function fetchCachedFx(symbol) {
  const file = path.join(FX_CACHE_ROOT, `${cacheName(symbol)}.json`);
  if (fs.existsSync(file)) {
    try {
      const cached = readJson(file);
      if (Array.isArray(cached.bars) && cached.bars.length) return { bars: cached.bars, source: symbol, cached: true };
    } catch (_) { /* refetch malformed cache */ }
  }
  const bars = await fetchPriceWithRetry(symbol, RANGE, '1d');
  if (!Array.isArray(bars) || !bars.length) return null;
  fs.mkdirSync(FX_CACHE_ROOT, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ symbol, range: RANGE, fetchedAt: new Date().toISOString(), bars }, null, 2)}\n`);
  return { bars, source: symbol, cached: false };
}
async function loadFxRates(currencies = Object.keys(FX_SPECS)) {
  const rates = new Map([['USD', new Map()]]);
  const provenance = {};
  for (const currency of currencies) {
    const spec = FX_SPECS[currency];
    if (!spec) continue;
    let loaded = null;
    for (const symbol of spec.direct) {
      loaded = await fetchCachedFx(symbol);
      if (loaded) {
        rates.set(currency, asPriceMap(loaded.bars));
        provenance[currency] = { source: loaded.source, inverse: false, cached: loaded.cached, bars: loaded.bars.length };
        break;
      }
    }
    if (loaded) continue;
    for (const symbol of spec.inverse) {
      loaded = await fetchCachedFx(symbol);
      if (loaded) {
        rates.set(currency, asPriceMap(loaded.bars, true));
        provenance[currency] = { source: loaded.source, inverse: true, cached: loaded.cached, bars: loaded.bars.length };
        break;
      }
    }
    if (!loaded) provenance[currency] = { source: null, unavailable: true };
  }
  return {
    provenance,
    workerEntries: Object.fromEntries([...rates.entries()].map(([currency, values]) => [currency, [...values.entries()]])),
    at(currency, date) {
      const code = String(currency || '').toUpperCase();
      if (code === 'USD') return 1;
      return rates.get(code)?.get(date) ?? null;
    },
  };
}
function rowsFor(market, symbol) {
  const dir = path.join(CACHE_ROOT, market, symbol.replace(/\//g, '_2F'));
  const read = endpoint => {
    const file = path.join(dir, `${endpoint}.json`);
    if (!fs.existsSync(file)) return [];
    const record = readJson(file);
    return record.status === 'OK' && Array.isArray(record.rows) ? record.rows : [];
  };
  return { incomeStatements: read('income'), balanceSheets: read('balance'), cashFlowStatements: read('cashflow') };
}
function statementCurrency(arrays) {
  return String(arrays.balanceSheets[0]?.reportedCurrency || arrays.incomeStatements[0]?.reportedCurrency || '').toUpperCase();
}
function metric(trades) {
  const rows = trades || [];
  const summary = summarizeReturns(rows.map(row => row.ret));
  const wins = rows.filter(row => row.ret > 0).length;
  const losses = rows.filter(row => row.ret <= 0).length;
  const grossWinReturn = rows.filter(row => row.ret > 0).reduce((s, row) => s + row.ret, 0);
  const grossLossReturn = rows.filter(row => row.ret <= 0).reduce((s, row) => s + Math.abs(row.ret), 0);
  const averageWin = wins ? grossWinReturn / wins * 100 : null;
  const averageLoss = losses ? -grossLossReturn / losses * 100 : null;
  return {
    trades: summary.trades, wins, winRate: summary.winRate, profitFactor: summary.profitFactor,
    pnlUsd: +(rows.reduce((sum, row) => sum + row.ret * NOTIONAL, 0)).toFixed(2),
    averageWinPct: averageWin == null ? null : +averageWin.toFixed(3),
    averageLossPct: averageLoss == null ? null : +averageLoss.toFixed(3),
    grossWinReturn: +grossWinReturn.toFixed(8),
    grossLossReturn: +grossLossReturn.toFixed(8),
  };
}
function metricDelta(value, baseline) {
  const difference = field => Number.isFinite(value?.[field]) && Number.isFinite(baseline?.[field])
    ? +(value[field] - baseline[field]).toFixed(3)
    : null;
  return {
    trades: difference('trades'),
    winRate: difference('winRate'),
    profitFactor: difference('profitFactor'),
    pnlUsd: difference('pnlUsd'),
    averageWinPct: difference('averageWinPct'),
    averageLossPct: difference('averageLossPct'),
  };
}
function combineMetrics(metrics) {
  const trades = metrics.reduce((sum, row) => sum + (row?.trades || 0), 0);
  const wins = metrics.reduce((sum, row) => sum + (row?.wins || 0), 0);
  const grossWinReturn = metrics.reduce((sum, row) => sum + (row?.grossWinReturn || 0), 0);
  const grossLossReturn = metrics.reduce((sum, row) => sum + (row?.grossLossReturn || 0), 0);
  const pnlUsd = metrics.reduce((sum, row) => sum + (row?.pnlUsd || 0), 0);
  const losses = trades - wins;
  return {
    trades, wins,
    winRate: trades ? +(wins / trades * 100).toFixed(1) : null,
    profitFactor: trades ? +(grossLossReturn ? grossWinReturn / grossLossReturn : 99).toFixed(3) : null,
    pnlUsd: +pnlUsd.toFixed(2),
    averageWinPct: wins ? +(grossWinReturn / wins * 100).toFixed(3) : null,
    averageLossPct: losses ? +(-grossLossReturn / losses * 100).toFixed(3) : null,
    grossWinReturn: +grossWinReturn.toFixed(8),
    grossLossReturn: +grossLossReturn.toFixed(8),
  };
}
function inRange(row, range) {
  return row.signalDate >= range.from && row.signalDate <= range.to;
}
function exactBinomialTail(wins, trials) {
  if (!(trials > 0)) return null;
  let term = Math.pow(0.5, trials);
  let cumulative = term;
  for (let k = 1; k < wins; k++) {
    term *= (trials - k + 1) / k;
    cumulative += term;
  }
  return Math.min(1, +(1 - cumulative).toPrecision(8));
}
function pValue(metrics) {
  return metrics.trades ? exactBinomialTail(metrics.wins, metrics.trades) : null;
}
function promotion(metrics, development) {
  const stable = development.filter(fold => fold.metrics.pnlUsd > 0 && fold.metrics.profitFactor >= 1.3).length >= 2;
  const p = pValue(metrics);
  const base = metrics.winRate >= 60 && metrics.profitFactor >= 1.3 && metrics.pnlUsd > 0 && stable;
  if (metrics.trades >= 30) return { confidence: 'FULL', eligible: base, pValue: p };
  if (metrics.trades >= 15) {
    return { confidence: 'THIN', eligible: base && metrics.profitFactor >= 1.6 && p != null && p < 0.05, pValue: p };
  }
  return { confidence: 'INSUFFICIENT', eligible: false, pValue: p };
}
function coverageSummary(counters) {
  const total = counters.decisions || 0;
  return {
    decisions: total,
    piotroskiUsable: counters.pio || 0,
    fullGateUsable: counters.full || 0,
    piotroskiPct: total ? +((counters.pio || 0) / total * 100).toFixed(1) : 0,
    fullGatePct: total ? +((counters.full || 0) / total * 100).toFixed(1) : 0,
    unavailable: counters.unavailable || 0,
    missingFxOrCurrencyParity: counters.currency || 0,
  };
}
function applyBh(cells) {
  const tested = cells.filter(cell => cell.tested && cell.holdout?.trades > 0);
  const ranked = tested.map(cell => ({ cell, p: pValue(cell.holdout) ?? 1 })).sort((a, b) => a.p - b.p);
  let maxRank = 0;
  ranked.forEach((row, index) => { if (row.p <= 0.05 * (index + 1) / ranked.length) maxRank = index + 1; });
  for (const cell of cells) {
    if (!cell.tested) { cell.bhStatus = 'NOT_EVALUABLE_NOT_TESTED'; continue; }
    const rank = ranked.findIndex(row => row.cell === cell);
    cell.bhStatus = rank >= 0 && rank < maxRank ? 'BH_PASS_0.05' : 'BH_FAIL_0.05';
    if (cell.promotion) cell.promotion.eligible = cell.promotion.eligible && cell.bhStatus === 'BH_PASS_0.05';
  }
}
function applyBhPartD(cells) {
  // Part D is a threshold family (Piotroski >=5, >=6, >=7). Correcting it
  // separately prevents unrelated Parts B/E or exit variants from silently
  // changing the threshold-family conclusion.
  const family = cells.filter(cell => cell.tested && cell.part === 'D' && cell.holdout?.trades > 0);
  const ranked = family.map(cell => ({ cell, p: pValue(cell.holdout) ?? 1 })).sort((a, b) => a.p - b.p);
  let maxRank = 0;
  ranked.forEach((row, index) => { if (row.p <= 0.05 * (index + 1) / ranked.length) maxRank = index + 1; });
  for (const cell of cells.filter(cell => cell.part === 'D')) {
    const rank = ranked.findIndex(row => row.cell === cell);
    cell.bhPartDStatus = !cell.tested ? 'NOT_EVALUABLE_NOT_TESTED'
      : rank >= 0 && rank < maxRank ? 'BH_PART_D_PASS_0.05' : 'BH_PART_D_FAIL_0.05';
  }
}
function applyBhStage2(cells) {
  const family = cells.filter(cell => cell.tested && cell.part === 'C' && cell.holdout?.trades > 0);
  const ranked = family.map(cell => ({ cell, p: pValue(cell.holdout) ?? 1 })).sort((a, b) => a.p - b.p);
  let maxRank = 0;
  ranked.forEach((row, index) => { if (row.p <= 0.05 * (index + 1) / ranked.length) maxRank = index + 1; });
  for (const cell of cells.filter(cell => cell.part === 'C')) {
    const rank = ranked.findIndex(row => row.cell === cell);
    cell.bhStage2Status = !cell.tested ? 'NOT_EVALUABLE_NOT_TESTED'
      : rank >= 0 && rank < maxRank ? 'BH_STAGE2_PASS_0.05' : 'BH_STAGE2_FAIL_0.05';
    if (cell.promotion) cell.promotion.eligible = cell.promotion.eligible && cell.bhStage2Status === 'BH_STAGE2_PASS_0.05';
  }
}
function compareCells(a, b) {
  const eligible = Number(Boolean(b.promotion?.eligible)) - Number(Boolean(a.promotion?.eligible));
  if (eligible) return eligible;
  const pnl = (b.holdout?.pnlUsd || 0) - (a.holdout?.pnlUsd || 0);
  if (pnl) return pnl;
  const pf = (b.holdout?.profitFactor ?? -Infinity) - (a.holdout?.profitFactor ?? -Infinity);
  if (pf) return pf;
  const winRate = (b.holdout?.winRate ?? -Infinity) - (a.holdout?.winRate ?? -Infinity);
  if (winRate) return winRate;
  const trades = (b.holdout?.trades || 0) - (a.holdout?.trades || 0);
  if (trades) return trades;
  return [
    a.part, a.variant || a.gate || '', a.market, a.horizon, a.side,
  ].join('|').localeCompare([
    b.part, b.variant || b.gate || '', b.market, b.horizon, b.side,
  ].join('|'));
}
function stage1Cells(cells) {
  return cells.filter(cell => cell.tested && cell.part !== 'C' && cell.parity === 'PRIMARY_EXACT');
}
function formatMetric(value, suffix = '') {
  return Number.isFinite(value) ? `${value}${suffix}` : '—';
}
function configLabel(cell) {
  return cell?.gate || cell?.variant || '—';
}
function renderStage1Summary(cells) {
  const rows = [];
  for (const market of Object.keys(ACTIVE_UNIVERSES)) for (const horizon of HORIZONS) for (const side of ['buy', 'sell']) {
    const options = stage1Cells(cells)
      .filter(cell => cell.market === market && cell.horizon === horizon && cell.side === side)
      .sort(compareCells);
    const selected = options[0];
    const holdout = selected?.holdout || {};
    const coverage = selected?.coverage || {};
    rows.push([
      market,
      horizon,
      side,
      selected?.promotion?.eligible ? `PASS — ${configLabel(selected)}` : 'FAIL',
      formatMetric(holdout.winRate, '%'),
      formatMetric(holdout.profitFactor),
      formatMetric(holdout.pnlUsd, ' USD'),
      selected?.promotion?.confidence || '—',
      `${holdout.trades ?? 0} trades`,
      `${formatMetric(coverage.fullGatePct, '%')} (${coverage.fullGateUsable ?? 0}/${coverage.decisions ?? 0})`,
      selected ? `${selected.part}; ${selected.status}` : 'No Stage 1 cell',
    ]);
  }
  return [
    '| Geography | Horizon | Side | Result / best passing config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) | Basis |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}
function renderRankedStage1List(cells, limit = 30) {
  const ranked = stage1Cells(cells).sort(compareCells).slice(0, limit);
  if (!ranked.length) return 'No evaluated primary-parity Stage 1 configurations.';
  return [
    '| Rank | Result | Geography | Horizon | Side | Part | Config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) |',
    '| ---: | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |',
    ...ranked.map((cell, index) => {
      const holdout = cell.holdout || {};
      const coverage = cell.coverage || {};
      return `| ${index + 1} | ${cell.promotion?.eligible ? 'PASS' : 'FAIL'} | ${cell.market} | ${cell.horizon} | ${cell.side} | ${cell.part} | ${configLabel(cell)} | ${formatMetric(holdout.winRate, '%')} | ${formatMetric(holdout.profitFactor)} | ${formatMetric(holdout.pnlUsd, ' USD')} | ${cell.promotion?.confidence || '—'} | ${holdout.trades ?? 0} trades | ${formatMetric(coverage.fullGatePct, '%')} (${coverage.fullGateUsable ?? 0}/${coverage.decisions ?? 0}) |`;
    }),
  ].join('\n');
}
function foldResult(events, folds, selector = () => true) {
  const development = folds.slice(0, -1).map(fold => ({
    fold: fold.fold, validation: metric(events.filter(row => selector(row) && inRange(row, fold.validation))),
    metrics: metric(events.filter(row => selector(row) && inRange(row, fold.test))),
  }));
  const developmentWindows = folds.slice(0, -1).map(fold => fold.test);
  const pooledEvents = events.filter(row => selector(row)
    && developmentWindows.some(window => inRange(row, window)));
  const pooledByYear = {};
  for (const row of pooledEvents) {
    const year = String(row.signalDate || '').slice(0, 4);
    if (year) (pooledByYear[year] ||= []).push(row);
  }
  return {
    development,
    // Test windows are date-aligned and non-overlapping. This pooled summary
    // is development-only; the final fold remains an untouched holdout.
    pooled: metric(pooledEvents),
    pooledCalendarWindows: developmentWindows,
    pooledPerYear: Object.fromEntries(Object.entries(pooledByYear)
      .map(([year, rows]) => [year, metric(rows)])),
    holdout: metric(events.filter(row => selector(row) && inRange(row, folds.at(-1).test))),
  };
}
function statusFor(result, preliminary) {
  if (!result.holdout.trades) return 'INSUFFICIENT_NO_HOLDOUT_TRADES';
  if (result.holdout.winRate >= 60 && result.holdout.profitFactor < 1.3) return 'REJECTED_BLEEDER';
  if (preliminary) return 'SAMPLED_PRELIMINARY_NOT_PROMOTABLE';
  return result.holdout.trades < 15 ? 'INSUFFICIENT_SAMPLE' : 'EXECUTED';
}
function exitVariants(horizon) {
  const stopCapPct = horizon === 'short' ? 0.04 : horizon === 'medium' ? 0.08 : 0.12;
  const timeBars = horizon === 'short' ? [5, 10] : horizon === 'medium' ? [15, 30] : [40, 80];
  const variants = [];
  for (const tp1R of [null, 0.75, 1, 1.25]) {
    for (const cap of [null, stopCapPct]) {
      for (const time of timeBars) {
        for (const tp1Only of [true, false]) {
          const tp = tp1R == null ? 'CURRENT' : `${tp1R.toFixed(2)}R`;
          const capLabel = cap == null ? 'NONE' : `${Math.round(cap * 100)}PCT`;
          variants.push({
            id: `TP1_${tp}_CAP_${capLabel}_TIME_${time}_MODE_${tp1Only ? 'TP1_ONLY' : '50_50_TP2'}`,
            tp1R, stopCapPct: cap, timeBars: time, tp1Only,
            violatesCurrentTp1MinRr: tp1R != null && tp1R < 1.1,
          });
        }
      }
    }
  }
  return variants;
}
function fScore(row) { return Number.isFinite(row?.quality?.piotroski) ? row.quality.piotroski : null; }
function structuralSell(row) {
  const i = row?.signalIndex;
  const context = row?.context;
  const bars = context?.bars;
  const benchmark = context?.benchmarkBars;
  if (!Number.isInteger(i) || i < 200 || !Array.isArray(bars) || !Array.isArray(benchmark)) return false;
  const closes = bars.slice(i - 199, i + 1).map(bar => bar.c);
  if (closes.length !== 200 || !closes.every(Number.isFinite)) return false;
  const ma200 = closes.reduce((a, b) => a + b, 0) / 200;
  const changes = closes.slice(-3).map((value, index, values) => index ? value - values[index - 1] : null).slice(1);
  const up = changes.filter(value => value > 0).reduce((a, b) => a + b, 0) / 2;
  const down = changes.filter(value => value < 0).reduce((a, b) => a + Math.abs(b), 0) / 2;
  const rsi2 = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  const latest20 = closes.slice(-20);
  const mean = latest20.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(latest20.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
  const benchmarkIndex = context.benchmarkIndex instanceof Map
    ? context.benchmarkIndex
    : new Map(benchmark.map((bar, index) => [dateOf(bar), index]));
  const benchIndex = benchmarkIndex.get(row.signalDate);
  if (benchIndex == null || benchIndex < 200) return false;
  const benchmarkMa200 = benchmark.slice(benchIndex - 199, benchIndex + 1)
    .reduce((sum, bar) => sum + bar.c, 0) / 200;
  const tideDown = benchmark[benchIndex].c < benchmarkMa200;
  return bars[i].c < ma200 && tideDown && (rsi2 > 95 || bars[i].c > mean + 2 * sd);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
function taskId(...parts) {
  return parts.join('__').replace(/[^A-Za-z0-9_.-]+/g, '_');
}
function serializableFx(fx) {
  // FX is intentionally carried with each worker task so workers never touch
  // a shared cache or a live data source while replaying.
  return fx.workerEntries;
}
function makeFxAt(fxEntries) {
  const maps = new Map(Object.entries(fxEntries || {}).map(([currency, rows]) => [currency, new Map(rows)]));
  return (currency, date) => String(currency || '').toUpperCase() === 'USD' ? 1 : (maps.get(String(currency || '').toUpperCase())?.get(date) ?? null);
}
function addCounters(target, source) {
  for (const [kind, values] of Object.entries(source || {})) {
    target[kind] ||= {};
    for (const [key, value] of Object.entries(values || {})) target[kind][key] = (target[kind][key] || 0) + value;
  }
}
function normalizeContext(context) {
  return {
    ...context,
    benchmarkIndex: new Map((context.benchmarkBars || []).map((bar, index) => [dateOf(bar), index])),
  };
}
async function runStage1Task(task) {
  const listing = LISTING[task.market];
  const [benchmarkBars, bars] = await Promise.all([
    fetchPriceWithRetry(BENCHMARK[task.market], RANGE, '1d'),
    fetchPriceWithRetry(task.symbol, RANGE, '1d'),
  ]);
  if (!Array.isArray(benchmarkBars) || !benchmarkBars.length) {
    return {
      outcome: 'price_failure',
      reason: `benchmark ${BENCHMARK[task.market]} price history unavailable`,
    };
  }
  if (!Array.isArray(bars) || bars.length < 1400) {
    return {
      outcome: 'price_failure',
      reason: Array.isArray(bars)
        ? `${task.symbol} has only ${bars.length} daily bars (requires 1400)`
        : `${task.symbol} price history unavailable`,
    };
  }
  const arrays = rowsFor(task.market, task.symbol);
  if (!arrays.incomeStatements.length || !arrays.balanceSheets.length || !arrays.cashFlowStatements.length) {
    return {
      outcome: 'price_failure',
      reason: `${task.symbol} statement cache is incomplete`,
    };
  }
  // Each bounded worker owns its relevant FX cache/live retry context. The
  // parent never serially fetches market data before dispatching Stage 1.
  const fx = await loadFxRates([listing.currency]);
  const context = normalizeContext({
    market: task.market, symbol: task.symbol, bars, arrays, benchmarkBars,
  });
  const marketSeries = buildMarketRegime(context.benchmarkBars);
  const fxAt = makeFxAt(fx.workerEntries);
  const counters = { primary: {}, secondary: {} };
  const qualityByIndex = { primary: new Map(), secondary: new Map() };
  const provider = (kind, countCoverage = true) => ({ index, bar }) => {
    const counter = counters[kind];
    if (countCoverage) counter.decisions = (counter.decisions || 0) + 1;
    const quality = scoreAtDecision(context.arrays, {
      market: context.market, decisionDate: dateOf(bar), close: bar.c, listingCurrency: listing.currency,
      listingPriceScale: listing.scale, fxAt,
    });
    if (countCoverage) {
      if (Number.isFinite(quality.piotroski)) counter.pio = (counter.pio || 0) + 1;
      if (quality.usable) counter.full = (counter.full || 0) + 1;
      else counter.unavailable = (counter.unavailable || 0) + 1;
      if (quality.reason === 'MISSING_SAME_DATE_FX') counter.currency = (counter.currency || 0) + 1;
    }
    const fmp = kind === 'secondary'
      ? (Number.isFinite(quality.piotroski) ? { piotroski: quality.piotroski } : null)
      : (quality.usable ? quality : null);
    qualityByIndex[kind].set(index, fmp);
    return { fmp };
  };
  const eventSets = { baseline: { buy: [], sell: [] }, primary: { buy: [], sell: [] }, secondary: { buy: [], sell: [] }, structuralSell: [] };
  const primaryEntries = { buy: new Map(), sell: new Map() };
  const timingCollector = { signalEntryDecisionMs: 0, exitSimulationMs: 0 };
  for (const kind of ['baseline', 'primary', 'secondary']) {
    const result = await backtestSignal(context.bars, task.horizon, dailyToWeeklyBars(context.bars), null, {
      symbol: context.symbol, market: context.market, marketSeries, windowBars: context.bars.length, entryStep: 2,
      allowOverlapping: true, closedOnly: true, stopFirst: true, timingCollector,
      ...(kind === 'baseline' ? {} : { fundamentalsAt: provider(kind), captureEntryCandidates: kind === 'primary' }),
    });
    for (const trade of result?.tradeResults || []) {
      const row = { ...trade, signalDate: dateOf(context.bars[trade.signalIndex]) };
      if (!inResearchUniverse(context.market, context.symbol, row.signalDate)) continue;
      if (kind !== 'baseline') row.quality = qualityByIndex[kind].get(trade.signalIndex) || null;
      eventSets[kind][trade.side].push(row);
    }
    if (kind === 'primary') for (const candidate of result?.entryCandidates || []) {
      if (inResearchUniverse(context.market, context.symbol, dateOf(context.bars[candidate.signalIndex]))) {
        primaryEntries[candidate.side].set(candidate.signalIndex, candidate);
      }
    }
  }
  const structural = await backtestSignal(context.bars, task.horizon, dailyToWeeklyBars(context.bars), null, {
    symbol: context.symbol, market: context.market, marketSeries, windowBars: context.bars.length, entryStep: 2,
    allowOverlapping: true, closedOnly: true, stopFirst: true, fundamentalsAt: provider('primary', false), timingCollector,
  });
  for (const trade of structural?.tradeResults || []) {
    const row = { ...trade, signalDate: dateOf(context.bars[trade.signalIndex]) };
    if (inResearchUniverse(context.market, context.symbol, row.signalDate)) eventSets.structuralSell.push(row);
  }
  const entries = { buy: [...primaryEntries.buy.keys()], sell: [...primaryEntries.sell.keys()] };
  await assertGoldenExitReplay(context, context.market, task.horizon, marketSeries, provider('primary', false), new Set([...entries.buy, ...entries.sell]), timingCollector);
  return {
    outcome: 'success',
    context: {
      market: context.market, symbol: context.symbol, bars: context.bars,
      arrays: context.arrays, benchmarkBars: context.benchmarkBars,
    },
    eventSets, entries, counters, timingCollector,
  };
}
async function runStage2Task(task) {
  const context = normalizeContext(task.context);
  const listing = LISTING[context.market];
  // Stage 2 is conditional, but retains the same worker-owned FX context
  // discipline as Stage 1 rather than relying on a parent-side preload.
  const fx = await loadFxRates([listing.currency]);
  const fxAt = makeFxAt(fx.workerEntries);
  const provider = ({ bar }) => {
    const quality = scoreAtDecision(context.arrays, {
      market: context.market, decisionDate: dateOf(bar), close: bar.c, listingCurrency: listing.currency,
      listingPriceScale: listing.scale, fxAt,
    });
    return { fmp: quality.usable ? quality : null };
  };
  const replay = await backtestSignal(context.bars, task.horizon, dailyToWeeklyBars(context.bars), null, {
    symbol: context.symbol, market: context.market, marketSeries: buildMarketRegime(context.benchmarkBars),
    windowBars: context.bars.length, entryStep: 2, allowOverlapping: true, closedOnly: true, stopFirst: true,
    side: task.side, fundamentalsAt: provider, entryIndexes: new Set(task.entryIndexes || []), researchExitVariant: task.variant,
  });
  return {
    events: (replay?.tradeResults || []).map(trade => ({
      ...trade, signalDate: dateOf(context.bars[trade.signalIndex]),
    })).filter(row => inResearchUniverse(context.market, context.symbol, row.signalDate)),
  };
}
async function runWorkerTask() {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* unsupported platform */ }
  const task = readJson(path.resolve(ROOT, args.workerTask));
  const send = message => new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Worker was started without an IPC channel.'));
    process.send(message, error => error ? reject(error) : resolve());
  });
  const waitForAck = () => new Promise(resolve => {
    const timeout = setTimeout(resolve, 10000);
    timeout.unref();
    process.on('message', message => {
      if (message?.type === 'ack' && message.taskId === task.id) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const exitAfterAck = async (message, code) => {
    try {
      await send(message);
      await waitForAck();
    } finally {
      if (process.connected) process.disconnect();
      process.exit(code);
    }
  };
  try {
    let result;
    // Test-only task flag: exercises the parent's child/IPC EPIPE retry path
    // without requiring a real broken Windows named-pipe handle.
    if (task.simulateEpipe && Number(task.attempt || 0) === 0) {
      const error = new Error('simulated worker IPC EPIPE');
      error.code = 'EPIPE';
      throw error;
    }
    if (task.kind === 'stage1') result = await runStage1Task(task);
    else if (task.kind === 'stage2') result = await runStage2Task(task);
    else if (task.kind === 'smoke') { await sleep(25); result = { symbol: task.symbol, pid: process.pid }; }
    else throw new Error(`Unknown worker task kind "${task.kind}".`);
    atomicWrite(task.output, { taskId: task.id, completedAt: new Date().toISOString(), result });
    await exitAfterAck({ type: 'result', taskId: task.id, output: task.output }, 0);
  } catch (error) {
    await exitAfterAck({
      type: 'error',
      taskId: task.id,
      error: { message: error?.message || String(error), code: error?.code || null, stack: error?.stack || null },
    }, 1);
  }
}
function isEpipe(error) {
  return error?.code === 'EPIPE' || /\bEPIPE\b/i.test(String(error?.message || error));
}
function workerEpipeDelay(attempt) {
  return Math.min(WORKER_EPIPE_RETRY_MAX_MS, WORKER_EPIPE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}
function runTasks(tasks, { onCompleted, onFailed } = {}) {
  return new Promise((resolve, reject) => {
    const pending = [...tasks];
    let active = 0;
    let delayedRetries = 0;
    let failure = null;
    const running = new Set();
    const fail = error => {
      if (failure) return;
      failure = error;
      pending.length = 0;
      for (const state of running) if (!state.exited) state.child.kill();
    };
    const finishIfDone = () => {
      if (active) return;
      if (failure) return reject(failure);
      if (!pending.length && !delayedRetries) resolve();
    };
    const retryOrFail = (task, error) => {
      const attempt = Number(task.attempt) || 0;
      if (isEpipe(error) && attempt < WORKER_EPIPE_RETRIES) {
        const nextAttempt = attempt + 1;
        const delay = workerEpipeDelay(nextAttempt);
        console.warn(`Worker EPIPE for ${task.id}; retry ${nextAttempt}/${WORKER_EPIPE_RETRIES} in ${delay}ms.`);
        delayedRetries++;
        setTimeout(() => {
          delayedRetries--;
          pending.unshift({ ...task, attempt: nextAttempt });
          start();
        }, delay);
        return;
      }
      if (isEpipe(error) && onFailed) {
        try {
          onFailed(task, error, attempt);
        } catch (callbackError) {
          fail(callbackError);
          return;
        }
        return;
      }
      fail(error);
    };
    const start = () => {
      finishIfDone();
      while (!failure && active < WORKERS && pending.length) {
        const task = pending.shift();
        atomicWrite(task.file, task);
        active++;
        // Workers report only structured IPC events; their server/bootstrap logs
        // must never flood the parent terminal.
        let child;
        try {
          child = fork(__filename, [`--workerTask=${task.file}`], {
            cwd: ROOT,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: { ...process.env, RESEARCH_MODE: '1', PERFORMANCE_WORKER: '1' },
          });
        } catch (error) {
          active--;
          retryOrFail(task, error);
          continue;
        }
        const state = { task, child, result: null, workerError: null, stderr: '', exited: false, settled: false };
        running.add(state);
        const release = () => {
          if (state.settled) return false;
          state.settled = true;
          running.delete(state);
          active--;
          return true;
        };
        const failAttempt = error => {
          if (!release()) return;
          if (!state.exited) child.kill();
          retryOrFail(task, error);
          start();
        };
        child.stderr?.on('data', chunk => { state.stderr = `${state.stderr}${chunk}`.slice(-8192); });
        child.on('message', message => {
          if (!message || message.taskId !== task.id) return;
          if (message.type === 'result') {
            try {
              const record = readJson(message.output);
              if (record.taskId !== task.id) throw new Error(`Worker ${task.id} returned a mismatched output record.`);
              state.result = record;
              try {
                child.send({ type: 'ack', taskId: task.id }, error => {
                  // The durable result exists and was validated above. A closed
                  // IPC channel at acknowledgement time must not discard it.
                  if (error && !isEpipe(error)) failAttempt(error);
                });
              } catch (error) {
                if (!isEpipe(error)) failAttempt(error);
              }
            } catch (error) {
              failAttempt(error);
            }
          } else if (message.type === 'error') {
            state.workerError = message.error || { message: 'Worker reported an unknown error.' };
            const error = new Error(`Worker failed for ${task.id}: ${state.workerError.message}`);
            error.code = state.workerError.code || null;
            failAttempt(error);
          }
        });
        child.on('error', error => failAttempt(error));
        child.on('exit', (code, signal) => {
          state.exited = true;
          if (!release()) return;
          if (!state.result && !failure) {
            const detail = state.workerError?.message || state.stderr.trim() || 'no result IPC message received';
            const error = new Error(`Worker ${task.id} exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}) without a result: ${detail}`);
            error.code = state.workerError?.code || (/\bEPIPE\b/i.test(detail) ? 'EPIPE' : null);
            retryOrFail(task, error);
          } else if (!failure) {
            // Windows may report STATUS_CONTROL_C_EXIT after a worker has
            // atomically written and IPC-acknowledged its result. The durable
            // result record is the completion authority; rejecting it would
            // unnecessarily discard a resumable research task.
            if (code !== 0 || signal) {
              console.warn(`Worker ${task.id} returned a valid result but exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}); accepting checkpointed result.`);
            }
            try { onCompleted?.(task, state.result); } catch (error) { fail(error); }
          }
          start();
        });
      }
      finishIfDone();
    };
    start();
  });
}
function buildTask(kind, id, payload) {
  const base = path.join(WORKER_ROOT, kind, id);
  return { ...payload, kind, id, file: `${base}.task.json`, output: `${base}.result.json` };
}
async function parallelSmoke() {
  const root = path.join(os.tmpdir(), `alphasignal-parallel-smoke-${process.pid}-${Date.now()}`);
  const tasks = ['SMOKE_A', 'SMOKE_B'].map(symbol => {
    const id = taskId('smoke', symbol);
    const base = path.join(root, id);
    return {
      kind: 'smoke', id, symbol, file: `${base}.task.json`, output: `${base}.result.json`,
      simulateEpipe: args.parallelSmokeEpipe === '1' && symbol === 'SMOKE_A',
    };
  });
  await runTasks(tasks);
  const completed = tasks.map(task => readJson(task.output).result);
  assert.equal(new Set(completed.map(row => row.pid)).size, 2, 'smoke requires two distinct worker processes');
  const resumed = tasks.filter(task => !fs.existsSync(task.output));
  assert.equal(resumed.length, 0, 'resume must skip completed symbol outputs');
  console.log(`Parallel smoke passed: ${completed.map(row => `${row.symbol}@${row.pid}`).join(', ')}; resume skipped ${tasks.length} done symbol(s).`);
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  // This process is deliberately de-prioritized.  The runner is local-only and
  // leaves two logical CPUs free for the bridge/UI; individual replay calls are
  // cooperative (backtestSignal yields every 16 bars).
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* unsupported platform */ }
  const phaseTimings = {};
  const programStarted = process.hrtime.bigint();
  const checkpoint = readCheckpoint();
  const progress = { started: process.hrtime.bigint() };
  const preliminary = PER_MARKET > 0;
  console.log(`Research executor: ${WORKERS} local worker slot(s) from parent CPU capacity ${PARENT_CPU_SLOTS} minus reserve ${CPU_RESERVE}; below-normal priority.`);
  console.log('Progress ETA starts after the first 20 completed symbols.');
  let phaseStarted = process.hrtime.bigint();
  const dataLoadingStarted = phaseStarted;
  const contexts = {};
  let totalSymbols = 0;
  for (const [market, universe] of Object.entries(ACTIVE_UNIVERSES)) {
    const symbols = universe.filter(symbol =>
      (!REQUESTED_SYMBOLS || REQUESTED_SYMBOLS.has(symbol))
      && fs.existsSync(path.join(CACHE_ROOT, market, symbol, 'income.json')),
    );
    const chosen = PER_MARKET ? symbols.slice(0, PER_MARKET) : symbols;
    // Keep this parent-side pass filesystem-only. Price, FX, and statement
    // contexts are loaded by the bounded worker that replays the symbol.
    contexts[market] = { symbols: chosen.map(symbol => ({ market, symbol })), requested: chosen.length };
    totalSymbols += chosen.length;
  }
  phaseTimings.parentTaskPreparation = timing(msSince(phaseStarted));
  phaseTimings.dataLoading = timing(msSince(dataLoadingStarted));
  phaseStarted = process.hrtime.bigint();
  let stage2Ms = 0;
  let stage2Ran = false;
  const stage1Timing = { signalEntryDecisionMs: 0, exitSimulationMs: 0 };

  const cells = [];
  const stage1Tasks = [];
  for (const group of Object.values(contexts)) for (const horizon of HORIZONS) for (const context of group.symbols) {
    const id = taskId(context.market, horizon, context.symbol);
    const task = buildTask('stage1', id, { market: context.market, symbol: context.symbol, horizon });
    const key = `${context.market}|${horizon}|${context.symbol}`;
    if (!(['complete', 'price_failure'].includes(checkpoint.symbols[key]?.stage1) && fs.existsSync(task.output))) stage1Tasks.push(task);
  }
  if (AGGREGATE_ONLY && stage1Tasks.length) {
    throw new Error(`--aggregateOnly refuses symbol replay: ${stage1Tasks.length} Stage 1 worker output(s) are missing or incomplete.`);
  }
  console.log(`Stage 1: dispatching ${stage1Tasks.length} symbol replay(s) across ${WORKERS} local worker process(es).`);
  const scheduled = { completed: 0, total: stage1Tasks.length };
  await runTasks(stage1Tasks, {
    onCompleted(task, record) {
      const key = `${task.market}|${task.horizon}|${task.symbol}`;
      const result = record.result;
      checkpoint.symbols[key] = {
        market: task.market, horizon: task.horizon, symbol: task.symbol,
        stage1: result.outcome === 'success' ? 'complete' : 'price_failure',
        reason: result.reason || null, completedAt: new Date().toISOString(),
      };
      writeCheckpoint(checkpoint);
      scheduled.completed++;
      reportProgress(progress, scheduled.completed, scheduled.total);
    },
    onFailed(task, error, retries) {
      const key = `${task.market}|${task.horizon}|${task.symbol}`;
      checkpoint.symbols[key] = {
        market: task.market, horizon: task.horizon, symbol: task.symbol,
        stage1: 'worker_failure',
        reason: error.message,
        workerErrorCode: error.code || null,
        workerEpipeRetries: retries,
        failedAt: new Date().toISOString(),
      };
      writeCheckpoint(checkpoint);
      scheduled.completed++;
      reportProgress(progress, scheduled.completed, scheduled.total);
      console.error(`Stage 1 worker failure checkpointed for ${task.id} after ${retries} EPIPE retry/retries: ${error.message}`);
    },
  });
  const stage1Results = new Map();
  for (const group of Object.values(contexts)) for (const horizon of HORIZONS) for (const context of group.symbols) {
    const task = buildTask('stage1', taskId(context.market, horizon, context.symbol), { market: context.market, symbol: context.symbol, horizon });
    if (!fs.existsSync(task.output)) continue;
    const result = readJson(task.output).result;
    if (result.outcome === 'success') stage1Results.set(`${context.market}|${horizon}|${context.symbol}`, result);
  }
  // A market can only be aggregated when both horizon replays completed with
  // the same locally loaded context. Price failures remain checkpointed but do
  // not make the rest of the bounded run fail.
  for (const group of Object.values(contexts)) {
    group.symbols = group.symbols
      .filter(context => HORIZONS.every(horizon => stage1Results.has(`${context.market}|${horizon}|${context.symbol}`)))
      // Worker output is JSON, so normalize the non-serializable derived index
      // before attaching its context to aggregation event rows.
      .map(context => normalizeContext(stage1Results.get(`${context.market}|medium|${context.symbol}`).context));
    group.benchmarkBars = group.symbols[0]?.benchmarkBars || [];
  }
  for (const [market, group] of Object.entries(contexts)) {
    const benchmark = group.benchmarkBars;
    const timeline = benchmark?.map(dateOf).filter(Boolean) || [];
    for (const horizon of HORIZONS) {
      const folds = buildDateAlignedFolds(timeline, { folds: FOLDS, trainBars: 504, validationBars: 126, testBars: 126, embargoBars: EMBARGO[horizon] });
      if (folds.length !== FOLDS || !group.symbols.length) {
        for (const part of (horizon === 'short' ? ['B', 'C'] : ['B', 'C', 'D', 'E'])) for (const side of ['buy', 'sell']) {
          cells.push({ part, market, horizon, side, tested: false, status: 'BLOCKED_INSUFFICIENT_PRICE_HISTORY_OR_UNIVERSE', reason: 'No date-aligned 504/126/126 folds or no cached-universe symbol with sufficient daily history.', coverage: coverageSummary({}) });
        }
        continue;
      }
      const marketSeries = buildMarketRegime(benchmark);
      const eventSets = {
        baseline: { buy: [], sell: [] },
        primary: { buy: [], sell: [] },
        secondary: { buy: [], sell: [] },
        structuralSell: [],
      };
      const grid = exitVariants(horizon);
      const counters = { primary: {}, secondary: {} };
      const primaryEntries = { buy: new Map(), sell: new Map() };
      // Workers replay every Stage 1 symbol before any Stage 2 cell is considered.
      // The parent is the sole checkpoint/output aggregator.
      for (const context of group.symbols) {
        const completed = stage1Results.get(`${market}|${horizon}|${context.symbol}`);
        context.primaryEntries ||= {};
        context.primaryEntries[horizon] = {
          buy: new Set(completed.entries.buy),
          sell: new Set(completed.entries.sell),
        };
        for (const kind of ['baseline', 'primary', 'secondary']) for (const side of ['buy', 'sell']) {
          eventSets[kind][side].push(...completed.eventSets[kind][side].map(row => ({ ...row, context })));
        }
        eventSets.structuralSell.push(...completed.eventSets.structuralSell.map(row => ({ ...row, context })));
        addCounters(counters, completed.counters);
        stage1Timing.signalEntryDecisionMs += completed.timingCollector.signalEntryDecisionMs || 0;
        stage1Timing.exitSimulationMs += completed.timingCollector.exitSimulationMs || 0;
      }
      for (const context of []) {
        const listing = LISTING[market];
        const qualityByIndex = { primary: new Map(), secondary: new Map() };
        const provider = (kind, countCoverage = true) => ({ index, bar }) => {
          const counter = counters[kind];
          if (countCoverage) counter.decisions = (counter.decisions || 0) + 1;
          const decisionDate = dateOf(bar);
          const quality = scoreAtDecision(context.arrays, {
            market, decisionDate, close: bar.c, listingCurrency: listing.currency,
            listingPriceScale: listing.scale, fxAt: fx.at,
          });
          if (countCoverage) {
            if (Number.isFinite(quality.piotroski)) counter.pio = (counter.pio || 0) + 1;
            if (quality.usable) counter.full = (counter.full || 0) + 1;
            else counter.unavailable = (counter.unavailable || 0) + 1;
            if (quality.reason === 'MISSING_SAME_DATE_FX') counter.currency = (counter.currency || 0) + 1;
          }
          const fmp = kind === 'secondary'
            ? (Number.isFinite(quality.piotroski) ? { piotroski: quality.piotroski } : null)
            : (quality.usable ? quality : null);
          qualityByIndex[kind].set(index, fmp);
          return { fmp };
        };
        for (const kind of ['baseline', 'primary', 'secondary']) {
          process.stdout.write(`\rReplaying ${market} ${context.symbol} ${horizon} ${kind}`.padEnd(80));
          const result = await backtestSignal(context.bars, horizon, dailyToWeeklyBars(context.bars), null, {
            symbol: context.symbol, market, marketSeries, windowBars: context.bars.length, entryStep: 2,
            allowOverlapping: true, closedOnly: true, stopFirst: true, timingCollector: stage1Timing,
            ...(kind === 'baseline' ? {} : { fundamentalsAt: provider(kind), captureEntryCandidates: kind === 'primary' }),
          });
          for (const trade of result?.tradeResults || []) {
            const row = { ...trade, signalDate: dateOf(context.bars[trade.signalIndex]), context };
            if (kind !== 'baseline') row.quality = qualityByIndex[kind].get(trade.signalIndex) || null;
            eventSets[kind][trade.side].push(row);
          }
          if (kind === 'primary') {
            for (const candidate of result?.entryCandidates || []) primaryEntries[candidate.side].set(candidate.signalIndex, candidate);
          }
        }
        // Part E deliberately has its own replay. It must not inherit Part B's
        // exit results, because its structural short rule is an independent test.
        process.stdout.write(`\rReplaying ${market} ${context.symbol} ${horizon} Part E`.padEnd(90));
        const structural = await backtestSignal(context.bars, horizon, dailyToWeeklyBars(context.bars), null, {
          symbol: context.symbol, market, marketSeries, windowBars: context.bars.length, entryStep: 2,
          allowOverlapping: true, closedOnly: true, stopFirst: true,
          fundamentalsAt: provider('primary', false), timingCollector: stage1Timing,
        });
        for (const trade of structural?.tradeResults || []) {
          eventSets.structuralSell.push({ ...trade, signalDate: dateOf(context.bars[trade.signalIndex]), context });
        }
        const key = `${market}|${horizon}|${context.symbol}`;
        context.primaryEntries = {
          buy: new Set(primaryEntries.buy.keys()),
          sell: new Set(primaryEntries.sell.keys()),
        };
        await assertGoldenExitReplay(
          context, market, horizon, marketSeries, provider('primary', false),
          new Set([...context.primaryEntries.buy, ...context.primaryEntries.sell]), stage1Timing,
        );
        checkpoint.symbols[key] = { market, horizon, symbol: context.symbol, stage1: 'complete', completedAt: new Date().toISOString() };
        writeCheckpoint(checkpoint);
        reportProgress(progress, Object.keys(checkpoint.symbols).length, totalSymbols * 2);
      }
      for (const side of ['buy', 'sell']) {
        const baseline = foldResult(eventSets.baseline[side], folds);
        for (const kind of ['primary', 'secondary']) {
          const result = foldResult(eventSets[kind][side], folds);
          const cell = {
            part: 'B', market, horizon, side, variant: kind === 'primary' ? 'PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY' : 'PIO_ONLY_NON_PARITY',
            parity: kind === 'primary' ? 'PRIMARY_EXACT' : 'NON_PARITY', tested: true, status: statusFor(result, preliminary),
            coverage: coverageSummary(counters[kind]), baseline: baseline.holdout, ...result,
          };
          cell.promotion = promotion(cell.holdout, cell.development);
          if (preliminary || kind === 'secondary') cell.promotion.eligible = false;
          cells.push(cell);
        }
        if (horizon !== 'short') for (const threshold of [5, 6, 7]) {
          const result = foldResult(eventSets.primary[side], folds, row => fScore(row) >= threshold);
          const cell = {
            part: 'D', market, horizon, side, gate: `Piotroski>=${threshold}`, parity: 'PRIMARY_EXACT',
            tested: true, status: statusFor(result, preliminary), coverage: coverageSummary(counters.primary),
            baseline: baseline.holdout, ...result,
          };
          cell.promotion = promotion(cell.holdout, cell.development);
          if (preliminary) cell.promotion.eligible = false;
          cells.push(cell);
        }
        if (horizon !== 'short' && side === 'sell') {
          for (const [variant, selector] of [['PIT_F_SCORE_LE_3', row => structuralSell(row) && fScore(row) <= 3], ['CONTROL_NO_F_SCORE', structuralSell]]) {
            const result = foldResult(eventSets.structuralSell, folds, row => row.side === 'sell' && selector(row));
            const cell = {
              part: 'E', market, horizon, side, variant, parity: variant === 'PIT_F_SCORE_LE_3' ? 'PRIMARY_EXACT' : 'CONTROL',
              tested: true, status: statusFor(result, preliminary), coverage: coverageSummary(counters.primary),
              baseline: baseline.holdout, ...result,
            };
            cell.promotion = promotion(cell.holdout, cell.development);
            if (preliminary) cell.promotion.eligible = false;
            cells.push(cell);
          }
        }
      }
      if (STAGE === '1' || AGGREGATE_ONLY || !STAGE2_REVIEW_APPROVED) continue;
      // The approved Part C scope is every market's primary-parity BUY ledger;
      // promotion status is an outcome, not an input to the exit experiment.
      const qualifyingSides = new Set(['buy']);
      for (const side of qualifyingSides) {
        const baseline = foldResult(eventSets.primary[side], folds);
        for (const variant of grid) {
          stage2Ran = true;
          const variantStarted = process.hrtime.bigint();
          const stage2Tasks = group.symbols
            .filter(context => (context.primaryEntries?.[horizon]?.[side]?.size || 0) > 0)
            .map(context => buildTask('stage2', taskId(market, horizon, side, variant.id, context.symbol), {
              context, horizon, side, variant,
              entryIndexes: [...(context.primaryEntries?.[horizon]?.[side] || [])],
            }));
          checkpoint.stage2 ||= {};
          const forceVariantRerun = RERUN_STAGE2_HORIZON === horizon;
          await runTasks(stage2Tasks.filter(task => forceVariantRerun
            || !(checkpoint.stage2[task.id]?.complete && fs.existsSync(task.output))));
          const events = stage2Tasks.flatMap(task => readJson(task.output).result.events.map(row => ({ ...row, context: task.context })));
          for (const task of stage2Tasks) checkpoint.stage2[task.id] = { complete: true, market, horizon, side, variant: variant.id, symbol: task.context.symbol, completedAt: new Date().toISOString() };
          writeCheckpoint(checkpoint);
          for (const context of []) {
            const listing = LISTING[market];
            const provider = ({ bar }) => {
              const quality = scoreAtDecision(context.arrays, {
                market, decisionDate: dateOf(bar), close: bar.c, listingCurrency: listing.currency,
                listingPriceScale: listing.scale, fxAt: fx.at,
              });
              return { fmp: quality.usable ? quality : null };
            };
            process.stdout.write(`\rStage 2 ${market} ${context.symbol} ${horizon} ${side} ${variant.id}`.padEnd(120));
            const replay = await backtestSignal(context.bars, horizon, dailyToWeeklyBars(context.bars), null, {
              symbol: context.symbol, market, marketSeries, windowBars: context.bars.length, entryStep: 2,
              allowOverlapping: true, closedOnly: true, stopFirst: true, side,
              fundamentalsAt: provider, entryIndexes: context.primaryEntries?.[horizon]?.[side] || new Set(),
              researchExitVariant: variant,
            });
            for (const trade of replay?.tradeResults || []) {
              events.push({ ...trade, signalDate: dateOf(context.bars[trade.signalIndex]), context });
            }
          }
          const result = foldResult(events, folds);
          const cell = {
            part: 'C', market, horizon, side, variant: variant.id, exitVariant: variant,
            parity: 'PRIMARY_EXACT', tested: true, status: statusFor(result, preliminary),
            coverage: coverageSummary(counters.primary),
            baseline: baseline.holdout,
            baselinePooled: baseline.pooled,
            baselineHoldout: baseline.holdout,
            ...result,
          };
          cell.deltaVsBaseline = {
            pooled: metricDelta(cell.pooled, baseline.pooled),
            holdout: metricDelta(cell.holdout, baseline.holdout),
          };
          cell.promotion = promotion(cell.holdout, cell.development);
          if (preliminary || variant.violatesCurrentTp1MinRr) cell.promotion.eligible = false;
          if (variant.violatesCurrentTp1MinRr) cell.nonPromotableReason = 'TP1 R:R is below the frozen 1.1 minimum.';
          cells.push(cell);
          stage2Ms += msSince(variantStarted);
        }
      }
      if (!qualifyingSides.size) console.log(`Stage 2 ${market} ${horizon}: skipped; no Stage 1 Part B cell qualified.`);
    }
  }
  console.log('');
  const replayMs = msSince(phaseStarted);
  phaseTimings.stage2ExitGrid = timing(stage2Ms);
  phaseTimings.stage1BDE = timing(Math.max(0, replayMs - stage2Ms));
  phaseTimings.stage1SignalEntryDecision = timing(stage1Timing.signalEntryDecisionMs);
  phaseTimings.stage1ExitSimulation = timing(stage1Timing.exitSimulationMs);
  phaseTimings.stage1Other = timing(Math.max(
    0,
    replayMs - stage2Ms - stage1Timing.signalEntryDecisionMs - stage1Timing.exitSimulationMs,
  ));
  phaseStarted = process.hrtime.bigint();
  applyBh(cells);
  applyBhPartD(cells);
  applyBhStage2(cells);
  const stage2Pooled = HORIZONS.flatMap(horizon => [...new Set(cells
    .filter(cell => cell.part === 'C' && cell.side === 'buy' && cell.horizon === horizon)
    .map(cell => cell.variant))].map(variant => {
    const markets = cells.filter(cell => cell.part === 'C' && cell.side === 'buy'
      && cell.horizon === horizon && cell.variant === variant);
    const pooled = combineMetrics(markets.map(cell => cell.pooled));
    const holdout = combineMetrics(markets.map(cell => cell.holdout));
    const baseline = combineMetrics(markets.map(cell => cell.baselinePooled));
    const baselineHoldout = combineMetrics(markets.map(cell => cell.baselineHoldout));
    const harmedFullMarket = markets.some(cell => (cell.pooled?.trades || 0) >= 30
      && ((cell.deltaVsBaseline?.pooled?.pnlUsd || 0) < 0
        || (cell.deltaVsBaseline?.pooled?.profitFactor || 0) < 0));
    return {
      horizon, variant, exitVariant: markets[0]?.exitVariant || null,
      markets: markets.map(cell => ({
        market: cell.market, pooled: cell.pooled, holdout: cell.holdout,
        baseline: cell.baseline,
        baselinePooled: cell.baselinePooled,
        baselineHoldout: cell.baselineHoldout,
        deltaVsBaseline: cell.deltaVsBaseline,
        confidence: cell.promotion?.confidence || null, bhStatus: cell.bhStage2Status || null,
      })),
      pooled, holdout, baseline, baselineHoldout, deltaVsBaseline: {
        pooled: metricDelta(pooled, baseline),
        holdout: metricDelta(holdout, baselineHoldout),
      },
      clearlyHarmsFullMarket: harmedFullMarket,
      violatesCurrentTp1MinRr: markets[0]?.exitVariant?.violatesCurrentTp1MinRr === true,
    };
  }));
  const stage2Bh = stage2Pooled.filter(row => row.holdout.trades > 0)
    .map(row => ({ row, p: pValue(row.holdout) ?? 1 })).sort((a, b) => a.p - b.p);
  let stage2BhMaxRank = 0;
  stage2Bh.forEach((row, index) => {
    if (row.p <= 0.05 * (index + 1) / stage2Bh.length) stage2BhMaxRank = index + 1;
  });
  for (const row of stage2Pooled) {
    const rank = stage2Bh.findIndex(candidate => candidate.row === row);
    row.bhStatus = rank >= 0 && rank < stage2BhMaxRank ? 'BH_STAGE2_POOLED_PASS_0.05' : 'BH_STAGE2_POOLED_FAIL_0.05';
    row.recommended = !row.violatesCurrentTp1MinRr && !row.clearlyHarmsFullMarket
      && row.deltaVsBaseline.pooled.pnlUsd > 0 && row.deltaVsBaseline.pooled.profitFactor > 0
      && row.bhStatus === 'BH_STAGE2_POOLED_PASS_0.05';
  }
  const japanLongBaseline = cells.find(cell => cell.part === 'B' && cell.market === 'Japan'
    && cell.horizon === 'long' && cell.side === 'buy' && cell.parity === 'PRIMARY_EXACT');
  const japanLongExitComparison = [
    { label: 'Live exits', cell: japanLongBaseline, rr: 'LIVE_TP1_RULE' },
    ...[1.25, 1, 0.75].map(tp1R => ({
      label: `${tp1R.toFixed(2)}R / 12% / 80 / 50-50 TP2`,
      cell: cells.find(cell => cell.part === 'C' && cell.market === 'Japan' && cell.horizon === 'long'
        && cell.side === 'buy' && cell.variant === `TP1_${tp1R.toFixed(2)}R_CAP_12PCT_TIME_80_MODE_50_50_TP2`),
      rr: tp1R < 1.1 ? 'VIOLATES_TP1_RR' : 'OK',
    })),
  ].map(row => ({
    label: row.label,
    rr: row.rr,
    development: row.cell?.pooled || null,
    holdout: row.cell?.holdout || null,
    bhStatus: row.cell?.bhStage2Status || row.cell?.bhStatus || null,
  }));
  const candidates = cells.filter(cell => cell.tested && cell.promotion?.eligible)
    .sort((a, b) => b.holdout.pnlUsd - a.holdout.pnlUsd)
    .map(cell => ({ part: cell.part, market: cell.market, horizon: cell.horizon, side: cell.side, variant: cell.variant || cell.gate, holdout: cell.holdout, confidence: cell.promotion.confidence }))
    .slice(0, 20);
  const pooledCandidates = cells.filter(cell => cell.tested && (cell.pooled?.trades || 0) >= 30)
    .sort((a, b) => (b.pooled.pnlUsd || 0) - (a.pooled.pnlUsd || 0))
    .map(cell => ({
      part: cell.part, market: cell.market, horizon: cell.horizon, side: cell.side,
      variant: cell.variant || cell.gate, pooled: cell.pooled, pooledPerYear: cell.pooledPerYear,
      holdout: cell.holdout, confidence: cell.promotion?.confidence || null,
      bhPartDStatus: cell.bhPartDStatus || null,
    }));
  phaseTimings.aggregation = timing(msSince(phaseStarted));
  const report = {
    generatedAt: new Date().toISOString(), study: 'cache-backed-performance-program-v2', mode: 'BACKTEST_ONLY',
    liveBehaviorChanged: false, preregistration: 'docs/performance-program-preregistration.md',
    methodology: {
      statementSource: 'data/research/fmp cache only', priceHarness: 'server.fetchOHLCV + server.backtestSignal',
      provider: 'existing fundamentalsAt decision-date injection', folds: '4 x date-aligned 504/126/126', embargoBars: EMBARGO,
      primary: 'PIT Piotroski + PIT Altman Z with decision-date USD FX normalization and LSE GBp-to-GBP scaling',
      secondary: 'Piotroski-only NON_PARITY; never promotion eligible', preliminarySample: preliminary,
      sampledPerMarket: PER_MARKET || 'FULL_CACHED_UNIVERSE', notionalUsd: NOTIONAL,
      exitGrid: 'Existing live hybrid simulator with research-only TP1 R, stop-cap, time-cap, and TP1-only injection; no exit logic is duplicated.',
      bh: 'Benjamini-Hochberg over every executed cell/variant, plus a separately corrected Part D Piotroski-threshold family.',
      pooledDevelopment: 'Non-overlapping, date-aligned development test windows pooled by calendar year; final fold remains separate holdout.',
    },
    fx: Object.fromEntries(Object.entries(FX_SPECS).map(([currency]) => [
      currency,
      { source: 'worker-owned cache/retry context' },
    ])),
    universeCoverage: Object.fromEntries(Object.entries(contexts).map(([market, group]) => [market, {
      requested: group.requested, loaded: group.symbols.length,
      ...(market === 'US' ? {
        currentSymbols: US_UNIVERSE_SNAPSHOT.currentSymbols.length,
        historicalCandidates: US_UNIVERSE_SNAPSHOT.candidateSymbols.length,
        historicalMembership: US_UNIVERSE_SNAPSHOT.historicalMembership.available,
        survivorshipBias: US_UNIVERSE_SNAPSHOT.survivorshipBias,
      } : {}),
    }])),
    execution: {
      checkpoint: path.relative(ROOT, CHECKPOINT),
      workerSlots: WORKERS,
      workerSlotPolicy: `parent CPU capacity (${PARENT_CPU_SLOTS}) - ${CPU_RESERVE} reserved CPU(s)`,
      parentCpuSlots: PARENT_CPU_SLOTS,
      cpuReserve: CPU_RESERVE,
      priority: 'below-normal',
      priceRetry: { attempts: RETRY_ATTEMPTS, baseMs: RETRY_BASE_MS },
      phaseTimingsMs: phaseTimings,
    },
    stage2: {
      reviewRequired: true,
      reviewApproved: STAGE2_REVIEW_APPROVED,
      ran: stage2Ran,
      pooledByHorizon: stage2Pooled,
      recommendations: stage2Pooled.filter(row => row.recommended),
      japanLongExitComparison,
    },
    cells, bestConfigSummary: candidates[0] || null, rankedForwardCandidates: candidates, pooledCandidatesN30: pooledCandidates,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  const executed = cells.filter(cell => cell.tested).length;
  const blocked = cells.filter(cell => !cell.tested).length;
  const stage1Summary = renderStage1Summary(cells);
  const stage1Ranking = renderRankedStage1List(cells);
  const lines = [
    '# Cache-backed Performance Program Readout', '', `Generated: ${report.generatedAt}`, '',
    '## Outcome', `Executed cells: ${executed}; blocked cells: ${blocked}.`,
    preliminary ? `This was a per-market sample of ${PER_MARKET}; every executed cell is preliminary and not promotable.` : 'Full cached-universe run requested.',
    'Primary uses decision-date FX normalization for currency mismatches and scales LSE GBp prices to GBP; Piotroski-only output remains non-promotable.',
    'FX sources are loaded by each bounded worker from the local cache with retry.',
    AGGREGATE_ONLY
      ? 'This readout was regenerated from completed Stage 1 checkpoint/worker outputs only; no symbol replay occurred.'
      : 'This readout includes the execution requested for this run.',
    stage2Ran
      ? 'Stage 2 was run only after explicit Stage 1 review approval.'
      : 'Stage 2 was not run; it remains gated on explicit Stage 1 review.',
    '', '## Stage 1 geography × horizon × side summary', stage1Summary, '',
    'A PASS requires the frozen Stage 1 promotion criteria and BH correction. FAIL rows show the deterministically highest-ranked evaluated primary-parity Stage 1 cell for context; they are not candidates.', '',
    '## Stage 1 ranked configurations', stage1Ranking, '',
    '## Best configuration', candidates[0] ? JSON.stringify(candidates[0]) : 'No forward candidate qualified.', '',
    '## Pooled development candidates (n >= 30)',
    ...(pooledCandidates.length
      ? pooledCandidates.map(cell => `- ${cell.part} ${cell.market} ${cell.horizon} ${cell.side} ${cell.variant}: n=${cell.pooled.trades}, WR=${cell.pooled.winRate}%, PF=${cell.pooled.profitFactor}, PnL=${cell.pooled.pnlUsd} USD; holdout n=${cell.holdout.trades}; Part D BH=${cell.bhPartDStatus || 'n/a'}`)
      : ['No evaluated configuration reached n >= 30 in non-overlapping pooled development windows.']),
    '', '## Stage 2 buy-only pooled exit grid',
    '| Horizon | Variant | n | Win % | PF | PnL | Avg win | Avg loss | Δ PF | Δ PnL | Holdout n | BH | RR rule | Full-market harm | Recommended |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |',
    ...(stage2Pooled.length ? stage2Pooled.map(row => `| ${row.horizon} | ${row.variant} | ${row.pooled.trades} | ${formatMetric(row.pooled.winRate, '%')} | ${formatMetric(row.pooled.profitFactor)} | ${formatMetric(row.pooled.pnlUsd, ' USD')} | ${formatMetric(row.pooled.averageWinPct, '%')} | ${formatMetric(row.pooled.averageLossPct, '%')} | ${formatMetric(row.deltaVsBaseline.pooled.profitFactor)} | ${formatMetric(row.deltaVsBaseline.pooled.pnlUsd, ' USD')} | ${row.holdout.trades} | ${row.bhStatus} | ${row.violatesCurrentTp1MinRr ? 'VIOLATES_TP1_RR' : 'OK'} | ${row.clearlyHarmsFullMarket ? 'YES' : 'NO'} | ${row.recommended ? 'YES' : 'NO'} |`)
      : ['| — | No Stage 2 rows executed | — | — | — | — | — | — | — | — | — | — | — | — | — |']),
    '', 'Per-market Stage 2 metrics and baseline deltas are in the machine-readable `stage2.pooledByHorizon[*].markets` output.',
    '', '## Japan long buy — win % versus PF',
    '| Exit | Dev n | Dev win % | Dev PF | Dev PnL | Dev avg win/loss | Holdout n | Holdout win % | Holdout PF | Holdout PnL | Holdout avg win/loss | RR rule | BH |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...japanLongExitComparison.map(row => {
      const dev = row.development || {};
      const holdout = row.holdout || {};
      return `| ${row.label} | ${dev.trades ?? 0} | ${formatMetric(dev.winRate, '%')} | ${formatMetric(dev.profitFactor)} | ${formatMetric(dev.pnlUsd, ' USD')} | ${formatMetric(dev.averageWinPct, '%')} / ${formatMetric(dev.averageLossPct, '%')} | ${holdout.trades ?? 0} | ${formatMetric(holdout.winRate, '%')} | ${formatMetric(holdout.profitFactor)} | ${formatMetric(holdout.pnlUsd, ' USD')} | ${formatMetric(holdout.averageWinPct, '%')} / ${formatMetric(holdout.averageLossPct, '%')} | ${row.rr} | ${row.bhStatus || 'n/a'} |`;
    }),
    '',
    '## Explicit blocks', ...cells.filter(cell => !cell.tested).map(cell => `- ${cell.part} ${cell.market} ${cell.horizon} ${cell.side}: ${cell.status} — ${cell.reason}`),
    '', `Machine-readable report: ${path.relative(ROOT, OUTPUT)}`, '',
  ];
  fs.writeFileSync(READOUT, `${lines.join('\n')}\n`);
  phaseTimings.reporting = timing(msSince(phaseStarted));
  phaseTimings.total = timing(msSince(programStarted));
  // Persist terminal timing information as well as the symbol checkpoints.
  checkpoint.timings = phaseTimings;
  checkpoint.completedAt = new Date().toISOString();
  writeCheckpoint(checkpoint);
  console.log(`Phase timings (ms): ${JSON.stringify(phaseTimings)}`);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`);
  console.log(`Wrote ${path.relative(ROOT, READOUT)}`);
}

const entrypoint = args.workerTask ? runWorkerTask : ((args.parallelSmoke || args.parallelSmokeEpipe) ? parallelSmoke : main);
entrypoint().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
