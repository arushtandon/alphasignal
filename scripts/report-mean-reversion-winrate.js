#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const input = path.join(__dirname, 'backtest-mean-reversion-winrate-results.json');
const output = path.join(__dirname, '..', 'docs', 'mean-reversion-winrate-readout.md');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const fmt = value => value == null ? '—' : value;
const lines = [
  '# Mean-reversion win-rate study readout',
  '',
  `Run: ${report.generatedAt}`,
  '',
  'This is a backtest-only parallel buy book. No live rules, brackets, or sell books changed.',
  '',
  '## Holdout results',
  '',
  '| Geography | Horizon | Frozen model | n | Win % | PF | Net PnL ($10k/trade) | Result |',
  '|---|---|---|---:|---:|---:|---:|---|',
];
for (const cell of report.cells) {
  const h = cell.holdout;
  const reason = cell.status.pass ? 'PASS' : Object.entries(cell.status.checks).filter(([, value]) => !value).map(([key]) => key).join(', ');
  lines.push(`| ${cell.market} | ${cell.horizon} | ${cell.frozenModel.id} | ${fmt(h.trades)} | ${fmt(h.winRate)} | ${fmt(h.profitFactor)} | ${fmt(h.pnlUsd)} | ${reason} |`);
}
const bleeding = report.cells.filter(cell => cell.highWinLowPfReject);
const passing = report.cells.filter(cell => cell.status.pass);
lines.push('', '## Decision', '');
lines.push(passing.length
  ? `The following cells cleared every pre-registered gate: ${passing.map(cell => `${cell.market} ${cell.horizon}`).join(', ')}. They remain research candidates only.`
  : 'No cell cleared every pre-registered gate. Nothing is eligible for promotion.');
lines.push('', '## High-win / low-PF rejections', '');
lines.push(bleeding.length
  ? bleeding.map(cell => `- ${cell.market} ${cell.horizon}: holdout win ${cell.holdout.winRate}%, PF ${cell.holdout.profitFactor}, PnL $${cell.holdout.pnlUsd}; rejected because PF is below 1.3.`).join('\n')
  : 'None of the frozen holdout models achieved the win-rate target solely by breaching the PF floor.');
lines.push('', '## Interpretation', '');
lines.push('- Holdout-only strength is not sufficient: the development-fold stability rule prevents selection after a regime-specific lucky run.');
lines.push('- Germany and France have only 39 usable names, and commodities only 10, so those samples are below the requested 70–80-name breadth.');
lines.push('- FMP point-in-time capability was not locally verifiable because no FMP credential is configured; Part C was not run and no current fundamental data was substituted.');
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(output);
