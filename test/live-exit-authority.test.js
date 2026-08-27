'use strict';
const assert = require('assert');
const {
  isLiveSignalFlipExit,
  isOperationalIbkrExit,
  isLiveAuthorizedServerExit,
  isPaperPathSimExit,
  shouldApplyLiveTslUpdate
} = require('../lib/ibkr/live-exit-authority');

assert.strictEqual(isPaperPathSimExit({
  status: 'tp1_then_sl',
  exitReason: 'TP1 banked; trailing stop closed runner'
}), true);
assert.strictEqual(isLiveAuthorizedServerExit({
  status: 'tp1_then_sl',
  exitReason: 'TP1 banked; trailing stop closed runner'
}), false, 'paper TSL must not flatten live IB');

assert.strictEqual(isLiveSignalFlipExit({
  liveSignalFlip: true, reason: 'live-signal-flip', status: 'signal_exit'
}), true);
assert.strictEqual(isLiveAuthorizedServerExit({
  liveSignalFlip: true, reason: 'live-signal-flip', status: 'signal_exit'
}), true);
assert.strictEqual(isLiveAuthorizedServerExit({
  exitReason: 'Signal → Sell', status: 'signal_exit'
}), true);

assert.strictEqual(isOperationalIbkrExit({
  reason: 'unauthorized-non-recommendation', errorTrade: true
}), true);
assert.strictEqual(isLiveAuthorizedServerExit({
  reason: 'ib-flat-after-grace', errorTrade: true
}), true);
assert.strictEqual(isLiveAuthorizedServerExit({
  errorTrade: true, correctiveReentry: true
}), true);

assert.strictEqual(isLiveAuthorizedServerExit({
  status: 'time_limit', exitReason: 'Horizon time limit exit'
}), false);
assert.strictEqual(shouldApplyLiveTslUpdate({ tp1Done: true, closed: false }), true);
assert.strictEqual(shouldApplyLiveTslUpdate({ tp1Done: false, closed: false }), false);
assert.strictEqual(shouldApplyLiveTslUpdate({
  tp1Done: true, closed: true
}), false, 'closed lots do not ratchet');
assert.strictEqual(shouldApplyLiveTslUpdate({
  closed: false, tp1Done: false, qtyTotal: 413, qtySold: 207, qtyRunner: 206
}), true, 'remaining runner after partial');

const {
  isForceCashOpenTicker,
  ignoreServerExitForUnfilledForcePrint
} = require('../lib/ibkr/live-exit-authority');

assert.strictEqual(isForceCashOpenTicker('6098.T'), true);
assert.strictEqual(isForceCashOpenTicker('2914.T'), false);
assert.strictEqual(ignoreServerExitForUnfilledForcePrint(
  { ticker: '6098.T', entryFilled: false },
  { reason: 'stale-open-not-ib', status: 'signal_exit' },
  { forcePrint: true }
), true, '6098 must not cancel on Friday board drop');
assert.strictEqual(ignoreServerExitForUnfilledForcePrint(
  { ticker: '6098.T', entryFilled: false },
  { liveSignalFlip: true, reason: 'live-signal-flip', status: 'signal_exit' },
  { forcePrint: true }
), true, '6098 must not cancel on live-signal flip before fill');
assert.strictEqual(ignoreServerExitForUnfilledForcePrint(
  { ticker: '6098.T', entryFilled: false },
  { reason: 'user-flatten' },
  { forcePrint: true }
), false, 'user flatten still wins');
assert.strictEqual(ignoreServerExitForUnfilledForcePrint(
  { ticker: '6098.T', entryFilled: true },
  { reason: 'stale-open-not-ib' },
  { forcePrint: true }
), false, 'filled 6098 follows normal exits');
assert.strictEqual(ignoreServerExitForUnfilledForcePrint(
  { ticker: '0669.HK', entryFilled: false },
  { reason: 'stale-open-not-ib' },
  { asiaCarry: true }
), true, 'unfilled Asia carry ignores stale-open');

console.log('PASS live-exit-authority');
