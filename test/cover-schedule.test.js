'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { usCashDue, tseCashDue, sehkCashDue } = require('../lib/ibkr/cover-schedule');

describe('cover schedule', () => {
  it('US cash is not open at 07:05 ET and is open at 09:30 ET', () => {
    assert.equal(usCashDue(new Date('2026-10-30T11:05:00Z')), false);
    assert.equal(usCashDue(new Date('2026-10-30T13:29:00Z')), false);
    assert.equal(usCashDue(new Date('2026-10-30T13:30:00Z')), true);
    assert.equal(usCashDue(new Date('2026-10-30T20:00:00Z')), false);
  });

  it('TSE and SEHK opens on Monday 2 Nov 2026 are the cover windows', () => {
    assert.equal(tseCashDue(new Date('2026-11-01T23:59:00Z')), false);
    assert.equal(tseCashDue(new Date('2026-11-02T00:00:00Z')), true);
    assert.equal(sehkCashDue(new Date('2026-11-02T01:29:00Z')), false);
    assert.equal(sehkCashDue(new Date('2026-11-02T01:30:00Z')), true);
  });
});
