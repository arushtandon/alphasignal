'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { asiaUnfilledRearmReason } = require('../lib/ibkr/asia-entry-rearm');

const NOW = Date.parse('2026-08-28T05:00:00.000Z');

test('working JP LMT-THROUGH is not cancel-replaced every 2 minutes', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    parentId: 52174089,
    parentWorking: true,
    openOrdersComplete: true,
    lastRearmAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 30
  });
  assert.equal(reason, null);
});

test('LMT-THROUGH absent from manager open-order list is not treated as dead', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    parentId: 56792335,
    parentWorking: false,
    parentGone: false,
    openOrdersComplete: true,
    lastRearmAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 30
  });
  assert.equal(reason, null);
});

test('dead JP parent (10147 / missing from open orders) is retried once', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    parentId: 52135831,
    parentGone: true,
    parentWorking: false,
    openOrdersComplete: true,
    lastRearmAt: new Date(NOW - 3 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 5
  });
  assert.equal(reason, 'asia-rth-retry');
});

test('open-order timeout does not treat a live LMT-THROUGH as dead', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    parentId: 52174089,
    openOrdersComplete: false,
    parentWorking: false,
    lastRearmAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 30
  });
  assert.equal(reason, null);
});

test('JP OPG is held through the opening auction', () => {
  const hold = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'OPG',
    parentId: 1,
    parentWorking: true,
    minutesSinceRth: 1,
    auctionHoldMin: 2,
    now: NOW
  });
  assert.equal(hold, null);
  const after = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'OPG',
    parentId: 1,
    minutesSinceRth: 3,
    auctionHoldMin: 2,
    now: NOW
  });
  assert.equal(after, 'asia-rth');
});

test('lunch does not cancel a working Asia parent', () => {
  assert.equal(asiaUnfilledRearmReason({
    phase: 'lunch',
    entryStyle: 'LMT-THROUGH',
    parentId: 1,
    now: NOW
  }), null);
});

test('stale JP buy through-limit is repriced when last is above the parked LMT', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 2133,
    extLmt: 2110,
    parentId: 56878733,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 4 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 30
  });
  assert.equal(reason, 'asia-rth-reprice');
});

test('fresh JP through-limit is not repriced in the first two minutes', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 2133,
    extLmt: 2110,
    parentId: 56878733,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 30 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 5
  });
  assert.equal(reason, null);
});

test('marketable JP through-limit that has not filled in 10 minutes is retried', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 2091,
    extLmt: 2110,
    parentId: 56878733,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 12 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 30
  });
  assert.equal(reason, 'asia-rth-retry');
});

test('marketable LSE through-limit uses the same 10-minute retry', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 3515.5,
    extLmt: 3586,
    parentId: 57924340,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 12 * 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 90
  });
  assert.equal(reason, 'asia-rth-retry');
});

test('marketable LSE through-limit retries after 45s when sitMs is set', () => {
  const { LSE_THROUGH_SIT_MS } = require('../lib/ibkr/asia-entry-rearm');
  const reason = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 3523,
    extLmt: 3658,
    parentId: 56167726,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 60 * 1000).toISOString(),
    now: NOW,
    minutesSinceRth: 90,
    sitMs: LSE_THROUGH_SIT_MS
  });
  assert.equal(reason, 'asia-rth-retry');
});

test('LSE forceSitRetry rotates even when last has not crossed the limit', () => {
  const { LSE_THROUGH_SIT_MS } = require('../lib/ibkr/asia-entry-rearm');
  const hold = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 3510,
    extLmt: 3483,
    parentId: 1,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 10 * 1000).toISOString(),
    now: NOW,
    sitMs: LSE_THROUGH_SIT_MS,
    forceSitRetry: true
  });
  assert.equal(hold, null);
  const rotate = asiaUnfilledRearmReason({
    phase: 'rth',
    entryStyle: 'LMT-THROUGH',
    side: 'buy',
    quotePx: 3510,
    extLmt: 3483,
    parentId: 1,
    parentWorking: true,
    lastRearmAt: new Date(NOW - 30 * 1000).toISOString(),
    now: NOW,
    sitMs: LSE_THROUGH_SIT_MS,
    forceSitRetry: true
  });
  assert.equal(rotate, 'asia-rth-retry');
});

test('user-restore JP lot parks OPG while TSE is closed', () => {
  const reason = asiaUnfilledRearmReason({
    phase: 'closed',
    entryStyle: 'OPG',
    userReentry: true,
    parentId: null,
    now: NOW
  });
  assert.equal(reason, 'asia-to-opg');
});
