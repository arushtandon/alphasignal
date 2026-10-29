'use strict';

const fs = require('fs');
const path = require('path');

const FIELDS = 'aiscore,fundamental,technical,sentiment,low_risk';
const DEADLINE_MS = Date.parse('2026-11-01T00:00:00Z');
// Documented GET /sectors list (https://danelfin.com/docs/api). Ranking uses the
// same slug values in the `sector` query param — not display names or numeric ids.
// No listing call is spent to rediscover them.
const DOCUMENTED_SECTOR_SLUGS = Object.freeze([
  'communication-services',
  'consumer-discretionary',
  'consumer-staples',
  'energy',
  'financials',
  'health-care',
  'industrials',
  'information-technology',
  'materials',
  'real-estate',
  'utilities',
]);
const SECTORS = DOCUMENTED_SECTOR_SLUGS;
const STOP_REASONS = new Set(['budget', 'breaker-open', 'below-reserve', 'deadline', 'october-completion-only']);
const CAPPED_WEEK_ENDS = Object.freeze([
  '2025-01-03', '2025-01-10', '2025-01-17',
  '2025-02-14', '2025-02-21', '2025-02-28', '2025-06-13',
]);
// Danelfin returned error/empty for this week-end after retries — do not spend again.
const PERMANENTLY_MISSING_DATES = Object.freeze({
  '2025-07-11': 'danelfin error or empty AI=10 list after retries; omitted from candidate table',
});

function lastWeekday(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function monthEndDates() {
  const dates = [];
  for (let year = 2018; year <= 2024; year++) {
    const lastMonth = year === 2024 ? 8 : 11;
    for (let month = 0; month <= lastMonth; month++) dates.push(lastWeekday(year, month));
  }
  return dates;
}

function weekEndDates(count = 104, endFriday = '2026-10-23') {
  const end = new Date(`${endFriday}T00:00:00Z`);
  if (end.getUTCDay() !== 5) throw new Error(`${endFriday} is not a Friday`);
  const dates = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - i * 7);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function octoberCompletionPlan() {
  // 2025-07-11 is permanently missing; remaining sector splits are not spent in October.
  return [];
}

function researchSpendAllowed(spec, ms) {
  if (ms >= DEADLINE_MS) return true;
  // No further October research network calls (0711 permanent miss; sector split dropped).
  return false;
}

function markPermanentlyMissingDates(state, nowIso) {
  state.done = state.done || {};
  for (const [date, note] of Object.entries(PERMANENTLY_MISSING_DATES)) {
    const prior = state.done[date] || {};
    state.done[date] = {
      ...prior,
      stage: prior.stage || 'week-end',
      ok: false,
      tickers: prior.tickers || 0,
      capped: false,
      names: Array.isArray(prior.names) ? prior.names : [],
      permanentlyMissing: true,
      missingNote: note,
      at: prior.at || nowIso,
    };
  }
  if (!state.stopped || state.stopped === 'incomplete') {
    const blocking = Object.entries(state.done).filter(([, row]) =>
      row && row.ok !== true && row.permanentlyMissing !== true);
    if (!blocking.length) state.stopped = 'complete';
  }
  return state;
}

function rankingUrlPreview(params) {
  const url = new URL('https://apirest.danelfin.com/ranking');
  for (const [name, value] of Object.entries(params || {})) {
    if (value == null) continue;
    url.searchParams.set(name, String(value));
  }
  return url.toString().replace(/([?&]x-api-key=)[^&]*/i, '$1REDACTED');
}

function savedResponseFor(root, date, sector) {
  const file = sector
    ? sectorResponsePath(root, date, sector)
    : responsePath(root, date);
  const body = readJson(file);
  return {
    file: path.basename(file),
    exists: body != null,
    body,
  };
}

function buyHistoryPlan() {
  const monthEnds = monthEndDates().map(date => ({ stage: 'month-end', date, aiscore: 10 }));
  const weekEnds = weekEndDates().map(date => ({ stage: 'week-end', date, aiscore: 10 }));
  return [...monthEnds, ...weekEnds];
}

function checkpointPath(root) {
  return path.join(root, 'danelfin-history', 'checkpoint.json');
}

function readCheckpoint(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('bad checkpoint');
    parsed.done = parsed.done || {};
    return parsed;
  } catch (_) {
    return { version: 1, done: {}, stopped: null };
  }
}

