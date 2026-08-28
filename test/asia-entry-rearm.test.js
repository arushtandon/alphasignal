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
