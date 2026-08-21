'use strict';

const COST_MODEL_VERSION = 'implementation-cost-v1';

const PROFILES = Object.freeze({
  US: { commissionBps: 2, halfSpreadBps: 4, slippageBps: 5, taxBps: 0, fxBps: 0, borrowBpsPerDay: 0.5 },
  UK: { commissionBps: 4, halfSpreadBps: 8, slippageBps: 7, taxBps: 25, fxBps: 3, borrowBpsPerDay: 0.7 },
  EU: { commissionBps: 4, halfSpreadBps: 7, slippageBps: 6, taxBps: 0, fxBps: 3, borrowBpsPerDay: 0.7 },
  HK: { commissionBps: 5, halfSpreadBps: 9, slippageBps: 8, taxBps: 13, fxBps: 3, borrowBpsPerDay: 0.8 },
  JP: { commissionBps: 5, halfSpreadBps: 7, slippageBps: 7, taxBps: 0, fxBps: 3, borrowBpsPerDay: 0.7 },
  OTHER: { commissionBps: 6, halfSpreadBps: 10, slippageBps: 10, taxBps: 0, fxBps: 5, borrowBpsPerDay: 1 },
});

function marketFromSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/\.L$/.test(s)) return 'UK';
  if (/\.(DE|PA|AS|BR|MI|MC|ST|HE|CO|OL|SW)$/.test(s)) return 'EU';
  if (/\.HK$/.test(s)) return 'HK';
  if (/\.T$/.test(s)) return 'JP';
  if (/\.[A-Z]{1,3}$/.test(s)) return 'OTHER';
  return 'US';
}

function estimateRoundTripCostPct(opts = {}) {
  const market = opts.market || marketFromSymbol(opts.symbol);
  const profile = { ...(PROFILES[market] || PROFILES.OTHER), ...(opts.profile || {}) };
  const holdDays = Math.max(0, Number(opts.holdDays) || 0);
  const isSell = String(opts.side || '').toLowerCase() === 'sell';
  const impactBps = Math.max(0, Number(opts.impactBps) || 0);
  const borrowBps = isSell ? profile.borrowBpsPerDay * holdDays : 0;
  const oneWayExecution = profile.halfSpreadBps + profile.slippageBps + impactBps;
  const totalBps = (profile.commissionBps * 2) + (oneWayExecution * 2)
    + profile.taxBps + (profile.fxBps * 2) + borrowBps;
  return +(totalBps / 100).toFixed(4);
}

function applyCosts(grossReturn, opts = {}) {
  const gross = Number(grossReturn);
  if (!Number.isFinite(gross)) return null;
  const costPct = estimateRoundTripCostPct(opts);
  return {
    grossReturn: gross,
    costPct,
    netReturn: gross - costPct / 100,
    costModelVersion: COST_MODEL_VERSION,
  };
}

module.exports = {
  COST_MODEL_VERSION,
  PROFILES,
  marketFromSymbol,
  estimateRoundTripCostPct,
  applyCosts,
};
