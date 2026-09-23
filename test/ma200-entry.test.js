'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ma200BreakConfirmed,
  ma200BounceSetup,
  attachMa200Entry
} = require('../lib/strategy/ma200-entry');

test('already well above MA200 is not a break (7733-style)', () => {
  assert.equal(ma200BreakConfirmed({
    price: 1975, ma200: 1778.6, barsSinceCrossUp: 8, consecutiveAbove: 8, ma200SlopeUp: true
  }), false);
});

test('confirmed break is a recent hold just above MA200', () => {
  assert.equal(ma200BreakConfirmed({
    price: 102, ma200: 100, barsSinceCrossUp: 5, consecutiveAbove: 4, ma200SlopeUp: true
  }), true);
  assert.equal(ma200BreakConfirmed({
    price: 102, ma200: 100, barsSinceCrossUp: 1, consecutiveAbove: 1, ma200SlopeUp: true
  }), false);
});

test('bounce is a tag/sit on MA200 with turn-up tape', () => {
  assert.equal(ma200BounceSetup({
    price: 100.5, ma200: 100, low: 99.8, rsiRising: true
  }), true);
  assert.equal(ma200BounceSetup({
    price: 111, ma200: 100, low: 110, rsiRising: true
  }), false, 'already extended is not a bounce');
  assert.equal(ma200BounceSetup({
    price: 100.4, ma200: 100, low: 100.1, rsiRising: false, macdTurnUp: false,
    consecutiveHigherCloses: 0, prevClose: 100.5
  }), false, 'no bounce tape');
});

test('attachMa200Entry flags a bounce and not a late extension', () => {
  const closes = [];
  for (let i = 0; i < 220; i++) closes.push(100);
  const daily = closes.map((c, i) => ({ c, h: c + 0.4, l: i === 219 ? 99.7 : c - 0.3 }));
  daily[219].c = 100.4;
  const tech = attachMa200Entry({
    currentPrice: 100.4, ma200: 100, rsiRising: true, macdTurningUp: true,
    consecutiveHigherCloses: 1
  }, daily);
  assert.equal(tech.ma200BounceSetup, true);
  assert.equal(tech.ma200BuySetup, true);
  assert.equal(tech.extendedAboveMa200, false);
});
