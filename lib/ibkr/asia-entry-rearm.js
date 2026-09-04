'use strict';

/** Parent styles that are meant to sit in Asia cash until they fill. */
function isAsiaLiveEntryStyle(style) {
  return style === 'MKT' || style === 'LMT-THROUGH';
}

function isAsiaAuctionStyle(style) {
  return style === 'OPG' || style === 'LMT-OPEN' || style === 'MKT-OPEN';
}

/** Last has already moved through the parked through-limit — reprice soon. */
const ASIA_THROUGH_STALE_MS = 2 * 60 * 1000;
/** Marketable through-limit that still has not printed — treat as dead. */
const ASIA_THROUGH_SIT_MS = 10 * 60 * 1000;

function agedMs(opts, now) {
  const t0 = Date.parse((opts && (opts.lastRearmAt || opts.orderSubmittedAt)) || 0);
  return Number.isFinite(t0) ? now - t0 : Infinity;
}

/**
 * Live last has left a parked JP LMT-THROUGH behind (buy last > limit,
 * sell last < limit). 7733.T 4 Sep sat at 2110 after a stale 2068 last
 * while TSE printed through 2130.
 */
function asiaThroughLimitStale(opts) {
  const o = opts || {};
  if (o.entryStyle !== 'LMT-THROUGH') return false;
  const quote = Number(o.quotePx);
  const lmt = Number(o.extLmt);
  if (!(quote > 0) || !(lmt > 0)) return false;
  return o.side === 'sell' ? quote < lmt : quote > lmt;
}

/** Buy last still at/below the through-limit (sell at/above) — should have filled. */
function asiaThroughLimitMarketable(opts) {
  const o = opts || {};
  if (o.entryStyle !== 'LMT-THROUGH') return false;
  const quote = Number(o.quotePx);
  const lmt = Number(o.extLmt);
  if (!(quote > 0) || !(lmt > 0)) return false;
  return o.side === 'sell' ? quote >= lmt : quote <= lmt;
}

/**
 * Why (if at all) an unfilled HK/JP parent should be cancelled and replaced.
 *
 * A working LMT-THROUGH / MKT must sit until fill. 6098.T on 28 Aug was
 * cancelled every 2 minutes (`asia-rth-retry`) so it never printed at TSE open.
 * A through-limit that the live last has already crossed must be repriced
 * (7733.T 4 Sep: 2110 vs TSE ~2130).
 */
function asiaUnfilledRearmReason(opts) {
  const o = opts || {};
  const phase = o.phase;
  const style = o.entryStyle;
  const asiaLive = isAsiaLiveEntryStyle(style);
  const needsStandaloneRefresh = o.stopId != null || o.tp1Id != null || !!o.rearmBlocked;
  const auctionHoldMin = o.auctionHoldMin != null ? Number(o.auctionHoldMin) : 2;
  const minsSinceRth = o.minutesSinceRth;
  const now = o.now != null ? Number(o.now) : Date.now();

  if (phase === 'lunch') return null;

  if ((phase === 'pre' || phase === 'closed') && (needsStandaloneRefresh || asiaLive || !style)) {
    return (style === 'OPG' || needsStandaloneRefresh) ? 'asia-opg-refresh' : 'asia-to-opg';
  }

  if (phase === 'rth') {
    if (isAsiaAuctionStyle(style) && !o.contractRejected
      && Number.isFinite(minsSinceRth) && minsSinceRth < auctionHoldMin) {
      return null;
    }
    if (!asiaLive || o.contractRejected || o.deferred) return 'asia-rth';

    const age = agedMs(o, now);
    if (asiaThroughLimitStale(o) && age >= ASIA_THROUGH_STALE_MS) return 'asia-rth-reprice';
    if (asiaThroughLimitMarketable(o) && age >= ASIA_THROUGH_SIT_MS) return 'asia-rth-retry';

    const parentGone = !!o.parentGone || o.parentId == null || !!o.rearmBlocked;
    // Worker-client parents do not show on the manager reqAllOpenOrders
    // snapshot. Treating "not in list" as dead cancel-looped 5713.T / 6098.T.
    if (!parentGone) return null;

    if (!Number.isFinite(age) || age > 2 * 60 * 1000) return 'asia-rth-retry';
    return null;
  }

  if (phase !== 'rth' && phase !== 'lunch' && asiaLive) return 'asia-to-opg';
  if (!style) return 'asia-missing-style';
  return null;
}

module.exports = {
  asiaUnfilledRearmReason,
  asiaThroughLimitStale,
  asiaThroughLimitMarketable,
  isAsiaLiveEntryStyle,
  isAsiaAuctionStyle,
  ASIA_THROUGH_STALE_MS,
  ASIA_THROUGH_SIT_MS
};
