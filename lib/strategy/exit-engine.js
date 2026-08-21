'use strict';

const EXIT_POLICY_VERSION = process.env.EXIT_RULES_VERSION || 'hybrid-exit-v1';

const HORIZON_POLICY = Object.freeze({
  short: Object.freeze({ maxHoldDays: 20, partialFraction: 0.5, mode: 'mean-reversion' }),
  medium: Object.freeze({ maxHoldDays: 63, partialFraction: 0.5, mode: 'hybrid-trailing' }),
  long: Object.freeze({ maxHoldDays: 180, partialFraction: 0.5, mode: 'hybrid-trailing' }),
});

function exitPolicyFor(horizon) {
  return HORIZON_POLICY[horizon] || HORIZON_POLICY.short;
}

function horizonHoldDays(horizon) {
  return exitPolicyFor(horizon).maxHoldDays;
}

function normalizePartialFraction(value, horizon) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return exitPolicyFor(horizon).partialFraction;
}

function netReturnAfterCost(grossReturn, roundTripCostPct) {
  const gross = Number(grossReturn);
  const costPct = Number(roundTripCostPct);
  if (!Number.isFinite(gross)) return null;
  return gross - (Number.isFinite(costPct) ? costPct / 100 : 0);
}

module.exports = {
  EXIT_POLICY_VERSION,
  HORIZON_POLICY,
  exitPolicyFor,
  horizonHoldDays,
  normalizePartialFraction,
  netReturnAfterCost,
};
