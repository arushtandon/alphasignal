'use strict';

const PORTFOLIO_POLICY_VERSION = 'portfolio-caps-v1';
const DEFAULT_CAPS = Object.freeze({
  grossPct: Number(process.env.MAX_GROSS_EXPOSURE_PCT || 0.30),
  netAbsPct: Number(process.env.MAX_NET_EXPOSURE_PCT || 0.20),
  singleNamePct: Number(process.env.MAX_SINGLE_NAME_PCT || 0.025),
  sectorPct: Number(process.env.MAX_SECTOR_EXPOSURE_PCT || 0.10),
  countryPct: Number(process.env.MAX_COUNTRY_EXPOSURE_PCT || 0.20),
  currencyPct: Number(process.env.MAX_CURRENCY_EXPOSURE_PCT || 0.25),
  clusterPct: Number(process.env.MAX_CORRELATION_CLUSTER_PCT || 0.15),
  openStopRiskPct: Number(process.env.MAX_OPEN_STOP_RISK_PCT || 0.03),
  dailyNewRiskPct: Number(process.env.MAX_DAILY_NEW_RISK_PCT || 0.01),
});

function exposureMap(positions, field) {
  const out = {};
  for (const p of positions || []) {
    const key = String(p[field] || 'UNKNOWN').toUpperCase();
    out[key] = (out[key] || 0) + Math.abs(Number(p.notionalUsd) || 0);
  }
  return out;
}

function summarizePortfolio(positions, nlv) {
  const equity = Number(nlv) || 0;
  let gross = 0;
  let net = 0;
  let openStopRisk = 0;
  const byTicker = {};
  for (const p of positions || []) {
    const notional = Math.abs(Number(p.notionalUsd) || 0);
    const signed = (String(p.side || 'buy').toLowerCase() === 'sell' ? -1 : 1) * notional;
    gross += notional;
    net += signed;
    openStopRisk += Math.abs(Number(p.stopRiskUsd) || 0);
    const ticker = String(p.ticker || 'UNKNOWN').toUpperCase();
    byTicker[ticker] = (byTicker[ticker] || 0) + notional;
  }
  return {
    nlv: equity,
    grossUsd: gross,
    netUsd: net,
    openStopRiskUsd: openStopRisk,
    grossPct: equity > 0 ? gross / equity : 1,
    netPct: equity > 0 ? net / equity : 1,
    openStopRiskPct: equity > 0 ? openStopRisk / equity : 1,
    byTicker,
    bySector: exposureMap(positions, 'sector'),
    byCountry: exposureMap(positions, 'country'),
    byCurrency: exposureMap(positions, 'currency'),
    byCluster: exposureMap(positions, 'cluster'),
  };
}

function evaluatePortfolioAddition(input, caps = DEFAULT_CAPS) {
  const nlv = Number(input.nlv);
  if (!(nlv > 0)) return { allowed: false, reasons: ['missing-nlv'], version: PORTFOLIO_POLICY_VERSION };
  const candidate = {
    ticker: input.ticker,
    side: input.side,
    notionalUsd: Number(input.notionalUsd) || 0,
    stopRiskUsd: Number(input.stopRiskUsd) || 0,
    sector: input.sector,
    country: input.country,
    currency: input.currency,
    cluster: input.cluster,
  };
  const next = summarizePortfolio([...(input.positions || []), candidate], nlv);
  const ticker = String(candidate.ticker || 'UNKNOWN').toUpperCase();
  const sector = String(candidate.sector || 'UNKNOWN').toUpperCase();
  const country = String(candidate.country || 'UNKNOWN').toUpperCase();
  const currency = String(candidate.currency || 'UNKNOWN').toUpperCase();
  const cluster = String(candidate.cluster || 'UNKNOWN').toUpperCase();
  const known = value => value && value !== 'UNKNOWN';
  const dailyNewRiskPct = ((Number(input.dailyNewRiskUsd) || 0) + candidate.stopRiskUsd) / nlv;
  const checks = {
    gross: next.grossPct <= caps.grossPct,
    net: Math.abs(next.netPct) <= caps.netAbsPct,
    singleName: (next.byTicker[ticker] || 0) / nlv <= caps.singleNamePct,
    sector: !known(sector) || (next.bySector[sector] || 0) / nlv <= caps.sectorPct,
    country: !known(country) || (next.byCountry[country] || 0) / nlv <= caps.countryPct,
    currency: !known(currency) || (next.byCurrency[currency] || 0) / nlv <= caps.currencyPct,
    cluster: !known(cluster) || (next.byCluster[cluster] || 0) / nlv <= caps.clusterPct,
    openStopRisk: next.openStopRiskPct <= caps.openStopRiskPct,
    dailyNewRisk: dailyNewRiskPct <= caps.dailyNewRiskPct,
  };
  const reasons = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    allowed: reasons.length === 0,
    reasons,
    checks,
    projected: next,
    dailyNewRiskPct,
    version: PORTFOLIO_POLICY_VERSION,
  };
}

module.exports = {
  PORTFOLIO_POLICY_VERSION,
  DEFAULT_CAPS,
  summarizePortfolio,
  evaluatePortfolioAddition,
};
