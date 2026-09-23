'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';
process.env.PORT = process.env.PORT || '3996';

const { liveSignalFlipExit } = require('../server');

function map(current, previous) {
  return {
    TEST: {
      quantSignal: { short: current },
      prevQuantSignal: previous ? { short: previous } : {}
    }
  };
}

test('live signal-reversal flattening is paused by default', () => {
  delete process.env.IBKR_SIGNAL_FLIP_EXIT_ENABLED;
  const sell = { action: 'Sell', sellScore: 80, winRateHint: 65 };
  assert.equal(liveSignalFlipExit('TEST', 'short', false, map(sell, sell)), null);
});

test('one intraday opposite score cannot market-flatten a live lot', () => {
  process.env.IBKR_SIGNAL_FLIP_EXIT_ENABLED = '1';
  const sell = { action: 'Sell', sellScore: 80, winRateHint: 65 };
  assert.equal(liveSignalFlipExit('TEST', 'short', false, map(sell, null)), null);
});

test('confidence-demoted Hold cannot trigger signal exit', () => {
  process.env.IBKR_SIGNAL_FLIP_EXIT_ENABLED = '1';
  const hold = { action: 'Hold', sellScore: 80, winRateHint: 56 };
  assert.equal(liveSignalFlipExit('TEST', 'short', false, map(hold, hold)), null);
});

test('two actionable opposite daily signals confirm a reversal exit', () => {
  process.env.IBKR_SIGNAL_FLIP_EXIT_ENABLED = '1';
  const current = { action: 'Sell', sellScore: 80, winRateHint: 65 };
  const previous = { action: 'Sell', sellScore: 74, winRateHint: 62 };
  const flip = liveSignalFlipExit('TEST', 'short', false, map(current, previous));
  assert.equal(flip.reason, 'Sell');
  assert.equal(flip.confirmation, 'two-daily-bars');
  assert.equal(flip.previousScore, 74);
});
