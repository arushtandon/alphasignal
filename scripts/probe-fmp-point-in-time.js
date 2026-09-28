#!/usr/bin/env node
'use strict';

/**
 * Read-only capability probe. It never writes a credential or raw provider
 * response to disk; the report retains endpoint status and a redacted schema
 * sample only. This makes point-in-time eligibility auditable before a
 * backtest touches FMP data.
 */
const fs = require('fs');
const path = require('path');

const key = String(
  process.env.FMP_API_KEY || process.env.FMP_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '',
).trim();
const defaultOutput = path.join(__dirname, process.argv[2] || 'fmp-point-in-time-capability.json');

function normalize(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload ? [payload] : [];
}

function redactSample(value) {
  if (!value || typeof value !== 'object') return value;
  const allowed = [
    'symbol', 'date', 'publishedDate', 'createdAt', 'updatedAt', 'revisionDate',
    'filingDate', 'acceptedDate', 'reportedDate', 'fiscalDateEnding',
    'period', 'calendarYear', 'eps', 'epsActual', 'epsEstimated', 'estimatedEpsAvg',
    'actual', 'estimated', 'actualEarningResult', 'estimatedEarning', 'gradingCompany', 'newGrade',
    'previousGrade', 'action', 'priceTarget', 'priceTargetDate', 'score',
    'piotroskiScore', 'altmanZScore',
  ];
  const out = {};
  for (const field of allowed) if (value[field] != null) out[field] = value[field];
  return out;
}

