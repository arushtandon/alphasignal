'use strict';

const { accountReadingFresh } = require('../lib/strategy/setup-book-execution');
const { isUsSetupEntry } = require('../lib/schedule/entry-release');

const SUMMARY_TIMEOUT_MS = 20000;
const SUMMARY_ATTEMPTS = 2;
/** Same id the bridge's startup summary uses. Lives here so a poll cannot
 *  reference a constant that is scoped inside another function. */
const BRIDGE_SUMMARY_REQ_ID = 870001;
const BRIDGE_SUMMARY_TAGS = [
  'NetLiquidation', 'AvailableFunds', 'FullAvailableFunds', 'BuyingPower',
  'TotalCashValue', 'PreviousDayEquityWithLoanValue', 'EquityWithLoanValue',
  'GrossPositionValue', 'ExcessLiquidity', 'LookAheadAvailableFunds',
  'LookAheadExcessLiquidity', 'InitMarginReq', 'MaintMarginReq',
  'FullInitMarginReq', 'FullMaintMarginReq',
  'RealizedPnL', 'UnrealizedPnL', 'AccruedCash', 'AccruedDividend',
  'DividendReceivable', 'Cushion',
].join(',');

function waitForAccountSummary(ib, options) {
  const reqId = Number(options.reqId);
  const timeoutMs = options.timeoutMs;
  const summaryEvent = options.summaryEvent;
  const endEvent = options.endEvent;
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  return new Promise((resolve) => {
    let armed = false;
    let sawNlv = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      try { ib.off(summaryEvent, onSummary); } catch (_) {}
      try { ib.off(endEvent, onEnd); } catch (_) {}
      resolve(result);
    };
    const onSummary = (id, account, tag, value, currency) => {
      if (!armed || Number(id) !== reqId) return;
      if (options.onTag) options.onTag(tag, value, currency, account);
      if (tag === 'NetLiquidation') sawNlv = true;
    };
    const onEnd = (id) => {
      if (!armed || Number(id) !== reqId || !sawNlv) return;
      if (options.accept && !options.accept()) return;
      const summaryAt = new Date(now()).toISOString();
      try { ib.cancelAccountSummary(reqId); } catch (_) {}
      finish({ ok: true, summaryAt });
    };
    const timer = setTimer(() => {
      try { ib.cancelAccountSummary(reqId); } catch (_) {}
      finish({ ok: false });
    }, timeoutMs);
    ib.on(summaryEvent, onSummary);
    ib.on(endEvent, onEnd);
    if (options.onAttempt) options.onAttempt();
    try { ib.cancelAccountSummary(reqId); } catch (_) {}
    armed = true;
    try {
      ib.reqAccountSummary(reqId, 'All', options.tags);
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

async function refreshAccountSummaryForEntries(ib, accountSnap, options = {}) {
  const timeoutMs = options.timeoutMs == null ? SUMMARY_TIMEOUT_MS : options.timeoutMs;
  const attempts = options.attempts == null ? SUMMARY_ATTEMPTS : options.attempts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await waitForAccountSummary(ib, { ...options, timeoutMs });
    if (result.ok) {
      accountSnap.summaryAt = result.summaryAt;
      return { ok: true, summaryAt: result.summaryAt, attempt };
    }
  }
  return { ok: false, summaryAt: accountSnap.summaryAt || null };
}

/**
 * The poll path. Bridge passes the live IB event names; everything else
 * (request id, tag list, timeout, the two attempts) is fixed here and is
 * what the fake-IB test drives.
 */
function admitPolledEntries(ib, accountSnap, entries, hooks = {}) {
  return admitSetupEntries(ib, accountSnap, entries, {
    reqId: BRIDGE_SUMMARY_REQ_ID,
    tags: BRIDGE_SUMMARY_TAGS,
    summaryEvent: hooks.summaryEvent,
    endEvent: hooks.endEvent,
    accept: hooks.accept,
    onAttempt: hooks.onAttempt,
    onTag: hooks.onTag,
    alert: hooks.alert,
    now: hooks.now,
    session: hooks.session,
    timeoutMs: hooks.timeoutMs,
    attempts: hooks.attempts,
    setTimeout: hooks.setTimeout,
    clearTimeout: hooks.clearTimeout,
  });
}

async function admitSetupEntries(ib, accountSnap, entries, options = {}) {
  const batch = Array.isArray(entries) ? entries : [];
  if (!batch.length) return { proceed: [], skipped: [], alerted: false, summaryAt: accountSnap.summaryAt || null };
  const now = options.now ? options.now() : Date.now();
  const session = options.session || (batch.every(isUsSetupEntry) ? 'US' : undefined);
  const fresh = accountReadingFresh(accountSnap, now, session);
  if (fresh.fresh) {
    return {
      proceed: batch.slice(),
      skipped: [],
      alerted: false,
      summaryAt: accountSnap.summaryAt,
      reused: true,
    };
  }
  const refresh = await refreshAccountSummaryForEntries(ib, accountSnap, options);
  if (refresh.ok) {
    return { proceed: batch.slice(), skipped: [], alerted: false, summaryAt: refresh.summaryAt };
  }
  const skipped = batch.map(evt => ({
    ticker: evt && evt.ticker || '',
    setupId: evt && evt.setupId || '',
    reason: 'margin data stale',
    summaryAt: accountSnap.summaryAt || null,
  }));
  let alerted = false;
  if (options.alert) {
    await options.alert('margin data stale');
    alerted = true;
  }
  return { proceed: [], skipped, alerted, summaryAt: accountSnap.summaryAt || null };
}

module.exports = {
  SUMMARY_TIMEOUT_MS,
  SUMMARY_ATTEMPTS,
  BRIDGE_SUMMARY_REQ_ID,
  BRIDGE_SUMMARY_TAGS,
  waitForAccountSummary,
  refreshAccountSummaryForEntries,
  admitSetupEntries,
  admitPolledEntries,
};
