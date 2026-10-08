'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanDiagnostic } = require('../lib/strategy/scan-diagnostic');

test('scan diagnostic counts the funnel and the last drop gate', () => {
  const diagnostic = createScanDiagnostic(
    { reason: 'test' },
    {
      US_SHORT_MR: { id: 'US_SHORT_MR', market: 'US', horizon: 'short', kind: 'mean_reversion' },
      FRANCE_LONG_MOMENTUM: { id: 'FRANCE_LONG_MOMENTUM', market: 'France', horizon: 'long', kind: 'momentum' },
    },
    id => ({ paused: id === 'FRANCE_LONG_MOMENTUM', reason: id === 'FRANCE_LONG_MOMENTUM' ? 'alpha t' : null }),
  );
  diagnostic.noteMarket('US', 'SPY', new Array(400), new Array(399));
  diagnostic.scanned('US_SHORT_MR', 'AAA', 400);
  diagnostic.scanned('US_SHORT_MR', 'BBB', 100);
  diagnostic.drop('US_SHORT_MR', 'BBB', 'daily < 275');
  diagnostic.scanned('US_SHORT_MR', 'CCC', 400);
  diagnostic.trigger('US_SHORT_MR', 'CCC');
  diagnostic.plan('US_SHORT_MR', 'CCC');
  diagnostic.shortlist('US_SHORT_MR', 'CCC');
  diagnostic.drop('US_SHORT_MR', 'CCC', 'filterDashDataByMinRR');
  diagnostic.scanned('US_SHORT_MR', 'DDD', 400);
  diagnostic.trigger('US_SHORT_MR', 'DDD');
  diagnostic.plan('US_SHORT_MR', 'DDD');
  diagnostic.shortlist('US_SHORT_MR', 'DDD');
  diagnostic.board('US_SHORT_MR', 'DDD');
  const snap = diagnostic.snapshot({ dryRun: true });
  assert.equal(snap.markets.US.benchmark, 'SPY');
  assert.equal(snap.markets.US.rawBars, 400);
  assert.equal(snap.markets.US.completedBars, 399);
  const mr = snap.setups.US_SHORT_MR;
  assert.equal(mr.symbolsScanned, 4);
  assert.equal(mr.dailyUnder275, 1);
  assert.equal(mr.triggers, 2);
  assert.equal(mr.plans, 2);
  assert.equal(mr.shortlist, 2);
  assert.equal(mr.board, 1);
  assert.deepEqual(mr.drops.map(row => row.gate), ['daily < 275', 'filterDashDataByMinRR']);
  assert.equal(snap.setups.FRANCE_LONG_MOMENTUM.paused, true);
  assert.equal(snap.setups.FRANCE_LONG_MOMENTUM.reason, 'alpha t');
  assert.equal(snap.setups.FRANCE_LONG_MOMENTUM.inMorningScan, false);
});
