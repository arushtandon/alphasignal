'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PARAMS,
  aggregateByCount,
  calcSupertrend,
  momentum,
  dailyHlc,
  evaluateMtf,
  blendSignal
} = require('../lib/research/mtf-supertrend');

function trendBars(count, direction = 1) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + direction * index;
    return {
      t: 1_700_000_000 + index * 86400,
      o: close - direction * 0.4,
      h: close + 0.8,
      l: close - 0.8,
      c: close,
      v: 1000
    };
  });
}

test('bar aggregation is causal and preserves OHLCV', () => {
  const bars = trendBars(6);
  const grouped = aggregateByCount(bars, 3);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].o, bars[0].o);
  assert.equal(grouped[0].c, bars[2].c);
  assert.equal(grouped[0].v, 3000);
});

test('Supertrend points with persistent price direction', () => {
  assert.deepEqual(PARAMS.short, { period: 10, multiplier: 3 });
  assert.deepEqual(PARAMS.medium, { period: 10, multiplier: 3 });
  assert.deepEqual(PARAMS.long, { period: 10, multiplier: 3 });
  assert.equal(calcSupertrend(trendBars(80, 1), 10, 3).direction, 'bull');
  assert.equal(calcSupertrend(trendBars(80, -1), 10, 3).direction, 'bear');
});

test('price momentum and daily high-low-close features are causal', () => {
  const bars = trendBars(40, 1);
  const before = momentum(bars);
  const hlc = dailyHlc(bars);
  const withFuture = [...bars, { ...bars.at(-1), t: bars.at(-1).t + 86400, c: 1, h: 2, l: 0 }];
  assert.ok(before.roc5 > 0);
  assert.equal(hlc.higherHighHigherLow, true);
  assert.deepEqual(momentum(bars), before);
  assert.notDeepEqual(momentum(withFuture), before);
});

test('dual-timeframe alignment receives higher weight and opposite trend is gated', () => {
  const primary = trendBars(140, 1);
  const higher = trendBars(80, 1);
  const mtf = evaluateMtf(primary, higher, 'medium', 'buy');
  const slower = evaluateMtf(primary, higher, 'long', 'buy', primary, {
    period: 14,
    multiplier: 4
  });
  assert.equal(mtf.dualSupertrend, true);
  assert.equal(slower.dualSupertrend, true);
  assert.ok(blendSignal({ buyScore: 70, sellScore: 10 }, mtf, 'buy').buyScore >= 62);

  const conflict = evaluateMtf(primary, trendBars(80, -1), 'medium', 'buy');
  assert.equal(conflict.dualSupertrend, false);
  assert.equal(blendSignal({ buyScore: 90 }, conflict, 'buy').buyScore, 61);
});
