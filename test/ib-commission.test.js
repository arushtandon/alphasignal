'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  estimateIbkrCommission,
  applyEstimatedCommission,
  fillNeedsEstimatedCommission,
  stripEstimatedHkStamp
} = require('../lib/ibkr/ib-commission');

test('US small lot hits the $0.35 IBKR Pro minimum', () => {
  const ph = estimateIbkrCommission({ ticker: 'PH', qty: 11, price: 1011.03, currency: 'USD' });
  assert.ok(ph.commission >= 0.35);
  assert.ok(ph.commission < 0.40);
  assert.equal(ph.commissionCcy, 'USD');
  const ntap = estimateIbkrCommission({ ticker: 'NTAP', qty: 60, price: 191.81, currency: 'USD' });
  assert.ok(ntap.commission >= 0.35);
  assert.ok(ntap.commission < 0.40);
});

test('US large lot tracks $0.0035/sh + clearing (FAST 197 ≈ $0.73)', () => {
  const fast = estimateIbkrCommission({ ticker: 'FAST', qty: 197, price: 50.67, currency: 'USD' });
  assert.ok(Math.abs(fast.commission - 0.73) < 0.01);
});

test('qty-pad gets a commission and price is split out of avgCost', () => {
  const pad = applyEstimatedCommission({
    execId: 'recon-entry-PH|short|Mon Aug 24 2026-pad11',
    ticker: 'PH', qty: 11, price: 1011.03084455, currency: 'USD',
    synthetic: true, recon: 'qty-pad'
  });
  assert.ok(pad.commission > 0);
  assert.ok(pad.price < 1011.03084455);
  assert.ok(Math.abs((pad.price * 11 + pad.commission) - 11 * 1011.03084455) < 1e-4);
});

test('genuine IB exec without commission is left for commissionReport', () => {
  const row = {
    execId: '00025b49.6a91bd82.01.01',
    ticker: 'PLTR', qty: 66, price: 175.97, currency: 'USD'
  };
  assert.equal(fillNeedsEstimatedCommission(row), false);
  const out = applyEstimatedCommission(row);
  assert.equal(out.commission, undefined);
  assert.equal(out.price, 175.97);
});

test('HK estimate is IB + levies only — stamp is booked separately', () => {
  const hk = estimateIbkrCommission({
    ticker: '0700.HK', qty: 100, price: 400, currency: 'HKD'
  });
  const n = 100 * 400;
  const ib = Math.max(18, 0.0008 * n);
  const levies = 0.0001365 * n;
  assert.ok(Math.abs(hk.commission - (ib + levies)) < 1e-4);
  assert.ok(hk.commission < 0.001 * n);
});

test('older HK estimates that baked in stamp are stripped', () => {
  const n = 100 * 400;
  const baked = Math.max(18, 0.0008 * n) + 0.001 * n + 0.0001365 * n;
  const out = stripEstimatedHkStamp({
    ticker: '0700.HK', qty: 100, price: 400, currency: 'HKD',
    commission: baked, commissionSrc: 'ibkr-pro-schedule'
  });
  assert.ok(out.commission < baked);
  assert.ok(Math.abs(out.commission - (Math.max(18, 0.0008 * n) + 0.0001365 * n)) < 1e-4);
});
