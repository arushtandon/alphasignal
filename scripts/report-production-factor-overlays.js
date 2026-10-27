#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const input = process.argv[2] || path.join(__dirname, 'backtest-production-factor-overlays-results.json');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));

function value(number, decimals = 1) {
  return number != null && Number.isFinite(Number(number)) ? Number(number).toFixed(decimals) : '—';
}

console.log(`Production overlay study: ${report.generatedAt}`);
console.log(`Universe: ${Object.entries(report.methodology.loadedPerMarket)
  .map(([market, count]) => `${market} ${count}`).join(', ')}`);
console.log('Market | Horizon | Side | Baseline n/WR/PnL/PF | Challenger factors | New n/WR/PnL/PF | Delta WR/PnL | Status');
for (const cell of report.cells) {
  const baseline = cell.baselineHoldout;
  const challenger = cell.holdout;
  const factors = cell.factors.length ? cell.factors.join('+') : 'none';
  console.log([
    cell.market,
    cell.horizon,
    cell.side,
    `${baseline.trades}/${value(baseline.winRate)}%/$${value(baseline.pnlUsd, 0)}/${value(baseline.profitFactor, 2)}`,
    factors,
    `${challenger.trades}/${value(challenger.winRate)}%/$${value(challenger.pnlUsd, 0)}/${value(challenger.profitFactor, 2)}`,
    `${value(cell.holdoutDelta.winRatePctPoints)}pp/$${value(cell.holdoutDelta.pnlUsd, 0)}`,
    cell.status,
  ].join(' | '));
}

const passed = report.cells.filter(cell => cell.status === 'PASS');
console.log(`Passed: ${passed.length}/${report.cells.length}`);
if (!passed.length) {
  console.log('Recommendation: keep every live cell on current rules; no factor overlay met promotion safeguards.');
}
