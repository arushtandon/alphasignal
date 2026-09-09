'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  accumulateLotDaily,
  toDailyArray,
  sumMap
} = require('../lib/ibkr/daily-realized');

test('closed lot daily equals net realised after commission and stamp', () => {
  const daily = new Map();
  accumulateLotDaily({
    openQty: 0,
    realizedUsd: 100,
    commissionUsd: 8,
    stampDutyUsd: 12,
    fills: [
      { role: 'entry', time: '2026-09-01T00:00:00Z' },
      { role: 'tp1', time: '2026-09-02T00:00:00Z', dailyRealizedUsd: 100 },
      { role: 'stop', time: '2026-09-03T00:00:00Z', dailyRealizedUsd: 20 }
    ]
  }, daily, new Map());
  assert.equal(sumMap(daily), 100);
  assert.equal(daily.get('2026-09-02'), 100);
  assert.equal(daily.has('2026-09-03'), false);
});

test('open TP1 is booked gross; stamp stays off daily until the lot closes', () => {
  const daily = new Map();
  accumulateLotDaily({
    openQty: 50,
    realizedUsd: 658,
    commissionUsd: 5,
    stampDutyUsd: 10,
    fills: [
      { role: 'tp1', time: '2026-09-09T00:00:00Z', dailyRealizedUsd: 658 }
    ]
  }, daily, new Map());
  assert.equal(sumMap(daily), 658);
});

test('futures-roll cash stays on the roll day, not dumped onto today', () => {
  const daily = new Map();
  accumulateLotDaily({
    openQty: 0,
    realizedUsd: 1795,
    commissionUsd: 0,
    stampDutyUsd: 0,
    lastTime: '2026-09-07T00:00:00Z',
    fills: [
      { role: 'flatten', time: '2026-09-07T04:00:00Z', recon: 'futures-roll', dailyRealizedUsd: 1795 }
    ]
  }, daily, new Map());
  assert.equal(daily.get('2026-09-07'), 1795);
  assert.equal(daily.has('2026-09-09'), false);
  const rows = toDailyArray(daily);
  assert.equal(rows[rows.length - 1].cumUsd, 1795);
});

test('lot remainder is plugged on that lot close day, never on an unrelated last calendar day', () => {
  const daily = new Map();
  accumulateLotDaily({
    openQty: 0,
    realizedUsd: 100,
    commissionUsd: 0,
    stampDutyUsd: 0,
    fills: [
      { role: 'tp1', time: '2026-09-02T00:00:00Z', dailyRealizedUsd: 80 }
    ]
  }, daily, new Map());
  accumulateLotDaily({
    openQty: 0,
    realizedUsd: 10,
    commissionUsd: 0,
    stampDutyUsd: 0,
    fills: [
      { role: 'flatten', time: '2026-09-09T00:00:00Z', dailyRealizedUsd: 10 }
    ]
  }, daily, new Map());
  assert.equal(daily.get('2026-09-02'), 100);
  assert.equal(daily.get('2026-09-09'), 10);
});
