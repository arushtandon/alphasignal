'use strict';

/**
 * Error-trades panel reset.
 * Historical Error lots stay on the fill ledger (still excluded from model PnL)
 * but the panel only shows lots with a fill on/after this UTC date.
 * New unauthorized / |cursor-err| fills from this date still appear.
 */
const IBKR_ERROR_PANEL_START = '2026-09-08';

function fillDateKey(value) {
  const s = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function errorLotLastFillDate(t) {
  let latest = '';
  for (const f of (t && t.fills) || []) {
    const d = fillDateKey(f && f.time);
    if (d > latest) latest = d;
  }
  if (!latest) latest = fillDateKey(t && (t.lastTime || t.entryTime));
  return latest;
}

function isArchivedErrorPanelLot(t, start) {
  if (!t || !t.errorTrade) return false;
  const cutoff = fillDateKey(start) || IBKR_ERROR_PANEL_START;
  const d = errorLotLastFillDate(t);
  return !d || d < cutoff;
}

function dropArchivedErrorPanelLots(trades, start) {
  const cutoff = fillDateKey(start) || IBKR_ERROR_PANEL_START;
  const next = [];
  let dropped = 0;
  for (const t of trades || []) {
    if (isArchivedErrorPanelLot(t, cutoff)) {
      dropped++;
      continue;
    }
    next.push(t);
  }
  return { trades: next, dropped, start: cutoff };
}

module.exports = {
  IBKR_ERROR_PANEL_START,
  fillDateKey,
  errorLotLastFillDate,
  isArchivedErrorPanelLot,
  dropArchivedErrorPanelLots
};
