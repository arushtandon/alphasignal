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

test('intraday NLV wiggle does not reprice Sharpe', () => {
  const today = '2026-08-26';
  const startEq = 462_000;
  const mk = (eq) => computeAccountPerformance({
    bookStart: '2026-08-06',
    today,
    asOf: today,
    ibkrEquity: eq,
    netPnlUsd: eq - startEq,
    eod: [
      { date: '2026-08-06', currentBalance: startEq, netPnlUsd: 0 },
      { date: '2026-08-18', currentBalance: 464_000, netPnlUsd: 2000 }
    ]
  });
  const a = mk(464_000);
  const b = mk(455_000);
  assert.equal(a.sharpe, b.sharpe);
  assert.equal(a.sharpeDays, b.sharpeDays);
  assert.ok(a.currentEquity !== b.currentEquity);
});

test('US EOD for today is included in Sharpe', () => {
  const today = '2026-08-26';
  const startEq = 462_000;
  const mk = (eq) => computeAccountPerformance({
    bookStart: '2026-08-06',
    today,
    asOf: today,
    ibkrEquity: eq,
    netPnlUsd: eq - startEq,
    eod: [
      { date: '2026-08-06', currentBalance: startEq, netPnlUsd: 0 },
      { date: '2026-08-18', currentBalance: 464_000, netPnlUsd: 2000 },
      { date: today, currentBalance: eq, netPnlUsd: eq - startEq, session: 'us-post-close' }
    ]
  });
  const a = mk(464_000);
  const b = mk(455_000);
  assert.notEqual(a.sharpe, b.sharpe);
});

test('negative Sharpe does not raise Moderate while drawdown is under 5%', () => {
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    asOf: '2026-08-25',
    today: '2026-08-26',
    ibkrEquity: 462_000,
    netPnlUsd: -2000,
    eod: [
      { date: '2026-08-06', currentBalance: 464_000, netPnlUsd: 0 },
      { date: '2026-08-07', currentBalance: 463_200, netPnlUsd: -800 },
      { date: '2026-08-10', currentBalance: 462_000, netPnlUsd: -2000 }
    ]
  });
  assert.ok(p.sharpe != null && p.sharpe < 0);
  assert.ok(p.drawdownPct < 5);
  assert.equal(p.riskLevel, 'Low');
});

test('intra-day NLV is not a closed Sharpe day', () => {
  const eod = [
    { date: '2026-08-06', currentBalance: 464_000, netPnlUsd: 0 },
    { date: '2026-08-25', currentBalance: 467_000, netPnlUsd: 3000 }
  ];
  const closed = computeAccountPerformance({
    bookStart: '2026-08-06',
    today: '2026-08-27',
    asOf: '2026-08-27',
    ibkrEquity: 466_000,
    netPnlUsd: 2000,
    eod
  });
  const withTodayEod = computeAccountPerformance({
    bookStart: '2026-08-06',
    today: '2026-08-27',
    asOf: '2026-08-27',
    ibkrEquity: 466_000,
    netPnlUsd: 2000,
    eod: eod.concat([{ date: '2026-08-27', currentBalance: 466_000, netPnlUsd: 2000, session: 'us-post-close' }])
  });
  assert.ok(closed.sharpeDays < withTodayEod.sharpeDays);
});

test('Moderate only when IBKR NLV drawdown reaches 5%', () => {
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    ibkrEquity: 950_000,
    netPnlUsd: -50_000,
    daily: [
      { date: '2026-08-06', cumUsd: 0 },
      { date: '2026-08-10', cumUsd: -50_000 }
    ]
  });
  assert.equal(p.drawdownPct, 5);
  assert.equal(p.riskLevel, 'Moderate');
});

test('stale $1M book peak is replaced by live IBKR NLV', () => {
  const snap = applyIbkrNlvExtremes({
    netLiquidation: 464_000,
    peakNlv: 1_000_000,
    troughNlv: 1_000_000
  });
  assert.equal(snap.peakNlv, 464_000);
  assert.equal(snap.troughNlv, 464_000);
  assert.equal(snap.maxDrawdownUsd, 0);
});

test('intra-day EOD snapshot is not a closed Sharpe day', () => {
  const today = '2026-08-28';
  const eod = [
    { date: '2026-08-06', currentBalance: 464_000, netPnlUsd: 0 },
    { date: '2026-08-25', currentBalance: 467_000, netPnlUsd: 3000 },
    { date: today, currentBalance: 468_000, netPnlUsd: 4000 }
  ];
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    today,
    asOf: today,
    ibkrEquity: 468_000,
    netPnlUsd: 4000,
    eod
  });
  const closed = computeAccountPerformance({
    bookStart: '2026-08-06',
    today,
    asOf: today,
    ibkrEquity: 468_000,
    netPnlUsd: 4000,
    eod: eod.slice(0, 2)
  });
  assert.equal(p.sharpe, closed.sharpe);
  assert.equal(p.sharpeDays, closed.sharpeDays);
});

test('missing EOD NLV does not invent a Sharpe crash from fill-PnL cum', () => {
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    today: '2026-08-28',
    asOf: '2026-08-28',
    ibkrEquity: 468_813,
    netPnlUsd: 6919,
    daily: [{ date: '2026-08-27', cumUsd: 1756 }],
    eod: [
      { date: '2026-08-20', currentBalance: 461_266 },
      { date: '2026-08-25', currentBalance: 467_329 },
      { date: '2026-08-27', currentBalance: null, netPnlUsd: 0 }
    ],
    peakIbkrEquity: 470_130,
    troughIbkrEquity: 462_029
  });
  assert.ok(p.sharpe > 1.5, 'Sharpe=' + p.sharpe);
  assert.ok(p.drawdownUsd < 2500, 'fake daily-cum cliff would print ~$3.7k, got dd=' + p.drawdownUsd);
});

test('max drawdown never shrinks below the persisted high-water', () => {
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    today: '2026-08-28',
    asOf: '2026-08-28',
    ibkrEquity: 468_813,
    netPnlUsd: 6919,
    eod: [{ date: '2026-08-25', currentBalance: 467_329 }],
    persistedMaxDrawdownUsd: 5000
  });
  assert.ok(p.drawdownUsd >= 5000, 'dd=' + p.drawdownUsd);
});

test('a profitable IBKR book does not get a negative Sharpe from peak NLV stamped on day one', () => {
  const p = computeAccountPerformance({
    bookStart: '2026-08-06',
    today: '2026-08-27',
    asOf: '2026-08-27',
    ibkrEquity: 467_999,
    netPnlUsd: 4202,
    peakIbkrEquity: 468_141,
    peakIbkrEquityAt: '2026-08-06',
    eod: [
      { date: '2026-08-07', currentBalance: 462_013 },
      { date: '2026-08-20', currentBalance: 461_266 },
      { date: '2026-08-25', currentBalance: 467_329 }
    ]
  });
  assert.ok(p.fromStartUsd > 0);
  assert.ok(p.sharpe > 0, 'Sharpe must follow the start→close path, not the high-water mark');
});
