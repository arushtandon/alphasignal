'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  slimBook,
  attributeMove,
  currentAttribution,
  shouldRecordSnapshot
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
