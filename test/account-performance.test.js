'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  computeAccountPerformance,
  applyIbkrNlvExtremes
} = require('../lib/ibkr/account-performance');

test('move % is vs IBKR equity, not $1M and not peak PnL', () => {
  const p = computeAccountPerformance({
    startingCapital: 1_000_000,
    bookStart: '2026-08-06',
    ibkrEquity: 463_891,
    netPnlUsd: -109,
    daily: [
      { date: '2026-08-06', cumUsd: 1200 },
      { date: '2026-08-10', cumUsd: -109 }
    ]
  });
  assert.equal(p.source, 'ibkr-equity');
  assert.equal(p.fromStartUsd, -109);
  assert.equal(p.fromStartPct, -0.023);
  assert.notEqual(p.fromStartPct, -0.011);
  assert.notEqual(p.fromStartPct, -9.08);
  assert.equal(p.peakEquity, 465_200);
  assert.equal(p.troughEquity, 463_891);
  assert.equal(p.drawdownUsd, 1309);
  assert.equal(p.drawdownPct, 0.28);
});

test('max drawdown is peak IBKR equity to lowest well (1001 → 999 = 2 / 0.2%)', () => {
  const p = computeAccountPerformance({
    startingCapital: 1_000_000,
    bookStart: '2026-08-06',
    ibkrEquity: 999,
    netPnlUsd: -1,
    daily: [
      { date: '2026-08-06', cumUsd: 1 },
      { date: '2026-08-07', cumUsd: -1 }
    ]
  });
  assert.equal(p.peakEquity, 1001);
  assert.equal(p.troughEquity, 999);
  assert.equal(p.drawdownUsd, 2);
  assert.equal(p.drawdownPct, 0.2);
  assert.equal(p.fromStartUsd, -1);
  assert.equal(p.fromStartPct, -0.1);
});

test('eod IBKR NLV is used; $1M bookEquity is ignored', () => {
  const p = computeAccountPerformance({
    startingCapital: 1_000_000,
    ibkrEquity: 1_003_000,
    netPnlUsd: 3000,
    eod: [
      { date: '2026-08-06', netPnlUsd: 1000, currentBalance: 1_001_000, bookEquity: 1_001_000 },
      { date: '2026-08-07', netPnlUsd: 5000, currentBalance: 1_005_000, bookEquity: 1_005_000 },
      { date: '2026-08-10', netPnlUsd: 3000, currentBalance: 1_003_000, bookEquity: 1_003_000 }
    ]
  });
  assert.equal(p.peakEquity, 1_005_000);
  assert.equal(p.drawdownUsd, 2000);
  assert.equal(p.drawdownPct, 0.2);
  assert.equal(p.fromStartPct, 0.3);
});

test('smooth IBKR gain is Low risk with no giveback', () => {
  const p = computeAccountPerformance({
    ibkrEquity: 1_006_000,
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
  assert.equal(p.peakEquity, 1_006_000);
});

test('risk-off and deep IBKR equity drawdown raise the risk label', () => {
  const paused = computeAccountPerformance({
    ibkrEquity: 900_000, netPnlUsd: -100000, riskOff: true
  });
  assert.equal(paused.riskLevel, 'Paused');
  const elev = computeAccountPerformance({
    ibkrEquity: 880_000,
    netPnlUsd: -120000,
    daily: [
      { date: '2026-08-06', cumUsd: 0 },
      { date: '2026-08-10', cumUsd: -120000 }
    ]
  });
  assert.equal(elev.drawdownUsd, 120000);
  assert.equal(elev.drawdownPct, 12);
  assert.equal(elev.riskLevel, 'Elevated');
});

test('Sharpe uses every weekday since inception, not sparse snapshot days', () => {
  const { listWeekdays } = require('../lib/ibkr/account-performance');
  const days = listWeekdays('2026-08-06', '2026-08-25');
  assert.equal(days[0], '2026-08-06');
  assert.equal(days[days.length - 1], '2026-08-25');
  assert.equal(days.length, 14);
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    asOf: '2026-08-25',
    ibkrEquity: 464_000,
    netPnlUsd: 2000,
    daily: [
      { date: '2026-08-06', cumUsd: 1000 },
      { date: '2026-08-18', cumUsd: 2000 }
    ]
  });
  assert.equal(p.sharpeSince, '2026-08-06');
  assert.equal(p.sharpeDays, 13);
  assert.ok(p.sharpe != null);
});

test('stale $1M book peak is replaced by live IBKR NLV', () => {
  const snap = applyIbkrNlvExtremes({
    netLiquidation: 464_000,
    peakNlv: 1_000_000,
    troughNlv: 1_000_000
  });
  assert.equal(snap.peakNlv, 464_000);
  assert.equal(snap.troughNlv, 464_000);
});
