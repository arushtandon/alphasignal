'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  stampDutyLocal,
  isUkStampDutyFill,
  isStampDutyFill,
  fillTax,
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

test('GBP without .L (commodities) is not UK SDRT', () => {
  assert.equal(isUkStampDutyFill({
    ticker: 'BZ', side: 'buy', role: 'entry', currency: 'GBP', ccyScale: 100
  }), false);
  assert.equal(stampDutyLocal({
    ticker: 'BZ', side: 'buy', role: 'entry', qty: 10, price: 7000, ccyScale: 100, currency: 'GBP'
  }), 0);
});

test('HK stamp 0.1% on buys and sells', () => {
  const buy = fillTax({
    ticker: '0700.HK', side: 'buy', role: 'entry',
    qty: 100, price: 400, ccyScale: 1, currency: 'HKD'
  });
  assert.ok(buy);
  assert.equal(buy.id, 'hk-stamp');
  assert.equal(buy.amount, 40); // 100 * 400 * 0.001
  const sell = fillTax({
    ticker: '0700.HK', side: 'sell', role: 'tp1',
    qty: 50, price: 410, ccyScale: 1, currency: 'HKD'
  });
  assert.ok(sell);
  assert.equal(sell.amount, 20.5);
});

test('France FTT 0.4% on buys only; Germany has none', () => {
  const fr = fillTax({
    ticker: 'MC.PA', side: 'buy', role: 'entry',
    qty: 20, price: 650, ccyScale: 1, currency: 'EUR'
  });
  assert.ok(fr);
  assert.equal(fr.id, 'fr-ftt');
  assert.equal(fr.amount, 52); // 20 * 650 * 0.004
  assert.equal(stampDutyLocal({
    ticker: 'MC.PA', side: 'sell', role: 'stop', qty: 20, price: 640, currency: 'EUR'
  }), 0);
  assert.equal(isStampDutyFill({
    ticker: 'SIE.DE', side: 'buy', role: 'entry', currency: 'EUR'
  }), false);
});

test('Italy FTT 0.2% and India STT 0.1% both sides', () => {
  const it = fillTax({
    ticker: 'ENI.MI', side: 'buy', role: 'entry',
    qty: 100, price: 15, ccyScale: 1, currency: 'EUR'
  });
  assert.ok(it);
  assert.equal(it.amount, 3); // 100 * 15 * 0.002
  const inBuy = fillTax({
    ticker: 'RELIANCE.NS', side: 'buy', role: 'entry',
    qty: 10, price: 1400, ccyScale: 1, currency: 'INR'
  });
  assert.ok(inBuy);
  assert.equal(inBuy.amount, 14);
  const inSell = fillTax({
    ticker: 'INFY.NS', side: 'sell', role: 'flatten',
    qty: 20, price: 1600, currency: 'INR'
  });
  assert.ok(inSell);
  assert.equal(inSell.amount, 32);
});

test('Japan and US are not stamped', () => {
  assert.equal(isStampDutyFill({
    ticker: '7203.T', side: 'buy', role: 'entry', currency: 'JPY'
  }), false);
  assert.equal(isStampDutyFill({
    ticker: 'AAPL', side: 'buy', role: 'entry', currency: 'USD'
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
