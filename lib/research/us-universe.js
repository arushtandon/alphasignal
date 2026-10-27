'use strict';

// Research-only point-in-time US index-universe support. The live scanner
// remains the owner of current-universe construction in universe.js.

const fs = require('fs');
const path = require('path');
const { fetchUSConstituents, fmpToYahooUS, US_CORE } = require('../../universe');

const SNAPSHOT_FILE = 'us-universe.json';
const HISTORY_START = '2014-01-01'; // Covers the runner's 10-year price range plus warm-up.
const HISTORICAL_ENDPOINTS = [
  { index: 'sp500', path: '/stable/historical-sp500-constituent' },
  { index: 'nasdaq100', path: '/stable/historical-nasdaq-constituent' },
];

function dateKey(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function normalize(symbol) {
  return fmpToYahooUS(symbol);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function fetchHistoricalChanges(fetchFn, key) {
  const results = [];
  for (const spec of HISTORICAL_ENDPOINTS) {
    const url = new URL(`https://financialmodelingprep.com${spec.path}`);
    url.searchParams.set('apikey', key);
    try {
      const response = await fetchFn(url);
      const body = await response.json();
      const rows = Array.isArray(body) ? body : [];
      results.push({
        index: spec.index,
        endpoint: spec.path,
        httpStatus: response.status,
        usable: response.ok && rows.length > 0,
        rows: rows.map(row => ({
          date: dateKey(row.date || row.dateAdded),
          added: normalize(row.symbol || row.addedTicker),
          removed: normalize(row.removedTicker),
          reason: row.reason || null,
        })).filter(row => row.date && (row.added || row.removed) && row.date >= HISTORY_START),
      });
    } catch (error) {
      results.push({
        index: spec.index,
        endpoint: spec.path,
        httpStatus: null,
        usable: false,
        rows: [],
        error: String(error?.message || error),
      });
    }
  }
  return results;
}

async function createUsUniverseSnapshot({ cacheRoot, fetchFn = global.fetch, key }) {
  if (!key || typeof fetchFn !== 'function') throw new Error('FMP key and fetch are required for the US research universe.');
  const current = await fetchUSConstituents(fetchFn, key);
  const currentSource = current.length > US_CORE.length ? 'FMP_CURRENT' : 'US_CORE_FALLBACK';
  const histories = await fetchHistoricalChanges(fetchFn, key);
  const historicalAvailable = histories.every(result => result.usable);
  const changes = histories.flatMap(result => result.rows.map(row => ({ ...row, index: result.index })));
  const candidates = new Set(current.map(normalize));
  if (historicalAvailable) {
    for (const row of changes) {
      if (row.added) candidates.add(row.added);
      if (row.removed) candidates.add(row.removed);
    }
  }
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    currentMembershipSource: currentSource,
    currentSymbols: [...new Set(current.map(normalize))].sort(),
    historicalMembership: {
      available: historicalAvailable,
      historyStart: HISTORY_START,
      endpoints: histories.map(({ index, endpoint, httpStatus, usable, error, rows }) => ({
        index, endpoint, httpStatus, usable, error: error || null, rows: rows.length,
      })),
      changes,
    },
    candidateSymbols: [...candidates].sort(),
    survivorshipBias: !historicalAvailable,
  };
  writeJson(path.join(cacheRoot, SNAPSHOT_FILE), snapshot);
  return snapshot;
}

function loadUsUniverseSnapshot(cacheRoot) {
  const snapshot = readJson(path.join(cacheRoot, SNAPSHOT_FILE));
  if (!snapshot?.currentSymbols?.length) throw new Error(`Missing US research universe snapshot: ${path.join(cacheRoot, SNAPSHOT_FILE)}`);
  return snapshot;
}

function membershipAt(snapshot, date) {
  if (!snapshot?.historicalMembership?.available) return new Set(snapshot?.currentSymbols || []);
  const membership = new Set(snapshot.currentSymbols || []);
  const asOf = String(date || '').slice(0, 10);
  for (const change of snapshot.historicalMembership.changes || []) {
    // Reverse current membership through changes that happened after this
    // decision date: post-date additions were absent and removals were present.
    if (!change.date || change.date <= asOf) continue;
    if (change.added) membership.delete(change.added);
    if (change.removed) membership.add(change.removed);
  }
  return membership;
}

module.exports = {
  SNAPSHOT_FILE,
  createUsUniverseSnapshot,
  loadUsUniverseSnapshot,
  membershipAt,
};
