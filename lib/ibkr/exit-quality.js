'use strict';

/**
 * IBKR Exit Quality: one closed model lot, one bucket, that lot's realised $.
 * Never reuse tickerGroupRealizedUsd — that double-counts TSL/SL lots into flatten.
 */

const CLOSED_EXIT_TYPES = [
  'trailing stop (post-TP1)',
  'stop-loss (full)',
  'signal/time exit',
  'flatten exit',
  'tp exit'
];
const TP1_LIVE = 'tp1 banked — runner live';

function flag(t, key, role) {
  if (t && t[key]) return true;
  const fills = (t && t.fills) || [];
  return fills.some((f) => f && f.role === role);
}

function classifyIbkrExitQuality(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.errorTrade) return t.status === 'closed' || flag(t, 'hasFlatten', 'flatten')
    ? 'error flatten' : null;
  const raw = String(t.exitType || (t.rec && (t.rec.exitReason || t.rec.exitStatus)) || '').toLowerCase();
  const hasTp1 = flag(t, 'hasTp1', 'tp1');
  const hasStop = flag(t, 'hasStop', 'stop');
  const hasFlat = flag(t, 'hasFlatten', 'flatten');
  if (t.status !== 'closed') return hasTp1 ? TP1_LIVE : null;
  if (hasStop && hasTp1) return 'trailing stop (post-TP1)';
  if (hasStop && !hasTp1) return 'stop-loss (full)';
  if (hasFlat && !hasTp1) return 'flatten exit';
  if (hasTp1 && hasFlat) return 'trailing stop (post-TP1)';
  if (hasTp1) return 'tp exit';
  if (raw.includes('tp1_then_sl') || raw.includes('trailing stop closed runner')
    || raw === 'trailing stop (post-tp1)') {
    return 'trailing stop (post-TP1)';
  }
  if (raw === 'sl_hit' || raw.includes('stop loss') || raw.includes('stop-loss')) {
    return 'stop-loss (full)';
  }
  if (raw.includes('signal') || raw.includes('time_limit') || raw.includes('time limit')
    || raw.includes('horizon time')) {
    return 'signal/time exit';
  }
  if (raw === 'flatten exit' || raw.includes('flatten')) return 'flatten exit';
  return 'flatten exit';
}

/** Server-side wrapper used when classifying from fill-role booleans. */
function ibkrExitQualityType(status, modelReason, hasTp1, hasStop, hasFlat, errorTrade) {
  return classifyIbkrExitQuality({
    status,
    exitType: modelReason,
    rec: { exitReason: modelReason },
    hasTp1: !!hasTp1,
    hasStop: !!hasStop,
    hasFlatten: !!hasFlat,
    errorTrade: !!errorTrade,
    fills: []
  });
}

function bucketRow(type, lots) {
  const n = lots.length;
  const realizedUsd = +lots.reduce((s, t) => s + (Number(t.realizedUsd) || 0), 0).toFixed(2);
  const w = lots.filter((t) => (Number(t.realizedUsd) || 0) > 0).length;
  return {
    type,
    n,
    realizedUsd,
    wins: w,
    winRate: n ? Math.round((w / n) * 100) : null,
    tickers: lots.map((t) => t.ticker).filter(Boolean)
  };
}

function summarizeExitQuality(trades) {
  const model = (Array.isArray(trades) ? trades : []).filter((t) => t && !t.errorTrade);
  const closed = model.filter((t) => t.status === 'closed');
  const buckets = CLOSED_EXIT_TYPES.map((type) =>
    bucketRow(type, closed.filter((t) => classifyIbkrExitQuality(t) === type))
  );
  const tp1Live = model.filter((t) => t.status !== 'closed' && classifyIbkrExitQuality(t) === TP1_LIVE);
  buckets.push(bucketRow(TP1_LIVE, tp1Live));
  const closedBucketUsd = +buckets
    .filter((b) => b.type !== TP1_LIVE)
    .reduce((s, b) => s + b.realizedUsd, 0)
    .toFixed(2);
  const closedLotsUsd = +closed.reduce((s, t) => s + (Number(t.realizedUsd) || 0), 0).toFixed(2);
  const openTp1Usd = +tp1Live.reduce((s, t) => s + (Number(t.realizedUsd) || 0), 0).toFixed(2);
  const allRealizedUsd = +model.reduce((s, t) => s + (Number(t.realizedUsd) || 0), 0).toFixed(2);
  return {
    buckets,
    closedBucketUsd,
    closedLotsUsd,
    openTp1Usd,
    allRealizedUsd,
    reconOk: Math.abs(closedBucketUsd - closedLotsUsd) < 0.02
  };
}

module.exports = {
  CLOSED_EXIT_TYPES,
  TP1_LIVE,
  classifyIbkrExitQuality,
  ibkrExitQualityType,
  summarizeExitQuality
};
