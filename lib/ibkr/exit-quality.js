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

function fillExitPnlUsd(t, f, fx) {
  if (!f || f.role === 'entry') return 0;
  if (String(f.recon || '') === 'futures-roll') return 0;
  const rate = Number.isFinite(Number(fx)) ? Number(fx) : 1;
  const local = Number(f.realizedLocal);
  if (Number.isFinite(local)) return local * rate;
  const dir = t && t.side === 'sell' ? -1 : 1;
  const qty = Number(f.qty) || 0;
  const px = Number(f.price) || 0;
  const entry = Number(t && t.avgEntry) || 0;
  const mult = Number(f.multiplier || (t && t.multiplier)) || 1;
  const scale = Number(t && t.ccyScale) || 1;
  if (!(qty > 0) || !(px > 0) || !(entry > 0)) return 0;
  return ((px - entry) * qty * dir * mult / scale) * rate;
}

function fillThroughTp2(t, f) {
  if (!f || f.role === 'entry' || f.role === 'tp1') return false;
  if (f.role === 'tp2') return true;
  const tp2 = Number(t && t.rec && t.rec.tp2) || 0;
  const px = Number(f.price) || 0;
  if (!(tp2 > 0) || !(px > 0)) return false;
  return t.side === 'sell' ? px <= tp2 : px >= tp2;
}

/** Fill PnL booked at TP1 / TP2. Net on the trade is still t.realizedUsd (after closed comm). */
function bookedExitPnlUsd(t, fx) {
  let tp1 = 0;
  let tp2 = 0;
  let rest = 0;
  for (const f of (t && t.fills) || []) {
    if (!f || f.role === 'entry') continue;
    if (String(f.recon || '') === 'futures-roll') continue;
    const usd = fillExitPnlUsd(t, f, fx);
    if (f.role === 'tp1') {
      tp1 += usd;
      continue;
    }
    if (f.role === 'tp2' || fillThroughTp2(t, f)) {
      tp2 += usd;
      continue;
    }
    rest += usd;
  }
  return {
    tp1Usd: +tp1.toFixed(2),
    tp2Usd: +tp2.toFixed(2),
    restUsd: +rest.toFixed(2),
    grossUsd: +(tp1 + tp2 + rest).toFixed(2)
  };
}

module.exports = {
  CLOSED_EXIT_TYPES,
  TP1_LIVE,
  classifyIbkrExitQuality,
  ibkrExitQualityType,
  summarizeExitQuality,
  fillExitPnlUsd,
  fillThroughTp2,
  bookedExitPnlUsd
};
