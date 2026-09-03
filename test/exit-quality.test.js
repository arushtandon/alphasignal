'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyIbkrExitQuality, summarizeExitQuality } = require('../lib/ibkr/exit-quality');

test('flatten uses the lot’s own realised $, not ticker-group PnL', () => {
  const q = summarizeExitQuality([
    {
      ticker: '2914.T', status: 'closed', realizedUsd: 140,
      hasStop: true, hasTp1: true, hasFlatten: false, tickerGroupRealizedUsd: 1027
    },
    {
      ticker: '2914.T', status: 'closed', realizedUsd: -9,
      hasStop: false, hasTp1: false, hasFlatten: true, tickerGroupRealizedUsd: 1027
    },
    {
      ticker: 'NVDA', status: 'open', realizedUsd: 490,
      hasTp1: true, hasStop: false, hasFlatten: false
    }
  ]);
  const tsl = q.buckets.find((b) => b.type === 'trailing stop (post-TP1)');
  const flat = q.buckets.find((b) => b.type === 'flatten exit');
  const live = q.buckets.find((b) => b.type === 'tp1 banked — runner live');
  assert.equal(tsl.n, 1);
  assert.equal(tsl.realizedUsd, 140);
  assert.equal(flat.n, 1);
  assert.equal(flat.realizedUsd, -9);
  assert.equal(live.realizedUsd, 490);
  assert.equal(q.closedBucketUsd, 131);
  assert.equal(q.closedLotsUsd, 131);
  assert.equal(q.openTp1Usd, 490);
  assert.equal(q.allRealizedUsd, 621);
  assert.equal(q.reconOk, true);
});

test('closed TSL + SL + flatten + tp equals closed lots, not Total+group overcount', () => {
  const trades = [
    { ticker: 'A', status: 'closed', realizedUsd: 10240, hasStop: true, hasTp1: true },
    { ticker: 'B', status: 'closed', realizedUsd: -3110, hasStop: true, hasTp1: false },
    { ticker: 'C', status: 'closed', realizedUsd: 600, hasFlatten: true },
    { ticker: 'D', status: 'closed', realizedUsd: 27, hasTp1: true },
    { ticker: 'E', status: 'open', realizedUsd: 490, hasTp1: true }
  ];
  const q = summarizeExitQuality(trades);
  assert.equal(q.closedBucketUsd, 7757);
  assert.equal(q.closedLotsUsd, 7757);
  assert.equal(q.allRealizedUsd, 8247);
  assert.ok(q.closedBucketUsd !== 8184);
});

test('open runner with flatten fill is not a flatten-exit dollar', () => {
  assert.equal(classifyIbkrExitQuality({
    status: 'open', hasFlatten: true, hasTp1: true, realizedUsd: 50
  }), 'tp1 banked — runner live');
  const q = summarizeExitQuality([
    { ticker: 'X', status: 'open', realizedUsd: 50, hasFlatten: true, hasTp1: true }
  ]);
  assert.equal(q.buckets.find((b) => b.type === 'flatten exit').n, 0);
  assert.equal(q.buckets.find((b) => b.type === 'tp1 banked — runner live').realizedUsd, 50);
});
