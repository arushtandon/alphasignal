'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cachedEvidenceBars } = require('../lib/strategy/evidence-bars-cache');

test('evidence bars are shared within a scan and refreshed after the TTL', async () => {
  const cache = new Map();
  let now = 1_000_000;
  let calls = 0;
  const fetcher = async symbol => {
    calls++;
    return [{ symbol, date: calls === 1 ? '2026-10-12' : '2026-10-19' }];
  };
  const options = { now: () => now, ttlMs: 15 * 60 * 1000 };

  const first = await cachedEvidenceBars(cache, 'SPY', fetcher, options);
  const sameScan = await cachedEvidenceBars(cache, 'SPY', fetcher, options);
  assert.equal(calls, 1);
  assert.equal(sameScan, first);

  now += 24 * 60 * 60 * 1000;
  const nextDay = await cachedEvidenceBars(cache, 'SPY', fetcher, options);
  assert.equal(calls, 2);
  assert.equal(nextDay[0].date, '2026-10-19');
});

test('a rejected evidence fetch is evicted for retry', async () => {
  const cache = new Map();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) throw new Error('temporary');
    return [{ date: '2026-10-19' }];
  };

  await assert.rejects(cachedEvidenceBars(cache, 'EWJ', fetcher));
  const retried = await cachedEvidenceBars(cache, 'EWJ', fetcher);
  assert.equal(calls, 2);
  assert.equal(retried[0].date, '2026-10-19');
});
