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
    environment: 'render-live',
    notify: text => alerts.push(text),
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'danelfin-budget.json'), JSON.stringify({
    months: { '2026-10': { byEnv: { 'render-live': 60 }, byPurpose: {} } },
  }));
  const result = await dan.request({ purpose: 'live', endpoint: '/ranking', params: { date: '2026-10-27' } });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'budget');
  assert.equal(alerts.length, 1);
  assert.equal(dan.booksPaused().danelfinPaused, true);
  assert.equal(dan.booksPaused().otherBooks, 'run');
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
