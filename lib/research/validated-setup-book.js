'use strict';

const { summarizeReturns } = require('./performance');

const STUDY_ID = 'validated-setup-book-v1';
const NOTIONAL = 10_000;
const HOLDOUT_STATUS = 'OVERLAP_RISK';
const EMBARGO = Object.freeze({ short: 20, medium: 63, long: 180 });
const FOLD_SPEC = Object.freeze({
  folds: 4,
  trainBars: 504,
  validationBars: 126,
  testBars: 126,
});

const TARGET_CELLS = Object.freeze([
  ['US', 'short'], ['US', 'medium'], ['US', 'long'],
  ['UK', 'short'], ['UK', 'medium'], ['UK', 'long'],
  ['Japan', 'short'], ['Japan', 'medium'], ['Japan', 'long'],
  ['Germany', 'medium'], ['France', 'long'],
  ['Commodities', 'medium'], ['Commodities', 'long'],
]);

const REGIME_VARIANTS = Object.freeze([
  { id: 'baseline' },
  { id: 'vol_skip_top20', volQuantile: 0.8 },
  { id: 'vol_skip_top30', volQuantile: 0.7 },
  { id: 'ma50_flat_or_up', slope: true },
  { id: 'vol_skip_top20_and_ma50_flat_or_up', volQuantile: 0.8, slope: true },
  { id: 'vol_skip_top30_and_ma50_flat_or_up', volQuantile: 0.7, slope: true },
]);

const MR_MODELS = Object.freeze({
  US: {
    medium: {
      trigger: 'close_below_lower_bb20_2', target: 'one_atr',
      timeStopBars: 21, stopAtr: 2.5, partial: true,
    },
  },
  Japan: {
    short: {
      trigger: 'close_below_lower_bb20_2', target: 'one_atr',
      timeStopBars: 10, stopAtr: 2.5, partial: true,
    },
    medium: {
      trigger: 'close_below_lower_bb20_2', target: 'one_atr',
      timeStopBars: 21, stopAtr: 2.5, partial: false,
    },
  },
});

