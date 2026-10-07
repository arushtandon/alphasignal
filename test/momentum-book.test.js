'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  batchDue,
  score12Minus1,
  rankMembers,
  selectEntry,
  sleevesToExit,
  shouldAutoPause,
  addMonths,
  planMomentumBatch,
  commitMomentumAcceptances,
  padBenchmarkCalendar,
  previousWeekday,
} = require('../lib/strategy/momentum-book');
const { setupExitDecision, SETUPS } = require('../lib/strategy/evidence-setup-book');

function bars(count, start = 100) {
  const out = [];
  for (let index = 0; index < count; index++) {
    const day = new Date(Date.UTC(2018, 0, 1 + index));
    out.push({ date: day.toISOString().slice(0, 10), c: start + index });
  }
  return out;
}

test('momentum batch is the first session after month-end', () => {
  const dates = ['2026-09-29', '2026-09-30', '2026-10-01'];
  assert.equal(batchDue(dates, '2026-10-01', false), true);
  assert.equal(batchDue(dates, '2026-10-01', true), false);
  assert.equal(batchDue(dates, '2026-10-02', false), false);
  assert.equal(batchDue(['2026-09-30'], '2026-10-03', false), false);
});

test('12-1 rank skips a name already held and a six-month sleeve is due', () => {
  const series = new Map([
    ['AAA.L', bars(400, 50)],
    ['BBB.L', bars(400, 80)],
  ]);
  const asOf = '2019-02-05';
  const ranked = rankMembers(['AAA.L', 'BBB.L'], series, asOf);
  assert.equal(ranked.length, 2);
  assert.equal(selectEntry(ranked, new Set(['BBB.L'])).ticker, ranked.find(row => row.ticker !== 'BBB.L').ticker);
  assert.equal(score12Minus1(bars(400), asOf) > 0, true);
  const due = sleevesToExit([
    { month: '2026-04', ticker: 'AAA.L' },
    { month: '2026-05', ticker: 'BBB.L' },
  ], '2026-10');
  assert.deepEqual(due.map(row => row.ticker), ['AAA.L']);
  assert.equal(addMonths('2026-04', 6), '2026-10');
});

test('auto-pause needs six entries and more than five points behind', () => {
  assert.equal(shouldAutoPause(5, 0.01, 0.20), false);
  assert.equal(shouldAutoPause(6, 0.10, 0.16), true);
  assert.equal(shouldAutoPause(6, 0.12, 0.16), false);
  assert.equal(SETUPS.UK_LONG_MOMENTUM.experimentalLabel, 'Experimental');
  assert.equal(SETUPS.UK_LONG_MOMENTUM.benchmark, 'EWU');
  assert.equal(SETUPS.FRANCE_LONG_MOMENTUM.benchmark, 'EWQ');
  assert.equal(SETUPS.UK_LONG_MOMENTUM.stops, false);
  const position = { entry: 100, entryIndex: 0 };
  const held = Array.from({ length: 130 }, (_, index) => ({ h: 101, l: 99, c: 100, o: 100 }));
  assert.equal(setupExitDecision('UK_LONG_MOMENTUM', position, held, 10).action, 'hold');
  assert.equal(setupExitDecision('UK_LONG_MOMENTUM', position, held, 126).reason, 'hold_complete');
});

test('momentum batch before 06:00 SGT writes nothing', async () => {
  const file = path.join(os.tmpdir(), `momentum-before-release-${process.pid}.json`);
  const prior = process.env.MOMENTUM_BOOK_STATE_FILE;
  process.env.MOMENTUM_BOOK_STATE_FILE = file;
  fs.writeFileSync(file, '{"sentinel":true}\n');
  const before = fs.readFileSync(file, 'utf8');
  const plan = await planMomentumBatch({
    now: new Date('2026-10-06T21:30:00.000Z'),
    loadBars: async () => { throw new Error('bars should not load before the release'); },
  });
  assert.equal(plan.skipped, 'before-sgt-release');
  assert.deepEqual(plan.orders, []);
  assert.equal(plan.wrote, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file);
  if (prior == null) delete process.env.MOMENTUM_BOOK_STATE_FILE;
  else process.env.MOMENTUM_BOOK_STATE_FILE = prior;
});

test('a paused France book does not enter on 2 Nov and the UK book still can', async () => {
  const momentumFile = path.join(os.tmpdir(), `momentum-nov2-${process.pid}.json`);
  const runtimeFile = path.join(os.tmpdir(), `runtime-nov2-${process.pid}.json`);
  const priorMomentum = process.env.MOMENTUM_BOOK_STATE_FILE;
  const priorRuntime = process.env.SETUP_BOOK_RUNTIME_FILE;
  process.env.MOMENTUM_BOOK_STATE_FILE = momentumFile;
  process.env.SETUP_BOOK_RUNTIME_FILE = runtimeFile;
  fs.writeFileSync(runtimeFile, JSON.stringify({
    version: 1,
    paused: {
      FRANCE_LONG_MOMENTUM: {
        at: '2026-10-07T00:00:00.000Z',
        reason: 'alpha t 1.88 < 2 on 2026-10-07 check',
      },
    },
    operatorResume: {},
    alerts: [],
  }));
  fs.writeFileSync(momentumFile, '{}\n');
  const dates = [];
  for (let cursor = Date.parse('2025-01-02T00:00:00Z'); cursor <= Date.parse('2026-10-30T00:00:00Z'); cursor += 86400000) {
    const day = new Date(cursor);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    dates.push({ date: day.toISOString().slice(0, 10), c: 100 + dates.length * 0.15, o: 100 });
  }
  const plan = await planMomentumBatch({
    now: new Date('2026-11-02T02:00:00.000Z'),
    held: [],
    loadBars: async () => dates,
  });
  const france = plan.books.find(row => row.id === 'FRANCE_LONG_MOMENTUM');
  const uk = plan.books.find(row => row.id === 'UK_LONG_MOMENTUM');
  assert.equal(france.action, 'paused');
  assert.equal(france.reason, 'alpha t 1.88 < 2 on 2026-10-07 check');
  assert.equal(plan.orders.some(order => order.event && order.event.setupId === 'FRANCE_LONG_MOMENTUM' && order.action === 'buy'), false);
  assert.equal(uk.action, 'buy');
  assert.equal(plan.orders.filter(order => order.action === 'buy').every(order => order.event.setupId === 'UK_LONG_MOMENTUM'), true);
  fs.unlinkSync(momentumFile);
  fs.unlinkSync(runtimeFile);
  if (priorMomentum == null) delete process.env.MOMENTUM_BOOK_STATE_FILE;
  else process.env.MOMENTUM_BOOK_STATE_FILE = priorMomentum;
  if (priorRuntime == null) delete process.env.SETUP_BOOK_RUNTIME_FILE;
  else process.env.SETUP_BOOK_RUNTIME_FILE = priorRuntime;
});

