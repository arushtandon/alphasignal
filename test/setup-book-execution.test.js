'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  setupExitDecision,
  rebaseSetupLevels,
} = require('../lib/strategy/evidence-setup-book');
const {
  compareSetupEntries,
  setupOrderShape,
  setupFillLevels,
  evaluateSetupCapacity,
  evaluateCapitalPool,
  capitalSlotPlan,
} = require('../lib/strategy/setup-book-execution');

function bar({ o = 100, h = 100, l = 100, c = 100 } = {}) {
  return { o, h, l, c };
}

function position(setupId, entry = 100, atr = 2) {
  const levels = rebaseSetupLevels(setupId, entry, atr);
  return {
    entry,
    entryIndex: 0,
    atr,
    stop: levels.stop,
    target1: levels.target1,
    target2: levels.target2,
    tp1Hit: false,
  };
}

test('JAPAN_MEDIUM_MR places one full target OCA with the full stop', () => {
  const shape = setupOrderShape('JAPAN_MEDIUM_MR', 100, 1);
  assert.deepEqual(shape, {
    executable: true,
    fullExit: true,
    targetQuantity: 100,
    runnerQuantity: 0,
    initialStopQuantity: 100,
    targetStopOca: true,
    runnerStop: null,
  });
  const decision = setupExitDecision(
    'JAPAN_MEDIUM_MR',
    position('JAPAN_MEDIUM_MR'),
    [bar({ h: 102.1, l: 99 })],
    0,
  );
  assert.deepEqual(decision, { action: 'exit', price: 102, reason: 'target' });
});

test('JAPAN_SHORT_MR uses its 2.5 ATR initial stop', () => {
  const state = position('JAPAN_SHORT_MR');
  const decision = setupExitDecision(
    'JAPAN_SHORT_MR',
    state,
    [bar({ h: 101, l: 94.9 })],
    0,
  );
  assert.deepEqual(decision, { action: 'exit', price: 95, reason: 'stop' });
});

test('COMMODITIES_MEDIUM_MR is 50/50 then runner stop equals actual fill', () => {
  const shape = setupOrderShape('COMMODITIES_MEDIUM_MR', 2, 1);
  assert.equal(shape.targetQuantity, 1);
  assert.equal(shape.runnerQuantity, 1);
  assert.equal(shape.runnerStop, 'entry');
  const levels = setupFillLevels('COMMODITIES_MEDIUM_MR', 105, 3);
  assert.deepEqual(levels, {
    entry: 105,
    atr: 3,
    stop: 97.5,
    target1: 108,
    target2: 111,
  });
  const state = {
    ...position('COMMODITIES_MEDIUM_MR', 105, 3),
    tp1Hit: true,
  };
  const decision = setupExitDecision(
    'COMMODITIES_MEDIUM_MR',
    state,
    [bar({ h: 109, l: 104.9, c: 105 })],
    0,
  );
  assert.deepEqual(decision, { action: 'exit', price: 105, reason: 'runner_stop' });
});

test('amended Japan medium has no time exit and a one-lot TP1 trigger', () => {
  const quiet = Array.from({ length: 30 }, () => bar({ h: 101, l: 99, c: 100 }));
  assert.equal(setupExitDecision('JAPAN_MEDIUM_MR', position('JAPAN_MEDIUM_MR'), quiet, 25).action, 'hold');
  const armed = setupExitDecision(
    'JAPAN_MEDIUM_MR',
    { ...position('JAPAN_MEDIUM_MR'), oneLot: true },
    [bar({ h: 102.1, l: 99 })],
    0,
  );
  assert.equal(armed.action, 'arm');
  assert.equal(setupOrderShape('JAPAN_MEDIUM_MR', 100, 100).oneLotRunner, true);
  assert.equal(setupOrderShape('JAPAN_MEDIUM_MR', 200, 100).fullExit, true);
});

