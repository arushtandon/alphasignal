'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { estimateRoundTripCostPct } = require('../lib/research/cost-model');

test('UK round-trip research cost includes the full 0.5% purchase SDRT', () => {
  const uk = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'buy', holdDays: 0 });
  const us = estimateRoundTripCostPct({ symbol: 'SHEL', side: 'buy', holdDays: 0 });
  assert.ok(uk - us >= 0.5, `UK=${uk}% US=${us}%`);
});

test('UK short includes borrow but no second SDRT charge', () => {
  const buy = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'buy', holdDays: 10 });
  const sell = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'sell', holdDays: 10 });
  assert.equal(+(sell - buy).toFixed(4), 0.07);
});
