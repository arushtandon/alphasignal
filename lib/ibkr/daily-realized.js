'use strict';

/**
 * Daily realised must land on the same number as Total realised (net).
 * Exit-fill price PnL is booked on the fill day; closed-lot commission and
 * stamp/FTT/STT hit the close day. A final reconcile absorbs rounding.
 */

function addDaily(map, day, usd) {
  const d = String(day || '').slice(0, 10);
  const n = Number(usd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(n)) return;
  if (n === 0 && !map.has(d)) return;
  const next = (map.get(d) || 0) + n;
  if (Math.abs(next) < 5e-10) map.delete(d);
  else map.set(d, next);
}

function closeDay(t) {
  const fills = (t && t.fills) || [];
  const lastExit = fills.filter((f) => f && f.role !== 'entry').slice(-1)[0]
    || fills.slice(-1)[0];
  return String((lastExit && lastExit.time) || (t && (t.lastTime || t.entryTime)) || '').slice(0, 10);
}

function fillPnlUsd(f) {
  const n = Number(f && f.realizedUsd);
  return Number.isFinite(n) ? n : 0;
}

/** Book one lot into daily / dailyError. */
function accumulateLotDaily(t, daily, dailyError) {
  if (!t) return;
  const target = t.errorTrade ? dailyError : daily;
  const lotClosed = !(t.openQty > 0);
  for (const f of t.fills || []) {
    if (!f || f.role === 'entry') continue;
    addDaily(target, f.time, fillPnlUsd(f));
  }
  if (!lotClosed) return;
  addDaily(target, closeDay(t), -(Number(t.commissionUsd) || 0));
  addDaily(target, closeDay(t), -(Number(t.stampDutyUsd) || 0));
}

function sumMap(map) {
  let s = 0;
  for (const v of map.values()) s += Number(v) || 0;
  return s;
}

/** Force last daily row so cumulative === totRealUsd. */
function reconcileDailyToTotal(daily, totRealUsd) {
  const target = Number(totRealUsd) || 0;
  const gap = +(target - sumMap(daily)).toFixed(2);
  if (Math.abs(gap) < 0.005) return gap;
  const keys = [...daily.keys()].sort();
  const last = keys.length ? keys[keys.length - 1] : new Date().toISOString().slice(0, 10);
  daily.set(last, (daily.get(last) || 0) + gap);
  return gap;
}

function toDailyArray(daily) {
  const dailyArr = [...daily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, pnl]) => ({ date, realizedUsd: +Number(pnl).toFixed(2) }));
  let cum = 0;
  for (const d of dailyArr) {
    cum += d.realizedUsd;
    d.cumUsd = +cum.toFixed(2);
  }
  return dailyArr;
}

module.exports = {
  addDaily,
  closeDay,
  accumulateLotDaily,
  reconcileDailyToTotal,
  toDailyArray,
  sumMap
};
