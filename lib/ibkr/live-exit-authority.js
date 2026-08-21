'use strict';

/**
 * Live IBKR close authority.
 *
 * Price exits belong to Interactive Brokers child orders (TP1 limit fill,
 * resting stop fill). The server may flatten a live lot only on a genuine
 * Buy→Sell / Sell→Buy reversal.
 *
 * History daily-bar simulation (paper TP1, TSL ratchet, tp1_then_sl) updates
 * the History tab only — it must never place, resize, or flatten live orders.
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
  if (['tp1_then_sl', 'tp1_then_time', 'tp1_hit', 'tp2_hit', 'sl_hit', 'time_limit', 'tp1_open'].includes(status)) {
    return true;
  }
  const blob = textBlob(evt);
  return blob.includes('tp1 banked')
    || blob.includes('horizon time limit')
    || blob.includes('trailing stop closed runner');
}

module.exports = {
  isLiveSignalFlipExit,
  isOperationalIbkrExit,
  isLiveAuthorizedServerExit,
  isPaperPathSimExit
};
