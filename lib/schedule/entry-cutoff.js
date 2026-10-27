'use strict';

/**
 * How long a setup-book entry skipped for stale margin data may be retried.
 * The cut-off is the cash close of the session the order is for: the close
 * of the market's clock on the event's local day, or the next weekday's
 * close when the event arrives after that close (the 06:00 SGT US batch
 * lands after the previous US close).
 */

const { SETUPS } = require('../strategy/evidence-setup-book');

const CLOCKS = Object.freeze({
  US: { timeZone: 'America/New_York', close: 16 * 60 },
  Japan: { timeZone: 'Asia/Tokyo', close: 15 * 60 },
  'Hong Kong': { timeZone: 'Asia/Hong_Kong', close: 16 * 60 },
  UK: { timeZone: 'Europe/London', close: 16 * 60 + 30 },
  Germany: { timeZone: 'Europe/Berlin', close: 17 * 60 + 30 },
  France: { timeZone: 'Europe/Paris', close: 17 * 60 + 30 },
  Commodities: { timeZone: 'America/New_York', close: 17 * 60 },
});

function zoned(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
    weekend: get('weekday') === 'Sat' || get('weekday') === 'Sun',
  };
}

function addDays(date, count) {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + count);
  return cursor.toISOString().slice(0, 10);
}

function nextWeekday(date) {
  let cursor = addDays(date, 1);
  for (let step = 0; step < 6; step += 1) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

/** UTC instant of `minutes` past midnight on `date` in `timeZone` (DST-safe). */
function utcAtLocal(date, minutes, timeZone) {
  let guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
  for (let pass = 0; pass < 4; pass += 1) {
    const clock = zoned(guess, timeZone);
    const got = Date.parse(`${clock.date}T00:00:00Z`) + clock.minutes * 60000;
    const want = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
    if (got === want) return guess;
    guess += want - got;
  }
  return guess;
}

function clockFor(evt) {
  const market = (evt && evt.setupId && SETUPS[evt.setupId] && SETUPS[evt.setupId].market)
    || (evt && evt.market)
    || 'US';
  return CLOCKS[market] || CLOCKS.US;
}

function sessionEntryCutoffMs(evt, nowMs = Date.now()) {
  const clock = clockFor(evt);
  const from = Date.parse(evt && (evt.t || evt.entryDate)) || nowMs;
  const local = zoned(from, clock.timeZone);
  let date = local.date;
  if (local.weekend || local.minutes >= clock.close) date = nextWeekday(date);
  return utcAtLocal(date, clock.close, clock.timeZone);
}

function entryRetryOpen(evt, nowMs = Date.now()) {
  return nowMs < sessionEntryCutoffMs(evt, nowMs);
}

function partitionStaleRetries(events, nowMs = Date.now()) {
  const retry = [];
  const expired = [];
  for (const evt of events || []) {
    if (entryRetryOpen(evt, nowMs)) retry.push(evt);
    else expired.push(evt);
  }
  return { retry, expired };
}

module.exports = {
  CLOCKS,
  zoned,
  utcAtLocal,
  sessionEntryCutoffMs,
  entryRetryOpen,
  partitionStaleRetries,
};
