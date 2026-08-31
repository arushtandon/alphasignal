'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { geoOfTicker } = require('../lib/research/geography');

test('ticker suffix maps to listing geography', () => {
  assert.equal(geoOfTicker('NVDA'), 'United States');
  assert.equal(geoOfTicker('FOX'), 'United States');
  assert.equal(geoOfTicker('0883.HK'), 'Hong Kong');
  assert.equal(geoOfTicker('6098.T'), 'Japan');
  assert.equal(geoOfTicker('BA.L'), 'United Kingdom');
  assert.equal(geoOfTicker('SAP.DE'), 'Germany');
  assert.equal(geoOfTicker('SU.PA'), 'France');
  assert.equal(geoOfTicker('ASML.AS'), 'Europe');
  assert.equal(geoOfTicker('RELIANCE.NS'), 'India');
  assert.equal(geoOfTicker('BZ=F'), 'Commodities');
  assert.equal(geoOfTicker('BTC-USD'), 'Crypto');
});
