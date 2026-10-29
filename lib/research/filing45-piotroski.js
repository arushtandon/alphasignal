'use strict';

// Point-in-time Piotroski used by the U2 study: a filing is available
// 45 days after acceptedDate, else filingDate. A score needs income,
// balance sheet and cash flow for the same period end.

function field(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function filingAvailable(row) {
  const filed = row?.acceptedDate || row?.filingDate;
  const parsed = Date.parse(filed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + 45 * 86400000).toISOString().slice(0, 10);
}

function indexRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = String(row?.date || '').slice(0, 10);
    if (key) map.set(key, row);
  }
  return map;
}

function valuesOf(period) {
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
  const current = valuesOf(currentPeriod);
  const prior = valuesOf(priorPeriod);
  const base = current.totalAssets != null && prior.totalAssets != null
    ? (current.totalAssets + prior.totalAssets) / 2 : null;
  const roa = ratio(current.netIncome, base);
  const priorRoa = ratio(prior.netIncome, prior.totalAssets);
  const cfo = ratio(current.operatingCashFlow, base);
  const leverage = ratio(current.longTermDebt, current.totalAssets);
  const priorLeverage = ratio(prior.longTermDebt, prior.totalAssets);
  const currentRatio = ratio(current.currentAssets, current.currentLiabilities);
  const priorCurrentRatio = ratio(prior.currentAssets, prior.currentLiabilities);
  const margin = ratio(current.grossProfit, current.revenue);
  const priorMargin = ratio(prior.grossProfit, prior.revenue);
  const turnover = ratio(current.revenue, base);
  const priorTurnover = ratio(prior.revenue, prior.totalAssets);
  const components = [
    roa != null ? roa > 0 : null,
    cfo != null ? cfo > 0 : null,
    roa != null && priorRoa != null ? roa > priorRoa : null,
    current.operatingCashFlow != null && current.netIncome != null ? current.operatingCashFlow > current.netIncome : null,
    leverage != null && priorLeverage != null ? leverage < priorLeverage : null,
    currentRatio != null && priorCurrentRatio != null ? currentRatio > priorCurrentRatio : null,
    current.shares != null && prior.shares != null ? current.shares <= prior.shares : null,
    margin != null && priorMargin != null ? margin > priorMargin : null,
    turnover != null && priorTurnover != null ? turnover > priorTurnover : null,
  ];
  if (components.some(value => value == null)) return null;
  return {
    periodEnd: currentPeriod.periodEnd,
    availableOn: currentPeriod.availableOn,
    score: components.filter(Boolean).length,
  };
}

function cadenceOk(periods) {
  if (periods.length < 2) return false;
  for (let index = 1; index < periods.length; index += 1) {
    const days = (Date.parse(periods[index].periodEnd) - Date.parse(periods[index - 1].periodEnd)) / 86400000;
    const quarterly = days >= 70 && days <= 115;
    const annual = days >= 150 && days <= 230;
    if (!quarterly && !annual) return false;
  }
  return true;
}

function scoreStatements(income, balance, cash) {
  const periods = [];
  const balanceMap = indexRows(balance);
  const cashMap = indexRows(cash);
  for (const [key, incomeRow] of indexRows(income)) {
    const balanceRow = balanceMap.get(key);
    const cashRow = cashMap.get(key);
    if (!balanceRow || !cashRow) continue;
    const available = [filingAvailable(incomeRow), filingAvailable(balanceRow), filingAvailable(cashRow)];
    if (available.some(date => !date)) continue;
    available.sort();
    periods.push({
      periodEnd: key,
      availableOn: available[2],
      income: incomeRow,
      balance: balanceRow,
      cashflow: cashRow,
    });
  }
  periods.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  if (!periods.length) return { reason: 'no-filings', scores: [] };
  if (!cadenceOk(periods)) return { reason: 'cadence', scores: [] };
  const scores = [];
  for (let index = 1; index < periods.length; index += 1) {
    const score = scorePair(periods[index], periods[index - 1]);
    if (score) scores.push(score);
  }
  scores.sort((a, b) => (a.availableOn < b.availableOn ? -1 : 1));
  return { reason: scores.length ? null : 'incomplete-fields', scores };
}

function pioAt(scores, date) {
  let found = null;
  for (const row of scores || []) {
    if (row.availableOn <= date) found = row.score;
    else break;
  }
  return found;
}

module.exports = { scoreStatements, pioAt, filingAvailable };
