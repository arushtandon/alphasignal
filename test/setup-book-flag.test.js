'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('SETUP_BOOK_ENABLED defaults off and does not gate live cells', () => {
  delete process.env.SETUP_BOOK_ENABLED;
  const { setupBookEnabled, fmpTierOverlayEnabled } = require('../lib/strategy/feature-flags');
  const { resolveSetupBookCell, ibkrSetupBookAllowed } = require('../lib/strategy/setup-book');
  assert.equal(setupBookEnabled(), false);
  assert.equal(fmpTierOverlayEnabled(), false);
  const resolved = resolveSetupBookCell({ market: 'US', horizon: 'medium', side: 'buy' });
  assert.equal(resolved.gated, false);
  assert.equal(resolved.recommendability, 'unchanged');
  assert.equal(ibkrSetupBookAllowed(resolved), true);
});

test('enabled setup book publishes only frozen cells and remains paper-account only', () => {
  process.env.SETUP_BOOK_ENABLED = '1';
  process.env.SETUP_BOOK_PAPER_EXECUTION = '1';
  delete require.cache[require.resolve('../lib/strategy/feature-flags')];
  delete require.cache[require.resolve('../lib/strategy/setup-book')];
  const { resolveSetupBookCell, ibkrSetupBookAllowed, CELLS } = require('../lib/strategy/setup-book');
  try {
    assert.equal(Object.values(CELLS).filter(row => row.setupId).length, 12);
    const india = resolveSetupBookCell({ market: 'India', horizon: 'long', side: 'buy' });
    assert.equal(india.signalsOnly, true);
    assert.equal(ibkrSetupBookAllowed(india, { account: 'DU123', role: 'paper' }), false);
    const usMedium = resolveSetupBookCell({ market: 'US', horizon: 'medium', side: 'buy' });
    assert.equal(usMedium.gated, true);
    assert.equal(usMedium.recommendability, 'none');
    assert.equal(ibkrSetupBookAllowed(usMedium, { account: 'DU123', role: 'paper' }), false);
    const usShort = resolveSetupBookCell({ market: 'US', horizon: 'short', side: 'buy' });
    assert.equal(usShort.verdict, 'EXPERIMENTAL');
    assert.equal(ibkrSetupBookAllowed(usShort, { account: 'DU123', role: 'paper' }), true);
    assert.equal(ibkrSetupBookAllowed(usShort, { account: 'U123', role: 'live' }), false);
    assert.equal(ibkrSetupBookAllowed(usShort, { account: 'U123', role: 'paper' }), false);
  } finally {
    delete process.env.SETUP_BOOK_ENABLED;
    delete process.env.SETUP_BOOK_PAPER_EXECUTION;
    delete require.cache[require.resolve('../lib/strategy/feature-flags')];
    delete require.cache[require.resolve('../lib/strategy/setup-book')];
  }
});
