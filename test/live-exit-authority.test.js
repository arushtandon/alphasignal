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

console.log('PASS live-exit-authority');
