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
const output = path.join(__dirname, process.argv[2] || 'fmp-point-in-time-capability.json');

function normalize(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload ? [payload] : [];
}

function redactSample(value) {
  if (!value || typeof value !== 'object') return value;
  const allowed = [
    'symbol', 'date', 'publishedDate', 'createdAt', 'updatedAt', 'fiscalDateEnding',
    'period', 'calendarYear', 'epsActual', 'epsEstimated', 'estimatedEpsAvg',
    'actualEarningResult', 'estimatedEarning', 'gradingCompany', 'newGrade',
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
    };
  } catch (error) {
    return { id, endpoint, status: 'UNAVAILABLE', error: String(error.message || error), sample: null };
  }
}

async function runProbe(options = {}) {
  const probes = await Promise.all([
    probe('analyst_estimates', '/stable/analyst-estimates?symbol=AAPL&period=quarter&page=0&limit=20'),
    probe('historical_grades', '/stable/grades-historical?symbol=AAPL'),
    probe('upgrades_downgrades_legacy', '/api/v4/upgrades-downgrades?symbol=AAPL'),
    probe('price_target_summary', '/stable/price-target-summary?symbol=AAPL'),
    probe('financial_scores_current', '/stable/financial-scores?symbol=AAPL'),
    probe('historical_rating_legacy', '/api/v3/historical-rating/AAPL?limit=20'),
    probe('earnings_history', '/stable/earnings?symbol=AAPL'),
    probe('earnings_surprises', '/stable/earnings-surprises?symbol=AAPL'),
  ]);

  const find = id => probes.find(probe => probe.id === id);
  const estimates = find('analyst_estimates');
  const grades = find('historical_grades');
  const scores = find('financial_scores_current');
  const historicalRating = find('historical_rating_legacy');
  const earnings = find('earnings_history');
  const surprises = find('earnings_surprises');
  const capability = {
    analystEstimates: estimates?.status === 'NOT-CONFIGURED' ? 'NOT-CONFIGURED'
      : estimates?.status === 'PRESENT' && estimates.hasRevisionTimestamp
      ? 'PRESENT-with-history'
      : estimates?.status === 'PRESENT' ? 'CURRENT-only'
        : estimates?.status === 'NOT-ON-PLAN' ? 'NOT-ON-PLAN' : 'UNAVAILABLE',
    analystGradeHistory: grades?.status === 'NOT-CONFIGURED' ? 'NOT-CONFIGURED'
      : grades?.status === 'PRESENT' && grades.hasObservationDate
      ? 'PRESENT-with-history'
      : 'NOT-ON-PLAN',
    financialScoresAsOf: (historicalRating?.status === 'NOT-CONFIGURED' || scores?.status === 'NOT-CONFIGURED') ? 'NOT-CONFIGURED'
      : historicalRating?.status === 'PRESENT' && historicalRating.hasObservationDate
      ? 'PRESENT-with-history'
      : scores?.status === 'PRESENT' ? 'CURRENT-only'
        : 'NOT-ON-PLAN',
    earningsSurprises: (earnings?.status === 'NOT-CONFIGURED' || surprises?.status === 'NOT-CONFIGURED') ? 'NOT-CONFIGURED'
      : (earnings?.status === 'PRESENT' && earnings.hasObservationDate)
      || (surprises?.status === 'PRESENT' && surprises.hasObservationDate)
      ? 'PRESENT-with-history'
      : 'NOT-ON-PLAN',
  };
  const result = {
    generatedAt: new Date().toISOString(),
    symbol: 'AAPL',
    credentialConfigured: Boolean(key),
    capability,
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
      output,
      capability: result.capability,
      pointInTimeDecision: result.pointInTimeDecision,
    }, null, 2));
  }).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { runProbe };
