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
