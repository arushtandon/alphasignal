'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { computeAccountPerformance } = require('../lib/ibkr/account-performance');

test('account move, drawdown, sign flip, and Sharpe from a daily curve', () => {
  const p = computeAccountPerformance({
    startingCapital: 1_000_000,
    bookStart: '2026-08-06',
    bookEquity: 1_004_000,
    peakBookEquity: 1_012_000,
    troughBookEquity: 996_000,
    netPnlUsd: 4000,
    daily: [
      { date: '2026-08-06', cumUsd: 8000 },
      { date: '2026-08-07', cumUsd: -2000 },
      { date: '2026-08-10', cumUsd: 4000 }
    ]
  });
  assert.equal(p.fromStartUsd, 4000);
  assert.equal(p.fromStartPct, 0.4);
  assert.equal(p.drawdownUsd, 8000);
  assert.ok(p.drawdownPct > 0);
  assert.equal(p.signFlips.length, 2);
  assert.equal(p.signFlips[0].from, 'profit');
  assert.equal(p.signFlips[0].to, 'loss');
  assert.equal(p.signFlips[1].to, 'profit');
  assert.ok(['Low', 'Moderate'].includes(p.riskLevel));
  assert.ok(p.sharpe == null || Number.isFinite(p.sharpe));
});

test('smooth gain is Low risk', () => {
  const p = computeAccountPerformance({
    startingCapital: 1_000_000,
    bookEquity: 1_006_000,
    peakBookEquity: 1_006_000,
    troughBookEquity: 1_000_000,
    netPnlUsd: 6000,
    daily: [
      { date: '2026-08-06', cumUsd: 2000 },
      { date: '2026-08-07', cumUsd: 4000 },
      { date: '2026-08-10', cumUsd: 6000 }
    ]
  });
  assert.equal(p.riskLevel, 'Low');
  assert.equal(p.drawdownUsd, 0);
});

test('risk-off and deep drawdown raise the risk label', () => {
  const paused = computeAccountPerformance({
    startingCapital: 1_000_000, bookEquity: 900_000,
    peakBookEquity: 1_000_000, troughBookEquity: 900_000,
    netPnlUsd: -100000, riskOff: true
  });
  assert.equal(paused.riskLevel, 'Paused');
  const elev = computeAccountPerformance({
    startingCapital: 1_000_000, bookEquity: 880_000,
    peakBookEquity: 1_000_000, troughBookEquity: 880_000,
    netPnlUsd: -120000
  });
  assert.equal(elev.riskLevel, 'Elevated');
});
