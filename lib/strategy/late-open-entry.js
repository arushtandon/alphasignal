'use strict';

const LATE_AFTER_MIN = 15;

function lateOpenLimit(side, officialOpen) {
  const open = Number(officialOpen);
  if (!(open > 0)) return null;
  return open;
}

function lateOpenFills(side, officialOpen, printPx) {
  const open = Number(officialOpen);
  const px = Number(printPx);
  if (!(open > 0) || !(px > 0)) return false;
  const sell = String(side || 'buy').toLowerCase() === 'sell';
  return sell ? px >= open : px <= open;
}

function missedOpenDue(row, phase) {
  if (!row || row.entryStyle !== 'LMT-MISSED-OPEN') return false;
  if (row.entryFilled === true || row.closed === true) return false;
  return phase === 'closed' || phase === 'post';
}

function latestSessionOpen(bars, nowMs) {
  const last = bars && bars[bars.length - 1];
  if (!last || !(Number(last.o) > 0)) return null;
  if (nowMs - Number(last.t) > 36 * 3600 * 1000) return null;
  return Number(last.o);
}

module.exports = {
  LATE_AFTER_MIN,
  lateOpenLimit,
  lateOpenFills,
  missedOpenDue,
  latestSessionOpen,
};
