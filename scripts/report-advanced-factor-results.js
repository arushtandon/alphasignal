#!/usr/bin/env node
'use strict';

const path = require('path');

const input = process.argv[2] || 'backtest-advanced-factor-results.json';
const report = require(path.join(__dirname, input));

function value(number, digits = 1) {
  return Number.isFinite(number) ? Number(number).toFixed(digits) : '—';
}

console.log([
  'Market', 'Horizon', 'Side', 'Winner', 'Factors', 'Exit',
  'Base n', 'Base WR (95% CI)', 'Base PnL', 'Base Avg%', 'Base PF',
  'Win n', 'Win WR (95% CI)', 'Win PnL', 'Win Avg%', 'Win PF', 'Status', 'Failed gates',
].join('\t'));

for (const cell of report.cells) {
  const baseline = cell.baseline.holdout;
  const winner = cell.promotion.holdout;
  const baselineInterval = baseline.winRateInterval95 || [null, null];
  const interval = winner.winRateInterval95 || [null, null];
  const failed = Object.entries(cell.promotion.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (!cell.multiplicity.significantAt05) failed.push('multiplicity');
  console.log([
    cell.market,
    cell.horizon,
    cell.side,
    cell.frozenModel,
    cell.factors.length ? cell.factors.join('+') : 'none',
    cell.frozenExitProfile,
    baseline.trades,
    `${value(baseline.winRate)}% (${value(baselineInterval[0])}–${value(baselineInterval[1])})`,
    `$${value(baseline.pnlUsd, 0)}`,
    `${value(baseline.avgReturnPct, 2)}%`,
    value(baseline.profitFactor, 2),
    winner.trades,
    `${value(winner.winRate)}% (${value(interval[0])}–${value(interval[1])})`,
    `$${value(winner.pnlUsd, 0)}`,
    `${value(winner.avgReturnPct, 2)}%`,
    value(winner.profitFactor, 2),
    cell.status,
    failed.join('+') || 'none',
  ].join('\t'));
}

const passed = report.cells.filter(cell => cell.status === 'PASS');
console.log(`\nCells: ${report.cells.length}; passed: ${passed.length}; paused: ${report.cells.length - passed.length}`);
console.log(`Loaded: ${Object.entries(report.methodology.loadedPerMarket)
  .map(([market, count]) => `${market}=${count}`).join(', ')}`);
