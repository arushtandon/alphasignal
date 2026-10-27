'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';

const assert = require('node:assert/strict');
const test = require('node:test');
const { simulateHybridExit, dailyToWeeklyBars } = require('../server');

function flatBars() {
  return Array.from({ length: 260 }, (_, index) => ({
    t: Math.floor(Date.UTC(2024, 0, 1 + index) / 1000),
    o: 100, h: 101, l: 99, c: 100, v: 1_000_000,
  }));
}

test('short mean-reversion exit preserves default behavior without research injection', async () => {
  const bars = flatBars();
  const weekly = dailyToWeeklyBars(bars);
  const base = await simulateHybridExit(bars, 220, 100, 'short', false, weekly);
  const explicitEmpty = await simulateHybridExit(bars, 220, 100, 'short', false, weekly, null, null, false, 0.5, {});
  assert.deepEqual(explicitEmpty, base);
  assert.equal(base.exitIdx, 235);
  assert.equal(base.status, 'time_limit');
});

test('short mean-reversion exit honors research time-stop variants', async () => {
  const bars = flatBars();
  const weekly = dailyToWeeklyBars(bars);
  const fiveBars = await simulateHybridExit(bars, 220, 100, 'short', false, weekly, null, null, false, 0.5, {
    researchExitVariant: { timeBars: 5, tp1R: 1.25, stopCapPct: 0.04, tp1Only: true },
  });
  const tenBars = await simulateHybridExit(bars, 220, 100, 'short', false, weekly, null, null, false, 0.5, {
    researchExitVariant: { timeBars: 10, tp1R: 0.75, stopCapPct: 0.04, tp1Only: true },
  });
  assert.equal(fiveBars.exitIdx, 225);
  assert.equal(tenBars.exitIdx, 230);
  assert.notDeepEqual(fiveBars, tenBars);
});
