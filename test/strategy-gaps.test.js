'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tStat, scoreCell, normInv, deflatedSharpe, twoFactor, trialSharpes, shortExcessReturn } = require('../lib/research/strategy-gaps');

function folds() {
  return [1, 2, 3, 4].map(fold => ({
    fold,
    test: { from: `2020-0${fold}-01`, to: `2020-0${fold}-28` },
  }));
}

test('two-factor regression recovers a known line', () => {
  const spy = [0.01, -0.02, 0.03, 0.00, 0.02, -0.01];
  const qqq = [0.02, -0.01, 0.04, 0.01, 0.00, -0.03];
  const y = spy.map((value, index) => 0.01 + 0.5 * value + 1.5 * qqq[index]);
  const fit = twoFactor(y, spy, qqq);
  assert.ok(Math.abs(fit.alphaMonthly - 0.01) < 1e-10);
  assert.ok(Math.abs(fit.alphaAnnual - 0.12) < 1e-10);
  assert.ok(Math.abs(fit.betaSpy - 0.5) < 1e-10);
  assert.ok(Math.abs(fit.betaQqq - 1.5) < 1e-10);
  assert.ok(fit.t > 1e6);
});

test('t-stat uses the sample standard deviation', () => {
  const stat = tStat([0.01, 0.02, 0.03, 0.04]);
  assert.equal(stat.n, 4);
  assert.ok(stat.t > 3);
});

test('normInv matches the 97.5 percent point', () => {
  assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-4);
});

test('a cell passes only with four good windows, a benchmark beat, and t >= 3', () => {
  const monthly = [];
  const trades = [];
  for (let fold = 1; fold <= 4; fold += 1) {
    for (let day = 1; day <= 8; day += 1) {
      const date = `2020-0${fold}-${String(day).padStart(2, '0')}`;
      monthly.push({ date, ret: 0.02 });
      trades.push({ date, ret: 0.02 });
    }
  }
  const scored = scoreCell({
    monthly,
    grossMonthly: monthly.map(row => ({ ...row, ret: 0.025 })),
    trades,
    benchmarkMonthly: monthly.map(row => ({ date: row.date, ret: 0.001 })),
    folds: folds(),
    tSource: 'month',
  });
  assert.equal(scored.verdict, 'PASS');
  assert.ok(scored.full.tStat >= 3);
  assert.ok(scored.full.costDragPp > 0);
});

test('three good windows and a benchmark beat are a candidate', () => {
  const monthly = [];
  const trades = [];
  for (let fold = 1; fold <= 4; fold += 1) {
    const ret = fold === 4 ? -0.01 : 0.02;
    for (let day = 1; day <= 8; day += 1) {
      const date = `2020-0${fold}-${String(day).padStart(2, '0')}`;
      monthly.push({ date, ret });
      trades.push({ date, ret });
    }
  }
  const scored = scoreCell({
    monthly,
    trades,
    benchmarkMonthly: monthly.map(row => ({ date: row.date, ret: -0.01 })),
    folds: folds(),
    tSource: 'month',
  });
  assert.equal(scored.verdict, 'CANDIDATE');
});

test('deflated Sharpe is a probability', () => {
  const returns = Array.from({ length: 36 }, (_, index) => 0.02 + ((index % 5) - 2) * 0.005);
  const result = deflatedSharpe([
    { sharpe: 0.2 },
    { sharpe: 0.4 },
    { sharpe: 1 },
  ], returns);
  assert.equal(result.nTrials, 3);
  assert.ok(result.probability > 0 && result.probability <= 1);
});

test('tBasis excess changes the t-stat and the default does not count k books', () => {
  const monthly = [1, 2, 3, 4].flatMap(fold => (
    [1, 2, 3, 4, 5, 6, 7, 8].map(day => ({
      date: `2020-0${fold}-${String(day).padStart(2, '0')}`,
      ret: 0.01 + day * 0.002,
    }))
  ));
  const benchmarkMonthly = monthly.map(row => ({ date: row.date, ret: 0.01 }));
  const raw = scoreCell({ monthly, trades: monthly.map(row => ({ date: row.date, ret: row.ret })), benchmarkMonthly, folds: folds(), tSource: 'month' });
  const excess = scoreCell({ monthly, trades: monthly.map(row => ({ date: row.date, ret: row.ret })), benchmarkMonthly, folds: folds(), tSource: 'month', tBasis: 'excess' });
  assert.ok(excess.full.tStat < raw.full.tStat);
  const cell = {
    market: 'US', variant: 'a', side: 'short', full: { sharpe: 0.2 }, monthlyReturns: [0.01],
    k1: { full: { sharpe: 0.4 }, monthlyReturns: [0.02] },
  };
  assert.equal(trialSharpes([cell]).length, 1);
  assert.equal(trialSharpes([cell], { includeExecutableK: true }).length, 2);
});

test('a short against a flat index earns the opposite of the stock', () => {
  assert.equal(shortExcessReturn(-0.10, 0), 0.10);
  assert.equal(shortExcessReturn(0.10, 0), -0.10);
  assert.equal(shortExcessReturn(-0.10, 0.04), 0.14);
});
