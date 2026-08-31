'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { futuresDueForRoll, planFuturesRoll } = require('../lib/ibkr/futures-roll');

const bzOct = {
  secType: 'FUT',
  lastTradeDateOrContractMonth: '20260828 14:30:00 US/Eastern',
  localSymbol: 'BZV6',
  conId: 339981281
};

test('October Brent is due to roll on and after last trade day', () => {
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-27T12:00:00Z')), false);
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-28T12:00:00Z')), true);
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-31T06:00:00Z')), true);
  assert.equal(futuresDueForRoll({ secType: 'STK' }, new Date('2026-08-31T06:00:00Z')), false);
});

test('BZ roll keeps rec percentages off the new front fill', () => {
  const planned = planFuturesRoll({
    entry: 86.56, tp1Px: 91.85, originalSl: 81.86, tp2Px: 94.20
  }, 89.31);
  assert.ok(planned);
  assert.equal(+planned.tp1.toFixed(2), 94.77);
  assert.equal(+planned.sl.toFixed(2), 84.46);
  assert.equal(+planned.tp2.toFixed(2), 97.19);
  const tp1Pct = (91.85 - 86.56) / 86.56;
  assert.equal(+((planned.tp1 - 89.31) / 89.31).toFixed(6), +tp1Pct.toFixed(6));
});
