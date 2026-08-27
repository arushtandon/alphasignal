'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ibkrAvgToFillUnit, futuresMultiplierFor } = require('../lib/ibkr/avg-cost');

test('Brent IB averageCost 87442 is unit 87.442, not the buy price', () => {
  assert.equal(futuresMultiplierFor('BZ=F'), 1000);
  const unit = ibkrAvgToFillUnit(87442.36, 1, 87.44, { ticker: 'BZ=F' });
  assert.ok(Math.abs(unit - 87.44236) < 1e-6);
});

test('poisoned ledger 87442 still converts once recon already rewrote the fill', () => {
  const unit = ibkrAvgToFillUnit(87442.36, 1, 87442.36, { ticker: 'BZ=F', multiplier: 1000 });
  assert.ok(Math.abs(unit - 87.44236) < 1e-6);
});

test('already-unit futures averageCost is left alone', () => {
  const oil = ibkrAvgToFillUnit(87.44, 1, 87.44, { ticker: 'BZ=F' });
  assert.ok(Math.abs(oil - 87.44) < 1e-9);
  const es = ibkrAvgToFillUnit(5800, 1, 5800, { ticker: 'ES=F', multiplier: 50 });
  assert.equal(es, 5800);
});

test('ES notional averageCost divides by 50', () => {
  const unit = ibkrAvgToFillUnit(290000, 1, 5800, { ticker: 'ES=F' });
  assert.equal(unit, 5800);
});

test('LSE pence vs IB pounds is unchanged', () => {
  const avg = ibkrAvgToFillUnit(1.238, 100, 123.8, { ticker: 'MNDI.L' });
  assert.equal(avg, 123.8);
});
