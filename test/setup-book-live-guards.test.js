'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('live role never enables paper execution even when flags are on', () => {
  process.env.SETUP_BOOK_ENABLED = '1';
  process.env.SETUP_BOOK_PAPER_EXECUTION = '1';
  process.env.IBKR_BRIDGE_ROLE = 'live';
  delete require.cache[require.resolve('../lib/strategy/feature-flags')];
  delete require.cache[require.resolve('../lib/strategy/setup-book')];
  const { setupBookPaperExecutionEnabled } = require('../lib/strategy/feature-flags');
  const { ibkrSetupBookAllowed, resolveSetupBookCell } = require('../lib/strategy/setup-book');
  try {
    assert.equal(setupBookPaperExecutionEnabled(), false);
    process.env.SETUP_BOOK_ENABLED = '1';
    const resolved = resolveSetupBookCell({ market: 'Japan', horizon: 'medium', side: 'buy' });
    assert.equal(ibkrSetupBookAllowed(resolved, { account: 'U123456', role: 'live' }), false);
    assert.equal(ibkrSetupBookAllowed(resolved, { account: 'DU1764495', role: 'live' }), false);
  } finally {
    delete process.env.SETUP_BOOK_ENABLED;
    delete process.env.SETUP_BOOK_PAPER_EXECUTION;
    delete process.env.IBKR_BRIDGE_ROLE;
    delete require.cache[require.resolve('../lib/strategy/feature-flags')];
    delete require.cache[require.resolve('../lib/strategy/setup-book')];
  }
});

test('paper DU can execute published and experimental setup-book cells', () => {
  process.env.SETUP_BOOK_ENABLED = '1';
  process.env.SETUP_BOOK_PAPER_EXECUTION = '1';
  delete process.env.IBKR_BRIDGE_ROLE;
  delete require.cache[require.resolve('../lib/strategy/feature-flags')];
  delete require.cache[require.resolve('../lib/strategy/setup-book')];
  const { ibkrSetupBookAllowed, resolveSetupBookCell } = require('../lib/strategy/setup-book');
  try {
    const japan = resolveSetupBookCell({ market: 'Japan', horizon: 'medium', side: 'buy' });
    const experimental = resolveSetupBookCell({ market: 'US', horizon: 'short', side: 'buy' });
    const empty = resolveSetupBookCell({ market: 'UK', horizon: 'long', side: 'buy' });
    assert.equal(japan.setupId, 'JAPAN_MEDIUM_MR');
    assert.equal(ibkrSetupBookAllowed(japan, { account: 'DU1764495', role: 'paper' }), true);
    assert.equal(ibkrSetupBookAllowed(experimental, { account: 'DU1764495', role: 'paper' }), true);
    assert.equal(ibkrSetupBookAllowed(empty, { account: 'DU1764495', role: 'paper' }), false);
  } finally {
    delete process.env.SETUP_BOOK_ENABLED;
    delete process.env.SETUP_BOOK_PAPER_EXECUTION;
    delete require.cache[require.resolve('../lib/strategy/feature-flags')];
    delete require.cache[require.resolve('../lib/strategy/setup-book')];
  }
});
