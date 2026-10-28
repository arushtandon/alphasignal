'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monthEndDates, weekEndDates, buyHistoryPlan, runBuyHistory } = require('../lib/integrations/danelfin-history-pull');
const { buildWatchCards, dueForLiveRanking } = require('../lib/strategy/danelfin-signal-cards');

test('buy history is 81 month-ends then 104 Fridays, AI 10 only', () => {
  const months = monthEndDates();
  const weeks = weekEndDates();
  assert.equal(months.length, 81);
  assert.equal(months[0], '2018-01-31');
  assert.equal(months[months.length - 1], '2024-09-30');
  assert.equal(weeks.length, 104);
  assert.equal(weeks[weeks.length - 1], '2026-10-23');
  assert.equal(new Date(`${weeks[0]}T00:00:00Z`).getUTCDay(), 5);
  const plan = buyHistoryPlan();
  assert.equal(plan.length, 185);
  assert.ok(plan.every(item => item.aiscore === 10));
  assert.equal(new Set(plan.map(item => item.date)).size, 185);
});

test('history pull checkpoints each date and does not repeat a stored call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-hist-'));
  const calls = [];
  const client = {
    async request(spec) {
      calls.push(spec.params.date);
      assert.equal(spec.params.aiscore, 10);
      return { ok: true, status: 200, body: { [spec.params.date]: { AAPL: { aiscore: 10 } } } };
    },
  };
  const plan = [
    { stage: 'month-end', date: '2018-01-31', aiscore: 10 },
    { stage: 'week-end', date: '2026-10-23', aiscore: 10 },
  ];
  await runBuyHistory(client, { root, plan, now: () => Date.parse('2026-10-28T00:00:00Z') });
  assert.equal(calls.length, 2);
  await runBuyHistory(client, { root, plan, now: () => Date.parse('2026-10-28T00:00:00Z') });
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(path.join(root, 'danelfin-history', 'responses', '2018-01-31-ai10.json')));
});

test('watch cards do not create orders and report a missing price', () => {
  const view = buildWatchCards({
    names: ['AAPL', 'GONE'],
    u1: new Set(['AAPL', 'GONE']),
    u2: { AAPL: { pass: true }, GONE: { pass: false, hasPrice: false } },
    reusedTickers: [],
    rows: {
      AAPL: { hasPrice: true, ai: 10, close: 100, ma200: 90, ma200Rising: true, williams: -97, volOk: true, ret12_1: 0.2, engineMedium: 70, atr: 2, piotroski: 7 },
      GONE: { hasPrice: false },
    },
  });
  assert.equal(view.orders, false);
  assert.ok(view.cards.every(card => card.orders === false && card.ai === 10));
  assert.ok(view.cards.some(card => card.book === 'S-BUY' && card.ticker === 'AAPL'));
  assert.deepEqual(view.missingPrice, [{ ticker: 'GONE', universe: 'U1' }]);
});

test('live ranking is due only after the US cash close', () => {
  const before = dueForLiveRanking(new Date('2026-10-28T19:00:00Z'), new Set());
  const after = dueForLiveRanking(new Date('2026-10-28T20:15:00Z'), new Set());
  const stored = dueForLiveRanking(new Date('2026-10-28T20:15:00Z'), new Set(['2026-10-28']));
  assert.equal(before.due, false);
  assert.equal(after.due, true);
  assert.equal(after.date, '2026-10-28');
  assert.equal(stored.due, false);
});
