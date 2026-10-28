'use strict';

/** First tick at or after these Singapore minutes may retry a failed morning. */
const SLOTS = Object.freeze([
  Object.freeze({ id: '0630', minutes: 6 * 60 + 30 }),
  Object.freeze({ id: '0700', minutes: 7 * 60 }),
]);

function morningNeedsRetry({ plans = 0, cards = 0, scanError = false } = {}) {
  return scanError === true || (Number(plans) > 0 && Number(cards) === 0);
}

/**
 * One slot per call. A scan that is still running does not consume the slot.
 * The 07:00 slot alerts only when it is not itself launching another retry.
 */
function morningRetryDecision(state = {}) {
  const done = { ...(state.done || {}) };
  const decision = { retry: false, slot: null, alert: false, done };
  if (state.scanRunning) return decision;
  const minutes = Number(state.minutes) || 0;
  for (const slot of SLOTS) {
    if (minutes < slot.minutes || done[slot.id]) continue;
    done[slot.id] = true;
    const needs = morningNeedsRetry(state);
    if (needs) {
      decision.retry = true;
      decision.slot = slot.id;
      decision.alertAfter = slot.id === '0700';
    }
    break;
  }
  return decision;
}

function shouldAlertEmptyMorning(reason, plans, cards) {
  return reason === 'morning-retry-0700' && Number(plans) > 0 && Number(cards) === 0;
}

module.exports = {
  SLOTS,
  morningNeedsRetry,
  morningRetryDecision,
  shouldAlertEmptyMorning,
};
