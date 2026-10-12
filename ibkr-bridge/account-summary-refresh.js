'use strict';

const SUMMARY_TIMEOUT_MS = 20000;
const SUMMARY_ATTEMPTS = 2;

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
      finish({ ok: true, summaryAt: new Date(now()).toISOString() });
    };
    const timer = setTimer(() => finish({ ok: false }), timeoutMs);
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

async function admitSetupEntries(ib, accountSnap, entries, options = {}) {
  const batch = Array.isArray(entries) ? entries : [];
  if (!batch.length) return { proceed: [], skipped: [], alerted: false, summaryAt: accountSnap.summaryAt || null };
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
  waitForAccountSummary,
  refreshAccountSummaryForEntries,
  admitSetupEntries,
};
