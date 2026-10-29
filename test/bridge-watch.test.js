'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { watchWindow, evaluateBridgeWatch, STALE_MS, REPEAT_MS } = require('../lib/ibkr/bridge-watch');

const MIN = 60 * 1000;

test('watch is on during a cash session, the 2h before it, and the 06:00 SGT batch', () => {
  // Tuesday 2026-10-27 10:00 New York — US cash.
  const usOpen = Date.parse('2026-10-27T14:00:00Z');
  assert.equal(watchWindow(usOpen).active, true);
  assert.ok(watchWindow(usOpen).open.includes('US'));

  // 07:40 New York is inside the 2h before the 09:30 open, cash not open yet.
  const usLead = Date.parse('2026-10-27T11:40:00Z');
  assert.equal(watchWindow(usLead).active, true);
  assert.ok(watchWindow(usLead).lead.includes('US'));

  // 05:00 SGT Tuesday = 21:00Z Monday. Inside 04:00–06:00 SGT, before Japan.
  const batch = Date.parse('2026-10-26T21:00:00Z');
  assert.equal(watchWindow(batch).batch, true);
  assert.equal(watchWindow(batch).active, true);

  // Saturday 12:00 SGT. No cash session and no batch. Commodity Globex is shut.
  const saturday = Date.parse('2026-10-24T04:00:00Z');
  assert.equal(watchWindow(saturday).active, false);
});

test('30 minutes without a signal alerts, then repeats every 2 hours until it recovers', () => {
  const now = Date.parse('2026-10-27T14:00:00Z');
  const seen = new Date(now - 31 * MIN).toISOString();
  const first = evaluateBridgeWatch({ lastSeenAt: seen }, now, STALE_MS);
  assert.equal(first.offline, true);
  assert.equal(first.banner, `Bridge offline since ${seen}`);
  assert.equal(first.alert.kind, 'offline');

  const quiet = evaluateBridgeWatch({
    lastSeenAt: seen,
    offlineSince: first.offlineSince,
    lastAlertAt: first.lastAlertAt,
  }, now + 30 * MIN, STALE_MS);
  assert.equal(quiet.offline, true);
  assert.equal(quiet.alert, null);

  const again = evaluateBridgeWatch({
    lastSeenAt: seen,
    offlineSince: first.offlineSince,
    lastAlertAt: first.lastAlertAt,
  }, now + REPEAT_MS + MIN, STALE_MS);
  assert.equal(again.alert.kind, 'offline');

  const back = evaluateBridgeWatch({
    lastSeenAt: new Date(now + REPEAT_MS).toISOString(),
    offlineSince: first.offlineSince,
    lastAlertAt: again.lastAlertAt,
  }, now + REPEAT_MS + MIN, STALE_MS);
  assert.equal(back.offline, false);
  assert.equal(back.alert.kind, 'recovered');
  assert.equal(back.banner, null);
});

test('the 29 Oct outage stays inside the alert window from the Europe close through the Japan morning', () => {
  const seen = '2026-10-28T11:30:43.726Z';
  const morning = Date.parse('2026-10-29T00:00:00Z');
  const noon = Date.parse('2026-10-29T04:01:32Z');
  for (const now of [morning, noon]) {
    const view = evaluateBridgeWatch({ lastSeenAt: seen }, now, STALE_MS);
    assert.equal(view.offline, true);
    assert.equal(view.alert.kind, 'offline');
    assert.match(view.alert.text, /^BRIDGE OFFLINE since /);
  }
});

test('a skipped Telegram send does not suppress the next attempt', () => {
  const { retainAlertStamp } = require('../lib/ibkr/bridge-watch');
  const now = Date.parse('2026-10-29T04:01:32Z');
  const seen = '2026-10-28T11:30:43.726Z';
  const previous = { lastSeenAt: seen, lastAlertAt: null };
  const view = evaluateBridgeWatch(previous, now, STALE_MS);
  const kept = retainAlertStamp(previous, view, { skipped: true });
  assert.equal(kept.lastAlertAt, null);
  const again = evaluateBridgeWatch({ ...previous, ...kept }, now + 60 * 1000, STALE_MS);
  assert.equal(again.alert.kind, 'offline');
});

test('a fresh signal during the watch window is not an outage, and Saturday stays quiet', () => {
  const now = Date.parse('2026-10-27T14:00:00Z');
  const live = evaluateBridgeWatch({ lastSeenAt: new Date(now - 5 * MIN).toISOString() }, now, STALE_MS);
  assert.equal(live.offline, false);
  assert.equal(live.alert, null);

  const weekend = Date.parse('2026-10-24T04:00:00Z');
  const staleWeekend = evaluateBridgeWatch({
    lastSeenAt: new Date(weekend - 5 * 60 * MIN).toISOString(),
  }, weekend, STALE_MS);
  assert.equal(staleWeekend.offline, false);
});
