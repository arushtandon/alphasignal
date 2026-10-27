'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKET_DEADLINES = Object.freeze({
  US: { periodic: 45, annual: 90 },
  Japan: { periodic: 45, annual: 90 },
  'Hong Kong': { periodic: 60, annual: 90 },
  UK: { periodic: 90, annual: 120 },
  Germany: { periodic: 90, annual: 120 },
  France: { periodic: 90, annual: 120 },
  UNKNOWN: { periodic: 120, annual: 120 },
});

function field(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function dateValue(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString().slice(0, 10);
  }
  return null;
}

function periodKey(row) {
  return dateValue(row, ['date', 'fiscalDateEnding', 'periodEnding', 'calendarYear']);
}

function legalDeadlineDays(market, row) {
  const deadlines = MARKET_DEADLINES[market] || MARKET_DEADLINES.UNKNOWN;
  const period = String(row?.period || row?.fiscalPeriod || '').trim().toUpperCase();
  return ['FY', 'ANNUAL', 'YEAR', 'Y'].includes(period) ? deadlines.annual
    : period ? deadlines.periodic : deadlines.annual;
}

function vendorDate(row, market) {
  const names = market === 'US'
    ? ['acceptedDate', 'filingDate']
    : ['filingDate', 'acceptedDate'];
  for (const name of names) {
    const value = dateValue(row, [name]);
    if (!value) continue;
    const periodEnd = periodKey(row);
    const lagDays = Math.round((Date.parse(value) - Date.parse(periodEnd)) / DAY_MS);
    if (lagDays >= 5 && lagDays >= legalDeadlineDays(market, row)) return value;
  }
  return null;
}

function availability(row, market) {
  const periodEnd = periodKey(row);
  if (!periodEnd) return null;
  const deadlineOn = new Date(Date.parse(periodEnd) + legalDeadlineDays(market, row) * DAY_MS)
    .toISOString().slice(0, 10);
  const plausibleVendorDate = vendorDate(row, market);
  return {
    periodEnd,
    deadlineOn,
    vendorDate: plausibleVendorDate,
    availableOn: plausibleVendorDate && plausibleVendorDate >= deadlineOn ? plausibleVendorDate : deadlineOn,
    source: plausibleVendorDate && plausibleVendorDate >= deadlineOn ? 'VENDOR' : 'DEADLINE',
  };
}

function availableDate(row, market = 'UNKNOWN') {
  return availability(row, market)?.availableOn || null;
}

function indexStatements(rows) {
  return new Map((rows || []).map(row => [periodKey(row), row]).filter(([key]) => key));
}

