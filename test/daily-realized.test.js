'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  accumulateLotDaily,
  reconcileDailyToTotal,
  toDailyArray,
  sumMap
} = require('../lib/ibkr/daily-realized');

test('closed lot daily equals net realised after commission and stamp', () => {
  const daily = new Map();
  const err = new Map();
  accumulateLotDaily({
    openQty: 0,
    commissionUsd: 8,
    stampDutyUsd: 12,
    fills: [
      { role: 'entry', time: '2026-09-01T00:00:00Z' },
      { role: 'tp1', time: '2026-09-02T00:00:00Z', realizedUsd: 100 },
      { role: 'stop', time: '2026-09-03T00:00:00Z', realizedUsd: 20 }
    ]
  }, daily, err);
  assert.equal(sumMap(daily), 100);
  assert.equal(daily.get('2026-09-02'), 100);
  assert.equal(daily.has('2026-09-03'), false);
});

test('open TP1 is booked gross; stamp stays off daily until the lot closes', () => {
  const daily = new Map();
  accumulateLotDaily({
    openQty: 50,
    commissionUsd: 5,
    stampDutyUsd: 10,
    fills: [
      { role: 'tp1', time: '2026-09-09T00:00:00Z', realizedUsd: 658 }
    ]
  }, daily, new Map());
  assert.equal(sumMap(daily), 658);
});

test('cumulative is forced onto Total realised after rounding', () => {
  const daily = new Map([['2026-09-01', 9211.4]]);
  reconcileDailyToTotal(daily, 9212);
  const rows = toDailyArray(daily);
  assert.equal(rows[rows.length - 1].cumUsd, 9212);
});
