'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMarketRegime } = require('../server');
const {
  SETUPS,
  setupSignalAt,
  simulateSetupTrade,
} = require('../lib/strategy/evidence-setup-book');
const {
  simulateTrade: simulateResearchTrade,
} = require('../lib/research/mean-reversion');
const { simulateAmendedMeanReversion } = require('../lib/research/exit-amendment');

const WORKERS = path.join(
  __dirname,
  '..',
  'scripts',
  'performance-stage1-v2-checkpoint.json.workers',
  'stage1',
);

function dateOf(bar) {
  return new Date(Number(bar.t) * 1000).toISOString().slice(0, 10);
}

function workerContext(file) {
  return JSON.parse(fs.readFileSync(path.join(WORKERS, file), 'utf8')).result.context;
}

function replay(setupId, file, from, to) {
  const setup = SETUPS[setupId];
  const source = workerContext(file);
  const bars = source.bars;
  const benchmarkBars = source.benchmarkBars;
  const context = {
    symbol: source.symbol,
    bars,
    marketBars: benchmarkBars,
    sectorBars: benchmarkBars,
    marketRegime: buildMarketRegime(benchmarkBars),
  };
  const shared = [];
  const research = [];
  for (let index = 270; index < bars.length - 2; index++) {
    const signalDate = dateOf(bars[index]);
    if (signalDate < from || signalDate > to) continue;
    if (!setupSignalAt(setupId, context, index)) continue;
    const expected = setup.amendedExits
      ? simulateAmendedMeanReversion(bars, index, setup, {
        market: setup.market, symbol: source.symbol, oneLot: false,
      })
      : simulateResearchTrade(bars, index, {
        trigger: setup.trigger,
        target: 'one_atr',
        stopAtr: setup.stopAtr,
        timeStopBars: setup.timeStopBars,
        partial: setup.partial,
      }, {
        market: setup.market,
        symbol: source.symbol,
      });
    const actual = simulateSetupTrade(setupId, context, index);
    if (!expected || expected.closed === false || !actual) continue;
    research.push({
      entryDate: dateOf(bars[expected.entryIndex]),
      exitDate: dateOf(bars[expected.exitIndex]),
      reason: expected.status,
      pnl: expected.ret,
    });
    shared.push({
      entryDate: dateOf(bars[actual.entryIndex]),
      exitDate: dateOf(bars[actual.exitIndex]),
      reason: actual.status,
      pnl: actual.ret,
    });
  }
  return { shared, research };
}

for (const fixture of [
  {
    setupId: 'JAPAN_MEDIUM_MR',
    file: 'Japan__medium__7203.T.result.json',
  },
  {
    setupId: 'JAPAN_SHORT_MR',
    file: 'Japan__medium__7203.T.result.json',
  },
  {
    setupId: 'US_SHORT_MR',
    file: 'US__medium__AAPL.result.json',
  },
]) {
  test(`${fixture.setupId} shared replay matches canonical consistency-study trades`, () => {
    const { shared, research } = replay(
      fixture.setupId,
      fixture.file,
      '2024-09-30',
      '2026-10-02',
    );
    assert.ok(research.length > 0, 'fixed consistency-study range must contain trades');
    assert.equal(shared.length, research.length);
    for (let index = 0; index < research.length; index++) {
      assert.equal(shared[index].entryDate, research[index].entryDate);
      assert.equal(shared[index].exitDate, research[index].exitDate);
      assert.equal(shared[index].reason, research[index].reason);
      assert.ok(Math.abs(shared[index].pnl - research[index].pnl) < 1e-12);
    }
  });
}
