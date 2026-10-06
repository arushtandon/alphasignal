'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toContract,
  parentEntrySpec,
  momentumNoStopEntry,
  entryChildFlags,
} = require('../ibkr-bridge/bridge');
const { LSE_THROUGH_PCT } = require('../lib/ibkr/order-routing');

test('a momentum entry transmits the parent only, and LSE uses a through-limit', () => {
  const evt = {
    type: 'entry',
    ticker: 'SHEL.L',
    setupId: 'UK_LONG_MOMENTUM',
    side: 'buy',
    entry: 1000,
    sl: null,
    noStop: true,
    momentumOpen: true,
  };
  assert.equal(momentumNoStopEntry(evt), true);
  const children = entryChildFlags({
    asiaStandalone: false,
    momentumNoStop: momentumNoStopEntry(evt),
    oneLotRunner: false,
    tp1Px: 1100,
    tp2Px: 1200,
    sold: 100,
    runner: 0,
  });
  assert.deepEqual(children, { stop: false, tp1: false, tp2: false });
  const parent = parentEntrySpec(toContract('SHEL.L'), 'BUY', 100, {
    side: 'buy',
    entryPx: 1000,
    quotePx: 1000,
    momentumOpen: true,
    phaseOverride: 'pre',
  });
  assert.equal(parent.orderType, 'LMT');
  assert.equal(parent.tif, 'DAY');
  assert.equal(parent.transmit, true);
  assert.equal(parent.entryStyle, 'LMT-OPEN');
  assert.equal(parent.lmtPrice, 1005);
  assert.equal(LSE_THROUGH_PCT, 0.005);
  const france = parentEntrySpec(toContract('MC.PA'), 'BUY', 10, {
    side: 'buy',
    entryPx: 50,
    momentumOpen: true,
    phaseOverride: 'pre',
  });
  assert.equal(france.orderType, 'MKT');
  assert.equal(france.tif, 'OPG');
  assert.equal(france.entryStyle, 'OPG-MOMENTUM');
  assert.equal(france.transmit, true);
  const sell = parentEntrySpec(toContract('SHEL.L'), 'SELL', 100, {
    side: 'sell',
    entryPx: 1000,
    quotePx: 1000,
    momentumOpen: true,
    phaseOverride: 'closed',
  });
  assert.equal(sell.orderType, 'LMT');
  assert.equal(sell.lmtPrice, 995);
  assert.notEqual(sell.tif, 'OPG');
});
