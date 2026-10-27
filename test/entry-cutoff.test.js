'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionEntryCutoffMs, entryRetryOpen, partitionStaleRetries } = require('../lib/schedule/entry-cutoff');

test('a Japan entry emitted before the cash close retries until 15:00 Tokyo', () => {
  // 2026-10-27 07:00 JST.
  const evt = { setupId: 'JAPAN_MEDIUM_MR', t: '2026-10-26T22:00:00Z' };
  const cutoff = new Date(sessionEntryCutoffMs(evt)).toISOString();
  assert.equal(cutoff, '2026-10-27T06:00:00.000Z');
  assert.equal(entryRetryOpen(evt, Date.parse('2026-10-27T01:00:00Z')), true);
  assert.equal(entryRetryOpen(evt, Date.parse('2026-10-27T06:00:00Z')), false);
});

test('the 06:00 SGT US batch retries through that US session close, not the previous one', () => {
  // Monday 2026-10-26 06:00 SGT = Sunday 18:00 EDT, after Friday's close.
  const evt = { setupId: 'US_SHORT_MR', t: '2026-10-25T22:00:00.000Z', ticker: 'ALAB' };
  assert.equal(new Date(sessionEntryCutoffMs(evt)).toISOString(), '2026-10-26T20:00:00.000Z');
  assert.equal(entryRetryOpen(evt, Date.parse('2026-10-26T14:00:00Z')), true);
  assert.equal(entryRetryOpen(evt, Date.parse('2026-10-26T20:00:00Z')), false);
});

test('partition keeps the live session and drops the one past its close', () => {
  const live = { setupId: 'JAPAN_MEDIUM_MR', t: '2026-10-26T22:00:00Z', ticker: '8411.T' };
  const done = { setupId: 'US_SHORT_MR', t: '2026-10-25T22:00:00Z', ticker: 'ALAB' };
  const parts = partitionStaleRetries([live, done], Date.parse('2026-10-27T01:00:00Z'));
  assert.deepEqual(parts.retry.map(evt => evt.ticker), ['8411.T']);
  assert.deepEqual(parts.expired.map(evt => evt.ticker), ['ALAB']);
});
