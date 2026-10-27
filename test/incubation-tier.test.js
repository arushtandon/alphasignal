'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'incubation-')), 'momentum-book-state.json');
process.env.MOMENTUM_BOOK_STATE_FILE = stateFile;
process.env.SETUP_BOOK_RUNTIME_FILE = path.join(path.dirname(stateFile), 'runtime.json');
delete process.env.INCUBATION_UK_TOM_ENABLED;
delete process.env.INCUBATION_HK_TOM_ENABLED;
delete process.env.INCUBATION_US_LONG_P6_ENABLED;

const inc = require('../lib/strategy/incubation-tier');
const exec = require('../lib/strategy/setup-book-execution');
const { SETUPS } = require('../lib/strategy/evidence-setup-book');
const tom = require('../lib/strategy/tom-book');

function weekdays(from, count) {
  const out = [];
  const day = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}
function barsThrough(lastDate, count = 400) {
  const dates = weekdays('2025-01-01', 600).filter(date => date <= lastDate).slice(-count);
  return dates.map((date, index) => ({ date, o: 100 + index * 0.1, c: 100 + index * 0.1 }));
}

test('eligibility is enforced from the executable-instrument evidence row', () => {
  const uk = inc.incubationEligibility('INCUBATION_UK_TOM');
  assert.equal(uk.eligible, false);
  assert.deepEqual(uk.failReasons, ['excess t 0.91 < 1.5']);
  const hk = inc.incubationEligibility('INCUBATION_HK_TOM');
  assert.equal(hk.eligible, false);
  assert.deepEqual(hk.failReasons, ['excess t 1.26 < 1.5']);
  const us = inc.incubationEligibility('INCUBATION_US_LONG_P6');
  assert.equal(us.eligible, true);
  assert.deepEqual(us.failReasons, []);
  assert.equal(inc.incubationEligibility('JAPAN_MEDIUM_MR').eligible, false);
});

test('a book emits only when eligible and explicitly enabled', () => {
  assert.equal(inc.incubationCanEmit('INCUBATION_UK_TOM').reason, 'ineligible');
  assert.equal(inc.incubationCanEmit('INCUBATION_US_LONG_P6').reason, 'not-enabled');
  process.env.INCUBATION_US_LONG_P6_ENABLED = '1';
  assert.equal(inc.incubationCanEmit('INCUBATION_US_LONG_P6').allowed, true);
  process.env.INCUBATION_UK_TOM_ENABLED = '1';
  assert.equal(inc.incubationCanEmit('INCUBATION_UK_TOM').allowed, false, 'enable flag cannot override eligibility');
  delete process.env.INCUBATION_US_LONG_P6_ENABLED;
  delete process.env.INCUBATION_UK_TOM_ENABLED;
});

test('incubation books are $10k tickets at the lowest priority with the tier label', () => {
  assert.equal(exec.setupTicketUsd('INCUBATION_UK_TOM'), 10_000);
  assert.equal(exec.setupTicketUsd('INCUBATION_US_LONG_P6'), 10_000);
  assert.equal(exec.setupTicketUsd('JAPAN_MEDIUM_MR'), 30_000);
  assert.equal(exec.setupTicketUsd('UK_LONG_MOMENTUM'), 30_000);
  assert.ok(exec.setupPriority('INCUBATION_UK_TOM') > exec.setupPriority('UK_LONG_MOMENTUM'));
  assert.ok(exec.setupPriority('INCUBATION_US_LONG_P6') > exec.setupPriority('US_SHORT_MR'));
  assert.equal(exec.evidenceTier('INCUBATION_HK_TOM'), 4);
  for (const id of Object.keys(inc.INCUBATION_BOOKS)) {
    assert.equal(SETUPS[id].tier, 'Incubation — not validated');
    assert.equal(SETUPS[id].experimentalLabel, 'Incubation — not validated');
    assert.equal(SETUPS[id].incubation, true);
    assert.ok(SETUPS[id].benchmark);
  }
  const sorted = [
    { setupId: 'INCUBATION_UK_TOM', ticker: 'ISF.L', signalDate: '2026-11-02' },
    { setupId: 'US_SHORT_MR', ticker: 'KLAC', signalDate: '2026-11-02' },
    { setupId: 'JAPAN_MEDIUM_MR', ticker: '8411.T', signalDate: '2026-11-02' },
  ].sort(exec.compareSetupEntries);
  assert.deepEqual(sorted.map(row => row.setupId), ['JAPAN_MEDIUM_MR', 'US_SHORT_MR', 'INCUBATION_UK_TOM']);
});

