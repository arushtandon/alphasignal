'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { tslAfterTp1, ratchetTslOnOpen, ratchetTslFromDailyBar } = require('../lib/ibkr/tsl-policy');

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
