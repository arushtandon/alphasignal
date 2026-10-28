'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assembleTickerView, marketOf } = require('../lib/strategy/ticker-view');

function bars(count = 320) {
  const start = Date.UTC(2024, 0, 1) / 1000;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.2;
    return { t: start + index * 86400, o: close - 0.2, h: close + 1, l: close - 1, c: close, v: 1_000_000 };
  });
}

function depsFor(ticker) {
  const calls = [];
  const note = name => { calls.push(name); };
  return {
    calls,
    loadBars: async () => bars(),
    rawQuant: async () => ({
      short: { conditions: ['RSI turning up', 'Falling knife: below MA20 & MA200'], buyScore: 70 },
      medium: { conditions: ['Trend intact'], buyScore: 66 },
      long: { conditions: ['Quality compounder'], buyScore: 60 },
    }),
    structuralCaps: async () => ['short: structural cap 70 -> 61'],
    fundamentals: async symbol => marketOf(symbol) === 'Commodities'
      ? null
      : { piotroski: 7, valuation: 'fair', quality: 'high' },
    earningsDate: async () => '2026-11-01',
    analystConsensus: async () => 150,
    danelfinLists: async () => ({ ai10: new Set(['AAPL']), ai1: new Set(['GOOGL']) }),
    marketRegime: async () => new Map(),
    paused: () => false,
    emitTradeEvent: () => { note('emit'); throw new Error('emit'); },
    addTradesToHistory: () => { note('history'); throw new Error('history'); },
    saveDashboardPicksFile: () => { note('board'); throw new Error('board'); },
    ibkr: () => { note('ibkr'); throw new Error('ibkr'); },
  };
}

test('view for AAPL, GOOGL, CL=F and 7203.T writes nothing the board or bridge reads', async () => {
  for (const ticker of ['AAPL', 'GOOGL', 'CL=F', '7203.T']) {
    const deps = depsFor(ticker);
    const view = await assembleTickerView(ticker, deps);
    assert.equal(view.ticker, ticker);
    assert.equal(view.status.label, 'No active setup');
    assert.ok(view.distance.length > 0);
    assert.ok(view.trend.ma200 != null);
    assert.equal(view.ifLong.short.label, 'informational, not a validated setup');
    assert.equal(view.targets.analystConsensus.label, 'analyst consensus');
    assert.equal(deps.calls.length, 0);
    if (ticker === 'CL=F') {
      assert.equal(view.market, 'Commodities');
      assert.equal(view.fundamentals, null);
    } else {
      assert.notEqual(view.fundamentals, null);
      assert.equal(view.fundamentals.piotroski, 7);
    }
    if (ticker === '7203.T') assert.equal(view.market, 'Japan');
    if (ticker === 'AAPL') assert.equal(view.danelfin.text, 'AI 10');
    if (ticker === 'GOOGL') assert.equal(view.danelfin.text, 'AI 1');
  }
});

test('the view route does not emit, record history, or save the board', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/api/view/:ticker'");
  assert.ok(start > 0);
  const end = source.indexOf("function readStoredDanelfinLists", start);
  const block = source.slice(start, end);
  for (const name of ['emitTradeEvent', 'addTradesToHistory', 'saveDashboardPicksFile', 'runUniverseScan']) {
    assert.equal(block.includes(name), false, name);
  }
});
