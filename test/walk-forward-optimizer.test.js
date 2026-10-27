'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDateAlignedFolds,
  assertFoldIsolation,
  improvesWinRateAndPnl,
  runNestedSelection,
} = require('../lib/research/walk-forward-optimizer');

function dates(count) {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10));
}

test('four folds are date aligned and separated by an embargo', () => {
  const folds = buildDateAlignedFolds(dates(80), {
    folds: 4,
    trainBars: 20,
    validationBars: 8,
    testBars: 8,
    embargoBars: 5,
  });
  assert.equal(folds.length, 4);
  assert.equal(folds.at(-1).finalHoldout, true);
  assert.equal(folds[0].embargo.bars, 5);
  assert.equal(assertFoldIsolation(folds), true);
});

test('nested selection never evaluates candidates on final holdout before freezing', () => {
  const folds = buildDateAlignedFolds(dates(80), {
    folds: 4,
    trainBars: 20,
    validationBars: 8,
    testBars: 8,
    embargoBars: 5,
  });
  const validationRanges = [];
  const testRanges = [];
  const result = runNestedSelection({
    folds,
    candidates: [{ id: 'a' }, { id: 'b' }],
    fallback: { id: 'a' },
    evaluateValidation(candidate, range) {
      validationRanges.push(range);
      return { score: candidate.id === 'b' ? 2 : 1, metrics: { trades: 30 } };
    },
    evaluateTest(candidate, range) {
      testRanges.push({ candidate: candidate.id, range });
      return { trades: 30 };
    },
  });
  assert.equal(result.frozen.id, 'b');
  assert.equal(validationRanges.some(range => range.from === folds.at(-1).test.from), false);
  assert.deepEqual(testRanges.at(-1), { candidate: 'b', range: folds.at(-1).test });
});

test('overlapping ranges are rejected', () => {
  assert.throws(() => assertFoldIsolation([{
    fold: 1,
    finalHoldout: true,
    train: { from: '2020-01-01', to: '2020-01-10' },
    validation: { from: '2020-01-10', to: '2020-01-20' },
    embargo: { from: null, to: null, bars: 0 },
    test: { from: '2020-01-21', to: '2020-01-30' },
  }]), /overlap/);
});

test('dual-improvement requires both higher win rate and higher PnL', () => {
  const baseline = { winRate: 60, pnlUsd: 1000 };
  assert.equal(improvesWinRateAndPnl({ winRate: 61, pnlUsd: 1001 }, baseline), true);
  assert.equal(improvesWinRateAndPnl({ winRate: 70, pnlUsd: 999 }, baseline), false);
  assert.equal(improvesWinRateAndPnl({ winRate: 59, pnlUsd: 5000 }, baseline), false);
  assert.equal(improvesWinRateAndPnl({ winRate: 60, pnlUsd: 1000 }, baseline), false);
});
