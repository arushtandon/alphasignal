'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  priceActionSetup,
  structuralBracket,
  simulatePriceActionExit
} = require('../lib/strategy/price-action-short');

test('price-action setup is causal and ignores future bars', () => {
  const bars = Array.from({ length: 35 }, (_, i) => ({
    o: 100 + i * 0.2,
    h: 101 + i * 0.2,
    l: 99 + i * 0.2,
    c: 100.7 + i * 0.2,
    v: 1000 - i * 5
  }));
  const before = priceActionSetup(bars, 30, 'buy');
  bars[31] = { o: 1, h: 1000, l: 0.1, c: 900, v: 1e9 };
  assert.deepEqual(priceActionSetup(bars, 30, 'buy'), before);
});

test('structural stop stays beyond normal noise instead of hugging entry', () => {
  const bracket = structuralBracket(102, { atr: 2, invalidation: 101.5 }, 'buy');
  assert.equal(bracket.riskAtr, 1.15);
  assert.equal(bracket.stop, 99.7);
  assert.ok(bracket.tp1 > 102);
});

test('structural bracket rejects a setup whose invalidation is excessively wide', () => {
  assert.equal(structuralBracket(102, { atr: 2, invalidation: 90 }, 'buy'), null);
});

test('price-action stop simulation charges an adverse opening gap', () => {
  const result = simulatePriceActionExit([
    { o: 102, h: 103, l: 101, c: 102 },
    { o: 95, h: 96, l: 94, c: 95 }
  ], 1, 100, 'buy', { stop: 98, tp1: 104, tp2: 108 }, 15);
  assert.equal(result.status, 'sl_hit');
  assert.equal(result.exitPrice, 95);
  assert.equal(result.ret, -0.05);
});
