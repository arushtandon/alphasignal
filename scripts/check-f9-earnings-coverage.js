'use strict';

// Data check for the frozen F9 study. Does not run a backtest.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadResearchEnv } = require('./research-env');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'research', 'f9-earnings');
const PRICE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');

function everMembers(snapshot) {
  const ever = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
    if (change.date) {
      const members = membershipAt(snapshot, change.date);
      if (members) for (const symbol of members) ever.add(symbol);
    }
  }
  return [...ever].sort();
}
function fetchEarnings(symbol, key) {
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
  return new Promise(resolve => {
    const request = https.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve(null); return; }
        try {
          const rows = JSON.parse(body);
          resolve(Array.isArray(rows) ? rows : null);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
  });
}
async function mapLimit(items, limit, operation) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}
function blank(year, table) {
  if (!table[year]) table[year] = { reports: 0, eps: 0, revenue: 0, symbols: new Set() };
  return table[year];
}

async function main() {
  const state = loadResearchEnv();
  if (!state.keyPresent) {
    console.log('DATA GAP: FMP_API_KEY is absent. No backtest.');
    process.exit(2);
  }
  const snapshot = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
  const symbols = everMembers(snapshot).filter(symbol => fs.existsSync(path.join(PRICE, `${symbol}.json`)));
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`symbols ${symbols.length}`);
  const table = {};
  let missing = 0;
  let done = 0;
  await mapLimit(symbols, 6, async symbol => {
    const file = path.join(CACHE, `${symbol}.json`);
    let rows = null;
    if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      rows = await fetchEarnings(symbol, process.env.FMP_API_KEY);
      if (rows) fs.writeFileSync(file, JSON.stringify(rows));
    }
    done += 1;
    if (done % 50 === 0) console.log(`fetched ${done}/${symbols.length}`);
    if (!rows) { missing += 1; return; }
    for (const row of rows) {
      const year = String(row.date || '').slice(0, 4);
      if (!/^\d{4}$/.test(year)) continue;
      const bucket = blank(year, table);
      bucket.reports += 1;
      bucket.symbols.add(symbol);
      if (row.epsActual != null && row.epsActual !== '' && row.epsEstimated != null && row.epsEstimated !== '') bucket.eps += 1;
      if (row.revenueActual != null && row.revenueActual !== '' && row.revenueEstimated != null && row.revenueEstimated !== '') bucket.revenue += 1;
    }
  });
  console.log(`missing ${missing}`);
  console.log('year reports epsBoth revenueBoth symbols');
  for (const year of Object.keys(table).sort()) {
    const row = table[year];
    console.log(year, row.reports, row.eps, row.revenue, row.symbols.size);
  }
}

main();
