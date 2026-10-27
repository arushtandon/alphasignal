'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';

const assert = require('node:assert/strict');
const test = require('node:test');
const { backtestSignal } = require('../server');

function fixedBars() {
  return Array.from({ length: 260 }, (_, index) => {
    const trend = index < 230 ? 140 - index * 0.18 : 98 + (index - 230) * 0.8;
    const close = trend + Math.sin(index / 3) * 1.2;
    return {
      t: Math.floor(Date.UTC(2024, 0, 1 + index) / 1000),
      o: close - 0.2,
      h: close + 1.4,
      l: close - 1.4,
      c: close,
      v: 1000000 + (index % 7) * 1000
    };
  });
}

const staticFund = { earningsGrowth: 12, revenueGrowth: 8 };
const replayOptions = {
  symbol: 'X',
  windowBars: 30,
  entryStep: 5,
  closedOnly: true
};

test('backtest default replay remains golden when no provider is injected', async () => {
  const actual = await backtestSignal(fixedBars(), 'medium', null, staticFund, replayOptions);
  assert.deepEqual(actual, {
    winRate: null,
    trades: 0,
    avgReturnPct: null,
    avgGrossReturnPct: null,
    avgCostPct: null,
    profitFactor: null,
    supertrendWinRate: null,
    supertrendTrades: 0,
    hybridExit: true,
    decisionPolicyVersion: 'capital-readiness-v1',
    exitPolicyVersion: 'hybrid-exit-v1',
    costModelVersion: 'implementation-cost-v1',
    rejectionCounts: { actionable: 6, sideAllowed: 6, confidence: 6 },
    tradeReturns: [],
    tradeResults: [],
    windowYears: 5
  });
});

test('injected decision-date snapshot uses the live FMP overlay pipeline', async () => {
  const calls = [];
  const observed = [];
  await backtestSignal(fixedBars(), 'medium', null, staticFund, {
    ...replayOptions,
    fundamentalsAt: ({ decisionTs, index, defaultFund }) => {
      calls.push({ decisionTs, index, defaultFund });
      return {
        fund: staticFund,
        fmp: { qualityScore: 8, piotroski: 7, altmanZ: 3.4 }
      };
    },
    signalOverlay: ({ signal }) => {
      observed.push(signal);
      return signal;
    }
  });

  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ decisionTs }) => Number.isFinite(decisionTs)));
  assert.ok(observed.every(signal =>
    signal.conditions.some(condition => /FMP quality 8\/10/.test(condition))
    && signal.weighting === '50% technical · 30% FMP · 20% fundamentals'
    && signal.tier2Eligible === true
  ));
});
