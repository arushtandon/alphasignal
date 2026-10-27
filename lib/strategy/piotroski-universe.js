'use strict';

/**
 * Point-in-time Piotroski universe for INCUBATION_US_LONG_P6.
 *
 * Members are the current S&P 500 + Nasdaq-100 list the live scan uses
 * (universe.js fetchUSConstituents). The research snapshot
 * us-universe.json is not the live membership. Scores still come from the
 * statement cache, available at filing/accepted date + STATEMENT_LAG_DAYS.
 * A missing key, a failed constituent fetch, or an empty statement cache
 * is a reported gap. The loader does not substitute a different universe.
 */

const fs = require('fs');
const path = require('path');

const STATEMENT_LAG_DAYS = 45;

// Research modules are loaded lazily so a missing module is a reported gap
// for this book, never a server boot failure.
function researchModules() {
  try {
    const { buildPitPiotroskiScores } = require('../research/pit-piotroski');
    const { membershipAt } = require('../research/us-universe');
    return { ok: true, buildPitPiotroskiScores, membershipAt };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function fmpDir() {
  if (process.env.FMP_RESEARCH_DIR) return process.env.FMP_RESEARCH_DIR;
  const base = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(base, 'research', 'fmp');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function shiftFiling(row, lagDays) {
  const filed = row?.acceptedDate || row?.filingDate;
  if (!filed || !Number.isFinite(Date.parse(filed))) return null;
  const available = new Date(Date.parse(filed) + lagDays * 86400000).toISOString().slice(0, 10);
  return { ...row, acceptedDate: available, filingDate: available };
}

function loadScores(market, symbol, lagDays = STATEMENT_LAG_DAYS) {
  const dir = path.join(fmpDir(), market, symbol);
  const read = kind => {
    const record = readJson(path.join(dir, `${kind}.json`));
    if (!record || record.status !== 'OK' || !Array.isArray(record.rows)) return [];
    return record.rows.map(row => shiftFiling(row, lagDays)).filter(Boolean);
  };
  const statements = {
    incomeStatements: read('income'),
    balanceSheets: read('balance'),
    cashFlowStatements: read('cashflow'),
    market,
  };
  if (!statements.incomeStatements.length) return null;
  const mods = researchModules();
  if (!mods.ok) return null;
  const pio = mods.buildPitPiotroskiScores(statements);
  return (pio.scores || [])
    .map(row => ({ availableOn: row.availableOn, score: row.score }))
    .sort((a, b) => String(a.availableOn).localeCompare(String(b.availableOn)));
}

async function loadScanMembers() {
  let fetchUSConstituents;
  let core;
  try {
    ({ fetchUSConstituents, US_CORE: core } = require('../../universe'));
  } catch (error) {
    return { ok: false, gap: 'scan-universe-unavailable', detail: error.message, members: [] };
  }
  const key = String(process.env.FMP_API_KEY || process.env.FMP_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '').trim();
  if (!key) {
    return {
      ok: false,
      gap: 'fmp-key-missing',
      detail: 'FMP_API_KEY is not set, so the scan constituent list cannot be loaded',
      members: [],
    };
  }
  const members = await fetchUSConstituents(fetch, key);
  const list = Array.isArray(members) ? members : [];
  const source = list.length > (core || []).length ? 'fmp-sp500-nasdaq100' : 'us-core-fallback';
  if (list.length < 50) {
    return { ok: false, gap: 'scan-universe-short', detail: `scan list returned ${list.length} names`, members: list, source };
  }
  return { ok: true, members: list, source };
}

function scoreBefore(scores, date) {
  if (!scores) return null;
  let found = null;
  for (const row of scores) {
    if (row.availableOn < date) found = row.score; else break;
  }
  return found;
}

/**
 * Members of the US universe on `asOf` whose latest point-in-time Piotroski
 * score (available strictly before `asOf`) is >= minScore.
 */
async function piotroskiUniverse({ asOf, minScore = 6, market = 'US', lagDays = STATEMENT_LAG_DAYS, members: injected, memberSource } = {}) {
  const mods = researchModules();
  if (!mods.ok) {
    return { ok: false, gap: 'research-module-missing', detail: mods.error, members: [], scored: 0, qualifying: [] };
  }
  let members = Array.isArray(injected) ? injected : null;
  let source = memberSource || (members ? 'injected' : null);
  if (!members) {
    const loaded = await loadScanMembers();
    if (!loaded.ok) {
      return { ok: false, gap: loaded.gap, detail: loaded.detail, source: loaded.source || null, members: loaded.members || [], scored: 0, qualifying: [] };
    }
    members = loaded.members;
    source = loaded.source;
  }
  const statementRoot = path.join(fmpDir(), market);
  if (!fs.existsSync(statementRoot)) {
    return {
      ok: false,
      gap: 'piotroski-data-missing',
      detail: `${members.length} names from ${source}; ${statementRoot} not present`,
      source,
      members,
      scored: 0,
      qualifying: [],
    };
  }
  const qualifying = [];
  let scored = 0;
  for (const symbol of members) {
    const scores = loadScores(market, symbol, lagDays);
    if (!scores || !scores.length) continue;
    scored += 1;
    const score = scoreBefore(scores, asOf);
    if (score != null && score >= minScore) qualifying.push({ ticker: symbol, piotroski: score });
  }
  if (!scored) {
    return {
      ok: false,
      gap: 'piotroski-data-missing',
      detail: `${members.length} names from ${source}; no statement cache under ${statementRoot}`,
      source,
      members,
      scored,
      qualifying: [],
    };
  }
  return { ok: true, source, members, scored, qualifying, lagDays, minScore };
}

module.exports = {
  STATEMENT_LAG_DAYS,
  fmpDir,
  loadScores,
  loadScanMembers,
  scoreBefore,
  piotroskiUniverse,
};
