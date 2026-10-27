'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  BRIDGE_SUMMARY_REQ_ID,
  admitPolledEntries,
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
    clearTimeout(item) { if (item) item.cleared = true; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = timers.filter(item => !item.cleared && item.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cleared = true;
        next.fn();
      }
      now = target;
    },
  };
}

test('the bridge poll path requests account summary from the fake IB and admits on the real end event', async () => {
  const clock = manualClock();
  const requested = [];
  const listeners = {};
  const ib = {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off(name, fn) { listeners[name] = (listeners[name] || []).filter(item => item !== fn); },
    cancelAccountSummary(reqId) { requested.push(['cancel', reqId]); },
    reqAccountSummary(reqId, group, tags) {
      requested.push(['req', reqId, group, tags]);
      clock.setTimeout(() => {
        const emit = (tag, value) => {
          for (const fn of (listeners.accountSummary || []).slice()) fn(reqId, 'DU1764495', tag, value, 'USD');
        };
        emit('NetLiquidation', '457089');
        emit('GrossPositionValue', '409744');
        emit('ExcessLiquidity', '180000');
        for (const fn of (listeners.accountSummaryEnd || []).slice()) fn(reqId);
      }, 1000);
    },
  };
  const account = {
    summaryAt: new Date(clock.now() - 40 * 60 * 1000).toISOString(),
    netLiquidation: null,
  };
  const pending = admitPolledEntries(ib, account, [
    { ticker: 'ALAB', setupId: 'US_SHORT_MR', seq: 10 },
  ], {
    summaryEvent: 'accountSummary',
    endEvent: 'accountSummaryEnd',
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    timeoutMs: 20000,
    attempts: 2,
    onTag: (tag, value) => { if (tag === 'NetLiquidation') account.netLiquidation = Number(value); },
    accept: () => account.netLiquidation != null,
  });
  clock.advance(1000);
  const decision = await pending;
  const req = requested.find(row => row[0] === 'req');
  assert.equal(BRIDGE_SUMMARY_REQ_ID, 870001);
  assert.ok(req, 'fake IB received reqAccountSummary');
  assert.equal(req[1], 870001);
  assert.match(req[3], /NetLiquidation/);
  assert.match(req[3], /ExcessLiquidity/);
  assert.equal(decision.proceed.length, 1);
  assert.equal(decision.proceed[0].ticker, 'ALAB');
  assert.equal(decision.skipped.length, 0);
  const source = fs.readFileSync(path.join(__dirname, '..', 'ibkr-bridge', 'bridge.js'), 'utf8');
  assert.match(source, /admitPolledEntries\(ib, accountSnap, entries, marginSummaryHooks\(\)\)/);
  assert.doesNotMatch(source, /admitSetupEntries\(ib/);
});
