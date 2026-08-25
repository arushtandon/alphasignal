'use strict';

/**
 * IB exec.time is usually "yyyyMMdd  HH:mm:ss" in the TWS / listing clock.
 * Parse naive stamps in that zone so US cash hours are not labelled UTC.
 */
function wallTimeInZoneToUtcMs(year, month, day, hour, minute, second, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second || 0);
  if (!timeZone) return utcGuess;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const partsOf = (ms) => {
    const p = fmt.formatToParts(new Date(ms));
    const get = t => Number((p.find(x => x.type === t) || {}).value);
    return {
      y: get('year'), mo: get('month'), d: get('day'),
      h: get('hour'), mi: get('minute'), s: get('second')
    };
  };
  let ms = utcGuess;
  for (let i = 0; i < 3; i++) {
    const got = partsOf(ms);
    const gotMin = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi, got.s);
    const wantMin = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    const delta = wantMin - gotMin;
    if (delta === 0) break;
    ms += delta;
  }
  return ms;
}

function parseIbExecTime(t, timeZone) {
  const s = String(t || '').trim();
  if (!s) return NaN;
  if (/T/.test(s) || /Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const iso = Date.parse(s);
    if (Number.isFinite(iso)) return iso;
  }
  const m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const iso = Date.parse(s);
    return Number.isFinite(iso) ? iso : NaN;
  }
  return wallTimeInZoneToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], timeZone || 'UTC');
}

module.exports = { wallTimeInZoneToUtcMs, parseIbExecTime };
