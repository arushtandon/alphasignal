'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  preferredExchange,
  fallbackExchange,
  listingVenue,
  parentStandalone,
  isRoutingError,
  isSessionBlockedError,
  isShortSaleReject,
  asiaCashBlocksRestingOrders,
  shouldDeferProtectiveChildren,
  ibLocalSymbol,
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

test('JPY names route SMART first (TSEJ direct is discarded by TWS 10311)', () => {
  const c = { symbol: '6501', market: 'JP', currency: 'JPY', primaryExch: 'TSEJ', conId: 1 };
  assert.equal(preferredExchange(c), 'SMART');
  assert.equal(fallbackExchange('SMART', c), 'TSEJ');
});

test('Yahoo suffixes are never sent as IB localSymbol', () => {
  assert.equal(ibLocalSymbol('6098.T'), undefined);
  assert.equal(ibLocalSymbol('0005.HK'), undefined);
  assert.equal(ibLocalSymbol('BA.'), 'BA.');
  const c = {
    symbol: '6098', market: 'JP', currency: 'JPY', primaryExch: 'TSEJ',
    conId: 166623148, localSymbol: '6098.T'
  };
  assert.equal(placeableStkContract(c).localSymbol, undefined);
  assert.equal(placeableStkContract(c).symbol, '6098');
  assert.equal(placeableStkContract(c).exchange, 'SMART');
});

test('LSE parents transmit standalone so a child 110 cannot kill the entry', () => {
  const lse = { symbol: 'SGRO', market: 'LSE', currency: 'GBP', primaryExch: 'LSE' };
  const jp = { symbol: '7733', market: 'JP', currency: 'JPY', primaryExch: 'TSEJ' };
  const us = { symbol: 'NVDA', market: 'US', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
  assert.equal(parentStandalone(lse), true);
  assert.equal(parentStandalone(jp), true);
  assert.equal(parentStandalone(us), false);
});

test('US names stay on SMART and fall back to the listing venue', () => {
  const c = { symbol: 'NVDA', market: 'US', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
  assert.equal(preferredExchange(c), 'SMART');
  assert.equal(fallbackExchange('SMART', c), 'NASDAQ');
  assert.equal(listingVenue(c), 'NASDAQ');
});

test('error 200 is a routing miss; 201 short-sale is not a session block', () => {
  assert.equal(isRoutingError(200), true);
  assert.equal(isRoutingError(201), false);
  assert.equal(isSessionBlockedError(201, 'The contract is not available for short sale.'), false);
  assert.equal(isSessionBlockedError(201, 'The exchange is closed.'), true);
  assert.equal(isSessionBlockedError(200, 'No security definition'), false);
  assert.equal(isShortSaleReject(201, 'The contract is not available for short sale.'), true);
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

test('on parent fill, try GTC except during HK/JP lunch', () => {
  const hk = { market: 'HK', currency: 'HKD', primaryExch: 'SEHK' };
  const us = { market: 'US', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
  const fut = { market: 'US', currency: 'USD', secType: 'FUT' };
  assert.equal(shouldDeferProtectiveChildren(hk, 'lunch', { onFill: true }), true);
  assert.equal(shouldDeferProtectiveChildren(hk, 'closed', { onFill: true }), false);
  assert.equal(shouldDeferProtectiveChildren(hk, 'rth', { onFill: true }), false);
  assert.equal(shouldDeferProtectiveChildren(us, 'closed', { onFill: true }), false);
  assert.equal(shouldDeferProtectiveChildren(fut, 'rth', { onFill: true }), false);
  assert.equal(shouldDeferProtectiveChildren(hk, 'closed', {}), true);
  assert.equal(shouldDeferProtectiveChildren(us, 'closed', {}), true);
  assert.equal(shouldDeferProtectiveChildren(us, 'rth', {}), false);
});
