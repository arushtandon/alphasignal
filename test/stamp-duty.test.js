'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  stampDutyLocal,
  isUkStampDutyFill,
  stampInflatedAvg,
  shouldSkipStampInflatedAvgCorrect,
  isStampInflatedCorrectedFill
} = require('../lib/ibkr/stamp-duty');

test('UK buy entry is stamped at 0.5% of GBP consideration', () => {
  const gbp = stampDutyLocal({
    ticker: 'SHEL.L', side: 'buy', role: 'entry',
    qty: 744, price: 3523, ccyScale: 100, currency: 'GBP'
  });
  // 744 * 35.23 * 0.005 = 131.0556
  assert.ok(Math.abs(gbp - 131.0556) < 1e-4);
  assert.equal(isUkStampDutyFill({
    ticker: 'SHEL.L', side: 'buy', role: 'entry', currency: 'GBP', ccyScale: 100
  }), true);
});

test('UK sells and US names are not stamped', () => {
  assert.equal(stampDutyLocal({
    ticker: 'SHEL.L', side: 'sell', role: 'tp1', qty: 372, price: 3803, ccyScale: 100, currency: 'GBP'
  }), 0);
  assert.equal(isUkStampDutyFill({
    ticker: 'NVDA', side: 'buy', role: 'entry', currency: 'USD', ccyScale: 1
  }), false);
});

test('IB avg 3542 vs tape 3523 is stamp, not a new print', () => {
  assert.equal(stampInflatedAvg(3523, 3542.3765), true);
  assert.equal(shouldSkipStampInflatedAvgCorrect(3523, 3542.3765, 100), true);
  assert.equal(shouldSkipStampInflatedAvgCorrect(3523, 3542.3765, 1), false);
  assert.equal(stampInflatedAvg(3523, 3523), false);
  assert.equal(stampInflatedAvg(123.8, 87.44), false);
});

test('avg-correct fill that is stamp-inflated can be restored', () => {
  assert.equal(isStampInflatedCorrectedFill({
    role: 'entry', recon: 'avg-correct', ccyScale: 100,
    price: 3542.3765, priceCorrectedFrom: 3523
  }), true);
  assert.equal(isStampInflatedCorrectedFill({
    role: 'entry', recon: 'avg-correct', ccyScale: 1,
    price: 124.1, priceCorrectedFrom: 123.8
  }), false);
});