async function probe(id, endpoint) {
  if (!key) {
    return { id, endpoint, status: 'NOT-CONFIGURED', sample: null };
  }
  const url = `https://financialmodelingprep.com${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* retained as status only */ }
    const rows = normalize(body);
    const first = rows.find(row => row && typeof row === 'object' && !row.error && !row['Error Message']) || null;
    const keys = first ? Object.keys(first).sort() : [];
    const dates = rows
      .map(row => row && (row.publishedDate || row.updatedAt || row.createdAt || row.revisionDate || row.date))
      .map(value => ({ value, ms: Date.parse(value) }))
      .filter(item => Number.isFinite(item.ms))
      .sort((a, b) => a.ms - b.ms);
    const spacingDays = dates.length > 1
      ? +(dates.slice(1).reduce((sum, item, index) => sum + (item.ms - dates[index].ms), 0) / (dates.length - 1) / 86400000).toFixed(1)
      : null;
    const hasObservationDate = keys.some(field => /^(date|publishedDate|createdAt|updatedAt)$/i.test(field));
    const hasRevisionTimestamp = keys.some(field => /revision|updatedAt|createdAt|publishedDate/i.test(field));
    const status = !response.ok
      ? (response.status === 401 || response.status === 403 || response.status === 402 ? 'NOT-ON-PLAN' : 'UNAVAILABLE')
      : first ? 'PRESENT' : 'EMPTY';
    return {
      id,
      endpoint,
      httpStatus: response.status,
      status,
      rowCount: rows.length,
      fields: keys,
      sample: redactSample(first),
      hasObservationDate,
      hasRevisionTimestamp,
      history: dates.length ? {
        earliestDate: dates[0].value,
        latestDate: dates[dates.length - 1].value,
        averageSpacingDays: spacingDays,
      } : null,
    };
  } catch (error) {
    return { id, endpoint, status: 'UNAVAILABLE', error: String(error.message || error), sample: null };
  }
}

function presentWithHistory(result, timestampPattern) {
  if (result?.status !== 'PRESENT') return null;
  return (result.fields || []).some(field => timestampPattern.test(field));
}

function classifyProbe(result, historyTest) {
  if (result?.status === 'NOT-CONFIGURED') return 'NOT-CONFIGURED';
  if (result?.status === 'NOT-ON-PLAN') return 'NOT-ON-PLAN';
  if (result?.status !== 'PRESENT') return result?.status || 'UNAVAILABLE';
  return historyTest ? 'PRESENT-with-history' : 'CURRENT-only';
}

function coverageMarket(symbol) {
  if (symbol.endsWith('.T')) return 'Japan';
  if (symbol.endsWith('.HK')) return 'Hong Kong';
  if (symbol.endsWith('.L')) return 'UK';
  if (symbol.endsWith('.DE')) return 'Germany';
  if (symbol.endsWith('.PA')) return 'France';
  return 'US';
}

async function coverageForSymbol(symbol) {
  const encoded = encodeURIComponent(symbol);
  const endpoints = await Promise.all([
    probe('grades_historical', `/stable/grades-historical?symbol=${encoded}`),
    probe('earnings', `/stable/earnings?symbol=${encoded}`),
    probe('income_statement_quarter', `/stable/income-statement?symbol=${encoded}&period=quarter&limit=20`),
    probe('balance_sheet_quarter', `/stable/balance-sheet-statement?symbol=${encoded}&period=quarter&limit=20`),
    probe('cash_flow_quarter', `/stable/cash-flow-statement?symbol=${encoded}&period=quarter&limit=20`),
  ]);
  return {
    symbol,
    market: coverageMarket(symbol),
    endpoints: Object.fromEntries(endpoints.map(result => [result.id, {
      status: result.status,
      rowCount: result.rowCount || 0,
      fields: result.fields || [],
    }])),
  };
}

async function runProbe(options = {}) {
  const output = options.outputFile || defaultOutput;
  const probes = await Promise.all([
    probe('analyst_estimates', '/stable/analyst-estimates?symbol=AAPL&period=quarter&page=0&limit=20'),
    probe('historical_grades', '/stable/grades-historical?symbol=AAPL'),
    probe('upgrades_downgrades_legacy', '/api/v4/upgrades-downgrades?symbol=AAPL'),
    probe('price_target_summary', '/stable/price-target-summary?symbol=AAPL'),
    probe('financial_scores_current', '/stable/financial-scores?symbol=AAPL'),
    probe('historical_rating_legacy', '/api/v3/historical-rating/AAPL?limit=20'),
    probe('earnings_history', '/stable/earnings?symbol=AAPL'),
    probe('earnings_surprises', '/stable/earnings-surprises?symbol=AAPL'),
    probe('income_statement_quarter', '/stable/income-statement?symbol=AAPL&period=quarter&limit=20'),
    probe('balance_sheet_quarter', '/stable/balance-sheet-statement?symbol=AAPL&period=quarter&limit=20'),
    probe('cash_flow_quarter', '/stable/cash-flow-statement?symbol=AAPL&period=quarter&limit=20'),
  ]);

  const find = id => probes.find(probe => probe.id === id);
  const estimates = find('analyst_estimates');
  const grades = find('historical_grades');
  const scores = find('financial_scores_current');
  const historicalRating = find('historical_rating_legacy');
  const earnings = find('earnings_history');
  const surprises = find('earnings_surprises');
  const statements = [
    find('income_statement_quarter'),
    find('balance_sheet_quarter'),
    find('cash_flow_quarter'),
  ];
  const hasGradeDate = presentWithHistory(grades, /^(date|publishedDate|createdAt|updatedAt)$/i);
  const hasEarningsReport = [earnings, surprises].some(result =>
    result?.status === 'PRESENT'
    && (result.fields || []).some(field => /^(date|reportedDate|publishedDate)$/i.test(field))
    && (result.fields || []).some(field => /^(epsActual|actual|actualEarningResult)$/i.test(field))
    && (result.fields || []).some(field => /^(epsEstimated|estimated|estimatedEpsAvg|estimatedEarning)$/i.test(field)));
  const statementFilingTimestamp = statements.map(result => ({
    id: result?.id,
    classification: classifyProbe(result, presentWithHistory(result, /^(filingDate|acceptedDate)$/i)),
    hasFilingTimestamp: presentWithHistory(result, /^(filingDate|acceptedDate)$/i),
  }));
  const capability = {
    analystEstimates: estimates?.status === 'NOT-CONFIGURED' ? 'NOT-CONFIGURED'
      : estimates?.status === 'PRESENT' && estimates.hasRevisionTimestamp
      ? 'PRESENT-with-history'
      : estimates?.status === 'PRESENT' ? 'CURRENT-only'
        : estimates?.status === 'NOT-ON-PLAN' ? 'NOT-ON-PLAN' : 'UNAVAILABLE',
    analystGradeHistory: classifyProbe(grades, hasGradeDate),
    financialScoresAsOf: (historicalRating?.status === 'NOT-CONFIGURED' || scores?.status === 'NOT-CONFIGURED') ? 'NOT-CONFIGURED'
      : historicalRating?.status === 'PRESENT' && historicalRating.hasObservationDate
      ? 'PRESENT-with-history'
      : scores?.status === 'PRESENT' ? 'CURRENT-only'
        : 'NOT-ON-PLAN',
    earningsSurprises: classifyProbe(
      earnings?.status === 'PRESENT' ? earnings : surprises,
      hasEarningsReport,
    ),
    statementQualityAsOf: statementFilingTimestamp,
  };
  const coverage = await Promise.all(
    ['7203.T', '0700.HK', 'SHEL.L', 'SAP.DE', 'MC.PA'].map(coverageForSymbol),
  );
  const result = {
    generatedAt: new Date().toISOString(),
    symbol: 'AAPL',
    credentialConfigured: Boolean(key),
    capability,
    gradeHistory: {
      ...(grades?.history || { earliestDate: null, latestDate: null, averageSpacingDays: null }),
      note: 'Spacing derives from dated rows returned in this redacted server-side capture.',
    },
    statementFilingTimestamp,
    coverage,
    probes,
    pointInTimeDecision: capability.analystEstimates === 'PRESENT-with-history'
      ? 'PART_C_ELIGIBLE'
      : 'PART_C_BLOCKED_NO_TIMESTAMPED_ESTIMATE_REVISION_HISTORY',
  };
  if (options.write !== false) fs.writeFileSync(output, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  runProbe().then(result => {
    console.log(JSON.stringify({
      output: defaultOutput,
      capability: result.capability,
      pointInTimeDecision: result.pointInTimeDecision,
    }, null, 2));
  }).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { runProbe };
