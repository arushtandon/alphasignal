'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPECTED_BH_FAMILY_SIZE,
  registry,
  confirmedDowntrend,
  sellSignalAt,
} = require('../lib/research/regime-sell-hedge');

test('frozen sell/hedge family has 1,954 variants', () => {
  const rows = registry();
  assert.equal(rows.length, EXPECTED_BH_FAMILY_SIZE);
  assert.equal(rows.filter(row => row.part === 'A').length, 1944);
  assert.equal(rows.filter(row => row.part === 'B').length, 10);
});

test('sells require a confirmed benchmark downtrend', () => {
  const start = Date.UTC(2020, 0, 1) / 1000;
  const up = Array.from({ length: 260 }, (_, index) => ({
    t: start + index * 86400,
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100 + index,
  }));
  const down = Array.from({ length: 260 }, (_, index) => ({
    t: start + index * 86400,
    o: 400 - index,
    h: 401 - index,
    l: 399 - index,
    c: 400 - index,
  }));
  assert.equal(confirmedDowntrend(up, 250), false);
  assert.equal(confirmedDowntrend(down, 250), true);
  assert.equal(sellSignalAt(down, 250, { trigger: 'rsi2_gt_95' }, up, 250), false);
});
