'use strict';
/**
 * Single 06:00 SGT recommendation-release gate.
 *
 * A new model entry is allowed only when ALL of:
 *   1. Current Singapore time is at/after PICKS_REFRESH_HOUR_SGT (default 06:00).
 *   2. The event itself was stamped at/after that hour (a 02:10 emit cannot
 *      be executed later the same day).
 *   3. Callers that place IBKR orders also require today's board dashTs to
 *      be at/after 06:00 SGT (overnight shortlist scans are not "the board").
 *
 * userReentry / correctiveReentry are the only bypasses — never "rearm".
 */
const ENTRY_RELEASE_HOUR_SGT = Math.max(
  0,
  Math.min(23, parseInt(process.env.PICKS_REFRESH_HOUR_SGT || '6', 10) || 6)
);
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

function singaporeParts(ms = Date.now()) {
  const sgt = new Date(Number(ms) + SGT_OFFSET_MS);
  return {
    key: sgt.toISOString().slice(0, 10),
    hour: sgt.getUTCHours(),
    minute: sgt.getUTCMinutes()
  };
}

function minutesPastMidnight(parts) {
  return (Number(parts.hour) || 0) * 60 + (Number(parts.minute) || 0);
}

function isAfterDailyRecommendationRelease(ms = Date.now()) {
  return minutesPastMidnight(singaporeParts(ms)) >= ENTRY_RELEASE_HOUR_SGT * 60;
}

function eventStampedAtOrAfterRelease(evt) {
  const ts = Date.parse(evt && (evt.entryDate || evt.t) || 0);
  if (!Number.isFinite(ts)) return false;
  return minutesPastMidnight(singaporeParts(ts)) >= ENTRY_RELEASE_HOUR_SGT * 60;
}

function isManualEntryBypass(evt) {
  return !!(evt && (evt.userReentry === true || evt.correctiveReentry === true));
}

function isUsSetupEntry(evt) {
  if (!evt) return false;
  const market = String(evt.market || evt.country || '').toUpperCase();
  if (market === 'US' || market === 'USA') return true;
  return String(evt.setupId || '').startsWith('US_');
}

function zoneDayKey(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function usSessionDayKey(ms) {
  return zoneDayKey(ms, 'America/New_York');
}

/**
 * @param {object} evt
 * @param {number} [now]
 */
function entryReleaseBlock(evt, now = Date.now()) {
  if (!evt) return 'missing-event';
  if (isManualEntryBypass(evt)) return null;
  const ts = Date.parse(evt.entryDate || evt.t || 0);
  if (!Number.isFinite(ts)) return 'missing-timestamp';
  if (!eventStampedAtOrAfterRelease(evt)) return 'event-before-release-hour';
  if (isUsSetupEntry(evt)) {
    if (usSessionDayKey(ts) !== usSessionDayKey(now)) return 'older-than-todays-release';
    return null;
  }
  if (!isAfterDailyRecommendationRelease(now)) return 'before-release-hour';
  if (singaporeParts(ts).key !== singaporeParts(now).key) return 'older-than-todays-release';
  return null;
}

function scheduledEntryReleaseAllowed(evt, now = Date.now()) {
  return entryReleaseBlock(evt, now) == null;
}

/**
 * True only for today's board generated at/after the daily release hour.
 * A Friday 02:10 scan is never a published recommendation, even at 17:00 SGT.
 */
function boardPublishedAtRelease(dashTs, now = Date.now()) {
  const ts = Number(dashTs) || 0;
  if (!(ts > 0)) return false;
  if (!isAfterDailyRecommendationRelease(now)) return false;
  const generated = singaporeParts(ts);
  const current = singaporeParts(now);
  if (generated.key !== current.key) return false;
  return minutesPastMidnight(generated) >= ENTRY_RELEASE_HOUR_SGT * 60;
}

module.exports = {
  ENTRY_RELEASE_HOUR_SGT,
  singaporeParts,
  isAfterDailyRecommendationRelease,
  eventStampedAtOrAfterRelease,
  isManualEntryBypass,
  isUsSetupEntry,
  usSessionDayKey,
  entryReleaseBlock,
  scheduledEntryReleaseAllowed,
  boardPublishedAtRelease
};
