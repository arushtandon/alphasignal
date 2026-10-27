'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPECTED_BH_FAMILY_SIZE,
  registry,
  metric,
  scoreVariant,
  applyBh,
  rankConsistent,
} = require('../lib/research/consistency-study');

function rows(count, winRate = 0.7, prefix = 'A') {
  const wins = Math.round(count * winRate);
  return Array.from({ length: count }, (_, index) => ({
    symbol: `${prefix}${index}`,
    signalDate: `2024-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    entryDate: `2024-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    exitDate: `2024-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    ret: index < wins ? 0.02 : -0.01,
  }));
}

test('frozen registry has one 1,982-variant BH family', () => {
  const definitions = registry();
  assert.equal(definitions.length, EXPECTED_BH_FAMILY_SIZE);
  assert.equal(new Set(definitions.map(row => row.id)).size, definitions.length);
  assert.equal(definitions.filter(row => row.part === 'A').length, 1944);
  assert.equal(definitions.filter(row => row.part === 'B').length, 36);
  assert.equal(definitions.filter(row => row.part === 'C').length, 2);
});

test('metrics report breakeven win rate and margin', () => {
  const result = metric(rows(10, 0.6));
  assert.equal(result.avgWinPct, 2);
  assert.equal(result.avgLossPct, -1);
  assert.equal(result.breakevenWinRate, 33.333);
  assert.equal(result.breakevenMargin, 26.667);
});

test('MR consistency requires profit and 60 percent wins in all four windows', () => {
  const folds = [
    { fold: 1, finalHoldout: false, test: { from: '2024-01-01', to: '2024-01-31' } },
    { fold: 2, finalHoldout: false, test: { from: '2024-02-01', to: '2024-02-29' } },
    { fold: 3, finalHoldout: false, test: { from: '2024-03-01', to: '2024-03-31' } },
    { fold: 4, finalHoldout: true, test: { from: '2024-04-01', to: '2024-04-30' } },
  ];
  const trades = Array.from({ length: 4 }, (_, month) => rows(28, 0.7, `M${month}`)
    .map(row => ({
      ...row,
      signalDate: row.signalDate.replace('2024-01', `2024-0${month + 1}`),
      entryDate: row.entryDate.replace('2024-01', `2024-0${month + 1}`),
      exitDate: row.exitDate.replace('2024-01', `2024-0${month + 1}`),
    }))).flat();
  const result = scoreVariant({ id: 'mr', part: 'A' }, trades, folds, 'POINT_IN_TIME');
  assert.equal(result.consistent, true);
  assert.equal(result.finalWindow.status, 'OVERLAP_RISK');

  const losingFinal = trades.map(row => (
    row.signalDate.startsWith('2024-04') ? { ...row, ret: -0.01 } : row
  ));
  assert.equal(
    scoreVariant({ id: 'mr', part: 'A' }, losingFinal, folds, 'POINT_IN_TIME').consistent,
    false,
  );
});

test('ranking uses worst-window PF before average loss', () => {
  const ranked = rankConsistent([
    { id: 'b', consistent: true, worstWindowPf: 1.4, averageLossMagnitude: 1 },
    { id: 'a', consistent: true, worstWindowPf: 1.6, averageLossMagnitude: 5 },
  ]);
  assert.equal(ranked[0].id, 'a');
});

test('BH correction covers all supplied variants', () => {
  const cells = registry().map((definition, index) => ({
    ...definition,
    pooledDevelopment: {
      trades: 40,
      winRate: index === 0 ? 90 : 50,
      breakevenWinRate: 50,
    },
    finalWindow: {
      metrics: {
        trades: 40,
        winRate: 50,
        breakevenWinRate: 50,
      },
    },
  }));
  applyBh(cells);
  assert.equal(cells.every(cell => cell.bhFamilySize === EXPECTED_BH_FAMILY_SIZE), true);
  assert.equal(cells.every(cell => Number.isFinite(cell.bhQValue)), true);
});
