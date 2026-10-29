'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDanelfinClient, DANELFIN_HOST, MONTHLY_CAP } = require('../lib/integrations/danelfin-client');

function clock() {
  let t = Date.parse('2026-10-01T00:00:00Z');
  return {
    now: () => t,
    sleep(ms) { t += ms; return Promise.resolve(); },
  };
}

function client(dir, time, fetch, extra = {}) {
  return createDanelfinClient({
    root: dir,
    environment: extra.environment || 'research',
    apiKey: 'test-key',
    allowNetwork: true,
    now: time.now,
    sleep: time.sleep,
    fetch,
    notify: extra.notify,
    maxCalls: extra.maxCalls,
    octoberCompletion: false,
  });
}

test('no file except the client names the Danelfin host', () => {
  const skip = new Set(['node_modules', '.git', 'data', 'archive']);
  const hits = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|md|html|json|yml|ps1)$/.test(entry.name)) continue;
      if (full.endsWith(`${path.sep}danelfin-client.js`)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(DANELFIN_HOST)) hits.push(path.relative(path.join(__dirname, '..'), full));
    }
  }
  walk(path.join(__dirname, '..'));
  assert.deepEqual(hits, []);
});

test('a burst of 20 stays at or under 10 per minute and 7 seconds apart', async () => {
  const time = clock();
  const stamps = [];
  const dan = client(fs.mkdtempSync(path.join(os.tmpdir(), 'dan-')), time, async () => {
    stamps.push(time.now());
    return { status: 200, json: async () => ({ ok: true, n: stamps.length }) };
  });
  for (let index = 0; index < 20; index++) {
    const result = await dan.request({ purpose: 'burst', endpoint: '/ranking', params: { n: index } });
    assert.equal(result.ok, true);
  }
  assert.equal(stamps.length, 20);
  for (let index = 1; index < stamps.length; index++) {
    assert.ok(stamps[index] - stamps[index - 1] >= 7000);
  }
  for (const stamp of stamps) {
    const inWindow = stamps.filter(other => other <= stamp && stamp - other < 60000);
    assert.ok(inWindow.length <= 10, `window ${inWindow.length}`);
  }
});

test('an exhausted share is refused and alerts', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  const alerts = [];
  const dan = client(dir, time, async () => ({ status: 200, json: async () => ({ ok: true }) }), {
    environment: 'live-sweep',
    notify: text => alerts.push(text),
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'danelfin-budget.json'), JSON.stringify({
    months: { '2026-10': { byEnv: { 'live-sweep': 130 }, byPurpose: {} } },
  }));
  const result = await dan.request({ purpose: 'live', endpoint: '/ranking', params: { date: '2026-10-27' } });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'budget');
  assert.equal(alerts.length, 1);
  assert.equal(dan.booksPaused().danelfinPaused, true);
  assert.equal(dan.booksPaused().otherBooks, 'run');
});

test('an expired breaker starts the failure count over', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'danelfin-budget.json'), JSON.stringify({
    breakerUntil: time.now() - 1000,
    consecutiveFailures: 2,
    months: { '2026-10': { byEnv: { research: 0 }, byPurpose: {} } },
  }));
  const dan = client(dir, time, async () => ({ status: 500, json: async () => ({ error: 'down' }) }));
  const first = await dan.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2025-07-11' }, noRetry: true });
  assert.equal(first.ok, false);
  assert.equal(first.reason, undefined);
  assert.equal(dan.status().breakerOpen, false);
  await dan.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2025-07-18' }, noRetry: true });
  const blocked = await dan.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2025-07-25' }, noRetry: true });
  assert.equal(blocked.reason, 'breaker-open');
});

test('two failures open the breaker and a later call is refused', async () => {
  const time = clock();
  const dan = client(fs.mkdtempSync(path.join(os.tmpdir(), 'dan-')), time, async () => ({ status: 500, json: async () => ({ error: 'down' }) }));
  await dan.request({ purpose: 'live', endpoint: '/ranking', params: { date: '2026-10-01' } });
  await dan.request({ purpose: 'live', endpoint: '/ranking', params: { date: '2026-10-02' }, retried: true });
  const blocked = await dan.request({ purpose: 'live', endpoint: '/ranking', params: { date: '2026-10-03' } });
  assert.equal(blocked.reason, 'breaker-open');
  assert.equal(dan.booksPaused().otherBooks, 'run');
});

test('an interrupted pull resumes without repeating a stored response', async () => {
  const time = clock();
  let calls = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  const fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => ({ calls }) };
  };
  const first = client(dir, time, fetch);
  await first.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2024-01-02', aiscore_min: 9 } });
  const second = client(dir, time, fetch);
  const again = await second.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2024-01-02', aiscore_min: 9 } });
  assert.equal(again.fromCache, true);
  assert.equal(calls, 1);
});

