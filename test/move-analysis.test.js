'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  slimBook,
  attributeMove,
  currentAttribution,
  shouldRecordSnapshot,
  moverSentence,
  writePeriodNote,
  buildMoveNotes,
  periodStarts,
  splitContributors,
  realisedFromFills
} = require('../lib/ibkr/move-analysis');

function name(ticker, unreal, extra) {
  return Object.assign({
    key: ticker + '|long|Mon Sep 07 2026',
    ticker,
    side: 'buy',
    openQty: 10,
    avgEntry: 100,
    mark: 90,
    unrealizedUsd: unreal,
    realizedUsd: 0,
    errorTrade: false
  }, extra || {});
}

test('current attribution names the largest drag', () => {
  const book = slimBook([
    name('BA.L', -1210),
    name('SU.PA', -629),
    name('SNDK', 748)
  ], { unrealizedUsd: -1091, realizedUsd: 0, openCount: 3 });
  const a = currentAttribution(book);
  assert.equal(a.drags[0].ticker, 'BA.L');
  assert.match(a.headline, /BA\.L/);
  assert.match(a.headline, /1210/);
});

test('attributeMove explains a new large unrealised hole', () => {
  const prev = slimBook([name('BA.L', -200)], { unrealizedUsd: 400, realizedUsd: 8000, openCount: 1 });
  const curr = slimBook(
    [name('BA.L', -1210), name('7733.T', -365, { key: '7733.T|short|Fri Sep 04 2026' })],
    { unrealizedUsd: -3537, realizedUsd: 8000, openCount: 2 }
  );
  const m = attributeMove(prev, curr);
  assert.equal(m.large, true);
  assert.ok(m.dUnrealUsd < -3000);
  assert.equal(m.rows[0].ticker, 'BA.L');
  assert.ok(m.headline.includes('BA.L'));
  const t7733 = m.rows.find((r) => r.ticker === '7733.T');
  assert.equal(t7733.reason, 'new');
});

test('closed name shows as realized move', () => {
  const prev = slimBook([name('FOO', -400)], { unrealizedUsd: -400, realizedUsd: 100, openCount: 1 });
  const curr = slimBook(
    [name('FOO', 0, { openQty: 0, realizedUsd: -380 })],
    { unrealizedUsd: 0, realizedUsd: -280, openCount: 0 }
  );
  const m = attributeMove(prev, curr);
  assert.equal(m.rows[0].reason, 'closed');
  assert.ok(m.rows[0].dRealUsd < 0);
});

test('snapshot throttle skips tiny moves inside a minute', () => {
  const a = slimBook([name('X', 100)], { unrealizedUsd: 100, realizedUsd: 0 }, { at: '2026-09-07T01:00:00.000Z' });
  const b = slimBook([name('X', 110)], { unrealizedUsd: 110, realizedUsd: 0 }, { at: '2026-09-07T01:00:20.000Z' });
  assert.equal(shouldRecordSnapshot(a, b, 60000), false);
  const c = slimBook([name('X', 200)], { unrealizedUsd: 200, realizedUsd: 0 }, { at: '2026-09-07T01:02:00.000Z' });
  assert.equal(shouldRecordSnapshot(a, c, 60000), true);
});

test('period note names the names that moved PnL', () => {
  assert.match(moverSentence({
    ticker: '4062.T', reason: 'closed', dRealUsd: 1623, dUnrealUsd: 0
  }), /4062\.T closed and booked/);
  const prev = slimBook([name('BA.L', -200)], {
    unrealizedUsd: -200, realizedUsd: 8000, openCount: 1
  }, { at: '2026-09-07T00:10:00.000Z' });
  const curr = slimBook(
    [name('BA.L', -1210), name('4062.T', 0, {
      key: '4062.T|short|Mon Aug 24 2026', openQty: 0, realizedUsd: 1623
    })],
    { unrealizedUsd: -3537, realizedUsd: 9623, openCount: 1 },
    { at: '2026-09-07T05:11:00.000Z' }
  );
  const note = writePeriodNote(attributeMove(prev, curr), { label: 'Today', key: 'day' });
  assert.match(note.summary, /Today/);
  assert.match(note.summary, /changed by/i);
  assert.match(note.reason, /BA\.L|4062\.T/);
  assert.match(note.reason, /Unrealised down|Realised up/);
  assert.ok(note.realisedHelped.some((m) => m.ticker === '4062.T'));
  assert.ok(note.unrealisedHurt.some((m) => m.ticker === 'BA.L'));
  assert.ok(note.movers.length >= 2);
});

test('contributors split realised and unrealised, helped and hurt', () => {
  const split = splitContributors([
    { ticker: '4062.T', dRealUsd: 1623, dUnrealUsd: 0 },
    { ticker: 'SAP.DE', dRealUsd: 0, dUnrealUsd: -183 },
    { ticker: '6758.T', dRealUsd: 0, dUnrealUsd: 102 },
    { ticker: 'FOO', dRealUsd: -90, dUnrealUsd: 0 }
  ]);
  assert.equal(split.realisedHelped[0].ticker, '4062.T');
  assert.equal(split.realisedHurt[0].ticker, 'FOO');
  assert.equal(split.unrealisedHelped[0].ticker, '6758.T');
  assert.equal(split.unrealisedHurt[0].ticker, 'SAP.DE');
});