function setupRegistry() {
  const rows = TARGET_CELLS.map(([market, horizon]) => ({
    id: `v0_live__${market.toLowerCase()}__${horizon}`,
    market, horizon, side: 'buy', kind: 'live_control',
    label: 'V0 current live rules (control)',
    control: true,
  }));
  rows.push(
    { id: 'wave3_baseline__us__medium', market: 'US', horizon: 'medium', side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
    { id: 'wave3_baseline__us__long', market: 'US', horizon: 'long', side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
    { id: 'mr_bb_atr_t21_partial__us__medium__vol30_ma50', market: 'US', horizon: 'medium', side: 'buy', kind: 'mean_reversion', variant: 'vol_skip_top30_and_ma50_flat_or_up', label: 'BB lower / 1 ATR / t21 / 2.5 ATR / 50-50 + vol30 + MA50' },
    { id: 'live_pio5__germany__medium', market: 'Germany', horizon: 'medium', side: 'buy', kind: 'live_pio5', label: 'Live trend + PIT Piotroski >=5' },
    { id: 'wave3_baseline__france__long', market: 'France', horizon: 'long', side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
    { id: 'wave3_baseline__commodities__medium', market: 'Commodities', horizon: 'medium', side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
    { id: 'wave3_baseline__commodities__long', market: 'Commodities', horizon: 'long', side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
  );
  for (const horizon of ['medium', 'long']) {
    rows.push(
      { id: `wave3_baseline__uk__${horizon}`, market: 'UK', horizon, side: 'buy', kind: 'wave3', label: 'Wave 3 trend/breakout baseline' },
      { id: `wave3_baseline_pio5__uk__${horizon}`, market: 'UK', horizon, side: 'buy', kind: 'wave3_pio5', label: 'Wave 3 trend/breakout baseline + PIT Piotroski >=5' },
    );
  }
  rows.push({
    id: 'live_v3__japan__long', market: 'Japan', horizon: 'long',
    side: 'buy', kind: 'live_v3', label: 'Exact live-v3 trend engine',
  });
  for (const horizon of ['short', 'medium']) {
    for (const variant of REGIME_VARIANTS) {
      rows.push({
        id: `mr_frozen__japan__${horizon}__${variant.id}`,
        market: 'Japan', horizon, side: 'buy', kind: 'mean_reversion',
        variant: variant.id, label: `Frozen Japan ${horizon} MR + ${variant.id}`,
      });
    }
  }
  return rows;
}

function tradeKey(trade, setupId) {
  return [
    setupId,
    trade.symbol || trade.ticker || '',
    trade.signalDate || trade.entryDate || trade.signalTs || '',
    trade.entryDate || trade.entryTs || '',
  ].join('|');
}

function dedupeTrades(trades, setupId) {
  const seen = new Set();
  return (trades || []).filter(trade => {
    const key = tradeKey(trade, setupId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metricSummary(trades, exposureMonths = null) {
  const rows = trades || [];
  const summary = summarizeReturns(rows.map(row => row.ret));
  const wins = rows.filter(row => Number(row.ret) > 0);
  const losses = rows.filter(row => Number(row.ret) <= 0);
  const average = list => list.length
    ? list.reduce((sum, row) => sum + Number(row.ret), 0) / list.length * 100
    : null;
  return {
    ...summary,
    pnlUsd: +(rows.reduce((sum, row) => sum + Number(row.ret) * NOTIONAL, 0)).toFixed(2),
    averageWinPct: wins.length ? +average(wins).toFixed(3) : null,
    averageLossPct: losses.length ? +average(losses).toFixed(3) : null,
    exposureMonths,
    picksPerMonth: exposureMonths > 0 ? +(rows.length / exposureMonths).toFixed(3) : null,
  };
}

function exactBinomialP(trades) {
  const n = trades.length;
  const wins = trades.filter(row => Number(row.ret) > 0).length;
  if (!n) return 1;
  // One-sided alternative is win rate >50%. Returning 1 below the null mean
  // is conservative and avoids meaningless "significance" for losing setups.
  if (wins <= n / 2) return 1;
  let logCombination = 0;
  for (let i = 1; i <= wins; i++) {
    logCombination += Math.log(n - wins + i) - Math.log(i);
  }
  let probability = Math.exp(logCombination - n * Math.log(2));
  let tail = probability;
  for (let i = wins; i < n; i++) {
    probability *= (n - i) / (i + 1);
    tail += probability;
  }
  return Math.min(1, tail);
}

function applyBenjaminiHochberg(cells, alpha = 0.05) {
  const ordered = cells.map((cell, index) => ({
    cell, index, p: Number.isFinite(cell.holdoutWinRatePValue)
      ? cell.holdoutWinRatePValue : 1,
  })).sort((a, b) => a.p - b.p || a.index - b.index);
  let adjusted = 1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    adjusted = Math.min(adjusted, ordered[i].p * ordered.length / (i + 1));
    ordered[i].cell.bhQValue = +Math.min(1, adjusted).toFixed(6);
    ordered[i].cell.bhPass = ordered[i].cell.bhQValue <= alpha;
    ordered[i].cell.bhFamilySize = ordered.length;
  }
  return cells;
}

function passingMetrics(metrics, minPf = 1.3) {
  return Number(metrics?.winRate) >= 60
    && Number(metrics?.profitFactor) >= minPf
    && Number(metrics?.pnlUsd) > 0;
}

function classifyVerdict(cell) {
  const holdout = cell.holdout || {};
  const stable = Number(cell.stableDevelopmentFolds) >= 2;
  const full = Number(holdout.trades) >= 30
    && passingMetrics(holdout)
    && stable
    && cell.beatsControl === true
    && cell.bhPass === true;
  const thin = Number(holdout.trades) >= 15 && Number(holdout.trades) <= 29
    && Number(cell.holdoutWinRatePValue) < 0.05
    && passingMetrics(holdout, 1.6)
    && stable
    && cell.beatsControl === true
    && cell.bhPass === true;
  if ((full || thin) && cell.holdoutStatus === 'CLEAN') return 'VALIDATED';
  if (full || thin) return 'CANDIDATE';
  return 'REJECTED';
}

function rejectionReason(cell) {
  if (cell.control || cell.verdict === 'VALIDATED' || cell.verdict === 'CANDIDATE') return null;
  const holdout = cell.holdout || {};
  if (Number(holdout.winRate) >= 60 && Number(holdout.profitFactor) < 1.3) {
    return 'REJECTED_BLEEDER';
  }
  if (Number(holdout.trades) < 15) return 'INSUFFICIENT_HOLDOUT_SAMPLE';
  if (Number(cell.stableDevelopmentFolds) < 2) return 'UNSTABLE_DEVELOPMENT_FOLDS';
  if (cell.beatsControl !== true) return 'DID_NOT_BEAT_CONTROL';
  if (cell.bhPass !== true) return 'BH_FAIL';
  if (cell.holdoutStatus === 'OVERLAP_RISK') return 'OVERLAP_RISK_WITHOUT_PROMOTION_METRICS';
  return 'PROMOTION_THRESHOLDS_NOT_MET';
}

function bhFamilyManifest() {
  return setupRegistry().map(row => row.id);
}

function assertsFullUniverse(source) {
  const text = String(source || '');
  return !/\.slice\(\s*0\s*,\s*80\s*\)/.test(text)
    && !/perMarket\s*=\s*80/.test(text)
    && !/requestedPerMarket:\s*80/.test(text);
}

function perYear(trades) {
  const groups = new Map();
  for (const trade of trades || []) {
    const date = String(trade.signalDate || trade.entryDate || '').slice(0, 10);
    if (!/^\d{4}-/.test(date)) continue;
    const year = date.slice(0, 4);
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(trade);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([year, rows]) => [year, metricSummary(rows)]));
}

module.exports = {
  STUDY_ID,
  NOTIONAL,
  HOLDOUT_STATUS,
  EMBARGO,
  FOLD_SPEC,
  TARGET_CELLS,
  REGIME_VARIANTS,
  MR_MODELS,
  setupRegistry,
  dedupeTrades,
  metricSummary,
  exactBinomialP,
  applyBenjaminiHochberg,
  passingMetrics,
  classifyVerdict,
  rejectionReason,
  bhFamilyManifest,
  assertsFullUniverse,
  perYear,
};
