'use strict';

/**
 * Dead-man's switch for the local IBKR bridge.
 *
 * The bridge is "seen" when it posts /api/ibkr/recon or polls /api/ibkr/events.
 * While a market we trade is open — or within 2 hours before a cash open or
 * the 06:00 SGT entry batch — 30 minutes without either signal is an outage.
 * Alerts repeat every 2 hours until a signal arrives.
 */

const STALE_MS = 30 * 60 * 1000;
const REPEAT_MS = 2 * 60 * 60 * 1000;
const LEAD_MINUTES = 120;

const CASH_SESSIONS = Object.freeze([
  { id: 'US', timeZone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
  { id: 'UK', timeZone: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30 },
  { id: 'Japan', timeZone: 'Asia/Tokyo', open: 9 * 60, close: 15 * 60 },
  { id: 'Hong Kong', timeZone: 'Asia/Hong_Kong', open: 9 * 60 + 30, close: 16 * 60 },
  { id: 'Germany', timeZone: 'Europe/Berlin', open: 9 * 60, close: 17 * 60 + 30 },
  { id: 'France', timeZone: 'Europe/Paris', open: 9 * 60, close: 17 * 60 + 30 },
]);

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
  const weekday = get('weekday');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
    weekend: weekday === 'Sat' || weekday === 'Sun',
    weekday,
  };
}

function cashOpen(now) {
  return CASH_SESSIONS.filter(session => {
    const clock = zoned(now, session.timeZone);
    if (clock.weekend) return false;
    return clock.minutes >= session.open && clock.minutes < session.close;
  }).map(session => session.id);
}

function openingSoon(now) {
  return CASH_SESSIONS.filter(session => {
    const clock = zoned(now, session.timeZone);
    if (clock.weekend) return false;
    return clock.minutes >= session.open - LEAD_MINUTES && clock.minutes < session.open;
  }).map(session => session.id);
}

/** 04:00–06:00 SGT on a weekday: the two hours before the daily entry batch. */
function batchSoon(now) {
  const clock = zoned(now, 'Asia/Singapore');
  if (clock.weekend) return false;
  return clock.minutes >= 4 * 60 && clock.minutes < 6 * 60;
}

/**
 * Commodity Globex: Sunday 18:00 ET through Friday 17:00 ET, with the daily
 * 17:00–18:00 ET halt. Saturday and Sunday before 18:00 ET are quiet.
 */
function commodityOpen(now) {
  const clock = zoned(now, 'America/New_York');
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[clock.weekday];
  if (day === 6) return false;
  if (day === 0 && clock.minutes < 18 * 60) return false;
  if (day === 5 && clock.minutes >= 17 * 60) return false;
  if (day >= 1 && day <= 4 && clock.minutes >= 17 * 60 && clock.minutes < 18 * 60) return false;
  return true;
}

function watchWindow(now) {
  const open = cashOpen(now);
  const lead = openingSoon(now);
  const batch = batchSoon(now);
  const commodity = commodityOpen(now);
  return {
    active: open.length > 0 || lead.length > 0 || batch || commodity,
    open,
    lead,
    batch,
    commodity,
  };
}

function evaluateBridgeWatch(state, now, uptimeMs = STALE_MS) {
  const watch = watchWindow(now);
  const seenMs = Date.parse(state && state.lastSeenAt);
  const seen = Number.isFinite(seenMs);
  const ageMs = seen ? now - seenMs : null;
  const stale = seen ? ageMs > STALE_MS : Number(uptimeMs) >= STALE_MS;
  const offline = watch.active && stale;
  const previousSince = state && state.offlineSince;
  let offlineSince = null;
  let alert = null;
  let lastAlertAt = state && state.lastAlertAt || null;
  if (offline) {
    offlineSince = previousSince || (seen ? state.lastSeenAt : new Date(now - Number(uptimeMs)).toISOString());
    const alertedMs = Date.parse(lastAlertAt || '');
    const due = !Number.isFinite(alertedMs) || now - alertedMs >= REPEAT_MS;
    if (due) {
      lastAlertAt = new Date(now).toISOString();
      alert = {
        kind: 'offline',
        text: `BRIDGE OFFLINE since ${offlineSince}. No recon or heartbeat for 30+ minutes while a traded market is open or a batch is due.`,
      };
    }
  } else if (previousSince) {
    alert = { kind: 'recovered', text: `Bridge back. It had been offline since ${previousSince}.` };
    lastAlertAt = null;
  }
  return {
    lastSeenAt: state && state.lastSeenAt || null,
    lastKind: state && state.lastKind || null,
    offline,
    offlineSince,
    lastAlertAt,
    ageMs,
    watch,
    alert,
    banner: offline ? `Bridge offline since ${offlineSince}` : null,
  };
}

module.exports = {
  STALE_MS,
  REPEAT_MS,
  LEAD_MINUTES,
  CASH_SESSIONS,
  zoned,
  watchWindow,
  evaluateBridgeWatch,
};