test('this week vs last week uses last-week realised fills when snaps start this Monday', () => {
  const now = Date.parse('2026-09-07T05:15:00.000Z');
  const curr = slimBook(
    [name('BA.L', -1210), name('4062.T', 0, { openQty: 0, realizedUsd: 1623 })],
    { unrealizedUsd: -1210, realizedUsd: 9623, openCount: 1 },
    { at: '2026-09-07T05:11:00.000Z' }
  );
  const monday = slimBook(
    [name('BA.L', -200)],
    { unrealizedUsd: -200, realizedUsd: 8000, openCount: 1 },
    { at: '2026-09-07T04:58:00.000Z' }
  );
  const fills = [
    { key: 'HO.PA|short|Mon Aug 24 2026', ticker: 'HO.PA', side: 'buy', currency: 'EUR', ccyScale: 1, errorTrade: false, role: 'entry', qty: 10, price: 100, time: '2026-08-25T08:00:00.000Z' },
    { key: 'HO.PA|short|Mon Aug 24 2026', ticker: 'HO.PA', side: 'buy', currency: 'EUR', ccyScale: 1, errorTrade: false, role: 'tp1', qty: 10, price: 110, time: '2026-09-03T08:00:00.000Z' }
  ];
  const notes = buildMoveNotes([monday, curr], now, { fills });
  assert.match(notes.week.vsLast, /last week/i);
  assert.match(notes.month.vsLast, /last month/i);
  assert.notEqual(notes.week.vsLast, notes.month.vsLast);
  assert.ok(notes.week.last.missing || notes.week.last.fromFills);
  const lastWeek = realisedFromFills(fills, Date.parse('2026-08-31T00:00:00+08:00'), Date.parse('2026-09-07T00:00:00+08:00'));
  assert.ok(lastWeek.dRealUsd > 0);
  assert.equal(lastWeek.rows[0].ticker, 'HO.PA');
});

test('this month realised includes earlier-in-month fills that this week does not', () => {
  const now = Date.parse('2026-09-07T13:15:00.000Z');
  const monday = slimBook(
    [name('BA.L', -200)],
    { unrealizedUsd: -200, realizedUsd: 8000, openCount: 1 },
    { at: '2026-09-07T04:58:00.000Z' }
  );
  const curr = slimBook(
    [name('BA.L', -1210), name('4062.T', 0, { openQty: 0, realizedUsd: 1623 })],
    { unrealizedUsd: -1210, realizedUsd: 9623, openCount: 1 },
    { at: '2026-09-07T05:11:00.000Z' }
  );
  const fill = (ticker, key, role, qty, price, time, extra) => Object.assign({
    key, ticker, side: 'buy', currency: 'USD', ccyScale: 1, errorTrade: false,
    role, qty, price, time
  }, extra || {});
  const fills = [
    fill('HO.PA', 'HO.PA|short|Mon Aug 24 2026', 'entry', 10, 100, '2026-08-25T08:00:00.000Z', { currency: 'EUR' }),
    fill('HO.PA', 'HO.PA|short|Mon Aug 24 2026', 'tp1', 10, 110, '2026-09-03T08:00:00.000Z', { currency: 'EUR' }),
    fill('4062.T', '4062.T|short|Mon Aug 24 2026', 'entry', 100, 20000, '2026-08-24T08:00:00.000Z'),
    fill('4062.T', '4062.T|short|Mon Aug 24 2026', 'tp1', 100, 21623, '2026-09-07T05:00:00.000Z')
  ];
  const notes = buildMoveNotes([monday, curr], now, { fills });
  assert.equal(notes.day.dRealUsd, notes.week.dRealUsd);
  assert.ok(notes.week.hideReal);
  assert.ok(notes.week.hideUnreal);
  assert.ok(notes.month.hideUnreal);
  assert.equal(!!notes.month.hideReal, false);
  assert.notEqual(notes.month.dRealUsd, notes.week.dRealUsd);
  assert.ok(notes.month.realisedHelped.some((m) => m.ticker === 'HO.PA'));
  assert.ok(!notes.week.realisedHelped.some((m) => m.ticker === 'HO.PA'));
  assert.ok(notes.day.realisedHelped.some((m) => m.ticker === '4062.T'));
  assert.ok(notes.month.realisedHelped.some((m) => m.ticker === '4062.T'));
  assert.match(notes.week.summary, /same window as Today/i);
});

test('buildMoveNotes uses SGT day/week/month baselines', () => {
  const starts = periodStarts(Date.parse('2026-09-07T05:00:00.000Z'));
  assert.equal(starts.day.fromMs, Date.parse('2026-09-07T00:00:00+08:00'));
  assert.equal(starts.week.fromMs, starts.day.fromMs);
  const before = slimBook([name('BA.L', -200)], {
    unrealizedUsd: -200, realizedUsd: 8000, openCount: 1
  }, { at: '2026-09-06T15:00:00.000Z' });
  const curr = slimBook([name('BA.L', -1210)], {
    unrealizedUsd: -1210, realizedUsd: 8000, openCount: 1
  }, { at: '2026-09-07T05:11:00.000Z' });
  const notes = buildMoveNotes([before, curr], Date.parse('2026-09-07T05:15:00.000Z'));
  assert.match(notes.summary, /BA\.L/);
  assert.match(notes.summary, /Today: unrealised changed by/);
  assert.equal(notes.day.partial, false);
  assert.ok(notes.day.dUnrealUsd < -900);
  assert.equal(notes.day.unrealStartUsd, -200);
  assert.equal(notes.day.unrealNowUsd, -1210);
  assert.match(notes.day.reason, /BA\.L/);
});
