'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { estimateRoundTripCostPct, researchMarketProfile } = require('../lib/research/cost-model');

test('UK round-trip research cost includes the full 0.5% purchase SDRT', () => {
  const uk = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'buy', holdDays: 0 });
  const us = estimateRoundTripCostPct({ symbol: 'SHEL', side: 'buy', holdDays: 0 });
  assert.ok(uk - us >= 0.5, `UK=${uk}% US=${us}%`);
});

test('UK and HK ETFs carry no stamp duty (ISF.L, 2800.HK); single stocks still do', () => {
  const isf = estimateRoundTripCostPct({ symbol: 'ISF.L', side: 'buy', holdDays: 2 });
  const shel = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'buy', holdDays: 2 });
  assert.equal(+(shel - isf).toFixed(4), 0.5);
  const tracker = estimateRoundTripCostPct({ symbol: '2800.HK', side: 'buy', holdDays: 2 });
  const hsbc = estimateRoundTripCostPct({ symbol: '0005.HK', side: 'buy', holdDays: 2 });
  assert.equal(+(hsbc - tracker).toFixed(4), 0.13);
  const flagged = estimateRoundTripCostPct({ symbol: 'XYZ.L', side: 'buy', holdDays: 2, etf: true });
  assert.equal(flagged, isf);
});

test('UK short includes borrow but no second SDRT charge', () => {
  const buy = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'buy', holdDays: 10 });
  const sell = estimateRoundTripCostPct({ symbol: 'SHEL.L', side: 'sell', holdDays: 10 });
  assert.equal(+(sell - buy).toFixed(4), 0.07);
});

test('research geography labels map to explicit cost profiles', () => {
  assert.equal(researchMarketProfile('Germany', 'SAP.DE'), 'EU');
  assert.equal(researchMarketProfile('France', 'MC.PA'), 'EU');
  assert.equal(researchMarketProfile('Japan', '7203.T'), 'JP');
  assert.equal(researchMarketProfile('Commodities', 'CL=F'), 'OTHER');
});