test('the monthly cap refuses the 451st attempt', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  fs.writeFileSync(path.join(dir, 'danelfin-budget.json'), JSON.stringify({
    months: { '2026-10': { byEnv: { research: MONTHLY_CAP }, byPurpose: {} } },
  }));
  const dan = client(dir, time, async () => ({ status: 200, json: async () => ({}) }));
  const result = await dan.request({ purpose: 'history', endpoint: '/ranking', params: { date: '2026-10-27' }, useReserve: true });
  assert.equal(result.reason, 'budget');
});

test('server construction sends one counted ranking request through global fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  const seen = [];
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.DANELFIN_API_KEY;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return { status: 200, json: async () => ({ '2026-10-27': { AAPL: { aiscore: 10 } } }) };
  };
  process.env.DANELFIN_API_KEY = 'test-key';
  try {
    const client = createDanelfinClient({
      root: dir,
      environment: 'research',
      allowNetwork: true,
      maxCalls: 3,
      octoberCompletion: false,
    });
    const fields = 'aiscore,fundamental,technical,sentiment,low_risk';
    const result = await client.request({
      purpose: 'discovery-latest-ai-10',
      endpoint: '/ranking',
      params: { date: '2026-10-27', aiscore: 10, fields },
      noRetry: true,
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    const url = new URL(seen[0].url);
    assert.equal(url.hostname, DANELFIN_HOST);
    assert.equal(url.pathname, '/ranking');
    assert.equal(url.searchParams.get('date'), '2026-10-27');
    assert.equal(url.searchParams.get('aiscore'), '10');
    assert.equal(url.searchParams.get('fields'), fields);
    assert.equal(seen[0].init.headers['x-api-key'], 'test-key');
    assert.equal(client.status().used, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey == null) delete process.env.DANELFIN_API_KEY;
    else process.env.DANELFIN_API_KEY = savedKey;
  }
});

test('a ledger adjustment restores calls that never left the process', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  fs.writeFileSync(path.join(dir, 'danelfin-budget.json'), JSON.stringify({
    months: { '2026-10': { byEnv: { research: 2 }, byPurpose: {} } },
    breakerUntil: Date.parse('2026-10-02T00:00:00Z'),
    consecutiveFailures: 2,
  }));
  const dan = client(dir, time, async () => ({ status: 200, json: async () => ({}) }));
  const line = dan.recordAdjustment({
    who: 'danelfin-discover',
    why: 'fetchImpl is not a function; the two attempts never left the process',
    callsRestored: 2,
    clearBreaker: true,
  });
  assert.equal(line.callsRestored, 2);
  assert.equal(line.who, 'danelfin-discover');
  assert.equal(dan.status().used, 0);
  assert.equal(dan.status().breakerOpen, false);
  const ledger = dan.ledgerTail(5);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].purpose, 'ledger-adjustment');
  assert.equal(ledger[0].callsRestored, 2);
  assert.match(ledger[0].why, /never left the process/);
});

test('a missing fetch is refused before it is counted', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const dan = createDanelfinClient({
      root: dir,
      environment: 'research',
      apiKey: 'test-key',
      allowNetwork: true,
      octoberCompletion: false,
      now: time.now,
      sleep: time.sleep,
    });
    const result = await dan.request({ purpose: 'nofetch', endpoint: '/ranking', params: { date: '2026-10-27' } });
    assert.equal(result.reason, 'no-fetch');
    assert.equal(dan.status().used, 0);
    assert.equal(dan.status().breakerOpen, false);
  } finally {
    globalThis.fetch = saved;
  }
});

test('October research refuses every call except the completion list and does not count it', async () => {
  const time = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dan-'));
  let calls = 0;
  const dan = createDanelfinClient({
    root: dir,
    environment: 'research',
    apiKey: 'test-key',
    allowNetwork: true,
    now: time.now,
    sleep: time.sleep,
    fetch: async () => { calls += 1; return { status: 200, json: async () => ({}) }; },
  });
  const refused = await dan.request({ purpose: 'discovery-latest-ai-10', endpoint: '/ranking', params: { date: '2026-10-27', aiscore: 10 } });
  assert.equal(refused.reason, 'october-completion-only');
  assert.equal(calls, 0);
  assert.equal(dan.status().used, 0);
  const allowed = await dan.request({
    purpose: 'history-ai-10-week-end',
    endpoint: '/ranking',
    params: { date: '2025-07-11', aiscore: 10 },
    noRetry: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls, 1);
  assert.equal(dan.status().used, 1);
});

test('cache-only mode makes no network call', async () => {
  const time = clock();
  let calls = 0;
  const dan = createDanelfinClient({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'dan-')),
    environment: 'research',
    apiKey: 'test-key',
    now: time.now,
    sleep: time.sleep,
    fetch: async () => { calls += 1; return { status: 200, json: async () => ({}) }; },
  });
  const result = await dan.request({ purpose: 'history', endpoint: '/ranking', params: { ticker: 'AAPL' } });
  assert.equal(result.reason, 'cache-only');
  assert.equal(calls, 0);
});
