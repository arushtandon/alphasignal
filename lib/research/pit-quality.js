'use strict';

const {
  availableDate,
  buildPitPiotroskiScores,
  mergeStatements,
} = require('./pit-piotroski');

function number(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function periodEnd(row) {
  const value = row?.date || row?.fiscalDateEnding || row?.periodEnding;
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : null;
}

function ttm(rows, market, decisionDate) {
  const eligible = (rows || [])
    .map(row => ({ row, periodEnd: periodEnd(row), availableOn: availableDate(row, market) }))
    .filter(item => item.periodEnd && item.availableOn && item.availableOn < decisionDate)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  if (!eligible.length) return null;
  const count = String(eligible[0].row.period || '').toUpperCase().startsWith('H') ? 2 : 4;
  const recent = eligible.slice(0, count);
  if (recent.length !== count) return null;
  const values = recent.map(item => number(item.row, ['ebit', 'operatingIncome', 'operatingIncomeLoss']));
  const sales = recent.map(item => number(item.row, ['revenue', 'totalRevenue']));
  return values.every(value => value != null) && sales.every(value => value != null)
    ? { ebit: values.reduce((sum, value) => sum + value, 0), sales: sales.reduce((sum, value) => sum + value, 0) }
    : null;
}

function fxValue(fxAt, currency, date) {
  if (currency === 'USD') return 1;
  const value = typeof fxAt === 'function' ? fxAt(currency, date) : null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolves a cache-only FMP-compatible score as it was knowable before a
 * decision-date bar. fxAt returns USD per unit of the given currency.
 */
function scoreAtDecision(statementArrays, {
  market,
  decisionDate,
  close,
  fxAt,
  listingCurrency,
  listingPriceScale = 1,
} = {}) {
  if (!decisionDate || !(close > 0)) return { usable: false, reason: 'MISSING_DECISION_PRICE_OR_DATE' };
  const periods = mergeStatements({ ...statementArrays, market });
  const latest = periods.filter(period => period.availableOn < decisionDate).at(-1);
  const pioScores = buildPitPiotroskiScores({ ...statementArrays, market }).scores;
  const pio = pioScores.filter(score => score.availableOn < decisionDate).at(-1)?.score ?? null;
  if (!latest) return { usable: false, piotroski: pio, altmanZ: null, reason: 'NO_AVAILABLE_BALANCE_SHEET' };

  const balance = latest.balance;
  const incomeTtm = ttm(statementArrays.incomeStatements, market, decisionDate);
  const shares = number(latest.income, [
    'weightedAverageShsOutDil', 'weightedAverageShsOut', 'commonStockSharesOutstanding',
  ]) ?? number(balance, ['commonStockSharesOutstanding']);
  const currentAssets = number(balance, ['totalCurrentAssets']);
  const currentLiabilities = number(balance, ['totalCurrentLiabilities']);
  const retainedEarnings = number(balance, ['retainedEarnings', 'retainedEarningsTotal']);
  const assets = number(balance, ['totalAssets']);
  const liabilities = number(balance, ['totalLiabilities', 'totalLiabilitiesAndStockholdersEquity']);
  const statementCurrency = String(balance?.reportedCurrency || listingCurrency || '').toUpperCase();
  const priceCurrency = String(listingCurrency || statementCurrency).toUpperCase();
  const statementFx = fxValue(fxAt, statementCurrency, decisionDate);
  const priceFx = fxValue(fxAt, priceCurrency, decisionDate);
  const complete = [
    shares, currentAssets, currentLiabilities, retainedEarnings, assets, liabilities,
    incomeTtm?.ebit, incomeTtm?.sales, statementFx, priceFx,
  ].every(Number.isFinite) && assets > 0 && liabilities > 0;
  if (!complete) {
    return {
      usable: pio != null,
      piotroski: pio,
      altmanZ: null,
      reason: statementFx == null || priceFx == null ? 'MISSING_SAME_DATE_FX' : 'INCOMPLETE_ALTMAN_INPUTS',
      availableOn: latest.availableOn,
    };
  }
  const marketValueEquity = close * listingPriceScale * shares * priceFx;
  const assetsUsd = assets * statementFx;
  const liabilitiesUsd = liabilities * statementFx;
  const altmanZ = 1.2 * ((currentAssets - currentLiabilities) * statementFx / assetsUsd)
    + 1.4 * (retainedEarnings * statementFx / assetsUsd)
    + 3.3 * (incomeTtm.ebit * statementFx / assetsUsd)
    + 0.6 * (marketValueEquity / liabilitiesUsd)
    + (incomeTtm.sales * statementFx / assetsUsd);
  const pScore = pio == null ? null : Math.round((pio * 10) / 9);
  const aScore = altmanZ > 2.99 ? 9 : altmanZ > 1.81 ? 6 : 3;
  const qualityScore = [pScore, aScore].filter(Number.isFinite);
  return {
    usable: pio != null && Number.isFinite(altmanZ),
    piotroski: pio,
    altmanZ,
    qualityScore: qualityScore.length ? Math.round(qualityScore.reduce((sum, value) => sum + value, 0) / qualityScore.length) : null,
    availableOn: latest.availableOn,
    inputs: { shares, marketValueEquity, statementCurrency, priceCurrency, listingPriceScale, ttm: incomeTtm },
  };
}

module.exports = { scoreAtDecision };
