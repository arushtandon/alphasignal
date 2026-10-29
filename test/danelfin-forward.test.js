'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WATCH_LABEL, NOTIONAL, monthlySelectionDue, choosePicks, markPosition, updateForwardBook,
} = require('../lib/strategy/danelfin-forward');

function bars(count, closeAt) {
  const start = Date.parse('2024-01-02T00:00:00Z');
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    const close = closeAt(index, count) ;
    out.push({ date, o: close, h: close + 1, l: Math.max(0.5, close - 1), c: close, v: 5e6 });
  }
  return out;
}

test('monthly selection is the last weekday after the US close', () => {
  const due = monthlySelectionDue(new Date('2026-10-30T20:15:00Z'), new Set());
  assert.equal(due.due, true);
  assert.equal(due.date, '2026-10-30');
  assert.equal(monthlySelectionDue(new Date('2026-10-29T20:15:00Z'), new Set()).due, false);
  assert.equal(monthlySelectionDue(new Date('2026-10-30T18:00:00Z'), new Set()).due, false);
  assert.equal(monthlySelectionDue(new Date('2026-10-30T20:15:00Z'), new Set(['2026-10'])).due, false);
});

test('medium takes the top 6-month name and long takes up to five by 12-1', () => {
  const rows = [
    { ticker: 'AAA', ai: 10, close: 20, marketCap: 3e9, dollarAdv: 30e6, ret6: 0.4, ret12: 0.2, piotroski: 7 },
    { ticker: 'BBB', ai: 10, close: 20, marketCap: 3e9, dollarAdv: 30e6, ret6: 0.9, ret12: 0.1, piotroski: 5 },
    { ticker: 'CCC', ai: 10, close: 20, marketCap: 3e9, dollarAdv: 30e6, ret6: 0.1, ret12: 0.8, piotroski: 6 },
    { ticker: 'DDD', ai: 9, close: 20, marketCap: 3e9, dollarAdv: 30e6, ret6: 2, ret12: 2, piotroski: 9 },
    { ticker: 'EEE', ai: 10, close: 4, marketCap: 3e9, dollarAdv: 30e6, ret6: 3, ret12: 3, piotroski: 9 },
  ];
  const picks = choosePicks(rows, []);
  assert.equal(picks.find(row => row.horizon === 'medium').ticker, 'BBB');
  assert.deepEqual(picks.filter(row => row.horizon === 'long').map(row => row.ticker), ['CCC', 'AAA']);
  assert.ok(picks.every(row => row.orders === false && row.label === WATCH_LABEL));
  const held = choosePicks(rows, [{ horizon: 'medium', ticker: 'BBB' }]);
  assert.equal(held.find(row => row.horizon === 'medium').ticker, 'AAA');
});

test('medium uses the engine exit and long holds six months, with no orders', () => {
  const series = bars(80, () => 100);
  series[20].l = 90;
  const medium = markPosition({
    ticker: 'AAA', horizon: 'medium', book: 'M-BUY', signalDate: series[14].date, orders: false,
  }, series);
  assert.equal(medium.status, 'closed');
  assert.equal(medium.reason, 'stop');
  assert.equal(medium.orders, false);
  assert.equal(medium.model.notional, NOTIONAL);
  assert.ok(medium.model.pnl < 0);

  const start = Date.parse('2026-01-02T00:00:00Z');
  const longBars = [];
  for (let index = 0; index < 220; index += 1) {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    longBars.push({ date, o: 10 + index / 100, h: 14, l: 9, c: 12, v: 5e6 });
  }
  const long = markPosition({
    ticker: 'CCC', horizon: 'long', book: 'L-BUY', signalDate: longBars[0].date, orders: false,
  }, longBars);
  assert.equal(long.status, 'closed');
  assert.equal(long.reason, 'hold_6m');
  assert.equal(long.orders, false);
  assert.equal(long.entryDate, longBars[1].date);
  assert.ok(long.exitDate >= '2026-07-03');
});

test('the forward book spends nothing and writes watch cards only', async () => {
  const end = Date.parse('2026-10-30T00:00:00Z');
  let spent = 0;
  let stored = null;
  const book = await updateForwardBook({
    now: () => new Date('2026-10-30T20:15:00Z'),
    readBook: () => null,
    writeBook: value => { stored = value; },
    readAi10: async () => ({
      truncated: false,
      names: ['BBB', 'AAA'],
      scores: {
        BBB: { aiscore: 10, fundamental: 8, technical: 7, sentiment: 6, low_risk: 5, date: '2026-10-30' },
        AAA: { aiscore: 10, fundamental: 8, technical: 7, sentiment: 6, low_risk: 5, date: '2026-10-30' },
      },
    }),
    loadBars: async ticker => {
      const out = [];
      for (let index = 0; index < 260; index += 1) {
        const date = new Date(end - (259 - index) * 86400000).toISOString().slice(0, 10);
        let close = 20;
        if (ticker === 'BBB' && index === 133) close = 10;
        if (ticker === 'AAA' && index === 7) close = 10;
        out.push({ date, o: close, h: close + 1, l: close - 1, c: close, v: 5e6 });
      }
      return out;
    },
    loadCap: async () => 3e9,
    loadPiotroski: async ticker => (ticker === 'AAA' ? 8 : 4),
    spend: () => { spent += 1; },
  });
  assert.equal(spent, 0);
  assert.equal(book.orders, false);
  assert.equal(book.label, WATCH_LABEL);
  assert.ok(book.cards.every(card => card.orders === false));
  assert.equal(book.cards.find(card => card.horizon === 'medium').ticker, 'BBB');
  assert.equal(stored.cards.find(card => card.horizon === 'long').ticker, 'AAA');
});
