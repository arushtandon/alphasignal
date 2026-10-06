'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batchDue,
  score12Minus1,
  rankMembers,
  selectEntry,
  sleevesToExit,
  shouldAutoPause,
  addMonths,
} = require('../lib/strategy/momentum-book');
const { setupExitDecision, SETUPS } = require('../lib/strategy/evidence-setup-book');

function bars(count, start = 100) {
  const out = [];
  for (let index = 0; index < count; index++) {
    const day = new Date(Date.UTC(2018, 0, 1 + index));
    out.push({ date: day.toISOString().slice(0, 10), c: start + index });
  }
  return out;
}

test('momentum batch is the first session after month-end', () => {
  const dates = ['2026-09-29', '2026-09-30', '2026-10-01'];
  assert.equal(batchDue(dates, '2026-10-01', false), true);
  assert.equal(batchDue(dates, '2026-10-01', true), false);
  assert.equal(batchDue(dates, '2026-10-02', false), false);
  assert.equal(batchDue(['2026-09-30'], '2026-10-03', false), false);
});

test('12-1 rank skips a name already held and a six-month sleeve is due', () => {
  const series = new Map([
    ['AAA.L', bars(400, 50)],
    ['BBB.L', bars(400, 80)],
  ]);
  const asOf = '2019-02-05';
  const ranked = rankMembers(['AAA.L', 'BBB.L'], series, asOf);
  assert.equal(ranked.length, 2);
  assert.equal(selectEntry(ranked, new Set(['BBB.L'])).ticker, ranked.find(row => row.ticker !== 'BBB.L').ticker);
  assert.equal(score12Minus1(bars(400), asOf) > 0, true);
  const due = sleevesToExit([
    { month: '2026-04', ticker: 'AAA.L' },
    { month: '2026-05', ticker: 'BBB.L' },
  ], '2026-10');
  assert.deepEqual(due.map(row => row.ticker), ['AAA.L']);
  assert.equal(addMonths('2026-04', 6), '2026-10');
});

test('auto-pause needs six entries and more than five points behind', () => {
  assert.equal(shouldAutoPause(5, 0.01, 0.20), false);
  assert.equal(shouldAutoPause(6, 0.10, 0.16), true);
  assert.equal(shouldAutoPause(6, 0.12, 0.16), false);
  assert.equal(SETUPS.UK_LONG_MOMENTUM.experimentalLabel, 'Experimental');
  assert.equal(SETUPS.UK_LONG_MOMENTUM.benchmark, 'EWU');
  assert.equal(SETUPS.FRANCE_LONG_MOMENTUM.benchmark, 'EWQ');
  assert.equal(SETUPS.UK_LONG_MOMENTUM.stops, false);
  const position = { entry: 100, entryIndex: 0 };
  const held = Array.from({ length: 130 }, (_, index) => ({ h: 101, l: 99, c: 100, o: 100 }));
  assert.equal(setupExitDecision('UK_LONG_MOMENTUM', position, held, 10).action, 'hold');
  assert.equal(setupExitDecision('UK_LONG_MOMENTUM', position, held, 126).reason, 'hold_complete');
});
