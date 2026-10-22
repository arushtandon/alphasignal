'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUESTED_CELLS,
  normalizeConsistencyCell,
  normalizeBookRow,
  consistencyVerdict,
  rankCell,
  buildCellTable,
} = require('../lib/research/cell-strategy-search');

function consistencyCell(overrides = {}) {
  const window = (fold, metrics, final = false) => ({
    fold, final, range: { from: `2025-0${fold}-01`, to: `2025-0${fold}-28` }, metrics,
  });
  return {
    id: 'A__UK__short__rsi2_lt_5__none__sl2__t5__full',
    part: 'A', market: 'UK', horizon: 'short', trigger: 'rsi2_lt_5', regime: 'none',
    stopAtr: 2, timeStopBars: 5, partial: false, survivorship: 'SURVIVORSHIP_BIAS',
    windows: [
      window(1, { trades: 20, winRate: 65, profitFactor: 1.4, pnlUsd: 500, avgLossPct: -2 }),
      window(2, { trades: 18, winRate: 61, profitFactor: 1.3, pnlUsd: 300, avgLossPct: -2.5 }),
      window(3, { trades: 22, winRate: 70, profitFactor: 1.9, pnlUsd: 900, avgLossPct: -1.5 }),
      window(4, { trades: 19, winRate: 63, profitFactor: 1.25, pnlUsd: 200, avgLossPct: -2 }, true),
    ],
    pooledDevelopment: {
      trades: 60, winRate: 65.3, profitFactor: 1.5, pnlUsd: 1700,
      avgWinPct: 2.1, avgLossPct: -2, breakevenWinRate: 48.8, picksPerMonth: 3.3,
    },
    consistent: true, bhQValue: 0.01, bhPass: true,
    ...overrides,
  };
}

test('requested cells cover the twelve empty cells as fourteen market rows', () => {
  assert.equal(REQUESTED_CELLS.length, 14);
  assert.deepEqual(
    REQUESTED_CELLS.filter(cell => cell.horizon === 'short').map(cell => cell.market),
    ['Hong Kong', 'UK', 'Germany', 'France', 'Commodities', 'Crypto'],
  );
  assert.deepEqual(
    REQUESTED_CELLS.filter(cell => cell.horizon === 'long').map(cell => cell.market),
    ['US', 'UK', 'Crypto'],
  );
});

test('mean reversion is consistent only with profit and 60% wins in every window', () => {
  const good = normalizeConsistencyCell(consistencyCell());
  assert.equal(good.kind, 'mean_reversion');
  assert.equal(good.consistent, true);
  assert.equal(good.worstWindowPf, 1.25);

  const weakWindow = consistencyCell();
  weakWindow.windows[1].metrics.winRate = 58;
  const bad = normalizeConsistencyCell(weakWindow);
  assert.equal(bad.consistent, false);
  assert.match(bad.failReason, /window 2 win rate 58% < 60%/);
});

test('trend and momentum books use the PF 1.2 rule on window returns', () => {
  const row = normalizeBookRow({
    id: 'B__UK__long__piotroski6__regimeoff',
    market: 'UK', horizon: 'long', strategy: '12-1 momentum among Piotroski >= 6',
    survivorship: 'SURVIVORSHIP_BIAS', verdict: 'PASS',
    windows: [
      { fold: 1, returnPct: 10.15, pf: 2.013, win: 51.7, trades: 60, beat: true },
      { fold: 2, returnPct: 5.93, pf: 5.41, win: 55, trades: 60, beat: true },
      { fold: 3, returnPct: 14.44, pf: 7.015, win: 60, trades: 66, beat: true },
      { fold: 4, returnPct: 2.09, pf: 1.478, win: 50, trades: 50, beat: false },
    ],
    overall: { returnPct: 56.38, pf: 1.478, win: 52.4, trades: 975, maxDrawdownPct: 32.44 },
  }, 'new-strategy-types');
  assert.equal(row.kind, 'momentum');
  assert.equal(row.consistent, true);
  assert.equal(row.benchmarkBeat, 3);
  assert.equal(row.worstWindowPf, 1.478);

  const losing = { ...row, windows: row.windows.map((window, index) => (
    index === 1 ? { ...window, returnPct: -1, profitFactor: 1.5 } : window
  )) };
  assert.equal(consistencyVerdict(losing).consistent, false);
  assert.match(consistencyVerdict(losing).reason, /window 2 lost money/);
});

test('ranking puts consistent rows first, then worst-window PF, then smaller loss', () => {
  const consistentLowPf = normalizeConsistencyCell(consistencyCell({ id: 'low' }));
  const rescored = normalizeConsistencyCell({
    ...consistencyCell({ id: 'high' }),
    windows: consistencyCell().windows.map(window => ({
      ...window, metrics: { ...window.metrics, profitFactor: 2 },
    })),
  });
  const inconsistent = normalizeConsistencyCell(consistencyCell({
    id: 'bleeder',
    windows: consistencyCell().windows.map(window => ({
      ...window, metrics: { ...window.metrics, profitFactor: 9, pnlUsd: -1 },
    })),
  }));
  const ranked = rankCell([inconsistent, consistentLowPf, rescored]);
  assert.deepEqual(ranked.map(row => row.id), ['high', 'low', 'bleeder']);
});

test('rows with an empty window rank behind populated rows and cells report verdicts', () => {
  const populated = normalizeConsistencyCell(consistencyCell({ id: 'populated' }));
  const sparse = normalizeConsistencyCell(consistencyCell({
    id: 'sparse',
    windows: consistencyCell().windows.map((window, index) => (
      index === 0 ? { ...window, metrics: { ...window.metrics, trades: 0, pnlUsd: 0, profitFactor: null } } : window
    )),
  }));
  assert.equal(sparse.consistent, false);
  assert.equal(sparse.emptyWindows, 1);
  const table = buildCellTable([sparse, populated], { 'UK|short': [] });
  const uk = table.find(cell => cell.key === 'UK|short');
  assert.equal(uk.verdict, 'CONSISTENT');
  assert.equal(uk.best.id, 'populated');
  assert.equal(uk.top[1].id, 'sparse');
  const empty = table.find(cell => cell.key === 'Crypto|long');
  assert.equal(empty.verdict, 'NONE');
  assert.equal(empty.variantsScored, 0);
});
