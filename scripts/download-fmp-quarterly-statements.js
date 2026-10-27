#!/usr/bin/env node
'use strict';

/**
 * Research-only FMP quarterly statement cache. It has no server or trading
 * imports, and stores resumable provider responses under data/research/fmp.
 */
const fs = require('fs');
const path = require('path');
const { assertFmpKey, ROOT } = require('./research-env');
const { buildFullUniverse } = require('../universe');
const {
  cacheFileName,
  cacheIsComplete,
  lagDistributionByMarket,
} = require('../lib/research/fmp-statement-cache');
const { createUsUniverseSnapshot } = require('../lib/research/us-universe');

const ENDPOINTS = [
  ['income', '/stable/income-statement'],
  ['balance', '/stable/balance-sheet-statement'],
  ['cashflow', '/stable/cash-flow-statement'],
];

const MARKET_NAMES = {
  US: 'US',
  NIKKEI225: 'Japan',
  HSI: 'Hong Kong',
  FTSE100: 'UK',
  DAX: 'Germany',
  CAC40: 'France',
};

function parseArgs(args) {
  const options = {
    paceMs: 750,
    limit: null,
    markets: Object.keys(MARKET_NAMES),
    currentOnly: false,
    cacheRoot: null,
  };
  for (const arg of args) {
    if (arg.startsWith('--paceMs=')) options.paceMs = Number(arg.slice('--paceMs='.length));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--cacheRoot=')) options.cacheRoot = arg.slice('--cacheRoot='.length);
    else if (arg === '--currentOnly') options.currentOnly = true;
    else if (arg.startsWith('--markets=')) {
      const requested = arg.slice('--markets='.length).split(',').map(value => value.trim().toLowerCase());
      options.markets = Object.entries(MARKET_NAMES)
        .filter(([key, name]) => requested.includes(key.toLowerCase()) || requested.includes(name.toLowerCase()))
        .map(([key]) => key);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  options.paceMs = Math.max(750, Number.isFinite(options.paceMs) ? Math.floor(options.paceMs) : 750);
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!options.markets.length) throw new Error('No supported markets selected');
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cachePath(cacheRoot, market, symbol, endpointId) {
  return path.join(cacheRoot, market, cacheFileName(symbol), `${endpointId}.json`);
}

function errorText(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body.error || body.message || body['Error Message'] || null;
  }
  return null;
}

async function downloadOne({ cacheRoot, market, symbol, endpointId, endpoint, key, paceMs }) {
  const file = cachePath(cacheRoot, market, symbol, endpointId);
  const existing = readJson(file);
  if (cacheIsComplete(existing)) return { state: 'cached', record: existing };

  // Do not print this URL: it contains the credential.
  const url = new URL(`https://financialmodelingprep.com${endpoint}`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('period', 'quarter');
  url.searchParams.set('limit', '400');
  url.searchParams.set('apikey', key);
  let record;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const providerError = errorText(body);
    record = {
      schemaVersion: 1,
      market,
      symbol,
      endpoint: endpointId,
      fetchedAt: new Date().toISOString(),
      httpStatus: response.status,
      status: response.ok && !providerError ? (rows.length ? 'OK' : 'NO_DATA') : 'ERROR',
      rows: response.ok && !providerError ? rows : [],
      error: response.ok && !providerError ? null : (providerError || `HTTP ${response.status}`),
    };
  } catch (error) {
    record = {
      schemaVersion: 1, market, symbol, endpoint: endpointId,
      fetchedAt: new Date().toISOString(), httpStatus: null, status: 'ERROR', rows: [],
      error: String(error.message || error),
    };
  }
  writeJson(file, record);
  await wait(paceMs);
  return { state: record.status === 'ERROR' ? 'error' : 'downloaded', record };
}

function buildManifest(records, options) {
  const noData = records.filter(record => record.status === 'NO_DATA')
    .map(record => ({ market: record.market, symbol: record.symbol, endpoint: record.endpoint }));
  const errors = records.filter(record => record.status === 'ERROR')
    .map(record => ({ market: record.market, symbol: record.symbol, endpoint: record.endpoint, httpStatus: record.httpStatus, error: record.error }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    paceMs: options.paceMs,
    markets: options.markets.map(market => MARKET_NAMES[market]),
    records: records.length,
    complete: records.filter(record => cacheIsComplete(record)).length,
    noData,
    errors,
    lagDistribution: lagDistributionByMarket(records),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertFmpKey(); // Logs presence only, never the credential.
  const key = String(process.env.FMP_API_KEY || process.env.FMP_KEY || '').trim();
  const cacheRoot = options.cacheRoot
    || process.env.FMP_RESEARCH_DIR
    || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'research', 'fmp');
  // Match the live FMP-backed US constituent source and retain point-in-time
  // membership changes for research. Other markets remain bundled universe lists.
  const usSnapshot = options.markets.includes('US')
    ? await createUsUniverseSnapshot({ cacheRoot, key })
    : null;
  const bundled = await buildFullUniverse();
  const universe = [
    ...(usSnapshot
      ? (options.currentOnly ? usSnapshot.currentSymbols : usSnapshot.candidateSymbols).map(t => ({ t, market: 'US' }))
      : []),
    ...bundled.filter(item => item.market !== 'US' && options.markets.includes(item.market)),
  ].map(item => ({ ...item, market: MARKET_NAMES[item.market] }));
  if (usSnapshot) {
    console.log(
      `US research universe: current=${usSnapshot.currentSymbols.length}; `
      + `candidates=${usSnapshot.candidateSymbols.length}; `
      + `historical=${usSnapshot.historicalMembership.available ? 'PIT' : 'SURVIVORSHIP_BIAS'}.`
    );
  }
  const selected = options.limit == null ? universe : universe.slice(0, options.limit);
  const records = [];
  let cached = 0;
  let downloaded = 0;
  console.log(`Research cache: ${selected.length} symbols, ${ENDPOINTS.length} endpoints each, pace ${options.paceMs}ms.`);
  for (const item of selected) {
    for (const [endpointId, endpoint] of ENDPOINTS) {
      const result = await downloadOne({ cacheRoot, market: item.market, symbol: item.t, endpointId, endpoint, key, paceMs: options.paceMs });
      records.push(result.record);
      if (result.state === 'cached') cached++;
      else downloaded++;
      console.log(`${item.market} ${item.t} ${endpointId}: ${result.record.status} (${result.state})`);
    }
  }
  const manifest = buildManifest(records, options);
  writeJson(path.join(cacheRoot, 'manifest.json'), manifest);
  console.log(`Done. cached=${cached}; requested=${downloaded}; no-data=${manifest.noData.length}; errors=${manifest.errors.length}.`);
  console.log(`Manifest: ${path.join(cacheRoot, 'manifest.json')}`);
  process.exitCode = manifest.errors.length ? 1 : 0;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`FMP research downloader failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, cachePath, buildManifest };
