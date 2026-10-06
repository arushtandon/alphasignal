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
  capitalEntryFit,
  marginDecision,
  evidenceTier,
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

test('per-setup caps are off unless an env override is set', () => {
  const key = 'SETUP_CAPACITY_JAPAN_MEDIUM_MR_POSITIONS';
  const prior = process.env[key];
  delete process.env[key];
  const rows = Array.from({ length: 5 }, () => ({
    setupId: 'JAPAN_MEDIUM_MR',
    setupNotionalUsd: 1000,
    closed: false,
  }));
  assert.equal(evaluateSetupCapacity('JAPAN_MEDIUM_MR', rows, 1000, 100000).allowed, true);
  process.env[key] = '5';
  const rejected = evaluateSetupCapacity('JAPAN_MEDIUM_MR', rows, 1000, 100000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, 'position-count');
  if (prior == null) delete process.env[key];
  else process.env[key] = prior;
  const ordered = [
    { setupId: 'US_SHORT_MR', ticker: 'Z', signalDate: '2026-10-06' },
    { setupId: 'COMMODITIES_MEDIUM_MR', ticker: 'CL=F', signalDate: '2026-10-06' },
    { setupId: 'JAPAN_MEDIUM_MR', ticker: 'A', signalDate: '2026-10-06' },
    { setupId: 'UK_LONG_MOMENTUM', ticker: 'SHEL.L', signalDate: '2026-10-06' },
    { setupId: 'JAPAN_SHORT_MR', ticker: 'B', signalDate: '2026-10-06' },
  ].sort(compareSetupEntries);
  assert.equal(ordered[0].setupId, 'JAPAN_MEDIUM_MR');
  assert.deepEqual(ordered.slice(1, 3).map(row => row.setupId).sort(), [
    'COMMODITIES_MEDIUM_MR',
    'JAPAN_SHORT_MR',
  ]);
  assert.deepEqual(ordered.slice(3).map(row => row.setupId).sort(), [
    'UK_LONG_MOMENTUM',
    'US_SHORT_MR',
  ]);
  assert.equal(evidenceTier('JAPAN_MEDIUM_MR'), 1);
  assert.equal(evidenceTier('UK_LONG_MOMENTUM'), 3);
});

test('one 50-slot pool and the margin floor', () => {
  const prior = process.env.CAPITAL_POOL_ENABLED;
  const role = process.env.IBKR_BRIDGE_ROLE;
  delete process.env.CAPITAL_POOL_ENABLED;
  delete process.env.IBKR_BRIDGE_ROLE;
  const dormant = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    buyingPower: 0, excessLiquidity: 0, netLiquidation: 1,
  });
  assert.equal(dormant.applied, false);
  process.env.CAPITAL_POOL_ENABLED = '1';
  const open = Array.from({ length: 25 }, (_, index) => ({
    entryFilled: true,
    closed: false,
    ticker: `N${index}`,
    setupId: index < 3 ? 'JAPAN_MEDIUM_MR' : '',
    market: index < 10 ? 'Japan' : 'US',
  }));
  const plan = capitalSlotPlan(open);
  assert.equal(plan.slots, 50);
  assert.equal(plan.free, 25);
  assert.equal(plan.byBook['old-engine'], 22);
  const account = {
    summaryAt: new Date().toISOString(),
    availableFunds: 315984,
    buyingPower: 900000,
    excessLiquidity: 200000,
    netLiquidation: 461316,
    grossPositionValue: 100000,
  };
  const allowed = evaluateCapitalPool('UK_LONG_MOMENTUM', open, 30000, account, { ticker: 'SHEL.L' });
  assert.equal(allowed.allowed, true);
  const duplicate = evaluateCapitalPool('FRANCE_LONG_MOMENTUM', open, 30000, account, { ticker: 'N0' });
  assert.equal(duplicate.log, 'skipped: capacity');
  assert.equal(duplicate.detail, 'one-position-per-ticker');
  const full = Array.from({ length: 50 }, (_, index) => ({ entryFilled: true, closed: false, ticker: `F${index}` }));
  const capped = evaluateCapitalPool('JAPAN_SHORT_MR', full, 30000, account, { ticker: 'NEW' });
  assert.equal(capped.log, 'skipped: capacity');
  const buyingPower = evaluateCapitalPool('JAPAN_SHORT_MR', [], 30000, {
    ...account, buyingPower: 10000,
  }, { ticker: 'AAA' });
  assert.equal(buyingPower.log, 'skipped: margin');
  assert.equal(buyingPower.detail, 'buying-power');
  const floor = marginDecision(30000, {
    buyingPower: 70000,
    excessLiquidity: 70000,
    netLiquidation: 400000,
  });
  assert.equal(floor.allowed, false);
  assert.equal(floor.detail, 'excess-liquidity-floor');
  const missing = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    summaryAt: new Date().toISOString(),
    buyingPower: 900000,
    netLiquidation: 461316,
    grossPositionValue: 100000,
  }, { ticker: 'BBB' });
  assert.equal(missing.detail, 'missing-account');
  process.env.IBKR_BRIDGE_ROLE = 'live';
  assert.equal(evaluateCapitalPool('JAPAN_MEDIUM_MR', full, 30000, account).applied, false);
  if (prior == null) delete process.env.CAPITAL_POOL_ENABLED;
  else process.env.CAPITAL_POOL_ENABLED = prior;
  if (role == null) delete process.env.IBKR_BRIDGE_ROLE;
  else process.env.IBKR_BRIDGE_ROLE = role;
});

