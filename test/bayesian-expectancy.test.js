'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  betaPosteriorMean,
  betaLowerBound,
  blendHierarchicalPrior,
  trailingClosedTrades,
  penalizedSelectionScore,
} = require('../lib/research/bayesian-expectancy');

test('small samples shrink toward the prior', () => {
  const small = betaPosteriorMean(1, 0, { alpha: 10, beta: 10 });
  const large = betaPosteriorMean(100, 0, { alpha: 10, beta: 10 });
  assert.ok(small < large);
  assert.ok(small < 0.6);
});

test('hierarchical prior incorporates parent evidence with capped strength', () => {
  const prior = blendHierarchicalPrior({
    global: { wins: 60, losses: 40 },
    geography: { wins: 14, losses: 6 },
    cell: { wins: 7, losses: 3 },
  });
  assert.ok(prior.mean > 0.5);
  assert.ok(prior.contributions.length === 3);
  assert.ok(prior.strength < 50);
});

test('trailing gate includes only trades closed strictly before signal', () => {
  const trades = [
    { exitDate: '2024-01-01', ret: 0.01 },
    { exitDate: '2024-01-05', ret: 0.02 },
    { exitDate: '2024-01-10', ret: -0.01 },
  ];
  assert.deepEqual(
    trailingClosedTrades(trades, '2024-01-10').map(trade => trade.exitDate),
    ['2024-01-01', '2024-01-05'],
  );
});

test('lower credible bound rises with stronger winning evidence', () => {
  assert.ok(betaLowerBound(70, 30, { alpha: 1, beta: 1 })
    > betaLowerBound(7, 3, { alpha: 1, beta: 1 }));
});

test('selection score penalizes complexity and sample shortfall', () => {
  const simple = penalizedSelectionScore({
    lowerBound: 0.55,
    expectancy: 0.01,
    trades: 30,
    complexity: 1,
  });
  const complex = penalizedSelectionScore({
    lowerBound: 0.55,
    expectancy: 0.01,
    trades: 10,
    complexity: 5,
  });
  assert.ok(simple.score > complex.score);
});
