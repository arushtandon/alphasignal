'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  availability,
  buildPitPiotroskiScores,
  validateStatementCoverage,
} = require('../lib/research/pit-piotroski');
const {
  createPerformanceProgramReport,
  performanceProgramReadout,
} = require('../lib/research/performance-program');

function statement(date, acceptedDate, values) {
  return { date, acceptedDate, ...values };
}

test('PIT Piotroski score uses legal-deadline availability for consecutive filings', () => {
  const dates = ['2023-03-31', '2023-06-30', '2023-09-30'];
  const accepted = ['2023-05-10', '2023-08-10', '2023-11-10'];
  const result = buildPitPiotroskiScores({
    market: 'US',
    incomeStatements: dates.map((date, index) => statement(date, accepted[index], {
      period: `Q${index + 1}`,
      netIncome: [10, 20, 30][index],
      revenue: [100, 120, 150][index],
      grossProfit: [40, 54, 75][index],
      weightedAverageShsOut: [100, 99, 98][index],
    })),
    balanceSheets: dates.map((date, index) => statement(date, accepted[index], {
      period: `Q${index + 1}`,
      totalAssets: [100, 110, 120][index],
      longTermDebt: [50, 45, 40][index],
      totalCurrentAssets: [60, 70, 80][index],
      totalCurrentLiabilities: [40, 40, 40][index],
    })),
    cashFlowStatements: dates.map((date, index) => statement(date, accepted[index], {
      period: `Q${index + 1}`,
      operatingCashFlow: [12, 25, 36][index],
    })),
  });
  assert.equal(result.eligible, true);
  assert.equal(result.scores.length, 2);
  assert.equal(result.scores.at(-1).availableOn, '2023-11-14');
  assert.equal(result.scores.at(-1).score, 9);
});

test('legal deadlines reject placeholder dates and accept late US vendor dates', () => {
  assert.deepEqual(availability(
    statement('2023-03-31', '2023-03-31', { period: 'Q1' }),
    'Japan',
  ), {
    periodEnd: '2023-03-31',
    deadlineOn: '2023-05-15',
    vendorDate: null,
    availableOn: '2023-05-15',
    source: 'DEADLINE',
  });
  assert.equal(availability(
    statement('2023-03-31', '2023-05-20', { period: 'Q1' }),
    'US',
  ).source, 'VENDOR');
  assert.equal(availability(
    statement('2023-12-31', '2024-02-01', {}),
    'France',
  ).availableOn, '2024-04-29');
});

test('coverage validation permits deadline-derived constant lags', () => {
  const deadlineDerived = validateStatementCoverage([{
    market: 'US',
    incomeStatements: [
      statement('2023-03-31', '2023-03-31', { period: 'Q1' }),
      statement('2023-06-30', '2023-06-30', { period: 'Q2' }),
      statement('2023-09-30', '2023-09-30', { period: 'Q3' }),
    ],
  }]);
  assert.equal(deadlineDerived[0].eligible, true);
  assert.equal(deadlineDerived[0].reason, null);
  assert.equal(deadlineDerived[0].minLagDays, 45);
});

test('program report is blocked without configured FMP PIT statements and preserves attachments', () => {
  const report = createPerformanceProgramReport({
    capability: { pointInTimeDecision: 'PART_C_BLOCKED_NO_TIMESTAMPED_ESTIMATE_REVISION_HISTORY', coverage: [] },
    factorResults: { study: 'production-factor-overlays-v1', generatedAt: '2026-09-24T00:00:00.000Z', cells: [] },
    meanReversionResults: {
      study: 'usjp-regime-stabilize-v1',
      generatedAt: '2026-09-27T00:00:00.000Z',
      methodology: { holdoutValidity: 'OVERLAP_RISK' },
      variants: [],
    },
  });
  assert.equal(report.liveBehaviorChanged, false);
  assert.equal(report.methodology.executedCells, 0);
  assert.ok(report.cells.some(cell => cell.status === 'BLOCKED_NO_RENDER_FMP_DATA'));
  assert.equal(report.attachments[1].holdoutValidity, 'OVERLAP_RISK');
  assert.match(performanceProgramReadout(report), /NOT_EVALUABLE/);
});
