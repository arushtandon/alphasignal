'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  factorEligibility,
  binomialWinPValue,
  sampleConfidence,
} = require('../lib/research/omitted-geo-rescue');

test('slow factors are ineligible on short horizon', () => {
  assert.deepStrictEqual(
    factorEligibility('hk_southbound_flow', 'short', { market: 'HK' }),
    { eligible: false, reason: 'ineligible: factor-horizon mismatch' },
  );
});

test('thin sample requires the stricter PF, significance and stability safeguards', () => {
  const pass = sampleConfidence(
    { trades: 20, winRate: 75, profitFactor: 1.7, pnlUsd: 500 },
    2,
  );
  assert.equal(pass.flag, 'THIN n15-29-passed-safeguard');
  assert.equal(pass.pass, true);
  const fail = sampleConfidence(
    { trades: 20, winRate: 75, profitFactor: 1.3, pnlUsd: 500 },
    2,
  );
  assert.equal(fail.flag, 'FAIL');
});

test('exact binomial tail is directionally correct', () => {
  assert.ok(binomialWinPValue(15, 20) < 0.05);
  assert.equal(binomialWinPValue(10, 20) > 0.05, true);
});
