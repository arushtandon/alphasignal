#!/usr/bin/env node
'use strict';

// Read-only verification: the key is retained in memory and never printed.
const fs = require('fs');
const path = require('path');
process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.chdir(path.join(__dirname, '..'));

const { fetchOHLCV } = require('../server');
const { scoreAtDecision } = require('../lib/research/pit-quality');
const ROOT = process.cwd();
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'ABBV'];
const envText = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const key = process.env.FMP_API_KEY || (envText.match(/^FMP_API_KEY\s*=\s*(.+)$/m)?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
function rows(symbol, endpoint) {
  const file = path.join(ROOT, 'data', 'research', 'fmp', 'US', symbol, `${endpoint}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  return record.status === 'OK' ? record.rows : [];
}
function day(bar) { return new Date((Number(bar.t) < 1e12 ? Number(bar.t) * 1000 : Number(bar.t))).toISOString().slice(0, 10); }
async function fmpAltman(symbol) {
  if (!key) return null;
  const url = `https://financialmodelingprep.com/stable/financial-scores?apikey=${encodeURIComponent(key)}&symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return null;
  const body = await response.json();
  const row = Array.isArray(body) ? body[0] : (Array.isArray(body?.data) ? body.data[0] : body);
  for (const field of ['altmanZScore', 'altmanZ', 'altman_z_score', 'altmanZscore', 'zScore', 'altmanZScoreTTM']) {
    const value = Number(row?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
(async () => {
  const comparisons = [];
  for (const symbol of SYMBOLS) {
    const bars = await fetchOHLCV(symbol, '1y', '1d');
    const latest = bars?.at(-1);
    const pit = latest && scoreAtDecision({
      incomeStatements: rows(symbol, 'income'), balanceSheets: rows(symbol, 'balance'), cashFlowStatements: rows(symbol, 'cashflow'),
    }, { market: 'US', decisionDate: day(latest), close: latest.c, listingCurrency: 'USD', fxAt: () => 1 });
    const fmp = await fmpAltman(symbol);
    comparisons.push({
      symbol, decisionDate: latest ? day(latest) : null, pitAltmanZ: pit?.altmanZ ?? null,
      pitTtm: pit?.inputs?.ttm ?? null, fmpAltmanZ: fmp,
      difference: Number.isFinite(pit?.altmanZ) && Number.isFinite(fmp) ? pit.altmanZ - fmp : null,
      pitReason: pit?.reason ?? null,
    });
  }
  const report = { generatedAt: new Date().toISOString(), mode: 'BACKTEST_ONLY', fmpKeyLogged: false, comparisons };
  fs.writeFileSync('scripts/pit-altman-fmp-comparison.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote scripts/pit-altman-fmp-comparison.json for ${comparisons.length} US names; FMP key not logged.`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
