#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'backtest-usjp-regime-stabilize-results.json'), 'utf8'));
const output = path.join(__dirname, '..', 'docs', 'usjp-regime-stabilize-readout.md');
const value = number => number == null ? '—' : number;
const lines = [
  '# US/JP mean-reversion regime stabilization readout',
  '',
  `Run: ${report.generatedAt}`,
  '',
  'Holdout status: OVERLAP_RISK. It is a reserved trailing fold but overlaps earlier research, so no result is promotable.',
  '',
  '## Baseline versus frozen regime variants',
  '',
  '| Cell | Variant | Dev pass folds | Holdout n | Holdout win % | PF | PnL | Confidence | Verdict |',
  '|---|---|---:|---:|---:|---:|---:|---|---|',
];
for (const cell of report.cells) {
  const verdict = cell.sampleConfidence.pass ? 'CANDIDATE_ONLY_OVERLAP_RISK' : cell.sampleConfidence.rejectionReason;
  lines.push(`| ${cell.market} ${cell.horizon} buy | ${cell.variant} | ${cell.stableDevelopmentFolds} | ${value(cell.holdout.trades)} | ${value(cell.holdout.winRate)} | ${value(cell.holdout.profitFactor)} | ${value(cell.holdout.pnlUsd)} | ${cell.sampleConfidence.flag} | ${verdict} |`);
  lines.push(`|  | folds 1/2/3 | ${cell.developmentFoldTests.map(fold => `${value(fold.winRate)}%/${value(fold.profitFactor)}/$${value(fold.pnlUsd)}`).join(' · ')} |  |  |  |  |  |  |`);
}
const qualified = report.cells.filter(cell => cell.sampleConfidence.pass);
lines.push('', '## Verdict', '');
lines.push(qualified.length
  ? `Metric-qualified variants: ${qualified.map(cell => `${cell.market} ${cell.horizon} ${cell.variant}`).join('; ')}. They remain overlap-risk diagnostics, not live candidates.`
  : 'None of the frozen regime variants stabilized a US/JP cell under the full diagnostic gate.');
lines.push('', 'A filter that merely reduces trade count without increasing qualifying development folds is not treated as stabilization.');
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(output);
