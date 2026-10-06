'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { SETUPS } = require('./evidence-setup-book');

const RUNTIME_FILE = process.env.SETUP_BOOK_RUNTIME_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'setup-book-runtime.json');

const PUBLICATION_FIELDS = Object.freeze([
  'setupId', 'setupTestedId', 'setupTier', 'tierLabel', 'experimental',
  'expectedPf', 'backtestSampleSize', 'expectedPicksPerMonth',
  'backtestBreakevenWinRate', 'setupInputs', 'setupLevels', 'setupExits',
  'setupTag', 'setupPlanVersion', 'setupPublication',
]);

function emptyState() {
  return { version: 1, paused: {}, operatorResume: {}, alerts: [] };
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    return {
      version: 1,
      paused: raw.paused && typeof raw.paused === 'object' ? raw.paused : {},
      operatorResume: raw.operatorResume && typeof raw.operatorResume === 'object'
        ? raw.operatorResume : {},
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
    };
  } catch (_) {
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function operatorResumeIds() {
  return String(process.env.SETUP_BOOK_RESUME_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isSetupPaused(setupId, state = readState()) {
  if (!setupId || !SETUPS[setupId]) return false;
  if (state.operatorResume[setupId] === true) return false;
  if (operatorResumeIds().includes(setupId)) return false;
  return Boolean(state.paused[setupId]);
}

function resumeSetup(setupId) {
  const state = readState();
  delete state.paused[setupId];
  state.operatorResume[setupId] = true;
  return writeState(state);
}

function copyPublicationFields(target, source) {
  if (!target || !source) return target;
  for (const field of PUBLICATION_FIELDS) {
    if (source[field] !== undefined) target[field] = source[field];
  }
  return target;
}

function closedSetupTrades(history) {
  const settled = new Set([
    'tp1_then_sl', 'tp1_then_time', 'sl_hit', 'time_limit', 'signal_exit',
    'tp1_hit', 'tp2_hit', 'target', 'stop', 'time', 'runner_stop', 'runner_target',
    'time_after_tp1',
  ]);
  const bySetup = new Map();
  for (const trade of history || []) {
    const setupId = trade.setupId;
    if (!SETUPS[setupId]) continue;
    const hz = trade.hz || SETUPS[setupId].horizon;
    const status = String(trade[`${hz}Status`] || trade.status || '').toLowerCase();
    if (!settled.has(status)) continue;
    const ret = Number(trade[`${hz}PnlPct`] ?? trade.pnlPct);
    if (!Number.isFinite(ret)) continue;
    if (!bySetup.has(setupId)) bySetup.set(setupId, []);
    bySetup.get(setupId).push({ setupId, ret: ret / (Math.abs(ret) > 2 ? 100 : 1) });
  }
  return bySetup;
}

function metricsFor(rows) {
  const wins = rows.filter(row => row.ret > 0);
  const losses = rows.filter(row => row.ret <= 0);
  const grossWin = wins.reduce((sum, row) => sum + row.ret, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.ret, 0));
  const winRate = rows.length ? 100 * wins.length / rows.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    trades: rows.length,
    wins: wins.length,
    winRate: +winRate.toFixed(3),
    profitFactor: Number.isFinite(profitFactor) ? +profitFactor.toFixed(3) : null,
  };
}

function shouldPause(setup, metrics) {
  const minTrades = setup.experimental ? 10 : 15;
  if (metrics.trades < minTrades) return null;
  if (metrics.profitFactor != null && metrics.profitFactor < 1) {
    return `PF ${metrics.profitFactor} < 1.0 after ${metrics.trades} closed trades`;
  }
  if (metrics.winRate < Number(setup.breakevenWinRate)) {
    return `win rate ${metrics.winRate}% < backtest breakeven ${setup.breakevenWinRate}%`;
  }
  return null;
}

function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    && process.env.TELEGRAM_ALERTS !== '0';
}

function sendTelegram(text) {
  if (!telegramConfigured()) return Promise.resolve({ skipped: true });
  const body = JSON.stringify({
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function evaluateSetupBookPauses(history, options = {}) {
  const state = readState();
  const grouped = closedSetupTrades(history);
  const newlyPaused = [];
  for (const setup of Object.values(SETUPS)) {
    if (state.operatorResume[setup.id] === true) continue;
    if (operatorResumeIds().includes(setup.id)) continue;
    const rows = grouped.get(setup.id) || [];
    const metrics = metricsFor(rows);
    const reason = shouldPause(setup, metrics);
    if (!reason) continue;
    if (!state.paused[setup.id]) {
      state.paused[setup.id] = {
        at: new Date().toISOString(),
        reason,
        metrics,
      };
      newlyPaused.push({ setupId: setup.id, reason, metrics });
    }
  }
  if (newlyPaused.length) {
    state.alerts.push(...newlyPaused.map(row => ({
      at: new Date().toISOString(),
      ...row,
    })));
    writeState(state);
    if (options.notify !== false) {
      for (const row of newlyPaused) {
        sendTelegram(
          `SETUP BOOK AUTO-PAUSE ${row.setupId}\n${row.reason}\nNew recommendations paused; open exits stay live.`,
        ).catch(error => console.warn('Setup-book Telegram pause alert failed:', error.message));
      }
    }
  }
  return { state: readState(), newlyPaused };
}

function setupBookPnlViews(history) {
  const grouped = closedSetupTrades(history);
  return Object.fromEntries(Object.values(SETUPS).map(setup => {
    const rows = grouped.get(setup.id) || [];
    return [setup.id, {
      tag: `SETUP_BOOK:${setup.id}`,
      ledgerNamespace: `SETUP_BOOK:${setup.id}`,
      paused: isSetupPaused(setup.id),
      ...metricsFor(rows),
    }];
  }));
}

module.exports = {
  RUNTIME_FILE,
  PUBLICATION_FIELDS,
  isSetupPaused,
  resumeSetup,
  copyPublicationFields,
  evaluateSetupBookPauses,
  setupBookPnlViews,
  sendTelegram,
  shouldPause,
  metricsFor,
};
