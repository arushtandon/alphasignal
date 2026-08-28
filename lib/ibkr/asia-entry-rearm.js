'use strict';

/** Parent styles that are meant to sit in Asia cash until they fill. */
function isAsiaLiveEntryStyle(style) {
  return style === 'MKT' || style === 'LMT-THROUGH';
}

function isAsiaAuctionStyle(style) {
  return style === 'OPG' || style === 'LMT-OPEN' || style === 'MKT-OPEN';
}

/**
 * Why (if at all) an unfilled HK/JP parent should be cancelled and replaced.
 *
 * A working LMT-THROUGH / MKT must sit until fill. 6098.T on 28 Aug was
 * cancelled every 2 minutes (`asia-rth-retry`) so it never printed at TSE open.
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

    const parentGone = !!o.parentGone || o.parentId == null || !!o.rearmBlocked;
    const listedMissing = o.openOrdersComplete === true && o.parentId != null
      && o.parentWorking !== true;
    if (!(parentGone || listedMissing)) return null;

    const t0 = Date.parse(o.lastRearmAt || o.orderSubmittedAt || 0);
    if (!Number.isFinite(t0) || now - t0 > 2 * 60 * 1000) return 'asia-rth-retry';
    return null;
  }

  if (phase !== 'rth' && phase !== 'lunch' && asiaLive) return 'asia-to-opg';
  if (!style) return 'asia-missing-style';
  return null;
}

module.exports = {
  asiaUnfilledRearmReason,
  isAsiaLiveEntryStyle,
  isAsiaAuctionStyle
};
