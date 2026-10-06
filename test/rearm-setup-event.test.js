'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rearmBracketEvent,
  parentEntrySpec,
  entryChildFlags,
  toContract,
} = require('../ibkr-bridge/bridge');
const { evaluateCapitalPool, setupOrderShape } = require('../lib/strategy/setup-book-execution');

function account() {
  return {
    summaryAt: new Date().toISOString(),
    buyingPower: 5000000,
    excessLiquidity: 2000000,
    netLiquidation: 462000,
    grossPositionValue: 487000,
  };
}

test('Japan MR re-arm keeps the setup exit and passes the capital guard', () => {
  const prior = process.env.CAPITAL_POOL_ENABLED;
  process.env.CAPITAL_POOL_ENABLED = '1';
  const key = '6501.T|medium|Tue Oct 06 2026';
  const source = {
    type: 'entry',
    key,
    ticker: '6501.T',
    hz: 'medium',
    side: 'buy',
    entry: 3600,
    sl: 3400,
    tp1: 3800,
    tp2: 4000,
    setupId: 'JAPAN_MEDIUM_MR',
    setupTag: 'SETUP_BOOK:JAPAN_MEDIUM_MR',
    ledgerNamespace: 'SETUP_BOOK:JAPAN_MEDIUM_MR',
    setupAtr: 80,
    setupStopAtr: 2.5,
    setupPartial: false,
    setupTimeStopBars: null,
    benchmark: null,
  };
  const row = {
    ticker: '6501.T',
    hz: 'medium',
    side: 'buy',
    entry: 3600,
    originalSl: 3400,
    stopPx: 3400,
    tp1Px: 3800,
    parentId: 58025144,
    entryFilled: false,
    closed: false,
    entryStyle: 'OPG',
    qtyTotal: 200,
    contract: { market: 'JP', secType: 'STK' },
    setupNotionalUsd: 450000,
  };
  const event = rearmBracketEvent(key, row, source, 'asia-rth');
  assert.equal(event.setupId, 'JAPAN_MEDIUM_MR');
  assert.equal(event.setupTag, 'SETUP_BOOK:JAPAN_MEDIUM_MR');
  assert.equal(event.ledgerNamespace, 'SETUP_BOOK:JAPAN_MEDIUM_MR');
  assert.equal(event.setupAtr, 80);
  assert.equal(event.setupStopAtr, 2.5);
  assert.equal(event.setupPartial, false);
  assert.equal(event.tp2, 4000);
  assert.equal(event.carryUnfilled, true);
  const shape = setupOrderShape(event.setupId, 200, 100);
  assert.equal(shape.fullExit, true);
  assert.equal(shape.targetStopOca, true);
  assert.equal(shape.momentumNoStop, undefined);
  const open = [{ ...row, key, ticker: '6501.T' }];
  const blocked = evaluateCapitalPool(event.setupId, open, 30000, account(), { ticker: '6501.T' });
  assert.equal(blocked.allowed, false);
  const passed = evaluateCapitalPool(event.setupId, open, 30000, account(), { ticker: '6501.T', key });
  assert.equal(passed.allowed, true);
  if (prior == null) delete process.env.CAPITAL_POOL_ENABLED;
  else process.env.CAPITAL_POOL_ENABLED = prior;
});

test('UK momentum LSE re-arm at RTH is parent-only and is not skipped', () => {
  const prior = process.env.CAPITAL_POOL_ENABLED;
  process.env.CAPITAL_POOL_ENABLED = '1';
  const key = 'SHEL.L|long|2026-11-02';
  const source = {
    type: 'entry',
    key,
    ticker: 'SHEL.L',
    hz: 'long',
    side: 'buy',
    entry: 1000,
    sl: null,
    tp2: null,
    noStop: true,
    momentumOpen: true,
    setupId: 'UK_LONG_MOMENTUM',
    setupTag: 'SETUP_BOOK:UK_LONG_MOMENTUM',
    ledgerNamespace: 'SETUP_BOOK:UK_LONG_MOMENTUM',
    benchmark: 'EWU',
  };
  const row = {
    ticker: 'SHEL.L',
    hz: 'long',
    side: 'buy',
    entry: 1000,
    parentId: 42,
    entryFilled: false,
    closed: false,
    entryStyle: 'LMT-OPEN',
    qtyTotal: 100,
    contract: toContract('SHEL.L'),
    setupNotionalUsd: 30000,
  };
  const event = rearmBracketEvent(key, row, source, 'eu-rth-after-opg');
  assert.equal(event.setupId, 'UK_LONG_MOMENTUM');
  assert.equal(event.noStop, true);
  assert.equal(event.momentumOpen, true);
  assert.equal(event.benchmark, 'EWU');
  assert.equal(event.skipChase, true);
  const parent = parentEntrySpec(row.contract, 'BUY', 100, {
    side: 'buy',
    entryPx: event.entry,
    quotePx: event.entry,
    momentumOpen: event.momentumOpen,
    throughPct: event.throughPct,
    phaseOverride: 'rth',
  });
  assert.equal(parent.orderType, 'LMT');
  assert.equal(parent.entryStyle, 'LMT-THROUGH');
  assert.equal(parent.transmit, true);
  assert.notEqual(parent.tif, 'OPG');
  assert.deepEqual(entryChildFlags({
    asiaStandalone: false,
    momentumNoStop: true,
    oneLotRunner: false,
    tp1Px: 1100,
    tp2Px: 1200,
    sold: 100,
    runner: 0,
  }), { stop: false, tp1: false, tp2: false });
  const open = [{ ...row, key }];
  const passed = evaluateCapitalPool(event.setupId, open, 30000, account(), { ticker: 'SHEL.L', key });
  assert.equal(passed.allowed, true);
  assert.notEqual(passed.log, 'skipped: leverage');
  if (prior == null) delete process.env.CAPITAL_POOL_ENABLED;
  else process.env.CAPITAL_POOL_ENABLED = prior;
});
