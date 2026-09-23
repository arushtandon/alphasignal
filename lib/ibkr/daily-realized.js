'use strict';

/**
 * Daily realised is cash on the fill's own calendar day.
 * Closed-lot commission and stamp hit that lot's close day.
 * Any leftover vs the lot's realisedUsd stays on that same lot — never on "today".
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

function fillDayUsd(f) {
  const daily = Number(f && f.dailyRealizedUsd);
  if (Number.isFinite(daily)) return daily;
  const n = Number(f && f.realizedUsd);
  return Number.isFinite(n) ? n : 0;
}

function addDetail(details, day, t, usd, kind) {
  if (!(details instanceof Map)) return;
  const date = String(day || '').slice(0, 10);
  const amount = Number(usd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount === 0) return;
  if (!details.has(date)) details.set(date, new Map());
  const rows = details.get(date);
  const key = String(t.key || t.ticker || 'unknown');
  const row = rows.get(key) || {
    key,
    ticker: String(t.ticker || key.split('|')[0] || '—'),
    status: t.status || null,
    realizedUsd: 0,
    parts: {}
  };
  row.realizedUsd += amount;
  row.parts[kind] = (row.parts[kind] || 0) + amount;
  rows.set(key, row);
}

/** Book one lot into daily / dailyError. Lot remainder stays on this lot's close day. */
function accumulateLotDaily(t, daily, dailyError, details) {
  if (!t) return;
  const target = t.errorTrade ? dailyError : daily;
  const lotClosed = !(t.openQty > 0);
  let booked = 0;
  for (const f of t.fills || []) {
    if (!f || f.role === 'entry') continue;
    const usd = fillDayUsd(f);
    addDaily(target, f.time, usd);
    if (!t.errorTrade) addDetail(details, f.time, t, usd, f.recon === 'futures-roll' ? 'roll' : 'exit');
    booked += usd;
  }
  if (lotClosed) {
    const comm = Number(t.commissionUsd) || 0;
    const stamp = Number(t.stampDutyUsd) || 0;
    addDaily(target, closeDay(t), -comm);
    addDaily(target, closeDay(t), -stamp);
    if (!t.errorTrade) {
      addDetail(details, closeDay(t), t, -comm, 'commission');
      addDetail(details, closeDay(t), t, -stamp, 'tax');
    }
    booked -= comm + stamp;
  }
  const want = Number(t.realizedUsd) || 0;
  const gap = +(want - booked).toFixed(2);
  if (Math.abs(gap) >= 0.005) {
    addDaily(target, closeDay(t), gap);
    if (!t.errorTrade) addDetail(details, closeDay(t), t, gap, 'adjustment');
  }
}

function sumMap(map) {
  let s = 0;
  for (const v of map.values()) s += Number(v) || 0;
  return s;
}

function toDailyArray(daily, details) {
  const dailyArr = [...daily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, pnl]) => {
      const components = details instanceof Map && details.has(date)
        ? [...details.get(date).values()].map(row => ({
          ...row,
          realizedUsd: +row.realizedUsd.toFixed(2),
          parts: Object.fromEntries(Object.entries(row.parts)
            .map(([kind, amount]) => [kind, +Number(amount).toFixed(2)]))
        })).sort((a, b) => Math.abs(b.realizedUsd) - Math.abs(a.realizedUsd))
        : undefined;
      return {
        date,
        realizedUsd: +Number(pnl).toFixed(2),
        ...(components ? { components } : {})
      };
    });
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
  toDailyArray,
  sumMap
};