test('a dry-run does not record the month or pause the book', async () => {
  const momentumFile = path.join(os.tmpdir(), `momentum-dry-${process.pid}.json`);
  const runtimeFile = path.join(os.tmpdir(), `runtime-dry-${process.pid}.json`);
  const priorMomentum = process.env.MOMENTUM_BOOK_STATE_FILE;
  const priorRuntime = process.env.SETUP_BOOK_RUNTIME_FILE;
  process.env.MOMENTUM_BOOK_STATE_FILE = momentumFile;
  process.env.SETUP_BOOK_RUNTIME_FILE = runtimeFile;
  fs.writeFileSync(momentumFile, '{}\n');
  fs.writeFileSync(runtimeFile, '{"version":1,"paused":{},"operatorResume":{},"alerts":[]}\n');
  const dates = [];
  for (let cursor = Date.parse('2025-01-02T00:00:00Z'); cursor <= Date.parse('2026-10-06T00:00:00Z'); cursor += 86400000) {
    const day = new Date(cursor);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    dates.push({ date: day.toISOString().slice(0, 10), c: 100 + dates.length * 0.15, o: 100 });
  }
  const through = previousWeekday('2026-11-02');
  const plan = await planMomentumBatch({
    now: new Date('2026-11-02T02:00:00.000Z'),
    held: [],
    dryRun: true,
    loadBars: async symbol => (symbol === 'EWU' || symbol === 'EWQ')
      ? padBenchmarkCalendar(dates, through)
      : dates,
  });
  assert.equal(plan.wrote, false);
  assert.equal(plan.dryRun, true);
  assert.equal(fs.readFileSync(momentumFile, 'utf8'), '{}\n');
  const france = plan.books.find(row => row.id === 'FRANCE_LONG_MOMENTUM');
  const uk = plan.books.find(row => row.id === 'UK_LONG_MOMENTUM');
  assert.equal(france.action, 'paused');
  assert.equal(france.reason, 'alpha t 1.88 < 2 on 2026-10-07 check');
  assert.equal(uk.action, 'buy');
  assert.equal(plan.orders.filter(order => order.action === 'buy').every(order => order.event.setupId === 'UK_LONG_MOMENTUM'), true);
  fs.unlinkSync(momentumFile);
  fs.unlinkSync(runtimeFile);
  if (priorMomentum == null) delete process.env.MOMENTUM_BOOK_STATE_FILE;
  else process.env.MOMENTUM_BOOK_STATE_FILE = priorMomentum;
  if (priorRuntime == null) delete process.env.SETUP_BOOK_RUNTIME_FILE;
  else process.env.SETUP_BOOK_RUNTIME_FILE = priorRuntime;
});

test('momentum month is recorded only after the emit is accepted', () => {
  const file = path.join(os.tmpdir(), `momentum-accept-${process.pid}.json`);
  const prior = process.env.MOMENTUM_BOOK_STATE_FILE;
  process.env.MOMENTUM_BOOK_STATE_FILE = file;
  fs.writeFileSync(file, '{"UK_LONG_MOMENTUM":{"monthsRun":[],"entries":[{"month":"2026-04","ticker":"AAA.L","entry":10,"key":"AAA.L|long|2026-04-01"}],"paused":null}}\n');
  commitMomentumAcceptances([]);
  const untouched = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(untouched.UK_LONG_MOMENTUM.monthsRun, []);
  assert.equal(untouched.UK_LONG_MOMENTUM.entries[0].exited, undefined);
  commitMomentumAcceptances([{
    accept: {
      setupId: 'UK_LONG_MOMENTUM',
      month: '2026-10',
      entry: { month: '2026-10', ticker: 'SHEL.L', entry: 100, entryDate: '2026-10-01', key: 'SHEL.L|long|2026-10-01' },
    },
  }, {
    accept: { setupId: 'UK_LONG_MOMENTUM', month: '2026-10', exitKey: 'AAA.L|long|2026-04-01' },
  }]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.UK_LONG_MOMENTUM.monthsRun, ['2026-10']);
  assert.equal(saved.UK_LONG_MOMENTUM.entries[0].exited, '2026-10');
  assert.equal(saved.UK_LONG_MOMENTUM.entries[1].ticker, 'SHEL.L');
  fs.unlinkSync(file);
  if (prior == null) delete process.env.MOMENTUM_BOOK_STATE_FILE;
  else process.env.MOMENTUM_BOOK_STATE_FILE = prior;
});
