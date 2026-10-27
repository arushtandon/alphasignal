'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETUPS,
  setupForCell,
  setupSignalAt,
  setupEntryPlan,
  setupExitDecision,
  simulateSetupTrade,
  completedDailyBars,
  evidenceMissGate,
  passesSetupRegime,
  volatilityRegimeAt,
} = require('../lib/strategy/evidence-setup-book');

function bars(count = 420) {
  const start = Date.UTC(2024, 0, 1) / 1000;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      t: start + index * 86400,
      o: close - 0.1,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1_000_000,
    };
  });
}

function contextFor(source) {
  const marketRegime = new Map(source.map(bar => [
    new Date(bar.t * 1000).toISOString().slice(0, 10),
    { trend: 'up', riskOff: false },
  ]));
  return {
    bars: source,
    marketBars: source,
    sectorBars: source,
    marketRegime,
  };
}

test('frozen setup cells contain only the operator-approved buy setups', () => {
  assert.equal(setupForCell('Japan', 'medium', 'buy').id, 'JAPAN_MEDIUM_MR');
  assert.equal(setupForCell('Japan', 'short', 'buy').id, 'JAPAN_SHORT_MR');
  assert.equal(setupForCell('Commodities', 'medium', 'buy').id, 'COMMODITIES_MEDIUM_MR');
  assert.equal(setupForCell('Japan', 'long', 'buy').id, 'JAPAN_LONG_ENGINE');
  assert.equal(setupForCell('India', 'long', 'buy').signalsOnly, true);
  assert.equal(setupForCell('US', 'long', 'buy'), null);
  assert.equal(setupForCell('US', 'short', 'buy').id, 'US_SHORT_MR');
  assert.equal(setupForCell('US', 'medium', 'buy'), null);
  assert.equal(setupForCell('UK', 'long', 'buy'), null);
  assert.equal(setupForCell('Japan', 'medium', 'sell'), null);
  assert.equal(Object.keys(SETUPS).length, 17);
  assert.equal(Object.values(SETUPS).filter(setup => setup.incubation === true).length, 3);
});

test('golden MR range produces identical shared signal, levels, and exits', () => {
  const source = bars();
  const signalIndex = 320;
  source[signalIndex] = {
    ...source[signalIndex],
    o: 241,
    h: 242,
    l: 239,
    c: 240,
  };
  source[signalIndex + 1] = {
    ...source[signalIndex + 1],
    o: 240,
    h: 250,
    l: 239,
    c: 246,
  };
  source[signalIndex + 2] = {
    ...source[signalIndex + 2],
    o: 246,
    h: 270,
    l: 245,
    c: 265,
  };
  const context = contextFor(source);

  const backtestSignal = setupSignalAt('COMMODITIES_MEDIUM_MR', context, signalIndex);
  const liveSignal = setupSignalAt('COMMODITIES_MEDIUM_MR', context, signalIndex);
  assert.equal(backtestSignal, true);
  assert.equal(liveSignal, backtestSignal);

  const backtestPlan = setupEntryPlan('COMMODITIES_MEDIUM_MR', context, signalIndex);
  const livePlan = setupEntryPlan('COMMODITIES_MEDIUM_MR', context, signalIndex);
  assert.deepEqual(livePlan, backtestPlan);

  const replay = simulateSetupTrade('COMMODITIES_MEDIUM_MR', context, signalIndex);
  const state = {
    entry: livePlan.levels.entry,
    entryIndex: signalIndex + 1,
    atr: livePlan.levels.atr,
    stop: livePlan.levels.stop,
    target1: livePlan.levels.target1,
    target2: livePlan.levels.target2,
    favorable: livePlan.levels.entry,
    tp1Hit: false,
  };
  const firstLiveExit = setupExitDecision(
    'COMMODITIES_MEDIUM_MR',
    state,
    source,
    signalIndex + 1,
  );
  const { index: replayIndex, ...firstBacktestExit } = replay.decisions[0];
  assert.equal(replayIndex, signalIndex + 1);
  assert.deepEqual(firstLiveExit, firstBacktestExit);
});

test('Japan medium MR live and backtest share one signal/exit function', () => {
  const source = bars();
  const signalIndex = 320;
  source[signalIndex] = { ...source[signalIndex], o: 241, h: 242, l: 230, c: 231 };
  source[signalIndex + 1] = { ...source[signalIndex + 1], o: 232, h: 250, l: 231, c: 248 };
  const context = contextFor(source);
  const backtest = setupSignalAt('JAPAN_MEDIUM_MR', context, signalIndex);
  const live = setupSignalAt('JAPAN_MEDIUM_MR', context, signalIndex);
  assert.equal(backtest, live);
  if (backtest) {
    const plan = setupEntryPlan('JAPAN_MEDIUM_MR', context, signalIndex);
    const replay = simulateSetupTrade('JAPAN_MEDIUM_MR', context, signalIndex);
    assert.equal(plan.exits.partial, false);
    assert.equal(plan.exits.timeStopBars, 21);
    assert.deepEqual(replay.plan, plan);
  }
});

function datedBars(count, lastDate, priceAt) {
  const last = Date.parse(`${lastDate}T00:00:00.000Z`) / 1000;
  return Array.from({ length: count }, (_, index) => {
    const close = priceAt(index, count);
    return {
      t: last - (count - 1 - index) * 86400,
      o: close,
      h: close,
      l: close,
      c: close,
      v: 1_000_000,
    };
  });
}

test('a missing benchmark date is not labelled regime', () => {
  const stock = datedBars(320, '2026-10-09', () => 100);
  const market = datedBars(320, '2026-10-08', () => 100);
  const context = contextFor(stock);
  context.marketBars = market;
  assert.equal(evidenceMissGate('JAPAN_MEDIUM_MR', context, stock.length - 1), 'benchmark date');
  assert.equal(passesSetupRegime(SETUPS.JAPAN_MEDIUM_MR, market, '2026-10-09'), false);
});

test('Japan regime passes when aligned volatility is below q70', () => {
  const prices = datedBars(400, '2026-10-09', (index, count) => {
    if (index >= count - 30) return 100 + (index - (count - 30)) * 0.01;
    return 100 * (index % 2 === 0 ? 1.05 : 0.95);
  });
  const index = prices.length - 1;
  const regime = volatilityRegimeAt(prices, index);
  assert.ok(regime.volatility < regime.q70);
  assert.equal(passesSetupRegime(SETUPS.JAPAN_MEDIUM_MR, prices, '2026-10-09'), true);
  const context = contextFor(prices);
  assert.notEqual(evidenceMissGate('JAPAN_MEDIUM_MR', context, index), 'regime');
});

test('aligned volatility at or above q70 stays labelled regime', () => {
  const flat = datedBars(320, '2026-10-09', () => 100);
  const regime = volatilityRegimeAt(flat, flat.length - 1);
  assert.equal(regime.volatility < regime.q70, false);
  const context = contextFor(flat);
  assert.equal(evidenceMissGate('JAPAN_MEDIUM_MR', context, flat.length - 1), 'regime');
});

test('US in-session daily bar is excluded until the cash close', () => {
  const source = bars(3);
  source[2].t = Date.UTC(2026, 10, 2) / 1000;
  const beforeClose = new Date('2026-11-02T20:45:00.000Z'); // 04:45 SGT, 15:45 ET
  const afterClose = new Date('2026-11-02T21:01:00.000Z'); // 05:01 SGT, 16:01 ET
  assert.equal(completedDailyBars(source, 'US', beforeClose).length, 2);
  assert.equal(completedDailyBars(source, 'US', afterClose).length, 3);
});
