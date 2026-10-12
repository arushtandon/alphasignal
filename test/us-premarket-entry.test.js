'use strict';
const assert = require('assert');
const {
  nyClock,
  usPremarketParentDecision,
  simulateUsSetupBuy,
  premarketStatusLine,
  usWorkingPendingNotional,
  US_OPEN_ORDER,
} = require('../lib/strategy/us-premarket-entry');
const { entryReleaseBlock } = require('../lib/schedule/entry-release');
const { leverageDecision, pendingWorkingNotional } = require('../lib/strategy/setup-book-execution');
const { parentEntrySpec } = require('../ibkr-bridge/bridge');

const edtPlace = Date.parse('2026-10-13T08:00:00.000Z'); // 16:00 SGT, 04:00 EDT
const edtPrint = Date.parse('2026-10-13T12:00:00.000Z'); // 08:00 EDT, still pre-market
const edtHandoff = Date.parse('2026-10-13T13:25:00.000Z'); // 09:25 EDT, 21:25 SGT
const edtOpen = 100;
const entry = {
  ticker: 'INTC',
  setupId: 'US_SHORT_MR',
  market: 'US',
  side: 'buy',
  entry: 100,
  entryDate: new Date(edtPlace).toISOString(),
  t: new Date(edtPlace).toISOString(),
};

const filledPre = simulateUsSetupBuy(entry, {
  qty: 100,
  atr: 1,
  placeAt: edtPlace,
  openPx: edtOpen,
  prints: [{ at: edtPrint, px: 99, qty: 100 }],
  outsidePrint: { px: 96, outsideRth: true },
  rthPrint: { px: 96, outsideRth: false },
});
assert.strictEqual(filledPre.order.entryStyle, 'LMT-PRE');
assert.strictEqual(filledPre.order.orderType, 'LMT');
assert.strictEqual(filledPre.order.lmtPrice, 100);
assert.strictEqual(filledPre.order.tif, 'DAY');
assert.strictEqual(filledPre.order.outsideRth, true);
assert.strictEqual(filledPre.openOrder, null);
assert.strictEqual(filledPre.filled, 100);
assert.strictEqual(filledPre.preFillPx, 99);
assert.ok(filledPre.children);
assert.strictEqual(filledPre.children.qty, 100);
assert.strictEqual(filledPre.children.stop.outsideRth, false);
assert.strictEqual(filledPre.children.stop.totalQuantity, 100);
assert.strictEqual(filledPre.children.stop.auxPrice, 97);
assert.strictEqual(filledPre.outsideStopped, false);
assert.strictEqual(filledPre.rthStopped, true);

const noPre = simulateUsSetupBuy(entry, {
  qty: 100,
  atr: 1,
  placeAt: edtPlace,
  handoffAt: edtHandoff,
  openPx: 101,
  prints: [{ at: edtPrint, px: 101, qty: 100 }],
});
assert.strictEqual(noPre.filled, 100);
assert.strictEqual(noPre.preFillPx, null);
assert.ok(noPre.openOrder);
assert.strictEqual(noPre.openOrder.orderType, US_OPEN_ORDER.orderType);
assert.strictEqual(noPre.openOrder.tif, US_OPEN_ORDER.tif);
assert.strictEqual(noPre.openOrder.outsideRth, false);
assert.strictEqual(noPre.openOrder.entryStyle, 'OPG');
assert.strictEqual(noPre.openOrder.totalQuantity, 100);
assert.strictEqual(noPre.avg, 101);
assert.strictEqual(noPre.children.qty, 100);
assert.strictEqual(noPre.vsOpen, 0);

const partial = simulateUsSetupBuy(entry, {
  qty: 100,
  atr: 1,
  placeAt: edtPlace,
  handoffAt: edtHandoff,
  openPx: 102,
  prints: [{ at: edtPrint, px: 99, qty: 40 }],
});
assert.strictEqual(partial.preFillPx, 99);
assert.strictEqual(partial.childrenAfterPartial.stop.totalQuantity, 40);
assert.strictEqual(partial.openOrder.totalQuantity, 60);
assert.strictEqual(partial.openOrder.entryStyle, 'OPG');
assert.strictEqual(partial.filled, 100);
assert.strictEqual(partial.children.qty, 100);
assert.strictEqual(partial.children.stop.totalQuantity, 100);
assert.strictEqual(partial.children.stop.outsideRth, false);
assert.ok(Math.abs(partial.avg - (40 * 99 + 60 * 102) / 100) < 1e-9);

