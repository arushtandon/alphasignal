'use strict';

const crypto = require('crypto');

const DECISION_SCHEMA_VERSION = 1;
const DEFAULT_POLICY = Object.freeze({
  version: process.env.STRATEGY_RULES_VERSION || 'capital-readiness-v1',
  minScore: Number(process.env.PICKS_MIN_SCORE || 62),
  strongBuyScore: Number(process.env.PICKS_STRONG_BUY_SCORE || 78),
  strongSellScore: Number(process.env.PICKS_STRONG_SELL_SCORE || 74),
  minConfidence: Number(process.env.PICKS_MIN_CONF || 62),
  minRewardRisk: Number(process.env.PICKS_MIN_RR || 1.1),
});

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function deriveActionRating(buyScore, sellScore, policy = DEFAULT_POLICY) {
  const buy = finiteNumber(buyScore);
  const sell = finiteNumber(sellScore);
  if (buy >= sell) {
    if (buy >= policy.strongBuyScore) return { action: 'Buy', rating: 'Strong Buy' };
    if (buy >= policy.minScore) return { action: 'Buy', rating: 'Buy' };
    return { action: 'Hold', rating: 'Hold' };
  }
  if (sell >= policy.strongSellScore) return { action: 'Sell', rating: 'Strong Sell' };
  if (sell >= policy.minScore) return { action: 'Sell', rating: 'Sell' };
  return { action: 'Hold', rating: 'Hold' };
}

function rewardRisk(entry, target, stop, side) {
  const e = finiteNumber(entry, NaN);
  const t = finiteNumber(target, NaN);
  const s = finiteNumber(stop, NaN);
  if (![e, t, s].every(Number.isFinite) || e <= 0) return null;
  const isSell = String(side || '').toLowerCase() === 'sell';
  const reward = isSell ? e - t : t - e;
  const risk = isSell ? s - e : e - s;
  return reward > 0 && risk > 0 ? reward / risk : null;
}

function evaluateSignalDecision(input, policy = DEFAULT_POLICY) {
  const signal = input && input.signal ? input.signal : {};
  const actionRating = deriveActionRating(signal.buyScore, signal.sellScore, policy);
  const side = actionRating.action === 'Sell' ? 'sell' : actionRating.action === 'Buy' ? 'buy' : null;
  const confidence = finiteNumber(signal.winRateHint ?? input.confidence);
  const rr = input.rewardRisk != null
    ? finiteNumber(input.rewardRisk, null)
    : rewardRisk(input.entry, input.target, input.stop, side);
  const checks = {
    actionable: Boolean(side),
    sideAllowed: side ? input.side !== 'buy' && input.side !== 'sell' ? true : input.side === side : false,
    confidence: confidence >= policy.minConfidence,
    rewardRisk: rr == null ? input.requireLevels !== true : rr >= policy.minRewardRisk,
    earnings: input.earningsBlocked !== true,
    cooldown: input.cooldownBlocked !== true,
    risk: input.riskBlocked !== true,
    bracket: input.bracketEnabled !== false,
    dataFresh: input.dataFresh !== false,
  };
  const rejectionReasons = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    policyVersion: policy.version,
    action: rejectionReasons.length ? 'Hold' : actionRating.action,
    rating: rejectionReasons.length ? 'Hold' : actionRating.rating,
    candidateAction: actionRating.action,
    candidateRating: actionRating.rating,
    side,
    confidence,
    rewardRisk: rr,
    eligible: rejectionReasons.length === 0,
    checks,
    rejectionReasons,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createDecisionSnapshot(input, policy = DEFAULT_POLICY) {
  const asOf = input.asOf || new Date().toISOString();
  const decision = input.decision || evaluateSignalDecision(input, policy);
  const canonical = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    rulesVersion: policy.version,
    asOf,
    ticker: String(input.ticker || '').toUpperCase(),
    horizon: input.horizon || 'short',
    signal: {
      buyScore: finiteNumber(input.signal && input.signal.buyScore),
      sellScore: finiteNumber(input.signal && input.signal.sellScore),
      confidence: decision.confidence,
    },
    levels: {
      entry: finiteNumber(input.entry, null),
      stop: finiteNumber(input.stop, null),
      target: finiteNumber(input.target, null),
      rewardRisk: decision.rewardRisk,
    },
    decision: {
      action: decision.action,
      rating: decision.rating,
      candidateAction: decision.candidateAction,
      eligible: decision.eligible,
      checks: decision.checks,
      rejectionReasons: decision.rejectionReasons,
    },
    context: input.context || {},
  };
  const digest = crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
  return { decisionId: `d1_${digest.slice(0, 24)}`, ...canonical, inputHash: digest };
}

module.exports = {
  DECISION_SCHEMA_VERSION,
  DEFAULT_POLICY,
  deriveActionRating,
  rewardRisk,
  evaluateSignalDecision,
  createDecisionSnapshot,
  stableJson,
};
