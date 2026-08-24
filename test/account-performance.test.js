'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { computeAccountPerformance } = require('../lib/ibkr/account-performance');

test('drawdown and Sharpe use IBKR PnL, not the $1M book', () => {
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
  assert.equal(p.source, 'ibkr-trades');
  assert.equal(p.fromStartUsd, 4000);
  assert.equal(p.peakEquity, 8000);
  assert.equal(p.troughEquity, -2000);
  assert.equal(p.stake, 8000);
  assert.equal(p.fromStartPct, 50);
  assert.equal(p.drawdownUsd, 4000);
  assert.equal(p.drawdownPct, 50);
  assert.notEqual(p.fromStartPct, 0.4);
  assert.equal(p.signFlips.length, 2);
  assert.equal(p.signFlips[0].from, 'profit');
  assert.equal(p.signFlips[0].to, 'loss');
  assert.equal(p.signFlips[1].to, 'profit');
  assert.ok(p.sharpe == null || Number.isFinite(p.sharpe));
});

test('eod netPnlUsd is preferred over $1M bookEquity', () => {
  const p = computeAccountPerformance({
    netPnlUsd: 3000,
    eod: [
      { date: '2026-08-06', netPnlUsd: 1000, bookEquity: 1_001_000 },
      { date: '2026-08-07', netPnlUsd: 5000, bookEquity: 1_005_000 },
      { date: '2026-08-10', netPnlUsd: 3000, bookEquity: 1_003_000 }
    ]
  });
  assert.equal(p.peakEquity, 5000);
  assert.equal(p.drawdownUsd, 2000);
  assert.equal(p.drawdownPct, 40);
});

test('smooth IBKR gain is Low risk with no giveback', () => {
  const p = computeAccountPerformance({
    netPnlUsd: 6000,
    daily: [
      { date: '2026-08-06', cumUsd: 2000 },
      { date: '2026-08-07', cumUsd: 4000 },
      { date: '2026-08-10', cumUsd: 6000 }
    ]
  });
  assert.equal(p.riskLevel, 'Low');
  assert.equal(p.drawdownUsd, 0);
  assert.equal(p.drawdownPct, 0);
});

test('risk-off and deep IBKR PnL drawdown raise the risk label', () => {
  const paused = computeAccountPerformance({
    netPnlUsd: -100000, riskOff: true
  });
  assert.equal(paused.riskLevel, 'Paused');
  const elev = computeAccountPerformance({
    netPnlUsd: -500,
    daily: [
      { date: '2026-08-06', cumUsd: 4000 },
      { date: '2026-08-10', cumUsd: -500 }
    ]
  });
  assert.equal(elev.drawdownUsd, 4500);
  assert.ok(elev.drawdownPct >= 10);
  assert.equal(elev.riskLevel, 'Elevated');
});
