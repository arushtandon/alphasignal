'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUMMARY_TIMEOUT_MS,
  SUMMARY_ATTEMPTS,
  admitSetupEntries,
} = require('../ibkr-bridge/account-summary-refresh');

function manualClock(start = Date.parse('2026-10-12T08:00:00.000Z')) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const item = { at: now + ms, fn, cleared: false };
      timers.push(item);
      return item;
    },
    clearTimeout(item) {
      if (item) item.cleared = true;
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = timers
          .filter(item => !item.cleared && item.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cleared = true;
        next.fn();
      }
      now = target;
    },
  };
}

function fakeIb(clock, respondAfterMs) {
  const listeners = {};
  return {
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    off(name, fn) {
      listeners[name] = (listeners[name] || []).filter(item => item !== fn);
    },
    cancelAccountSummary() {},
    reqAccountSummary(reqId) {
      if (respondAfterMs == null) return;
      clock.setTimeout(() => {
        for (const fn of (listeners.accountSummary || []).slice()) {
          fn(reqId, 'DU1764495', 'NetLiquidation', '100000', 'USD');
        }
        for (const fn of (listeners.accountSummaryEnd || []).slice()) fn(reqId);
      }, respondAfterMs);
    },
  };
}

const entries = [
  { ticker: 'INTC', setupId: 'US_SHORT_MR' },
  { ticker: 'BBY', setupId: 'US_SHORT_MR' },
];

function options(clock, account) {
  return {
    reqId: 870001,
    tags: 'NetLiquidation',
    summaryEvent: 'accountSummary',
    endEvent: 'accountSummaryEnd',
    timeoutMs: SUMMARY_TIMEOUT_MS,
    attempts: SUMMARY_ATTEMPTS,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    accept: () => account.netLiquidation != null,
  };
}

test('summary timeout is 20s with one retry', () => {
  assert.equal(SUMMARY_TIMEOUT_MS, 20000);
  assert.equal(SUMMARY_ATTEMPTS, 2);
});

test('stale reading plus a summary 3s later lets the entries proceed', async () => {
  const clock = manualClock();
  const ib = fakeIb(clock, 3000);
  const account = {
    summaryAt: new Date(clock.now() - 30 * 60 * 1000).toISOString(),
    netLiquidation: 100000,
  };
  const alerts = [];
  const pending = admitSetupEntries(ib, account, entries, {
    ...options(clock, account),
    alert: async (text) => { alerts.push(text); },
  });
  clock.advance(3000);
  const decision = await pending;
  assert.equal(decision.proceed.length, 2);
  assert.deepEqual(decision.skipped, []);
  assert.equal(decision.alerted, false);
  assert.deepEqual(alerts, []);
  assert.equal(account.summaryAt, new Date(clock.now()).toISOString());
  assert.notEqual(account.summaryAt, new Date(Date.parse('2026-10-12T08:00:00.000Z') - 30 * 60 * 1000).toISOString());
});

test('a fresh reading is reused and ten entries send one summary request', async () => {
  const clock = manualClock();
  const calls = [];
  const listeners = {};
  const ib = {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off(name, fn) { listeners[name] = (listeners[name] || []).filter(item => item !== fn); },
    cancelAccountSummary() { calls.push('cancel'); },
    reqAccountSummary(reqId) {
      calls.push('req');
      clock.setTimeout(() => {
        calls.push('end');
        for (const fn of (listeners.accountSummary || []).slice()) {
          fn(reqId, 'DU1764495', 'NetLiquidation', '100000', 'USD');
        }
        for (const fn of (listeners.accountSummaryEnd || []).slice()) fn(reqId);
      }, 1000);
    },
  };
  const freshAccount = {
    summaryAt: new Date(clock.now() - 5 * 60 * 1000).toISOString(),
    netLiquidation: 100000,
  };
  const burst = Array.from({ length: 10 }, (_, index) => ({
    ticker: 'N' + index,
    setupId: 'US_SHORT_MR',
  }));
  const reused = await admitSetupEntries(ib, freshAccount, burst, options(clock, freshAccount));
  assert.equal(reused.reused, true);
  assert.equal(reused.proceed.length, 10);
  assert.deepEqual(calls, []);
  assert.equal(freshAccount.summaryAt, new Date(clock.now() - 5 * 60 * 1000).toISOString());

  const staleAccount = {
    summaryAt: new Date(clock.now() - 30 * 60 * 1000).toISOString(),
    netLiquidation: 100000,
  };
  const pending = admitSetupEntries(ib, staleAccount, burst, options(clock, staleAccount));
  clock.advance(1000);
  const decision = await pending;
  assert.equal(decision.proceed.length, 10);
  assert.equal(calls.filter(call => call === 'req').length, 1);
  const endAt = calls.indexOf('end');
  assert.ok(endAt >= 0);
  assert.ok(calls.indexOf('cancel', endAt + 1) > endAt);
});

test('no summary response skips the entries and alerts once', async () => {
  const clock = manualClock();
  const ib = fakeIb(clock, null);
  const staleAt = new Date(clock.now() - 30 * 60 * 1000).toISOString();
  const account = { summaryAt: staleAt, netLiquidation: 100000 };
  const alerts = [];
  const pending = admitSetupEntries(ib, account, entries, {
    ...options(clock, account),
    alert: async (text) => { alerts.push(text); },
  });
  clock.advance(SUMMARY_TIMEOUT_MS);
  await Promise.resolve();
  await Promise.resolve();
  clock.advance(SUMMARY_TIMEOUT_MS);
  const decision = await pending;
  assert.deepEqual(decision.proceed, []);
  assert.equal(decision.skipped.length, 2);
  assert.equal(decision.skipped[0].reason, 'margin data stale');
  assert.equal(decision.skipped[0].summaryAt, staleAt);
  assert.equal(decision.alerted, true);
  assert.deepEqual(alerts, ['margin data stale']);
  assert.equal(account.summaryAt, staleAt);
});
