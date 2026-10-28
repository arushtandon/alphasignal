'use strict';

const fs = require('fs');
const path = require('path');

const FIELDS = 'aiscore,fundamental,technical,sentiment,low_risk';
const DEADLINE_MS = Date.parse('2026-11-01T00:00:00Z');

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
  for (const item of plan) {
    if (item.aiscore !== 10) throw new Error('buy history is AI 10 only');
    if (now() >= DEADLINE_MS) {
      state.stopped = 'deadline';
      writeCheckpoint(root, state);
      break;
    }
    if (state.done[item.date] && state.done[item.date].ok) continue;
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
    state.done[item.date] = {
      stage: item.stage,
      ok: result.ok === true,
      status: result.status || null,
      reason: result.reason || null,
      fromCache: result.fromCache === true,
      tickers: summary.tickers,
      capped: summary.capped,
      names: summary.names,
      at: new Date(now()).toISOString(),
    };
    state.updatedAt = state.done[item.date].at;
    writeCheckpoint(root, state);
    if (!result.ok && (result.reason === 'budget' || result.reason === 'breaker-open' || result.reason === 'below-reserve')) {
      state.stopped = result.reason;
      writeCheckpoint(root, state);
      break;
    }
  }
  if (!state.stopped) {
    const failed = plan.filter(item => !state.done[item.date] || state.done[item.date].ok !== true);
    state.stopped = failed.length ? 'incomplete' : 'complete';
    writeCheckpoint(root, state);
  }
  return state;
}

module.exports = {
  FIELDS,
  DEADLINE_MS,
  monthEndDates,
  weekEndDates,
  buyHistoryPlan,
  readCheckpoint,
  runBuyHistory,
};
