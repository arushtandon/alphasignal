#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const indexes = [
  { market: 'UK', name: 'FTSE 100', symbol: '^FTSE' },
  { market: 'Germany', name: 'DAX', symbol: '^GDAXI' },
  { market: 'France', name: 'CAC 40', symbol: '^FCHI' },
  { market: 'Hong Kong', name: 'Hang Seng', symbol: '^HSI' },
  { market: 'Japan', name: 'Nikkei 225', symbol: '^N225' },
  { market: 'India', name: 'Nifty 50', symbol: '^NSEI' },
];

async function main() {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY is required; its value is never logged.');
  const results = [];
  for (const index of indexes) {
    const url = new URL('https://financialmodelingprep.com/stable/historical-index-constituent');
    url.searchParams.set('symbol', index.symbol);
    url.searchParams.set('apikey', key);
    const response = await fetch(url);
    let body = null;
    try { body = await response.json(); } catch (_) {}
    const rows = Array.isArray(body) ? body : [];
    results.push({
      ...index,
      endpoint: '/stable/historical-index-constituent',
      httpStatus: response.status,
      rows: rows.length,
      usable: response.ok && rows.length > 0,
      conclusion: response.ok && rows.length > 0
        ? 'DATED_MEMBERSHIP_AVAILABLE'
        : 'NO_FMP_DATED_MEMBERSHIP',
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    provider: 'Financial Modeling Prep',
    secretLogged: false,
    documentedHistoricalCoverage: 'FMP documents named historical constituent endpoints for US S&P 500/Nasdaq/Dow; no documented equivalent for these six international indexes.',
    results,
    studyLabel: 'All six non-US equity markets use current index lists and are SURVIVORSHIP_BIAS.',
  };
  const output = path.join(__dirname, 'fmp-international-membership-check.json');
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), output)}; usable dated indexes=${results.filter(row => row.usable).length}.`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
