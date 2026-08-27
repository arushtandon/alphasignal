'use strict';
const assert = require('assert');
const {
  preferredCommoditySpec,
  orderedCommoditySpecs,
  ibFutSymbolToYahoo,
  INSTRUMENT_NOTIONAL_USD
} = require('../lib/ibkr/commodity-futures');
const { toContract } = require('../ibkr-bridge/bridge');
const { calculateRiskSize } = require('../lib/risk/sizing');

assert.strictEqual(INSTRUMENT_NOTIONAL_USD, 10000);

assert.strictEqual(preferredCommoditySpec('GC=F', 3400).symbol, '1OZ',
  'gold uses 1-oz so ~$10k is reachable (MGC is ~$34k)');
assert.strictEqual(preferredCommoditySpec('CL=F', 75).symbol, 'MCL');
assert.strictEqual(preferredCommoditySpec('BZ=F', 87).symbol, 'G',
  'most liquid 100-bbl Brent mini that fits $10k');
assert.strictEqual(preferredCommoditySpec('NG=F', 3).symbol, 'QG');
assert.strictEqual(preferredCommoditySpec('HG=F', 4.4).symbol, 'MHG');
assert.strictEqual(preferredCommoditySpec('SI=F', 38).symbol, 'SIC');
assert.strictEqual(preferredCommoditySpec('PA=F', 1000).symbol, 'PAM');
assert.strictEqual(preferredCommoditySpec('PL=F', 950).symbol, 'PLM');

const goldOrder = orderedCommoditySpecs('GC=F', 3400).map(s => s.symbol);
assert.ok(goldOrder.indexOf('1OZ') < goldOrder.indexOf('MGC'));
assert.ok(goldOrder.indexOf('MGC') < goldOrder.indexOf('GC'));

assert.strictEqual(ibFutSymbolToYahoo('MCL'), 'CL=F');
assert.strictEqual(ibFutSymbolToYahoo('BZ'), 'BZ=F');
assert.strictEqual(ibFutSymbolToYahoo('MGC'), 'GC=F');
assert.strictEqual(ibFutSymbolToYahoo('G'), 'BZ=F');

assert.strictEqual(toContract('CL=F').symbol, 'MCL');
assert.strictEqual(toContract('CL=F').multiplier, 100);
assert.strictEqual(toContract('GC=F').symbol, '1OZ');
assert.strictEqual(toContract('BZ=F').symbol, 'G');
assert.strictEqual(toContract('BZ=F').multiplier, 100);
assert.strictEqual(toContract('ES=F').symbol, 'ES', 'index futures stay on the E-mini');

const mcl = calculateRiskSize({
  nlv: 467_000, entry: 75, stop: 70, multiplier: 100, lot: 1, secType: 'FUT',
  maxNotionalUsd: 10000
});
assert.strictEqual(mcl.eligible, true);
assert.strictEqual(mcl.quantity, 1);
assert.ok(mcl.notionalUsd <= 10000, 'micro WTI stays inside $10k');

const oz = calculateRiskSize({
  nlv: 467_000, entry: 3400, stop: 3200, multiplier: 1, lot: 1, secType: 'FUT',
  maxNotionalUsd: 10000
});
assert.strictEqual(oz.eligible, true);
assert.strictEqual(oz.quantity, 2);
assert.ok(oz.notionalUsd <= 10000);

console.log('PASS commodity-futures minis');