function atNewYork(day, hour, minute) {
  const guess = Date.parse(day + 'T12:00:00.000Z');
  const clock = nyClock(guess);
  const deltaMin = (hour * 60 + minute) - clock.minutes;
  return guess + deltaMin * 60 * 1000;
}
const octLimit = atNewYork('2026-10-30', 4, 0);
const octAlmost = atNewYork('2026-10-30', 9, 24);
const octHandoff = atNewYork('2026-10-30', 9, 25);
const novLimit = atNewYork('2026-11-02', 4, 0);
const novAlmost = atNewYork('2026-11-02', 9, 24);
const novHandoff = atNewYork('2026-11-02', 9, 25);
assert.strictEqual(nyClock(octLimit).date, '2026-10-30');
assert.strictEqual(nyClock(novLimit).date, '2026-11-02');
assert.strictEqual(usPremarketParentDecision(octLimit), 'limit');
assert.strictEqual(usPremarketParentDecision(octAlmost), 'limit');
assert.strictEqual(usPremarketParentDecision(octHandoff), 'open');
assert.strictEqual(usPremarketParentDecision(novLimit), 'limit');
assert.strictEqual(usPremarketParentDecision(novAlmost), 'limit');
assert.strictEqual(usPremarketParentDecision(novHandoff), 'open');
assert.notStrictEqual(new Date(octLimit).getUTCHours(), new Date(novLimit).getUTCHours());
assert.notStrictEqual(new Date(octHandoff).getUTCHours(), new Date(novHandoff).getUTCHours());
const usContract = { usRth: true, market: 'US', secType: 'STK', currency: 'USD' };
const octSpec = parentEntrySpec(usContract, 'BUY', 100, {
  usSetupPremarket: true, side: 'buy', setupId: 'US_SHORT_MR', entryPx: 100,
  phaseOverride: 'pre', nowMs: octLimit,
});
const novSpec = parentEntrySpec(usContract, 'BUY', 100, {
  usSetupPremarket: true, side: 'buy', setupId: 'US_SHORT_MR', entryPx: 100,
  phaseOverride: 'pre', nowMs: novLimit,
});
assert.strictEqual(octSpec.entryStyle, 'LMT-PRE');
assert.strictEqual(novSpec.entryStyle, 'LMT-PRE');
assert.strictEqual(octSpec.outsideRth, true);
assert.strictEqual(octSpec.tif, 'DAY');
const octOpen = parentEntrySpec(usContract, 'BUY', 40, {
  usSetupPremarket: true, side: 'buy', setupId: 'US_SHORT_MR', entryPx: 100,
  phaseOverride: 'pre', nowMs: octHandoff,
});
const novOpen = parentEntrySpec(usContract, 'BUY', 40, {
  usSetupPremarket: true, side: 'buy', setupId: 'US_SHORT_MR', entryPx: 100,
  phaseOverride: 'pre', nowMs: novHandoff,
});
assert.strictEqual(octOpen.entryStyle, 'OPG');
assert.strictEqual(octOpen.orderType, 'MKT');
assert.strictEqual(octOpen.tif, 'OPG');
assert.strictEqual(octOpen.outsideRth, false);
assert.strictEqual(novOpen.entryStyle, 'OPG');
assert.strictEqual(novOpen.outsideRth, false);
const plainUs = parentEntrySpec(usContract, 'BUY', 100, {
  side: 'buy', entryPx: 100, phaseOverride: 'pre', nowMs: octLimit,
});
assert.strictEqual(plainUs.entryStyle, 'OPG');
assert.strictEqual(plainUs.outsideRth, false);
const japan = parentEntrySpec({ market: 'JP', secType: 'STK' }, 'BUY', 100, {
  phaseOverride: 'pre', entryPx: 1000, side: 'buy',
});
assert.notStrictEqual(japan.entryStyle, 'LMT-PRE');
const europe = parentEntrySpec({ market: 'XETRA', secType: 'STK' }, 'BUY', 100, {
  phaseOverride: 'pre', entryPx: 100, side: 'buy',
});
assert.notStrictEqual(europe.entryStyle, 'LMT-PRE');

const pastMidnight = Date.parse('2026-10-13T16:30:00.000Z'); // 00:30 SGT D+1, 12:30 EDT
assert.strictEqual(entryReleaseBlock(entry, pastMidnight), null);
assert.strictEqual(entryReleaseBlock(entry, edtHandoff), null);
const stillWorking = simulateUsSetupBuy(entry, {
  qty: 100,
  atr: 1,
  placeAt: edtPlace,
  handoffAt: edtHandoff,
  gateAt: pastMidnight,
  openPx: 100,
  prints: [],
});
assert.strictEqual(stillWorking.blocked, null);
assert.strictEqual(stillWorking.openOrder.entryStyle, 'OPG');

const samples = [filledPre.vsOpen, noPre.vsOpen].filter(value => Number.isFinite(value));
const status = premarketStatusLine(samples);
assert.ok(status.indexOf('n=2') > 0);
assert.ok(status.indexOf(((99 - 100) / 100 / 2).toFixed(6)) > 0);
assert.ok(filledPre.entryLine.indexOf('preFill=99') > 0);
assert.ok(filledPre.entryLine.indexOf('open=100') > 0);
assert.ok(noPre.entryLine.indexOf('preFill=none') > 0);

const workingRow = {
  usPremarketEntry: true,
  entryStyle: 'LMT-PRE',
  setupId: 'US_SHORT_MR',
  market: 'US',
  side: 'buy',
  parentId: 11,
  qtyTotal: 100,
  qtyFilled: 0,
  entryFilled: false,
  setupNotionalUsd: 30000,
};
const partialRow = { ...workingRow, qtyFilled: 40, entryFilled: true };
const doneRow = { ...workingRow, qtyFilled: 100, entryFilled: true };
assert.strictEqual(usWorkingPendingNotional(workingRow), 30000);
assert.strictEqual(usWorkingPendingNotional(partialRow), 18000);
assert.strictEqual(usWorkingPendingNotional(doneRow), 0);
assert.strictEqual(pendingWorkingNotional([workingRow, partialRow]), 48000);
const account = {
  grossPositionValue: 0,
  netLiquidation: 100000,
  buyingPower: 400000,
  excessLiquidity: 80000,
  availableFunds: 80000,
};
const workingLev = leverageDecision(0, account, usWorkingPendingNotional(workingRow));
const filledLev = leverageDecision(0, { ...account, grossPositionValue: 30000 }, 0);
assert.strictEqual(workingLev.projectedGross, 30000);
assert.strictEqual(filledLev.projectedGross, 30000);
const japanPending = pendingWorkingNotional([{
  parentId: 9, entryFilled: false, setupNotionalUsd: 30000, setupId: 'JAPAN_LONG_ENGINE', market: 'JP', side: 'buy',
}]);
assert.strictEqual(japanPending, 30000);

console.log('PASS us pre-market entry');