test('gross leverage, overnight margin, and fresh account data', () => {
  const prior = process.env.CAPITAL_POOL_ENABLED;
  const leverageCap = process.env.MAX_GROSS_LEVERAGE;
  process.env.CAPITAL_POOL_ENABLED = '1';
  delete process.env.MAX_GROSS_LEVERAGE;
  const now = Date.parse('2026-10-06T15:20:00+08:00');
  const account = {
    summaryAt: '2026-10-06T15:19:00+08:00',
    buyingPower: 1267685.81,
    excessLiquidity: 330676.91,
    netLiquidation: 461952.82,
    grossPositionValue: 486753.43,
  };
  const open = Array.from({ length: 25 }, (_, index) => ({
    entryFilled: true, closed: false, ticker: `N${index}`,
  }));
  const fit = capitalEntryFit(open, account);
  assert.equal(fit.slots, 25);
  assert.equal(fit.leverage, 14);
  assert.equal(fit.excessLiquidity, 33);
  assert.equal(fit.strictest, 14);
  const allowed = evaluateCapitalPool('JAPAN_MEDIUM_MR', open, 30000, account, { ticker: 'NEW', now });
  assert.equal(allowed.allowed, true);
  const tooMuchGross = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    grossPositionValue: 2 * account.netLiquidation - 1000,
  }, { ticker: 'BIG', now });
  assert.equal(tooMuchGross.log, 'skipped: leverage');
  assert.equal(tooMuchGross.detail, 'gross-leverage');
  process.env.MAX_GROSS_LEVERAGE = '3';
  const wider = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    grossPositionValue: 2 * account.netLiquidation,
  }, { ticker: 'WIDE', now });
  assert.equal(wider.allowed, true);
  const overnightFunds = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    lookAheadAvailableFunds: 10000,
    lookAheadExcessLiquidity: 300000,
  }, { ticker: 'NIGHT', now });
  assert.equal(overnightFunds.log, 'skipped: margin');
  assert.equal(overnightFunds.detail, 'lookahead-available-funds');
  const overnightExcess = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    lookAheadAvailableFunds: 80000,
    lookAheadExcessLiquidity: 70000,
  }, { ticker: 'NIGHT2', now });
  assert.equal(overnightExcess.log, 'skipped: margin');
  assert.equal(overnightExcess.detail, 'lookahead-excess-liquidity');
  const stale = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    summaryAt: '2026-10-06T14:00:00+08:00',
  }, { ticker: 'OLD', now });
  assert.equal(stale.log, 'skipped: margin data stale');
  assert.equal(stale.detail, 'older-than-15m');
  const previousDay = evaluateCapitalPool('JAPAN_MEDIUM_MR', [], 30000, {
    ...account,
    summaryAt: '2026-10-05T23:55:00+08:00',
  }, { ticker: 'YDAY', now: Date.parse('2026-10-06T00:05:00+08:00') });
  assert.equal(previousDay.log, 'skipped: margin data stale');
  assert.equal(previousDay.detail, 'previous-day');
  if (prior == null) delete process.env.CAPITAL_POOL_ENABLED;
  else process.env.CAPITAL_POOL_ENABLED = prior;
  if (leverageCap == null) delete process.env.MAX_GROSS_LEVERAGE;
  else process.env.MAX_GROSS_LEVERAGE = leverageCap;
});
