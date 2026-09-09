'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyMarket,
  isAngloSymbol,
  angloPickAllowed,
  minRrForSymbol,
  ANGLO_MIN_RR
} = require('../lib/strategy/market-tier');

test('equities are FMP quality — Danelfin is off', () => {
  for (const t of ['AAPL', 'SHEL.L', 'MC.PA', 'SIE.DE', '0700.HK', '7203.T']) {
    const m = classifyMarket(t);
    assert.equal(m.danelfin, false);
    assert.equal(m.tier, 'fmp_quality');
    assert.equal(m.fmp, true);
  }
});

test('commodities stay technical-only', () => {
  const m = classifyMarket('CL=F');
  assert.equal(m.tier, 'technical_only');
  assert.equal(m.fmp, false);
  assert.equal(isAngloSymbol('CL=F'), false);
});

test('US and UK are the Anglo book; France/Germany/Asia are not', () => {
  assert.equal(isAngloSymbol('NVDA'), true);
  assert.equal(isAngloSymbol('SHEL.L'), true);
  assert.equal(isAngloSymbol('MC.PA'), false);
  assert.equal(isAngloSymbol('SIE.DE'), false);
  assert.equal(isAngloSymbol('0700.HK'), false);
});

test('US/UK short buys are blocked; Strong medium buys need 1.4 RR', () => {
  assert.equal(angloPickAllowed('AAPL', { hz: 'short', side: 'buy', rating: 'Strong Buy' }).ok, false);
  assert.equal(angloPickAllowed('SHEL.L', { hz: 'medium', side: 'buy', rating: 'Buy' }).ok, false);
  assert.equal(angloPickAllowed('AAPL', { hz: 'medium', side: 'buy', rating: 'Strong Buy' }).ok, true);
  assert.equal(angloPickAllowed('0700.HK', { hz: 'short', side: 'buy', rating: 'Buy' }).ok, true);
  assert.equal(minRrForSymbol('AAPL', 1.1), ANGLO_MIN_RR);
  assert.equal(minRrForSymbol('SIE.DE', 1.1), 1.1);
});
