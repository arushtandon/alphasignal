'use strict';

/** Cash-session gates for the approved covers. Times are exchange local. */

function zonedParts(now, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of dtf.formatToParts(now)) map[p.type] = p.value;
  const hour = Number(map.hour);
  return {
    weekday: map.weekday,
    minutes: (hour === 24 ? 0 : hour) * 60 + Number(map.minute),
    ymd: map.year + '-' + map.month + '-' + map.day,
  };
}

function isWeekday(weekday) {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

/**
 * True once the cash session is open and still inside the day session.
 * openMin/closeMin are minutes from local midnight.
 */
function cashSessionDue(now, timeZone, openMin, closeMin) {
  const p = zonedParts(now instanceof Date ? now : new Date(now), timeZone);
  if (!isWeekday(p.weekday)) return false;
  return p.minutes >= openMin && p.minutes < closeMin;
}

function usCashDue(now) {
  return cashSessionDue(now, 'America/New_York', 9 * 60 + 30, 16 * 60);
}

function tseCashDue(now) {
  return cashSessionDue(now, 'Asia/Tokyo', 9 * 60, 11 * 60 + 30)
    || cashSessionDue(now, 'Asia/Tokyo', 12 * 60 + 30, 15 * 60 + 30);
}

function sehkCashDue(now) {
  return cashSessionDue(now, 'Asia/Hong_Kong', 9 * 60 + 30, 12 * 60)
    || cashSessionDue(now, 'Asia/Hong_Kong', 13 * 60, 16 * 60);
}

module.exports = {
  zonedParts,
  cashSessionDue,
  usCashDue,
  tseCashDue,
  sehkCashDue,
};
