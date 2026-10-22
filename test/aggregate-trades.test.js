'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { aggregateTrades, calculateTradePnl } = require('../lib/ibkr/aggregate-trades');
const { fifoFillsForRestoredKey } = require('../lib/ibkr/user-restore');
const { fifoLotEconomics } = require('../lib/ibkr/fifo-lots');
const { ibkrAvgToFillUnit, futuresMultiplierFor } = require('../lib/ibkr/avg-cost');
const { fillTax } = require('../lib/ibkr/stamp-duty');
const { bookedExitPnlUsd, fillExitPnlUsd, fillDailyPnlUsd } = require('../lib/ibkr/exit-quality');
const { accumulateLotDaily, toDailyArray } = require('../lib/ibkr/daily-realized');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ibkr-aggregate-trades-golden.json'), 'utf8'
));
const isCursorErrIbkrKey = key => /\|cursor-err(?:\||$)/i.test(String(key || ''));

function context() {
  return {
    fifoFillsForRestoredKey,
    futuresMultiplierFor,
    ibkrAvgToFillUnit,
    fifoLotEconomics,
    ibkrFillSession: () => 'regular',
    ibkrSessionLabel: session => session,
    isIbkrSyntheticFillRow: () => false,
    ibkrRecDayIsoFromKey: () => null,
    isCursorErrIbkrKey,
    isIbkrErrorTrade: trade => trade.errorTrade,
    fillsKeepOriginalRestoreAvg: () => false,
    isForceIbkrErrorTicker: () => false,
    legacyErrorKeys: new Set(),
    errExtra: null
  };
}

test('aggregateTrades golden fixture retains endpoint lot and PnL semantics', async () => {
  const lots = aggregateTrades(fixture.rows, context()).trades;
  const accounting = await calculateTradePnl(lots, {
    usdPerCcy: async ccy => ({ JPY: 1 / 150, GBP: 1.28 })[ccy] || 1,
    fillTax,
    bookedExitPnlUsd,
    fillExitPnlUsd,
    fillDailyPnlUsd,
    futuresMultiplierFor,
    ibkrAvgToFillUnit,
    liveMarks: {},
    futuresStillTradable: () => true,
    markMap: { AAPL: { price: 120, src: 'fixture' } },
    accumulateLotDaily,
    toDailyArray
  });
  const actual = accounting.trades.map(trade => ({
    key: trade.key,
    entryQty: trade.entryQty,
    exitQty: trade.exitQty,
    openQty: trade.openQty,
    avgEntry: trade.avgEntry,
    avgExit: trade.avgExit,
    status: trade.status,
    realizedLocal: trade.realizedLocal,
    errorTrade: trade.errorTrade,
    commissionUsd: trade.commissionUsd,
    stampDutyLocal: trade.stampDutyLocal,
    stampDutyGbp: trade.stampDutyGbp,
    stampDutyUsd: trade.stampDutyUsd,
    realizedUsdGross: trade.realizedUsdGross,
    commissionInRealized: trade.commissionInRealized,
    realizedUsd: trade.realizedUsd,
    mark: trade.mark,
    markSrc: trade.markSrc,
    unrealizedUsd: trade.unrealizedUsd,
    notionalUsd: trade.notionalUsd
  }));

  assert.deepEqual(actual, fixture.expected);
  assert.deepEqual(accounting.totals, fixture.totals);
});

test('LSE reconciliation mark in pounds is normalized to the pence fill unit', () => {
  const rows = [
    {
      key: 'SHEL.L|medium|Tue Sep 08 2026',
      ticker: 'SHEL.L',
      hz: 'medium',
      side: 'buy',
      role: 'entry',
      qty: 744,
      price: 3523,
      ccyScale: 100,
      currency: 'GBP',
      time: '2026-09-08T09:01:46.118Z',
      execId: 'entry',
    },
    {
      key: 'SHEL.L|medium|Tue Sep 08 2026',
      ticker: 'SHEL.L',
      hz: 'medium',
      side: 'buy',
      role: 'flatten',
      qty: 372,
      price: 37.873549,
      ccyScale: 100,
      currency: 'GBP',
      time: '2026-10-13T14:53:43.658Z',
      execId: 'recon-trim',
      synthetic: true,
      recon: 'qty-trim',
    },
  ];

  const [trade] = aggregateTrades(rows, context()).trades;
  assert.equal(trade.avgEntry, 3523);
  assert.equal(trade.avgExit, 3787.3549);
  assert.ok(trade.realizedLocal > 0, 'a profitable pence exit must not become a five-figure loss');
  assert.ok(Math.abs(trade.realizedLocal - 983.400228) < 1e-6);
});

test('LSE pence mark is normalized to a restored pound-denominated entry', async () => {
  const rows = [{
    key: 'SGRO.L|long|Fri Sep 04 2026',
    ticker: 'SGRO.L',
    hz: 'long',
    side: 'buy',
    role: 'entry',
    qty: 919,
    price: 9.501244,
    ccyScale: 1,
    currency: 'GBP',
    time: '2026-09-04T08:00:00.000Z',
    execId: 'entry',
  }];

  const trades = aggregateTrades(rows, context()).trades;
  const accounting = await calculateTradePnl(trades, {
    usdPerCcy: async () => 1.3,
    fillTax,
    bookedExitPnlUsd,
    fillExitPnlUsd,
    fillDailyPnlUsd,
    futuresMultiplierFor,
    ibkrAvgToFillUnit,
    liveMarks: {},
    futuresStillTradable: () => true,
    markMap: { 'SGRO.L': { price: 900, src: 'yahoo' } },
    accumulateLotDaily,
    toDailyArray
  });

  const [trade] = accounting.trades;
  assert.equal(trade.mark, 9);
  assert.ok(Math.abs(trade.unrealizedUsd) < 1000);
  assert.equal(accounting.totals.totUnrealUsd, trade.unrealizedUsd);
});