test('at most 10 incubation slots inside the 50-slot pool', () => {
  process.env.CAPITAL_POOL_ENABLED = '1';
  const account = {
    summaryAt: new Date().toISOString(), netLiquidation: 450_000, buyingPower: 1_500_000,
    excessLiquidity: 300_000, availableFunds: 300_000, grossPositionValue: 100_000,
  };
  const rows = [];
  for (let index = 0; index < 10; index++) {
    rows.push({ key: `X${index}|long|d`, ticker: `X${index}`, setupId: index % 2 ? 'INCUBATION_UK_TOM' : 'INCUBATION_US_LONG_P6', entryFilled: true, closed: false });
  }
  const blocked = exec.evaluateCapitalPool('INCUBATION_HK_TOM', rows, 10_000, account, { ticker: '2800.HK' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.detail, 'incubation-slots');
  const other = exec.evaluateCapitalPool('JAPAN_MEDIUM_MR', rows, 30_000, account, { ticker: '8411.T' });
  assert.equal(other.allowed, true, 'the incubation cap does not block validated books');
  const nine = exec.evaluateCapitalPool('INCUBATION_HK_TOM', rows.slice(0, 9), 10_000, account, { ticker: '2800.HK' });
  assert.equal(nine.allowed, true);
  assert.equal(exec.capitalSlotPlan(rows).incubation.used, 10);
  assert.equal(exec.capitalSlotPlan(rows).incubation.max, 10);
  delete process.env.CAPITAL_POOL_ENABLED;
});

test('TOM −1..+3: entry on the first session of the month, exit in the closing window of day +3', async () => {
  const loadBars = async () => barsThrough('2026-10-30');
  const entryDay = await tom.planTomBatch({ now: new Date('2026-11-02T02:00:00Z'), held: [], loadBars, dryRun: true });
  const uk = entryDay.books.find(book => book.id === 'INCUBATION_UK_TOM');
  assert.equal(uk.action, 'ineligible', 'gated books report the candidate but emit nothing');
  assert.equal(uk.candidate.ticker, 'ISF.L');
  assert.equal(uk.candidate.exitDue, '2026-11-04');
  assert.equal(entryDay.orders.length, 0);
  assert.equal(tom.exitSessionDate(['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'], '2026-11-02', 3), '2026-11-04');
  assert.equal(tom.exitSessionDate(['2026-10-30'], '2026-11-02', 3), '2026-11-04', 'calendar extended by weekdays');

  // Seed an open sleeve and check the exit timing.
  fs.writeFileSync(stateFile, JSON.stringify({
    INCUBATION_HK_TOM: { monthsRun: ['2026-11'], paused: null, entries: [{ month: '2026-11', ticker: '2800.HK', entry: 23.9, entryDate: '2026-11-02', key: '2800.HK|long|2026-11-02' }] },
  }));
  const early = await tom.planTomBatch({ now: new Date('2026-11-04T02:00:00Z'), held: ['2800.HK'], loadBars, dryRun: true });
  const hkEarly = early.books.find(book => book.id === 'INCUBATION_HK_TOM');
  assert.equal(early.orders.length, 0, '10:00 HKT on day +3 is not the closing window');
  assert.equal(hkEarly.openSleeve.exitDue, '2026-11-04');
  const closing = await tom.planTomBatch({ now: new Date('2026-11-04T07:45:00Z'), held: ['2800.HK'], loadBars, dryRun: true });
  assert.equal(closing.orders.length, 1, '15:45 HKT on day +3 emits the exit');
  assert.equal(closing.orders[0].event.setupTimeExit, true);
  assert.equal(closing.orders[0].event.status, 'time_limit');
  assert.match(closing.orders[0].event.reason, /setup-time-exit tom-window-complete/);
  const late = await tom.planTomBatch({ now: new Date('2026-11-05T02:00:00Z'), held: ['2800.HK'], loadBars, dryRun: true });
  assert.equal(late.orders.length, 1);
  assert.equal(late.books.find(book => book.id === 'INCUBATION_HK_TOM').exit.late, true);
  fs.writeFileSync(stateFile, '{}');
});

test('review rule: promote within 1 SD and positive, stop beyond 1 SD or 1.5x drawdown', () => {
  const expectation = inc.backtestExpectation('INCUBATION_US_LONG_P6', { months: 6 });
  assert.equal(expectation.unit, 'months');
  assert.equal(expectation.expectedExcessPct, 5.94);
  assert.ok(expectation.sdPct > 13 && expectation.sdPct < 14.5, `sd ${expectation.sdPct}`);
  assert.equal(inc.incubationReview('INCUBATION_US_LONG_P6', { monthsLive: 3, closedTrades: 2 }).decision, 'continue');
  assert.equal(inc.incubationReview('INCUBATION_US_LONG_P6', { monthsLive: 6, closedTrades: 3, liveExcessPct: 4, liveMaxDrawdownPct: 10 }).decision, 'promote');
  assert.equal(inc.incubationReview('INCUBATION_US_LONG_P6', { monthsLive: 6, closedTrades: 3, liveExcessPct: -9, liveMaxDrawdownPct: 10 }).decision, 'stop');
  assert.equal(inc.incubationReview('INCUBATION_US_LONG_P6', { monthsLive: 2, closedTrades: 1, liveExcessPct: 1, liveMaxDrawdownPct: 44 }).decision, 'stop');
  assert.equal(inc.incubationReview('INCUBATION_US_LONG_P6', { monthsLive: 6, closedTrades: 3, liveExcessPct: -2, liveMaxDrawdownPct: 10 }).decision, 'hold');
  const byTrades = inc.incubationReview('INCUBATION_UK_TOM', { monthsLive: 2, closedTrades: 30, liveExcessPct: 2, liveMaxDrawdownPct: 5 });
  assert.equal(byTrades.due, true);
  assert.equal(byTrades.expectation.unit, 'trades');
});
