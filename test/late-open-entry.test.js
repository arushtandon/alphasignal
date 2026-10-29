'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parentEntrySpec } = require('../ibkr-bridge/bridge');
const { lateOpenFills } = require('../lib/strategy/late-open-entry');

const jp = { market: 'JP', secType: 'STK', currency: 'JPY' };
const us = { usRth: true, market: 'US', secType: 'STK', currency: 'USD' };
const lateTokyo = Date.parse('2026-10-29T04:15:00Z');

test('a late setup-book buy is limited at the open and does not chase above it', () => {
  const spec = parentEntrySpec(jp, 'BUY', 1600, {
    setupId: 'JAPAN_MEDIUM_MR',
    side: 'buy',
    entryPx: 2885,
    quotePx: 2830,
    phaseOverride: 'rth',
    minutesSinceOpen: 255,
    officialOpen: 2817.5,
    nowMs: lateTokyo,
  });
  assert.equal(spec.orderType, 'LMT');
  assert.equal(spec.entryStyle, 'LMT-MISSED-OPEN');
  assert.ok(spec.lmtPrice <= 2817.5);
  assert.equal(lateOpenFills('buy', spec.lmtPrice, 2810), true);
  assert.equal(lateOpenFills('buy', spec.lmtPrice, 2885), false);
});

test('US pre-market setup orders stay on the pre-market limit', () => {
  const spec = parentEntrySpec(us, 'BUY', 100, {
    usSetupPremarket: true,
    side: 'buy',
    setupId: 'US_SHORT_MR',
    entryPx: 100,
    phaseOverride: 'pre',
    minutesSinceOpen: -30,
    officialOpen: 99,
    nowMs: Date.parse('2026-10-29T12:00:00Z'),
  });
  assert.equal(spec.entryStyle, 'LMT-PRE');
  assert.equal(spec.lmtPrice, 100);
  assert.equal(spec.outsideRth, true);
});
