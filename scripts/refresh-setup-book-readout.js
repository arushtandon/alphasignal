#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { rejectionReason } = require('../lib/research/validated-setup-book');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'scripts', 'validated-setup-book-results.json');
const READOUT = path.join(ROOT, 'docs', 'validated-setup-book-readout.md');
const CHECKPOINT = path.join(ROOT, 'scripts', 'validated-setup-book-checkpoint.json');

const report = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
report.cells.forEach(cell => {
  cell.rejectionReason = cell.control ? null : rejectionReason(cell);
});
report.methodology.preregistration = 'docs/validated-setup-book-preregistration.md';
report.liveRouterImplemented = false;
report.liveBehaviorChanged = false;
report.flagsEnabled = [];

const metric = value => value == null ? '—' : value;
const rows = report.cells.map(cell => `| ${cell.market} | ${cell.horizon} | ${cell.label} | ${cell.control ? 'CONTROL' : cell.verdict} | ${metric(cell.development.trades)} | ${metric(cell.development.picksPerMonth)} | ${metric(cell.development.winRate)}% | ${metric(cell.development.profitFactor)} | $${metric(cell.development.pnlUsd)} | ${metric(cell.development.averageWinPct)}% / ${metric(cell.development.averageLossPct)}% | ${metric(cell.measuredConfidence)}% | ${metric(cell.holdout.trades)} | ${metric(cell.holdout.winRate)}% | ${metric(cell.holdout.profitFactor)} | $${metric(cell.holdout.pnlUsd)} | ${cell.bhPass ? 'PASS' : 'FAIL'} (${metric(cell.bhQValue)}) | ${cell.rejectionReason || '—'} |`);
const book = report.setupBook.map(row => `| ${row.market} | ${row.horizon} | ${row.setup || row.reason} | ${row.verdict} | ${metric(row.expectedWinRate)}% | ${metric(row.holdoutWinRate)}% | ${metric(row.holdoutProfitFactor)} | ${metric(row.picksPerMonth)} |`);
const text = [
  '# Validated Setup Book Readout',
  '',
  `Generated: ${report.generatedAt}`,
  '',
  'Research only. No feature flag was enabled and no live recommendation, order, or deployment setting was changed.',
  `All ${report.methodology.bhFamilySize} tested control/setup rows share one Benjamini-Hochberg family. The trailing holdout is ${report.methodology.holdoutStatus} and cannot produce a VALIDATED verdict.`,
  '',
  '## One-page recommendation specification',
  '| Market | Horizon | Setup | Verdict | Dev Conf / WR | Holdout WR | Holdout PF | Picks / month |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
  ...book,
  '',
  '## Full setup results',
  '| Market | Hz | Setup | Verdict | Dev n | Picks/mo | Dev WR | Dev PF | Dev PnL | Avg win/loss | Conf | Holdout n | Holdout WR | Holdout PF | Holdout PnL | BH q | Why rejected |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ...rows,
  '',
  'Per-year breakdowns and fold-level results are in `scripts/validated-setup-book-results.json`.',
  '',
  '## Reference only',
  'The August Danelfin-era paper results remain historical operational evidence only. They were not used for selection, confidence, BH testing, or promotion.',
  '',
  '## Live router',
  report.validatedCount
    ? 'A VALIDATED setup exists. Any live router must remain behind SETUP_BOOK_ENABLED (default off) and must not be enabled by this study.'
    : 'No VALIDATED setup. The designed `SETUP_BOOK_ENABLED` router is not wired into pick generation or IBKR. The flag stays off and every cell remains `NO RECOMMENDATION` / `NO_VALIDATED_SETUP`.',
  '',
].join('\n');

fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(READOUT, `${text}\n`);
fs.writeFileSync(CHECKPOINT, `${JSON.stringify({
  version: 1,
  study: report.study,
  state: 'complete',
  completedAt: report.generatedAt,
  output: 'scripts/validated-setup-book-results.json',
  cells: report.cells.length,
}, null, 2)}\n`);
console.log('Refreshed setup-book results, readout, and checkpoint.');