function writeCheckpoint(root, state) {
  const file = checkpointPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function responsePath(root, date) {
  return path.join(root, 'danelfin-history', 'responses', `${date}-ai10.json`);
}

function sectorResponsePath(root, date, sector) {
  return path.join(root, 'danelfin-history', 'responses', `${date}-ai10-${sector}.json`);
}

function summariseBody(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const dateKeys = Object.keys(payload).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort();
  const names = [];
  for (const key of dateKeys) {
    const rows = payload[key];
    if (rows && typeof rows === 'object') names.push(...Object.keys(rows));
  }
  return { dateKeys, names, tickers: names.length, capped: names.length === 100 };
}

async function runBuyHistory(client, options = {}) {
  const root = options.root;
  const now = options.now || Date.now;
  const plan = options.plan || buyHistoryPlan();
  const state = readCheckpoint(root);
  state.startedAt = state.startedAt || new Date(now()).toISOString();
  markPermanentlyMissingDates(state, new Date(now()).toISOString());
  writeCheckpoint(root, state);
  for (const item of plan) {
    if (item.aiscore !== 10) throw new Error('buy history is AI 10 only');
    if (now() >= DEADLINE_MS) {
      state.stopped = 'deadline';
      writeCheckpoint(root, state);
      break;
    }
    if (state.done[item.date] && (state.done[item.date].ok || state.done[item.date].permanentlyMissing)) continue;
    if (PERMANENTLY_MISSING_DATES[item.date]) continue;
    const result = await client.request({
      purpose: `history-ai-10-${item.stage}`,
      endpoint: '/ranking',
      params: { date: item.date, aiscore: 10, fields: FIELDS },
      noRetry: true,
    });
    const summary = summariseBody(result.body);
    const file = responsePath(root, item.date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result.body == null ? { status: result.status, reason: result.reason } : result.body));
    const emptyOrError = result.ok !== true || summary.tickers === 0;
    const permanent = emptyOrError && PERMANENTLY_MISSING_DATES[item.date];
    state.done[item.date] = {
      stage: item.stage,
      ok: result.ok === true && summary.tickers > 0,
      status: result.status || null,
      reason: result.reason || null,
      fromCache: result.fromCache === true,
      tickers: summary.tickers,
      capped: summary.capped,
      names: summary.names,
      permanentlyMissing: permanent ? true : undefined,
      missingNote: permanent ? PERMANENTLY_MISSING_DATES[item.date] : undefined,
      at: new Date(now()).toISOString(),
    };
    state.updatedAt = state.done[item.date].at;
    writeCheckpoint(root, state);
    if (!result.ok && STOP_REASONS.has(result.reason)) {
      state.stopped = result.reason;
      writeCheckpoint(root, state);
      break;
    }
  }
  if (!state.stopped || state.stopped === 'incomplete') {
    const failed = plan.filter(item => {
      const row = state.done[item.date];
      if (!row) return true;
      if (row.ok === true || row.permanentlyMissing === true) return false;
      return true;
    });
    state.stopped = failed.length ? 'incomplete' : 'complete';
    writeCheckpoint(root, state);
  }
  return state;
}

