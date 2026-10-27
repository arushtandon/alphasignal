#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const input = path.join(__dirname, 'backtest-omitted-geo-rescue-results.json');
const output = path.join(__dirname, '..', 'docs', 'omitted-geo-rescue-readout.md');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const overlapRisk = String(report.methodology?.holdoutValidity || '').includes('OVERLAP_RISK');
const value = v => v == null ? '—' : v;
const lines = [
  '# Omitted-geography rescue readout',
  '',
  `Run: ${report.generatedAt}`,
  '',
  'Backtest only. No live rule, live bracket, or paused sell-book setting changed.',
  '',
  '## Per-cell holdout results',
  '',
  '| Geography | Horizon | Model | n | Win % | PF | PnL | Avg win % | Avg loss % | Confidence | Decision |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
];
for (const cell of report.cells) {
  const h = cell.holdout;
  const noBaselineEvents = h.trades === 0 && cell.development.trades === 0;
  const decision = noBaselineEvents ? 'NOT EVALUABLE: no PIT production-entry replay'
    : cell.sampleConfidence.promotable ? (overlapRisk ? 'CANDIDATE ONLY: overlap-risk holdout' : 'PROMOTABLE')
      : cell.sampleConfidence.rejectionReason || 'REJECTED';
  lines.push(`| ${cell.market} | ${cell.horizon} | ${cell.frozenModel} | ${value(h.trades)} | ${value(h.winRate)} | ${value(h.profitFactor)} | ${value(h.pnlUsd)} | ${value(h.avgWinPct)} | ${value(h.avgLossPct)} | ${cell.sampleConfidence.flag} | ${decision} |`);
}
const promotable = report.cells.filter(cell => cell.sampleConfidence.promotable);
const rejected = report.cells.filter(cell => !cell.sampleConfidence.promotable && !(cell.holdout.trades === 0 && cell.development.trades === 0));
const blocked = report.cells.filter(cell => cell.holdout.trades === 0 && cell.development.trades === 0);
lines.push('', '## PROMOTABLE', '');
lines.push(overlapRisk
  ? 'None. The trailing holdout overlaps prior studies, so any metric pass is candidate-only.'
  : promotable.length ? promotable.map(cell => `- ${cell.market} ${cell.horizon} buy: ${cell.sampleConfidence.flag}.`).join('\n') : 'None.');
lines.push('', '## REJECTED', '');
lines.push(rejected.length ? rejected.map(cell => `- ${cell.market} ${cell.horizon} buy: ${cell.sampleConfidence.rejectionReason || cell.sampleConfidence.flag}.`).join('\n') : 'None.');
lines.push('', '## NOT EVALUABLE', '');
lines.push(blocked.length
  ? blocked.map(cell => `- ${cell.market} ${cell.horizon} buy: exact production replay generated no point-in-time eligible entry events, so this is not a negative strategy result.`).join('\n')
  : 'None.');
lines.push('', '## RETIRE', '');
for (const market of ['France', 'Germany', 'HK', 'UK', 'Commodities']) {
  const marketCells = report.cells.filter(cell => cell.market === market);
  const ok = !overlapRisk && marketCells.some(cell => cell.sampleConfidence.promotable);
  const evaluable = marketCells.some(cell => !(cell.holdout.trades === 0 && cell.development.trades === 0));
  lines.push(`- ${market}: ${ok ? 'not retired; a promotable cell exists.' : overlapRisk ? 'no retirement decision: trailing holdout overlap risk.' : evaluable ? 'RETIRED for this study; no eligible cell cleared all safeguards.' : 'not retired: study data gate prevented an honest test.'}`);
}
lines.push('', '## Data-gated factors', '');
lines.push('- France SBF-120 and Germany HDAX expansion were not represented as successful tests until dated pre-holdout constituent snapshots are supplied; using today’s membership would be survivorship bias.');
lines.push('- HK Southbound/A-H, UK revenue/GBP, and FMP earnings gates are reported as unavailable/ineligible unless their dated point-in-time sources are verified.');
lines.push('- Ineligible factor-horizon combinations were not tested by construction.');
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(output);
