'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '3995';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CANDIDATES,
  factorPass,
  evaluateCandidate,
  metrics,
  optimizeCell,
} = require('../lib/research/production-overlay-study');
const {
  techAtBoundedIndex,
  dailyToWeeklyBars,
} = require('../server');

function event(overrides = {}) {
  return {
    symbol: 'AAA',
    market: 'US',
    horizon: 'short',
    side: 'buy',
    entryDate: '2024-01-02',
    exitDate: '2024-01-03',
    ret: 0.01,
    features: {
      mtf: true,
      rsPercentile: 0.95,
      alignment: true,
      breadth: true,
      adxVol: true,
      retest: true,
      maDistance: true,
      execution: true,
      commodity: true,
    },
    ...overrides,
  };
}

test('factor overlays only filter production opportunities', () => {
  const rs = CANDIDATES.find(candidate => candidate.id === 'rs20');
  assert.equal(factorPass(rs, event()), true);
  assert.equal(factorPass(rs, event({ features: { rsPercentile: 0.5 } })), false);
  assert.equal(factorPass(rs, event({ side: 'sell', features: { rsPercentile: 0.05 } })), true);
});

test('bounded production replay retains symbol-specific Anglo MTF state', () => {
  const bars = Array.from({ length: 280 }, (_, index) => {
    const close = 100 + index * 0.2 + Math.sin(index / 5);
    return {
      t: Math.floor(Date.UTC(2023, 0, 1 + index) / 1000),
      o: close - 0.1,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1e6,
    };
  });
  const weekly = dailyToWeeklyBars(bars);
  const anglo = techAtBoundedIndex(bars, weekly, bars.length - 1, 'AAPL');
  const neutral = techAtBoundedIndex(bars, weekly, bars.length - 1, 'X');
  assert.ok(anglo._angloShortBuyMtf);
  assert.equal(neutral._angloShortBuyMtf, null);
});

test('candidate-specific replay restores non-overlap after filtering', () => {
  const rs = CANDIDATES.find(candidate => candidate.id === 'rs20');
  const events = [
    event({
      entryDate: '2024-01-02',
      exitDate: '2024-01-10',
      features: { rsPercentile: 0.50 },
    }),
    event({
      entryDate: '2024-01-03',
      exitDate: '2024-01-04',
      features: { rsPercentile: 0.95 },
    }),
    event({
      entryDate: '2024-01-04',
      exitDate: '2024-01-05',
      features: { rsPercentile: 0.96 },
    }),
  ];
  const range = { from: '2024-01-01', to: '2024-01-31' };
  const baselineRows = evaluateCandidate(events, CANDIDATES[0], range);
  const filteredRows = evaluateCandidate(events, rs, range);
  assert.deepEqual(baselineRows.map(row => row.entryDate), ['2024-01-02']);
  assert.deepEqual(filteredRows.map(row => row.entryDate), ['2024-01-03']);
});

test('metrics report fixed-notional net PnL from production returns', () => {
  const result = metrics([event({ ret: 0.02 }), event({ ret: -0.01 })], 10000);
  assert.equal(result.trades, 2);
  assert.equal(result.winRate, 50);
  assert.equal(result.pnlUsd, 100);
  assert.equal(result.profitFactor, 2);
});

test('optimizer cannot promote a model that improves only one objective', () => {
  const folds = [
    {
      fold: 1,
      validation: { from: '2024-01-01', to: '2024-01-31' },
      test: { from: '2024-02-01', to: '2024-02-29' },
    },
    {
      fold: 2,
      validation: { from: '2024-03-01', to: '2024-03-31' },
      test: { from: '2024-04-01', to: '2024-04-30' },
      finalHoldout: true,
    },
  ];
  const rows = [];
  for (let month = 1; month <= 4; month++) {
    for (let index = 0; index < 20; index++) {
      const day = String(index + 1).padStart(2, '0');
      rows.push(event({
        symbol: `S${index}`,
        entryDate: `2024-${String(month).padStart(2, '0')}-${day}`,
        exitDate: `2024-${String(month).padStart(2, '0')}-${day}`,
        ret: index < 10 ? 0.001 : index < 15 ? 0.02 : -0.005,
        features: { rsPercentile: index < 10 ? 0.95 : 0.50 },
      }));
    }
  }
  const result = optimizeCell(rows, folds, {
    market: 'US',
    candidates: [CANDIDATES[0], CANDIDATES.find(candidate => candidate.id === 'rs20')],
  });
  // RS improves win rate to 100%, but removes net-profitable trades and therefore
  // does not strictly improve total PnL versus production.
  assert.equal(result.frozenModel, 'production');
  assert.equal(result.passBeforeMultiplicity, false);
});
