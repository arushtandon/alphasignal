'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  preferredExchange,
  fallbackExchange,
  listingVenue,
  isRoutingError,
  isSessionBlockedError,
  asiaCashBlocksRestingOrders,
  placeableStkContract
} = require('../lib/ibkr/order-routing');

test('HK names route to SEHK, not SMART', () => {
  const c = {
    symbol: '883', market: 'HK', currency: 'HKD',
    primaryExch: 'SEHK', conId: 12150119, exchange: 'SMART'
  };
  assert.equal(preferredExchange(c), 'SEHK');
  assert.equal(placeableStkContract(c).exchange, 'SEHK');
  assert.equal(placeableStkContract(c).conId, 12150119);
  assert.equal(fallbackExchange('SMART', c), 'SEHK');
  assert.equal(fallbackExchange('SEHK', c), 'SMART');
});

test('JPY names route to TSEJ', () => {
  const c = { symbol: '6501', market: 'JP', currency: 'JPY', primaryExch: 'TSEJ', conId: 1 };
  assert.equal(preferredExchange(c), 'TSEJ');
  assert.equal(fallbackExchange('TSEJ', c), 'SMART');
});

test('US names stay on SMART and fall back to the listing venue', () => {
  const c = { symbol: 'NVDA', market: 'US', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
  assert.equal(preferredExchange(c), 'SMART');
  assert.equal(fallbackExchange('SMART', c), 'NASDAQ');
  assert.equal(listingVenue(c), 'NASDAQ');
});

test('error 200 is a routing miss; 201 short-sale is a session block', () => {
  assert.equal(isRoutingError(200), true);
  assert.equal(isRoutingError(201), false);
  assert.equal(isSessionBlockedError(201, 'The contract is not available for short sale.'), true);
  assert.equal(isSessionBlockedError(200, 'No security definition'), false);
});

test('stored SMART on an HK row still routes to SEHK', () => {
  const c = {
    symbol: '883', market: 'HK', currency: 'HKD',
    primaryExch: 'SEHK', conId: 12150119, exchange: 'SMART'
  };
  assert.equal(preferredExchange(c), 'SEHK');
  assert.equal(placeableStkContract(c).exchange, 'SEHK');
  assert.equal(placeableStkContract(c, 'SMART').exchange, 'SMART');
});

test('HK/JP lunch and overnight block new resting orders; US does not', () => {
  const hk = { market: 'HK', currency: 'HKD', primaryExch: 'SEHK' };
  const us = { market: 'US', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
  assert.equal(asiaCashBlocksRestingOrders(hk, 'lunch'), true);
  assert.equal(asiaCashBlocksRestingOrders(hk, 'closed'), true);
  assert.equal(asiaCashBlocksRestingOrders(hk, 'rth'), false);
  assert.equal(asiaCashBlocksRestingOrders(us, 'closed'), false);
});
