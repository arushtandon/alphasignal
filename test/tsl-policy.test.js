'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  tslAfterTp1, ratchetTslOnOpen, ratchetTslFromDailyBar,
  catchUpTslFromDailyBars, pickLiveTslCatchUp
} = require('../lib/ibkr/tsl-policy');

test('9988 short: SL moves down by the entry→TP1 percent', () => {
  const tsl = tslAfterTp1({ entry: 128.4, tp1: 114.98, sl: 136.26, isSell: true });
  assert.equal(+tsl.toFixed(2), 122.02);
});

test('long: SL moves up by the entry→TP1 percent', () => {
  const tsl = tslAfterTp1({ entry: 100, tp1: 107, sl: 95, isSell: false });
  assert.equal(+tsl.toFixed(2), 101.65);
});

test('short TSL ratchets down on a lower open and holds on a higher open', () => {
  const start = tslAfterTp1({ entry: 128.4, tp1: 114.98, sl: 136.26, isSell: true });
  const down = ratchetTslOnOpen({
    tsl: start, prevClose: 120, open: 115.56, isSell: true, entry: 128.4
  });
  assert.equal(+down.toFixed(1), 117.5);
  const up = ratchetTslOnOpen({
    tsl: down, prevClose: 115.56, open: 118, isSell: true, entry: 128.4
  });
  assert.equal(+up.toFixed(1), 117.5);
});

test('daily bar uses the open, not the close', () => {
  const tsl = 122.02;
  const next = ratchetTslFromDailyBar(
    tsl,
    { c: 120 },
    { o: 115.56, c: 119 },
    true,
    128.4
  );
  assert.equal(+next.toFixed(1), 117.5);
});

test('catch-up applies each favorable open after TP1', () => {
  const start = tslAfterTp1({ entry: 100, tp1: 107, sl: 95, isSell: false });
  const caught = catchUpTslFromDailyBars(start, [
    { o: 106, c: 106 },
    { o: 108, c: 107.5 },
    { o: 107, c: 107 }
  ], false, 100);
  assert.ok(caught > start);
  assert.ok(caught >= 100);
});

test('catch-up clips to post-TP1 floor when the daily walk is through last', () => {
  const picked = pickLiveTslCatchUp({
    current: 22.94, floorTsl: 24.93, caught: 25.40, lastPx: 25.20, isSell: false
  });
  assert.equal(+picked.toFixed(2), 24.93);
});

test('catch-up skips a 1-tick park under last (0883 dump)', () => {
  const picked = pickLiveTslCatchUp({
    current: 22.94, floorTsl: 24.93, caught: 25.40, lastPx: 24.96, isSell: false
  });
  assert.equal(picked, 0);
});

test('catch-up skips entirely when even the floor is through last', () => {
  const picked = pickLiveTslCatchUp({
    current: 22.94, floorTsl: 24.93, caught: 25.40, lastPx: 24.80, isSell: false
  });
  assert.equal(picked, 0);
});

test('catch-up refuses when last is missing', () => {
  const picked = pickLiveTslCatchUp({
    current: 22.94, floorTsl: 24.93, caught: 25.40, lastPx: 0, isSell: false
  });
  assert.equal(picked, 0);
});

test('catch-up keeps a daily ratchet that is still behind last', () => {
  const picked = pickLiveTslCatchUp({
    current: 48.2, floorTsl: 48.2, caught: 49.0, lastPx: 49.77, isSell: false
  });
  assert.equal(+picked.toFixed(1), 49.0);
});
