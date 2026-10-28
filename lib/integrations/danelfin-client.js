'use strict';

const fs = require('fs');
const path = require('path');

const DANELFIN_HOST = 'apirest.danelfin.com';
const MIN_INTERVAL_MS = 7000;
const MAX_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;
const SHARES = Object.freeze({ 'render-live': 60, research: 340, reserve: 100 });
const MONTHLY_CAP = 450;
const RETRY_DELAY_MS = 10 * 60 * 1000;
const BREAKER_MS = 24 * 60 * 60 * 1000;

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

function defaultRoot() {
  return process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function environmentName() {
  if (process.env.DANELFIN_ENV) return process.env.DANELFIN_ENV;
  if (String(process.env.RENDER || '').toLowerCase() === 'true' || process.env.RENDER_EXTERNAL_URL) return 'render-live';
  return 'research';
}

function cacheKey(endpoint, params) {
  const pairs = Object.keys(params || {}).sort().map(key => `${key}=${params[key]}`);
  return `${endpoint}?${pairs.join('&')}`;
}

function createDanelfinClient(options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const fetchImpl = options.fetch || globalThis.fetch;
  const environment = options.environment || environmentName();
  const share = SHARES[environment];
  if (!(share > 0)) throw new Error(`unknown Danelfin environment ${environment}`);
  const root = options.root || defaultRoot();
  const stateFile = path.join(root, 'danelfin-budget.json');
  const cacheDir = path.join(root, 'danelfin-cache');
  const logFile = path.join(root, 'danelfin-calls.jsonl');
  const alerts = [];
  const notify = options.notify || (text => { alerts.push(text); });
  let lastCallAt = 0;
  const recent = [];

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  function writeState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  }
  function bucket(state, ms) {
    const key = monthKey(ms);
    if (!state.months) state.months = {};
    if (!state.months[key]) state.months[key] = { byEnv: {}, byPurpose: {} };
    const row = state.months[key];
    if (!row.byEnv[environment]) row.byEnv[environment] = 0;
    return row;
  }
  function usedInShare(state, ms) {
    const row = state.months && state.months[monthKey(ms)];
    return row && row.byEnv ? (row.byEnv[environment] || 0) : 0;
  }
  function totalUsed(state, ms) {
    const row = state.months && state.months[monthKey(ms)];
    if (!row || !row.byEnv) return 0;
    return Object.values(row.byEnv).reduce((sum, value) => sum + value, 0);
  }

  function logCall(entry) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date(now()).toISOString(), environment, ...entry })}\n`);
  }

  async function pace() {
    const t = now();
    while (recent.length && t - recent[0] >= MINUTE_MS) recent.shift();
    let wait = 0;
    if (lastCallAt && t - lastCallAt < MIN_INTERVAL_MS) wait = Math.max(wait, MIN_INTERVAL_MS - (t - lastCallAt));
    if (recent.length >= MAX_PER_MINUTE) wait = Math.max(wait, MINUTE_MS - (t - recent[0]));
    if (wait > 0) await sleep(wait);
    const stamp = now();
    lastCallAt = stamp;
    recent.push(stamp);
    while (recent.length && stamp - recent[0] >= MINUTE_MS) recent.shift();
  }

  function refuse(reason) {
    return { ok: false, refused: true, reason, fromCache: false };
  }

  function readCache(key) {
    const file = path.join(cacheDir, `${Buffer.from(key).toString('base64url')}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }
  function writeCache(key, body) {
    const file = path.join(cacheDir, `${Buffer.from(key).toString('base64url')}.json`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key, savedAt: new Date(now()).toISOString(), body }));
  }

  async function request(spec) {
    const endpoint = spec.endpoint || '/ranking';
    const params = spec.params || {};
    const purpose = spec.purpose || 'unspecified';
    const key = cacheKey(endpoint, params);
    const cached = readCache(key);
    if (cached) return { ok: true, fromCache: true, body: cached.body, status: 200 };
    const allowNetwork = spec.allowNetwork === true || options.allowNetwork === true;
    if (!allowNetwork) return refuse('cache-only');
    if (options.maxCalls != null && (options.callsMade || 0) >= options.maxCalls) return refuse('max-calls');
    const state = readState();
    const ms = now();
    if (state.breakerUntil && ms < state.breakerUntil) return refuse('breaker-open');
    if (state.breakerUntil && ms >= state.breakerUntil) {
      delete state.breakerUntil;
      state.consecutiveFailures = 0;
      writeState(state);
    }
    if (state.quotaRemaining != null && Number(state.quotaRemaining) < SHARES.reserve) return refuse('below-reserve');
    const shareUsed = usedInShare(state, ms);
    const cap = spec.useReserve === true ? share + SHARES.reserve : share;
    if (shareUsed >= cap || totalUsed(state, ms) >= MONTHLY_CAP) {
      notify(`DANELFIN BUDGET ${environment} exhausted (${shareUsed}/${share}). Danelfin books pause; other books continue.`);
      logCall({ purpose, endpoint, params, result: 'refused-budget' });
      return refuse('budget');
    }
    if (shareUsed + 1 >= Math.ceil(share * 0.8) && !state.alerted80?.[environment + monthKey(ms)]) {
      state.alerted80 = state.alerted80 || {};
      state.alerted80[environment + monthKey(ms)] = true;
      notify(`DANELFIN BUDGET ${environment} at 80% (${shareUsed + 1}/${share}).`);
      writeState(state);
    }
    const apiKey = options.apiKey || process.env.DANELFIN_API_KEY || '';
    if (!apiKey) return refuse('no-key');
    if (typeof fetchImpl !== 'function') return refuse('no-fetch');
    await pace();
    const url = new URL(`https://${DANELFIN_HOST}${endpoint}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    let response;
    let body = null;
    let status = 0;
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json', 'x-api-key': apiKey } });
      status = response.status;
      body = await response.json().catch(() => null);
    } catch (error) {
      status = 0;
      body = { error: error.message };
    }
    options.callsMade = (options.callsMade || 0) + 1;
    const row = bucket(readState(), now());
    row.byEnv[environment] += 1;
    row.byPurpose[purpose] = (row.byPurpose[purpose] || 0) + 1;
    const next = readState();
    const saved = bucket(next, now());
    saved.byEnv[environment] = row.byEnv[environment];
    saved.byPurpose[purpose] = row.byPurpose[purpose];
    const quota = body && (body.remaining ?? body.quota_remaining ?? body.quotaRemaining);
    if (quota != null && Number.isFinite(Number(quota))) next.quotaRemaining = Number(quota);
    const failed = !(status >= 200 && status < 300);
    if (failed) {
      next.consecutiveFailures = (next.consecutiveFailures || 0) + 1;
      if (status === 429) notify(`DANELFIN 429 on ${endpoint}. Counted. One retry in 10 minutes.`);
      if (next.consecutiveFailures >= 2) {
        next.breakerUntil = now() + BREAKER_MS;
        notify('DANELFIN breaker open for 24h after 2 consecutive failures. Danelfin books pause.');
      }
    } else {
      next.consecutiveFailures = 0;
      writeCache(key, body);
    }
    next.lastCall = { at: new Date(now()).toISOString(), purpose, endpoint, params, status };
    writeState(next);
    logCall({ purpose, endpoint, params, status, result: failed ? 'error' : 'ok' });
    if (failed && !spec.retried && !spec.noRetry && next.consecutiveFailures < 2) {
      await sleep(RETRY_DELAY_MS);
      return request({ ...spec, retried: true });
    }
    return { ok: !failed, fromCache: false, status, body, refused: false };
  }

  function status() {
    const state = readState();
    const ms = now();
    return {
      environment,
      share,
      reserve: SHARES.reserve,
      monthlyCap: MONTHLY_CAP,
      used: usedInShare(state, ms),
      totalUsed: totalUsed(state, ms),
      byPurpose: (state.months && state.months[monthKey(ms)] && state.months[monthKey(ms)].byPurpose) || {},
      quotaRemaining: state.quotaRemaining == null ? null : state.quotaRemaining,
      breakerOpen: Boolean(state.breakerUntil && now() < state.breakerUntil),
      breakerUntil: state.breakerUntil || null,
      lastCall: state.lastCall || null,
      alerts,
    };
  }

  function recordAdjustment(entry) {
    const callsRestored = Number(entry && entry.callsRestored) || 0;
    const state = readState();
    const row = bucket(state, now());
    row.byEnv[environment] = Math.max(0, (row.byEnv[environment] || 0) - callsRestored);
    if (entry && entry.clearBreaker) {
      delete state.breakerUntil;
      state.consecutiveFailures = 0;
    }
    const line = {
      at: new Date(now()).toISOString(),
      who: entry && entry.who || 'unknown',
      why: entry && entry.why || '',
      callsRestored,
      clearBreaker: entry && entry.clearBreaker === true,
      environment,
    };
    state.adjustments = Array.isArray(state.adjustments) ? state.adjustments : [];
    state.adjustments.push(line);
    writeState(state);
    logCall({
      purpose: 'ledger-adjustment',
      endpoint: null,
      params: null,
      result: 'restored',
      who: line.who,
      why: line.why,
      callsRestored,
      clearBreaker: line.clearBreaker,
    });
    return line;
  }

  function ledgerTail(limit = 20) {
    try {
      return fs.readFileSync(logFile, 'utf8')
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .slice(-limit)
        .map(line => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  function booksPaused() {
    const view = status();
    const paused = view.breakerOpen || view.used >= view.share || (view.quotaRemaining != null && view.quotaRemaining < SHARES.reserve);
    return { danelfinPaused: paused, otherBooks: 'run' };
  }

  return { request, status, booksPaused, recordAdjustment, ledgerTail, alerts, SHARES, MONTHLY_CAP, DANELFIN_HOST };
}

module.exports = {
  DANELFIN_HOST,
  MIN_INTERVAL_MS,
  MAX_PER_MINUTE,
  SHARES,
  MONTHLY_CAP,
  createDanelfinClient,
  cacheKey,
  monthKey,
};
