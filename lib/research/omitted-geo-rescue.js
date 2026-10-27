'use strict';

const FACTOR_HORIZONS = Object.freeze({
  liquidity_top_decile: ['short', 'medium', 'long'],
  hk_southbound_flow: ['medium', 'long'],
  hk_ah_discount: ['medium', 'long'],
  uk_revenue_partition: ['medium', 'long'],
  uk_weak_gbp: ['medium', 'long'],
  earnings_fundamental: ['medium', 'long'],
});

function factorEligibility(factor, horizon, options = {}) {
  const allowed = FACTOR_HORIZONS[factor] || [];
  if (!allowed.includes(horizon)) return { eligible: false, reason: 'ineligible: factor-horizon mismatch' };
  if (factor.startsWith('hk_') && options.market !== 'HK') return { eligible: false, reason: 'ineligible: factor-geography mismatch' };
  if (factor.startsWith('uk_') && options.market !== 'UK') return { eligible: false, reason: 'ineligible: factor-geography mismatch' };
  if (factor === 'earnings_fundamental' && options.fmpPointInTime !== true) {
    return { eligible: false, reason: 'ineligible: no verified point-in-time FMP history' };
  }
  return { eligible: true, reason: null };
}

// Exact one-sided P[X >= wins] for X~Binomial(n, 0.5), computed recursively to
// avoid using a normal approximation in the mandated thin-sample safeguard.
function binomialWinPValue(wins, trades) {
  const n = Math.max(0, Math.floor(trades));
  const k = Math.max(0, Math.min(n, Math.floor(wins)));
  if (!n) return 1;
  let probability = 2 ** -n;
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += probability;
    if (i < n) probability *= (n - i) / (i + 1);
  }
  return Math.min(1, tail);
}

function sampleConfidence(holdout, stableDevelopmentFolds) {
  const trades = Number(holdout?.trades) || 0;
  const winRate = Number(holdout?.winRate);
  const pf = Number(holdout?.profitFactor);
  const pnl = Number(holdout?.pnlUsd);
  const wins = Math.round(trades * winRate / 100);
  const pValue = binomialWinPValue(wins, trades);
  const common = winRate >= 60 && pnl > 0 && stableDevelopmentFolds >= 2;
  if (trades >= 30 && common && pf >= 1.3) return { flag: 'FULL', pValue, pass: true };
  if (trades >= 15 && trades < 30 && common && pf >= 1.6 && pValue < 0.05) {
    return { flag: 'THIN n15-29-passed-safeguard', pValue, pass: true };
  }
  return { flag: 'FAIL', pValue, pass: false };
}

function classifyCell(cell) {
  const confidence = sampleConfidence(cell.holdout, cell.stableDevelopmentFolds);
  const highWinLowPf = Number(cell.holdout?.winRate) >= 60 && Number(cell.holdout?.profitFactor) < 1.3;
  return {
    ...confidence,
    highWinLowPf,
    promotable: confidence.pass && cell.mtcPass === true,
    rejectionReason: confidence.pass && cell.mtcPass !== true
      ? 'multiple-testing control'
      : highWinLowPf ? 'rejected bleeder: win target with PF below 1.3'
        : confidence.pass ? null : 'promotion thresholds or sample-confidence safeguard not met',
  };
}

module.exports = { FACTOR_HORIZONS, factorEligibility, binomialWinPValue, sampleConfidence, classifyCell };
