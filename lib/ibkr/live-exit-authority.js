'use strict';

/**
 * Live IBKR close authority.
 *
 * Price exits belong to Interactive Brokers child orders (TP1 limit fill,
 * resting stop fill). The server may flatten a live lot only on a genuine
 * Buy→Sell / Sell→Buy reversal.
 *
 * History daily-bar simulation may publish a TSL ratchet for a lot that is
 * already in runner state after a real limit TP1 print. A working TP1 child
 * (qtySold reserved, no fill) is not a print. It must never mark TP1 done
 * or flatten a live lot.
 */

function textBlob(evt) {
  if (!evt || typeof evt !== 'object') return '';
  return [
    evt.reason, evt.exitReason, evt.status, evt.flatReason
  ].map(v => String(v || '').toLowerCase()).join(' | ');
}

function isLiveSignalFlipExit(evt) {
  if (!evt) return false;
  if (evt.liveSignalFlip === true) return true;
  const status = String(evt.status || '').toLowerCase();
  if (status === 'signal_exit') return true;
  const blob = textBlob(evt);
  if (blob.includes('live-signal-flip')) return true;
  if (blob.includes('signal reversal')) return true;
  if (/(^|\s)signal\s*→/.test(blob) || /(^|\s)signal\s*->/.test(blob)) return true;
  return false;
}

function isOperationalIbkrExit(evt) {
  if (!evt) return false;
  if (evt.correctiveReentry === true) return true;
  const blob = textBlob(evt);
  const needles = [
    'unauthorized-non-recommendation',
    'off-schedule-recommendation',
    'ib-flat-after-grace',
    'hold-abandon-unfilled',
    'stale-unfilled-abandon',
    'stale open',
    'stale-open-not-ib',
    'pre-release-cancel',
    'user-flatten',
    'userflatten'
  ];
  return needles.some(n => blob.includes(n));
}

/** True when the bridge may flatten / cancel on a server `exit` event. */
function isLiveAuthorizedServerExit(evt) {
  return isLiveSignalFlipExit(evt) || isOperationalIbkrExit(evt);
}

function isPaperPathSimExit(evt) {
  const status = String(evt && evt.status || '').toLowerCase();
  if (['tp1_then_sl', 'tp1_then_time', 'tp1_hit', 'tp2_hit', 'sl_hit', 'time_limit'].includes(status)) {
    return true;
  }
  const blob = textBlob(evt);
  return blob.includes('tp1 banked')
    || blob.includes('horizon time limit')
    || blob.includes('trailing stop closed runner');
}

/** Apply a server TSL ratchet only after a real limit TP1 print. */
function shouldApplyLiveTslUpdate(row) {
  if (!row || row.closed) return false;
  return row.tp1Done === true;
}

/**
 * Initial protective stop for a new entry. A trail on the profit side of
 * entry is a post-TP1 TSL and must not be used as the first STP.
 */
function initialProtectiveStop(evt) {
  if (!evt) return 0;
  const entry = Number(evt.entry) || 0;
  const sl = Number(evt.sl) || 0;
  const trail = evt.trailSl == null || evt.trailSl === '' ? NaN : Number(evt.trailSl);
  const isSell = String(evt.side || '').toLowerCase() === 'sell';
  if (Number.isFinite(trail) && trail > 0 && entry > 0) {
    const trailIsTsl = isSell ? trail < entry : trail > entry;
    if (trailIsTsl && sl > 0) return sl;
    return trail;
  }
  return sl;
}

function isUserFlattenExit(evt) {
  const blob = textBlob(evt);
  return blob.includes('user-flatten') || blob.includes('userflatten');
}

/** Thursday 6098.T must print at Friday TSE open even if the 06:00 board drops it. */
function isForceCashOpenTicker(ticker) {
  const y = String(ticker || '').toUpperCase().trim();
  return y === '6098.T' || y === '6098';
}

/**
 * Unfilled Asia (and pinned 6098.T) must not be cancelled by a model drop,
 * Hold rewrite, or live-signal flip. User flatten still wins.
 */
function ignoreServerExitForUnfilledForcePrint(row, evt, opts) {
  if (!row || row.entryFilled) return false;
  if (isUserFlattenExit(evt)) return false;
  const forcePrint = !!(opts && opts.forcePrint) || isForceCashOpenTicker(row.ticker);
  if (forcePrint) return true;
  if (!(opts && opts.asiaCarry)) return false;
  if (isLiveSignalFlipExit(evt)) return true;
  const blob = textBlob(evt);
  return blob.includes('stale-open')
    || blob.includes('stale open')
    || blob.includes('hold-abandon')
    || blob.includes('stale-unfilled');
}

module.exports = {
  isLiveSignalFlipExit,
  isOperationalIbkrExit,
  isLiveAuthorizedServerExit,
  isPaperPathSimExit,
  shouldApplyLiveTslUpdate,
  initialProtectiveStop,
  isUserFlattenExit,
  isForceCashOpenTicker,
  ignoreServerExitForUnfilledForcePrint
};
