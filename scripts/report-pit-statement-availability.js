#!/usr/bin/env node
'use strict';

/**
 * Cache-only availability and coverage report for Part A.
 * It intentionally does not import or invoke any backtest or live-engine code.
 */
const fs = require('fs');
const path = require('path');
const {
  availability,
  buildPitPiotroskiScores,
} = require('../lib/research/pit-piotroski');

const root = path.join(__dirname, '..');
const cacheRoot = path.join(root, 'data', 'research', 'fmp');
const outputPath = path.join(__dirname, 'pit-statement-availability-report.json');
const markdownPath = path.join(__dirname, 'pit-statement-availability-report.md');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function statementArrays(symbolDirectory) {
  const read = endpoint => {
    const file = path.join(symbolDirectory, `${endpoint}.json`);
    if (!fs.existsSync(file)) return [];
    const record = readJson(file);
    return record.status === 'OK' && Array.isArray(record.rows) ? record.rows : [];
  };
  return {
    incomeStatements: read('income'),
    balanceSheets: read('balance'),
    cashFlowStatements: read('cashflow'),
  };
}

function reportMarket(market) {
  const marketDirectory = path.join(cacheRoot, market);
  const rows = { vendor: 0, deadline: 0, availabilityLags: [] };
  let symbols = 0;
  let symbolsWithAllStatements = 0;
  let symbolsWithFScore = 0;
  for (const entry of fs.readdirSync(marketDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    symbols++;
    const arrays = statementArrays(path.join(marketDirectory, entry.name));
    const allRows = [...arrays.incomeStatements, ...arrays.balanceSheets, ...arrays.cashFlowStatements];
    for (const row of allRows) {
      const record = availability(row, market);
      if (!record) continue;
      rows[record.source.toLowerCase()]++;
      rows.availabilityLags.push(Math.round(
        (Date.parse(record.availableOn) - Date.parse(record.periodEnd)) / (24 * 60 * 60 * 1000),
      ));
    }
    if (!arrays.incomeStatements.length || !arrays.balanceSheets.length || !arrays.cashFlowStatements.length) continue;
    symbolsWithAllStatements++;
    const scoreResult = buildPitPiotroskiScores({ ...arrays, market });
    if (scoreResult.eligible && scoreResult.scores.length) symbolsWithFScore++;
  }
  const cadence = ['UK', 'Germany', 'France'].includes(market)
    ? 'TWICE_YEARLY_SCORE_UPDATE'
    : 'QUARTERLY_SCORE_UPDATE';
  return {
    market,
    vendorDateRows: rows.vendor,
    deadlineOnlyRows: rows.deadline,
    medianAvailabilityLagDays: median(rows.availabilityLags),
    fScoreCoverage: {
      symbols,
      symbolsWithAllStatements,
      symbolsWithEnoughConsecutiveFilings: symbolsWithFScore,
      percentage: symbols ? Number((symbolsWithFScore / symbols * 100).toFixed(1)) : 0,
    },
    cadence,
  };
}

function markdown(report) {
  const lines = [
    '# PIT Statement Availability Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Legal-deadline availability',
    'Availability is the later of the applicable legal deadline and a plausible vendor date. A vendor date is accepted only when it is at least five days after period end and not before that deadline; US acceptedDate is preferred.',
    '',
    'Market | Vendor-date rows | Deadline-only rows | Median availability lag (days) | F-score coverage | Cadence',
    '--- | ---: | ---: | ---: | --- | ---',
    ...report.markets.map(item => [
      item.market,
      item.vendorDateRows,
      item.deadlineOnlyRows,
      item.medianAvailabilityLagDays,
      `${item.fScoreCoverage.symbolsWithEnoughConsecutiveFilings}/${item.fScoreCoverage.symbols} (${item.fScoreCoverage.percentage}%)`,
      item.cadence,
    ].join(' | ')),
    '',
    '## Parts B–E status',
    `BLOCKED: ${report.partsBtoEBlocker}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

const manifest = readJson(path.join(cacheRoot, 'manifest.json'));
const report = {
  generatedAt: new Date().toISOString(),
  source: 'data/research/fmp cached statement responses only',
  researchOnly: true,
  liveBehaviorChanged: false,
  legalDeadlineRules: {
    US: 'quarterly 45d; annual 90d',
    Japan: 'quarterly 45d; annual 90d',
    'Hong Kong': 'interim 60d; annual 90d',
    'UK/Germany/France': 'quarterly or half-yearly 90d; annual 120d',
    unknownPeriod: 'longer applicable deadline',
  },
  markets: manifest.markets.map(reportMarket),
  partsBtoEBlocker: 'No genuine runner replays the production trend entry/exit primitives with cached PIT F-scores. scripts/backtest-performance-program.js only emits a blocked report and explicitly performs no execution, so Parts B–E were not run.',
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(markdownPath, markdown(report));
console.log(`Wrote ${path.relative(root, outputPath)}`);
console.log(`Wrote ${path.relative(root, markdownPath)}`);