function cappedWeekEnds(state) {
  return Object.entries(state.done || {})
    .filter(([, row]) => row && row.ok === true && row.capped === true && row.stage === 'week-end')
    .map(([date]) => date)
    .sort();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function scoresFromBody(body) {
  const fundamental = {};
  const payload = body && typeof body === 'object' ? body : {};
  for (const key of Object.keys(payload)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const rows = payload[key];
    if (!rows || typeof rows !== 'object') continue;
    for (const [ticker, row] of Object.entries(rows)) {
      const value = Number(row && row.fundamental);
      if (Number.isFinite(value)) fundamental[String(ticker).toUpperCase()] = value;
    }
  }
  return fundamental;
}

function unionFor(state, date) {
  const names = new Set();
  const bySector = (state.sectors && state.sectors[date]) || {};
  for (const sector of SECTORS) {
    const row = bySector[sector];
    for (const name of (row && row.names) || []) names.add(String(name).toUpperCase());
  }
  return names;
}

function sectorCheckFor(state, date) {
  const original = new Set(((state.done[date] && state.done[date].names) || []).map(name => String(name).toUpperCase()));
  const bySector = (state.sectors && state.sectors[date]) || {};
  const failed = [];
  const sectorCapped = [];
  for (const sector of SECTORS) {
    const row = bySector[sector];
    if (!row || row.ok !== true) failed.push(sector);
    else if (row.capped === true || row.tickers >= 100) sectorCapped.push(sector);
  }
  const union = unionFor(state, date);
  const missing = [...original].filter(name => !union.has(name)).sort();
  const complete = failed.length === 0 && sectorCapped.length === 0 && missing.length === 0;
  return {
    sectors: SECTORS.length,
    union: union.size,
    original: original.size,
    missing,
    sectorCapped,
    failed,
    reproduces: missing.length === 0 && failed.length === 0,
    allUnder100: sectorCapped.length === 0 && failed.length === 0,
    complete,
  };
}

async function runCappedSectorSplit(client, options = {}) {
  const root = options.root;
  const now = options.now || Date.now;
  const sectors = options.sectors || SECTORS;
  const state = readCheckpoint(root);
  state.sectors = state.sectors || {};
  state.sectorChecks = state.sectorChecks || {};
  const dates = options.dates || cappedWeekEnds(state);
  let halted = null;
  for (const date of dates) {
    const base = state.done[date];
    if (!base || base.ok !== true || base.capped !== true || base.stage !== 'week-end') continue;
    state.sectors[date] = state.sectors[date] || {};
    for (const sector of sectors) {
      const prior = state.sectors[date][sector];
      if (prior && prior.ok === true) continue;
      if (now() >= DEADLINE_MS) {
        halted = 'deadline';
        state.sectorStopped = halted;
        state.sectorChecks[date] = sectorCheckFor(state, date);
        writeCheckpoint(root, state);
        return state;
      }
      const result = await client.request({
        purpose: 'history-ai-10-sector',
        endpoint: '/ranking',
        params: { date, aiscore: 10, sector, fields: FIELDS },
        noRetry: true,
      });
      const summary = summariseBody(result.body);
      writeJson(sectorResponsePath(root, date, sector), result.body == null ? { status: result.status, reason: result.reason } : result.body);
      state.sectors[date][sector] = {
        ok: result.ok === true,
        status: result.status || null,
        reason: result.reason || null,
        fromCache: result.fromCache === true,
        tickers: summary.tickers,
        capped: summary.tickers >= 100,
        names: summary.names.map(name => String(name).toUpperCase()),
        at: new Date(now()).toISOString(),
      };
      state.sectorChecks[date] = sectorCheckFor(state, date);
      state.updatedAt = state.sectors[date][sector].at;
      writeCheckpoint(root, state);
      if (!result.ok && STOP_REASONS.has(result.reason)) {
        halted = result.reason;
        state.sectorStopped = halted;
        writeCheckpoint(root, state);
        return state;
      }
    }
    state.sectorChecks[date] = sectorCheckFor(state, date);
    writeCheckpoint(root, state);
  }
  if (!halted) {
    const pending = dates.filter(date => !state.sectorChecks[date] || state.sectorChecks[date].failed.length);
    state.sectorStopped = pending.length ? 'incomplete' : 'complete';
    writeCheckpoint(root, state);
  }
  return state;
}

function resolvedNames(state, date) {
  const base = state.done[date] || {};
  const check = state.sectorChecks && state.sectorChecks[date];
  if (check && check.complete) {
    return { names: [...unionFor(state, date)].sort(), source: 'sector-union', capped: false };
  }
  return {
    names: (base.names || []).map(name => String(name).toUpperCase()),
    source: base.capped ? 'capped-100' : 'full',
    capped: base.capped === true,
  };
}

function historyView(root, options = {}) {
  const state = markPermanentlyMissingDates(readCheckpoint(root), new Date().toISOString());
  if (options.persistMissing === true) writeCheckpoint(root, state);
  const done = state.done || {};
  const dates = Object.keys(done).sort();
  const failedDates = dates
    .filter(date => done[date] && done[date].ok !== true)
    .map(date => {
      const row = done[date];
      const saved = savedResponseFor(root, date);
      const params = { date, aiscore: 10, fields: FIELDS };
      return {
        date,
        stage: row.stage || null,
        ok: false,
        status: row.status == null ? null : row.status,
        reason: row.reason || null,
        tickers: row.tickers || 0,
        permanentlyMissing: row.permanentlyMissing === true,
        missingNote: row.missingNote || PERMANENTLY_MISSING_DATES[date] || null,
        url: rankingUrlPreview(params),
        savedBody: saved.body,
      };
    });
  const sectorAttempts = [];
  for (const [date, bySector] of Object.entries(state.sectors || {})) {
    for (const [sector, row] of Object.entries(bySector || {})) {
      if (!row || row.ok === true) continue;
      const params = { date, aiscore: 10, sector, fields: FIELDS };
      const saved = savedResponseFor(root, date, sector);
      sectorAttempts.push({
        date,
        sector,
        ok: false,
        status: row.status == null ? null : row.status,
        reason: row.reason || null,
        tickers: row.tickers || 0,
        url: rankingUrlPreview(params),
        savedBody: saved.body,
      });
    }
  }
  const view = {
    stopped: state.stopped || null,
    sectorStopped: state.sectorStopped || null,
    done: dates.length,
    dates,
    capped: Object.entries(done)
      .filter(([, row]) => row && row.capped)
      .map(([date, row]) => ({ date, ...row })),
    sectorChecks: state.sectorChecks || {},
    failedDates,
    sectorAttempts,
    permanentlyMissing: Object.entries(PERMANENTLY_MISSING_DATES).map(([date, note]) => ({
      date,
      note,
      row: done[date] || null,
    })),
  };
  if (options.names === true) {
    view.lists = dates.map(date => {
      const row = done[date] || {};
      const fundamental = scoresFromBody(readJson(responsePath(root, date)));
      for (const sector of SECTORS) {
        Object.assign(fundamental, scoresFromBody(readJson(sectorResponsePath(root, date, sector))));
      }
      const resolved = resolvedNames(state, date);
      return {
        date,
        stage: row.stage || null,
        ok: row.ok === true,
        tickers: row.tickers || 0,
        capped: row.capped === true,
        permanentlyMissing: row.permanentlyMissing === true,
        missingNote: row.missingNote || null,
        names: (row.names || []).map(name => String(name).toUpperCase()),
        fundamental,
        resolvedNames: resolved.names,
        resolvedSource: resolved.source,
      };
    });
  }
  if (options.responseDate) {
    view.savedResponse = {
      date: options.responseDate,
      sector: options.responseSector || null,
      ...savedResponseFor(root, options.responseDate, options.responseSector || null),
      url: rankingUrlPreview({
        date: options.responseDate,
        aiscore: 10,
        ...(options.responseSector ? { sector: options.responseSector } : {}),
        fields: FIELDS,
      }),
    };
  }
  return view;
}

module.exports = {
  FIELDS,
  DEADLINE_MS,
  SECTORS,
  DOCUMENTED_SECTOR_SLUGS,
  CAPPED_WEEK_ENDS,
  PERMANENTLY_MISSING_DATES,
  octoberCompletionPlan,
  researchSpendAllowed,
  markPermanentlyMissingDates,
  rankingUrlPreview,
  monthEndDates,
  weekEndDates,
  buyHistoryPlan,
  readCheckpoint,
  runBuyHistory,
  cappedWeekEnds,
  runCappedSectorSplit,
  historyView,
  sectorCheckFor,
};