function mergeStatements({ incomeStatements, balanceSheets, cashFlowStatements, market = 'UNKNOWN' }) {
  const income = indexStatements(incomeStatements);
  const balance = indexStatements(balanceSheets);
  const cashflow = indexStatements(cashFlowStatements);
  return [...income.keys()]
    .filter(key => balance.has(key) && cashflow.has(key))
    .map(key => {
      const rows = [income.get(key), balance.get(key), cashflow.get(key)];
      const dates = rows.map(row => availableDate(row, market));
      return dates.every(Boolean) ? {
        periodEnd: key,
        availableOn: dates.sort().at(-1),
        income: income.get(key),
        balance: balance.get(key),
        cashflow: cashflow.get(key),
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

function values(period) {
  const income = period.income;
  const balance = period.balance;
  const cashflow = period.cashflow;
  const totalAssets = field(balance, ['totalAssets']);
  return {
    netIncome: field(income, ['netIncome', 'netIncomeLoss']),
    operatingCashFlow: field(cashflow, ['operatingCashFlow', 'netCashProvidedByOperatingActivities']),
    totalAssets,
    longTermDebt: field(balance, ['longTermDebt', 'longTermDebtNoncurrent']),
    currentAssets: field(balance, ['totalCurrentAssets']),
    currentLiabilities: field(balance, ['totalCurrentLiabilities']),
    shares: field(income, ['weightedAverageShsOutDil', 'weightedAverageShsOut', 'commonStockSharesOutstanding'])
      ?? field(balance, ['commonStockSharesOutstanding']),
    grossProfit: field(income, ['grossProfit']),
    revenue: field(income, ['revenue', 'totalRevenue']),
  };
}

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator : null;
}

function scorePair(currentPeriod, priorPeriod) {
  const current = values(currentPeriod);
  const prior = values(priorPeriod);
  const currentAssetBase = current.totalAssets != null && prior.totalAssets != null
    ? (current.totalAssets + prior.totalAssets) / 2 : null;
  const roa = ratio(current.netIncome, currentAssetBase);
  const priorRoa = ratio(prior.netIncome, prior.totalAssets);
  const cfo = ratio(current.operatingCashFlow, currentAssetBase);
  const leverage = ratio(current.longTermDebt, current.totalAssets);
  const priorLeverage = ratio(prior.longTermDebt, prior.totalAssets);
  const currentRatio = ratio(current.currentAssets, current.currentLiabilities);
  const priorCurrentRatio = ratio(prior.currentAssets, prior.currentLiabilities);
  const margin = ratio(current.grossProfit, current.revenue);
  const priorMargin = ratio(prior.grossProfit, prior.revenue);
  const turnover = ratio(current.revenue, currentAssetBase);
  const priorTurnover = ratio(prior.revenue, prior.totalAssets);
  const components = {
    roaPositive: roa != null ? roa > 0 : null,
    cfoPositive: cfo != null ? cfo > 0 : null,
    roaImproving: roa != null && priorRoa != null ? roa > priorRoa : null,
    cfoExceedsNetIncome: current.operatingCashFlow != null && current.netIncome != null
      ? current.operatingCashFlow > current.netIncome : null,
    leverageDecreasing: leverage != null && priorLeverage != null ? leverage < priorLeverage : null,
    currentRatioImproving: currentRatio != null && priorCurrentRatio != null
      ? currentRatio > priorCurrentRatio : null,
    noDilution: current.shares != null && prior.shares != null ? current.shares <= prior.shares : null,
    grossMarginImproving: margin != null && priorMargin != null ? margin > priorMargin : null,
    assetTurnoverImproving: turnover != null && priorTurnover != null ? turnover > priorTurnover : null,
  };
  if (Object.values(components).some(value => value == null)) return null;
  return {
    periodEnd: currentPeriod.periodEnd,
    availableOn: currentPeriod.availableOn,
    score: Object.values(components).filter(Boolean).length,
    components,
  };
}

function cadenceDays(periods) {
  return periods.slice(1).map((period, index) =>
    (Date.parse(period.periodEnd) - Date.parse(periods[index].periodEnd)) / DAY_MS);
}

function cadenceIsEligible(periods) {
  const gaps = cadenceDays(periods);
  return gaps.length > 0 && gaps.every(days => (days >= 70 && days <= 115) || (days >= 150 && days <= 230));
}

function buildPitPiotroskiScores(statementArrays) {
  const periods = mergeStatements(statementArrays);
  if (!cadenceIsEligible(periods)) {
    return { eligible: false, reason: 'INELIGIBLE_STATEMENT_CADENCE', periods, scores: [] };
  }
  const scores = periods.slice(1).map((period, index) => scorePair(period, periods[index])).filter(Boolean);
  return {
    eligible: scores.length > 0,
    reason: scores.length ? null : 'INCOMPLETE_CONSECUTIVE_FILINGS',
    periods,
    scores,
  };
}

function validateStatementCoverage(records, options = {}) {
  const minObservations = Math.max(2, Number(options.minObservations) || 3);
  const byMarket = new Map();
  for (const record of records || []) {
    const rows = [
      ...(record.incomeStatements || []),
      ...(record.balanceSheets || []),
      ...(record.cashFlowStatements || []),
    ];
    for (const row of rows) {
      const periodEnd = dateValue(row, ['date', 'fiscalDateEnding', 'periodEnding']);
      const availabilityRecord = availability(row, record.market);
      const availableOn = availabilityRecord?.availableOn;
      if (!periodEnd || !availableOn) continue;
      const lagDays = Math.round((Date.parse(availableOn) - Date.parse(periodEnd)) / DAY_MS);
      if (!byMarket.has(record.market)) byMarket.set(record.market, []);
      byMarket.get(record.market).push(lagDays);
    }
  }
  return [...byMarket.entries()].map(([market, lags]) => {
    const uniqueLags = new Set(lags);
    const eligible = lags.length >= minObservations;
    return {
      market,
      observations: lags.length,
      minLagDays: lags.length ? Math.min(...lags) : null,
      maxLagDays: lags.length ? Math.max(...lags) : null,
      uniqueLagDays: uniqueLags.size,
      eligible,
      reason: eligible ? null : 'INSUFFICIENT_STATEMENT_AVAILABILITY',
    };
  });
}

module.exports = {
  MARKET_DEADLINES,
  legalDeadlineDays,
  vendorDate,
  availability,
  availableDate,
  mergeStatements,
  buildPitPiotroskiScores,
  validateStatementCoverage,
};
