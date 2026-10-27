'use strict';

const MARKETS = Object.freeze(['US', 'Japan', 'Hong Kong', 'UK', 'Germany', 'France']);
const HORIZONS = Object.freeze(['short', 'medium', 'long']);
const FUNDAMENTAL_HORIZONS = Object.freeze(['medium', 'long']);
const HORIZON_EMBARGO = Object.freeze({ short: 20, medium: 63, long: 180 });

function emptyMetrics() {
  return {
    trades: null,
    winRate: null,
    profitFactor: null,
    pnlUsd: null,
    averageWinLoss: null,
    folds: [],
  };
}

function statementDataAvailable(capability) {
  const coverage = capability?.coverage || [];
  return coverage.length > 0 && coverage.every(record => [
    'income_statement_quarter',
    'balance_sheet_quarter',
    'cash_flow_quarter',
  ].every(endpoint => {
    const result = record?.endpoints?.[endpoint];
    return result?.rowCount > 0 && (result.acceptedDatePresent || result.filingDatePresent);
  }));
}

function blockedCell(part, market, horizon, side, reason) {
  return {
    part,
    market,
    horizon,
    side,
    status: 'BLOCKED_NO_RENDER_FMP_DATA',
    reason,
    holdoutStatus: 'NOT_EVALUABLE',
    confidence: 'NOT_EVALUABLE',
    bhStatus: 'NOT_EVALUABLE_NO_TESTED_CELLS',
    metrics: emptyMetrics(),
  };
}

function attachment(source, report, note) {
  const rows = Array.isArray(report?.cells) ? report.cells : report?.results || [];
  const statusSummary = rows.reduce((summary, row) => {
    const status = row?.status || 'UNSPECIFIED';
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {});
  return {
    source,
    study: report?.study || null,
    generatedAt: report?.generatedAt || null,
    status: 'ATTACHED_NOT_RERUN',
    note,
    cells: Array.isArray(report?.cells) ? report.cells.length : null,
    variants: Array.isArray(report?.variants) ? report.variants.length : null,
    holdoutValidity: report?.methodology?.holdoutValidity || null,
    statusSummary,
  };
}

function createPerformanceProgramReport({ capability, factorResults, meanReversionResults }) {
  const hasStatements = statementDataAvailable(capability);
  const reason = hasStatements ? null
    : 'No Render/FMP quarterly statement arrays with acceptedDate or filingDate are available; PIT quality backtests were not run.';
  const cells = [];
  for (const market of MARKETS) {
    cells.push({
      part: 'A',
      market,
      status: hasStatements ? 'READY_FOR_PIT_INPUT' : 'BLOCKED_NO_RENDER_FMP_DATA',
      reason,
      coverage: 'NOT_VALIDATED',
    });
    for (const horizon of FUNDAMENTAL_HORIZONS) {
      for (const side of ['buy', 'sell']) {
        cells.push(blockedCell('B', market, horizon, side, reason));
        cells.push(blockedCell('C', market, horizon, side, reason));
        cells.push(blockedCell('D', market, horizon, side, reason));
      }
      cells.push(blockedCell('E', market, horizon, 'sell', reason));
      cells.push(blockedCell('E_CONTROL', market, horizon, 'sell', reason));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    study: 'performance-research-program-v1',
    mode: 'BACKTEST_ONLY',
    liveBehaviorChanged: false,
    preregistration: 'docs/performance-program-preregistration.md',
    methodology: {
      folds: { developmentBars: 504, validationBars: 126, holdoutBars: 126 },
      horizons: HORIZONS,
      fundamentalHorizons: FUNDAMENTAL_HORIZONS,
      embargoBars: HORIZON_EMBARGO,
      multiplicity: 'Benjamini-Hochberg across all tested cells and variants',
      promotion: 'holdout win rate >=60%, PF >=1.3, positive PnL, plus frozen FULL/THIN safeguards',
      executedCells: hasStatements ? 0 : 0,
      bhStatus: 'NOT_EVALUABLE_NO_TESTED_CELLS',
    },
    pointInTimeStatements: {
      available: hasStatements,
      capabilityDecision: capability?.pointInTimeDecision || null,
      reason,
    },
    cells,
    attachments: [
      attachment(
        'scripts/backtest-production-factor-overlays-results.json',
        factorResults,
        'Recorded price-only confirming-factor results; attached without rerun.',
      ),
      attachment(
        'scripts/backtest-usjp-regime-stabilize-results.json',
        meanReversionResults,
        'Recorded US/JP mean-reversion regime study; its OVERLAP_RISK label is retained.',
      ),
    ],
    conclusion: hasStatements
      ? 'PIT statement arrays are present but no execution is performed by this report builder.'
      : 'NOT_EVALUABLE: no claims, performance results, or promotion decisions are produced without Render/FMP PIT statement data.',
  };
}

function performanceProgramReadout(report) {
  const blocked = report.cells.filter(cell => cell.status === 'BLOCKED_NO_RENDER_FMP_DATA').length;
  const lines = [
    '# Performance Research Program Readout',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Outcome',
    report.conclusion,
    '',
    '## Execution safeguards',
    '- Backtest-only; no live signal, risk, bracket, exit, or execution behavior changed.',
    `- 504/126/126 date-aligned harness specified; BH status: ${report.methodology.bhStatus}.`,
    `- PIT quality cells blocked/not evaluable: ${blocked}.`,
    '',
    '## Attached prior evidence (not re-run)',
    ...report.attachments.map(item => `- ${item.source}: ${item.status}; ${item.note}`
      + (item.holdoutValidity ? ` Holdout validity: ${item.holdoutValidity}.` : '')),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = {
  MARKETS,
  HORIZONS,
  FUNDAMENTAL_HORIZONS,
  HORIZON_EMBARGO,
  statementDataAvailable,
  createPerformanceProgramReport,
  performanceProgramReadout,
};
