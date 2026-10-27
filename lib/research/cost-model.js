'use strict';

const COST_MODEL_VERSION = 'implementation-cost-v1';

const PROFILES = Object.freeze({
  US: { commissionBps: 2, halfSpreadBps: 4, slippageBps: 5, taxBps: 0, fxBps: 0, borrowBpsPerDay: 0.5 },
  // UK SDRT is 0.5% on the purchase leg, i.e. 50 bps per round trip.
  UK: { commissionBps: 4, halfSpreadBps: 8, slippageBps: 7, taxBps: 50, fxBps: 3, borrowBpsPerDay: 0.7 },
  EU: { commissionBps: 4, halfSpreadBps: 7, slippageBps: 6, taxBps: 0, fxBps: 3, borrowBpsPerDay: 0.7 },
  HK: { commissionBps: 5, halfSpreadBps: 9, slippageBps: 8, taxBps: 13, fxBps: 3, borrowBpsPerDay: 0.8 },
  JP: { commissionBps: 5, halfSpreadBps: 7, slippageBps: 7, taxBps: 0, fxBps: 3, borrowBpsPerDay: 0.7 },
  OTHER: { commissionBps: 6, halfSpreadBps: 10, slippageBps: 10, taxBps: 0, fxBps: 5, borrowBpsPerDay: 1 },
});

function researchMarketProfile(market, symbol) {
  const raw = String(market || '').trim().toUpperCase();
  if (raw === 'GERMANY' || raw === 'FRANCE' || raw === 'EUROPE' || raw === 'EU') return 'EU';
  if (raw === 'JAPAN' || raw === 'JP') return 'JP';
  if (raw === 'HONG KONG' || raw === 'HK') return 'HK';
  if (raw === 'UNITED KINGDOM' || raw === 'UK' || raw === 'FTSE100') return 'UK';
  if (raw === 'UNITED STATES' || raw === 'US') return 'US';
  if (raw === 'COMMODITIES' || raw === 'COMMODITY' || raw === 'CRYPTO') return 'OTHER';
  if (PROFILES[raw]) return raw;
  return marketFromSymbol(symbol);
}

function marketFromSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/\.L$/.test(s)) return 'UK';
  if (/\.(DE|PA|AS|BR|MI|MC|ST|HE|CO|OL|SW)$/.test(s)) return 'EU';
  if (/\.HK$/.test(s)) return 'HK';
  if (/\.T$/.test(s)) return 'JP';
  if (/\.[A-Z]{1,3}$/.test(s)) return 'OTHER';
  return 'US';
}

// Stamp duty / SDRT exemptions: UK ETFs (no SDRT on ETF purchases) and HK
// ETFs (stamp duty waived since 13 Feb 2015). Only ETFs the books trade are
// listed; pass `etf: true` for any other ETF.
const STAMP_EXEMPT_ETFS = new Set(['ISF.L', 'VUKE.L', 'CUKX.L', '2800.HK', '2828.HK', '3188.HK']);

function stampExempt(symbol, opts = {}) {
  if (opts.etf === true) return true;
  return STAMP_EXEMPT_ETFS.has(String(symbol || '').toUpperCase());
}

function estimateRoundTripCostPct(opts = {}) {
  const market = researchMarketProfile(opts.market, opts.symbol);
  const profile = { ...(PROFILES[market] || PROFILES.OTHER), ...(opts.profile || {}) };
  if ((market === 'UK' || market === 'HK') && stampExempt(opts.symbol, opts)) profile.taxBps = 0;
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
  STAMP_EXEMPT_ETFS,
  stampExempt,
  researchMarketProfile,
  marketFromSymbol,
  estimateRoundTripCostPct,
  applyCosts,
};