test('approved current-engine cells are partial, with a one-lot runner', () => {
  const { SETUPS } = require('../lib/strategy/evidence-setup-book');
  assert.equal(SETUPS.JAPAN_LONG_ENGINE.amendedExits, true);
  assert.equal(SETUPS.HK_MEDIUM_ENGINE.amendedExits, false);
  assert.equal(SETUPS.INDIA_LONG_ENGINE.amendedExits, false);
  assert.equal(setupOrderShape('JAPAN_LONG_ENGINE', 1, 1).oneLotRunner, true);
  const multi = setupOrderShape('JAPAN_LONG_ENGINE', 200, 1);
  assert.equal(multi.executable, true);
  assert.equal(multi.targetQuantity, 100);
  assert.equal(multi.runnerQuantity, 100);
});

test('US_SHORT_MR exits at the fifth session close', () => {
  const state = position('US_SHORT_MR');
  const bars = Array.from({ length: 5 }, () => bar({ h: 101, l: 99, c: 100.5 }));
  assert.equal(setupExitDecision('US_SHORT_MR', state, bars, 3).action, 'hold');
  assert.deepEqual(
    setupExitDecision('US_SHORT_MR', state, bars, 4),
    { action: 'exit', price: 100.5, reason: 'time' },
  );
});

test('bridge applies setup order shape, ATR fill rebase, OCA and frozen runner stop', () => {
  const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'ibkr-bridge', 'bridge.js'),
    'utf8',
  );
  assert.match(bridge, /setupOrderShape\(evt\.setupId, split\.total, lot\)/);
  assert.match(bridge, /setupFillLevels\(row\.setupId, fillPx, row\.setupAtr\)/);
  assert.match(bridge, /const fullTp1 = !oneLotRunner && split\.sold > 0 && !\(split\.runner > 0\)/);
  assert.match(bridge, /if \(row\?\.setupId && EVIDENCE_SETUPS\[row\.setupId\]\?\.kind !== 'current_engine'\) \{\s*return roundPx\(Number\(row\.ibAvgFill \|\| row\.entry\)/);
  assert.match(bridge, /tsl_update ignored \(setup-book stop is frozen\)/);
});

test('one-lot Japan medium stays open until TP2 or the trailing stop', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'ibkr-bridge', 'bridge.js'), 'utf8');
  assert.doesNotMatch(serverSrc, /30000 \/ entry/);
  assert.match(serverSrc, /if \(require\.main === module\) \{\r?\n  setTimeout\(bootDashHistorySync, 4000\)/);
  assert.match(serverSrc, /const entryReleaseTestBypass = !IS_PRODUCTION && process\.env\.AUTH_TEST_BYPASS === '1'/);
  assert.match(bridge, /if \(role === 'entry' && row\.oneLotRunner === true\) report\.setupOneLot = true/);
  const { simulateSetupHistoryExit, applySetupOneLotFlag } = require('../server');
  const entryMs = Date.parse('2020-01-06T01:00:00.000Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', weekday: 'short', month: 'short', day: '2-digit', year: 'numeric',
  }).formatToParts(new Date(entryMs));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  const key = `7203.T|medium|${get('weekday')} ${get('month')} ${get('day')} ${get('year')}`;
  const row = {
    ticker: '7203.T', hz: 'medium', setupId: 'JAPAN_MEDIUM_MR', entryDate: '2020-01-06T01:00:00.000Z',
  };
  assert.equal(applySetupOneLotFlag([row], [{ role: 'entry', key, price: 80000 }]), 0);
  assert.equal(applySetupOneLotFlag([row], [{ role: 'entry', setupOneLot: true, key }]), 1);
  assert.equal(row.setupOneLot, true);
  const sec = iso => Math.floor(Date.parse(iso) / 1000);
  const trade = {
    ...row, entry: 80000, mediumEntry: 80000, setupLevels: { atr: 1000 },
  };
  const afterTp1 = [
    { t: sec('2020-01-06T00:00:00Z'), o: 80000, h: 80500, l: 79800, c: 80000 },
    { t: sec('2020-01-07T00:00:00Z'), o: 80100, h: 81200, l: 80050, c: 81000 },
    { t: sec('2020-01-08T00:00:00Z'), o: 81000, h: 81500, l: 80100, c: 81200 },
  ];
  const armed = simulateSetupHistoryExit(trade, afterTp1, entryMs);
  assert.equal(armed.open, true);
  assert.equal(armed.status, 'tp1_open');
  const tp2 = simulateSetupHistoryExit(trade, afterTp1.concat([
    { t: sec('2020-01-09T00:00:00Z'), o: 81200, h: 82100, l: 81100, c: 82000 },
  ]), entryMs);
  assert.equal(tp2.open, false);
  assert.equal(tp2.status, 'tp2_hit');
  const trail = simulateSetupHistoryExit(trade, afterTp1.concat([
    { t: sec('2020-01-09T00:00:00Z'), o: 81000, h: 81100, l: 79900, c: 80000 },
  ]), entryMs);
  assert.equal(trail.open, false);
  assert.equal(trail.status, 'tp1_then_sl');
  const multi = simulateSetupHistoryExit(
    { ...trade, setupOneLot: false }, afterTp1, entryMs,
  );
  assert.equal(multi.open, false);
  assert.equal(multi.status, 'tp1_hit');
});

