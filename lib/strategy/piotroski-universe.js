'use strict';

/**
 * Point-in-time Piotroski universe for INCUBATION_US_LONG_P6.
 *
 * Reads the research statement cache (data/research/fmp/US/<symbol>/
 * {income,balance,cashflow}.json) and the US universe snapshot
 * (data/research/fmp/us-universe.json). Scores become available at the
 * statement's filing/accepted date + STATEMENT_LAG_DAYS, matching the
 * rescore (scripts/run-momentum-rescore.js). If the cache is absent — it is
 * gitignored and lives only where the research scripts ran — the loader
 * reports the gap instead of substituting data.
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
function piotroskiUniverse({ asOf, minScore = 6, market = 'US', lagDays = STATEMENT_LAG_DAYS } = {}) {
  const mods = researchModules();
  if (!mods.ok) {
    return { ok: false, gap: 'research-module-missing', detail: mods.error, members: [], scored: 0, qualifying: [] };
  }
  const snapshotFile = path.join(fmpDir(), 'us-universe.json');
  const snapshot = readJson(snapshotFile);
  if (!snapshot) {
    return { ok: false, gap: 'universe-missing', detail: `${snapshotFile} not present`, members: [], scored: 0, qualifying: [] };
  }
  const statementRoot = path.join(fmpDir(), market);
  if (!fs.existsSync(statementRoot)) {
    return { ok: false, gap: 'piotroski-data-missing', detail: `${statementRoot} not present`, members: [], scored: 0, qualifying: [] };
  }
  const members = [...mods.membershipAt(snapshot, asOf)];
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
    return { ok: false, gap: 'piotroski-data-missing', detail: `no statement cache under ${statementRoot}`, members, scored, qualifying: [] };
  }
  return { ok: true, members, scored, qualifying, lagDays, minScore, snapshotGeneratedAt: snapshot.generatedAt || null };
}

module.exports = {
  STATEMENT_LAG_DAYS,
  fmpDir,
  loadScores,
  scoreBefore,
  piotroskiUniverse,
};