test('setup target exits are not reopened by extinct-status folding', () => {
  const { normalizeExtinctStatuses } = require('../server');
  const row = {
    action: 'Buy', setupId: 'JAPAN_MEDIUM_MR', hz: 'medium', mediumStatus: 'tp1_hit',
  };
  assert.equal(normalizeExtinctStatuses([row], 'refresh'), 0);
  assert.equal(normalizeExtinctStatuses([row], 'refresh'), 0);
  assert.equal(normalizeExtinctStatuses([row], 'ingest'), 0);
  assert.equal(row.mediumStatus, 'tp1_hit');
  const plain = { action: 'Buy', hz: 'medium', mediumStatus: 'tp1_hit' };
  assert.equal(normalizeExtinctStatuses([plain], 'refresh'), 1);
  assert.equal(plain.mediumStatus, 'open');
});

test('capacity is per setup and entry ordering is deterministic', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    setupId: 'JAPAN_MEDIUM_MR',
    setupNotionalUsd: 1000,
    closed: false,
    index,
  }));
  const rejected = evaluateSetupCapacity('JAPAN_MEDIUM_MR', rows, 1000, 100000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, 'position-count');
  const ordered = [
    { setupId: 'US_SHORT_MR', ticker: 'Z' },
    { setupId: 'JAPAN_MEDIUM_MR', ticker: 'A' },
    { setupId: 'JAPAN_SHORT_MR', ticker: 'B' },
  ].sort(compareSetupEntries);
  assert.deepEqual(ordered.map(row => row.setupId), [
    'JAPAN_MEDIUM_MR',
    'JAPAN_SHORT_MR',
    'US_SHORT_MR',
  ]);
});

test('capital pool stays off unless the flag is set', () => {
  const prior = process.env.CAPITAL_POOL_ENABLED;
  delete process.env.CAPITAL_POOL_ENABLED;
  const dormant = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, { availableFunds: 0, buyingPower: 0 });
  assert.equal(dormant.applied, false);
  assert.equal(dormant.allowed, true);
  process.env.CAPITAL_POOL_ENABLED = '1';
  const open = Array.from({ length: 25 }, () => ({ entryFilled: true, closed: false }));
  const plan = capitalSlotPlan(open);
  assert.equal(plan.slots, 23);
  assert.equal(plan.free, 0);
  assert.equal(plan.over, 2);
  const blocked = evaluateCapitalPool('COMMODITIES_MEDIUM_MR', open, 30000, {
    availableFunds: 500000, buyingPower: 500000,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.log, 'skipped: slots');
  const margin = evaluateCapitalPool('JAPAN_SHORT_MR', [], 30000, {
    availableFunds: 10000, buyingPower: 800000,
  });
  assert.equal(margin.log, 'skipped: margin');
  if (prior == null) delete process.env.CAPITAL_POOL_ENABLED;
  else process.env.CAPITAL_POOL_ENABLED = prior;
});
