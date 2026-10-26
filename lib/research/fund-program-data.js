'use strict';

/**
 * Fund-style program (F12 / F13 / F14): instrument list, IBKR micro mapping,
 * Yahoo price cache and the data-gap report. Research only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..');
const PRICE_DIR = path.join(ROOT, 'data', 'research', 'fund-program-prices');
const FALLBACK_DIRS = [
  path.join(ROOT, 'data', 'research', 'strategy-amendment-prices'),
  path.join(ROOT, 'data', 'research', 'exit-amendment-prices'),
];
const HISTORY_START = '2010-01-01';

// Yahoo series → IBKR micro contract (or closest listed contract), asset class,
// contract multiplier in the quoted unit, and the roll assumption used for
// costs (rolls per year × round-trip cost).
const INSTRUMENTS = Object.freeze([
  // Equity index
  { symbol: 'ES=F', name: 'S&P 500 (E-mini series)', assetClass: 'equity', ibkr: 'MES', exchange: 'CME', multiplier: 5, currency: 'USD', rollsPerYear: 4, tom: true, tomLabel: 'S&P 500' },
  { symbol: 'NQ=F', name: 'Nasdaq 100', assetClass: 'equity', ibkr: 'MNQ', exchange: 'CME', multiplier: 2, currency: 'USD', rollsPerYear: 4 },
  { symbol: 'YM=F', name: 'Dow Jones', assetClass: 'equity', ibkr: 'MYM', exchange: 'CBOT', multiplier: 0.5, currency: 'USD', rollsPerYear: 4 },
  { symbol: 'RTY=F', name: 'Russell 2000', assetClass: 'equity', ibkr: 'M2K', exchange: 'CME', multiplier: 5, currency: 'USD', rollsPerYear: 4 },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50 (index)', assetClass: 'equity', ibkr: 'FSXE', exchange: 'EUREX', multiplier: 1, currency: 'EUR', rollsPerYear: 4, note: 'Micro-FESX; EUR 1 per point' },
  { symbol: '^GDAXI', name: 'DAX (index)', assetClass: 'equity', ibkr: 'FDXS', exchange: 'EUREX', multiplier: 1, currency: 'EUR', rollsPerYear: 4, tom: true, tomLabel: 'DAX', note: 'Micro-DAX; EUR 1 per point' },
  { symbol: '^FTSE', name: 'FTSE 100 (index)', assetClass: 'equity', ibkr: 'Z (ICE EU) — no micro; ISF.L ETF for TOM', exchange: 'ICEEU', multiplier: 10, currency: 'GBP', rollsPerYear: 4, tom: true, tomLabel: 'FTSE 100', note: 'No micro FTSE contract at IBKR; full Z is GBP 10/pt. TOM also run on ISF.L.' },
  { symbol: 'ISF.L', name: 'iShares Core FTSE 100 ETF', assetClass: 'equity', ibkr: 'ISF (LSE ETF)', exchange: 'LSE', multiplier: 1, currency: 'GBp', rollsPerYear: 0, tom: true, tomLabel: 'FTSE 100 via ISF.L', note: 'UK stamp duty does not apply to ETF purchases.' },
  { symbol: '^N225', name: 'Nikkei 225 (index)', assetClass: 'equity', ibkr: 'MNK (OSE Micro Nikkei 225)', exchange: 'OSE.JPN', multiplier: 10, currency: 'JPY', rollsPerYear: 4, tom: true, tomLabel: 'Nikkei 225', note: 'JPY 10 per point' },
  { symbol: '^HSI', name: 'Hang Seng (index)', assetClass: 'equity', ibkr: 'MHI (HKFE Mini Hang Seng)', exchange: 'HKFE', multiplier: 10, currency: 'HKD', rollsPerYear: 12, tom: true, tomLabel: 'Hang Seng', note: 'HKD 10 per point; monthly expiries' },
  { symbol: '^FCHI', name: 'CAC 40 (index)', assetClass: 'equity', ibkr: 'CAC40 (Euronext mini; no micro)', exchange: 'MONEP', multiplier: 1, currency: 'EUR', rollsPerYear: 12, tom: true, tomLabel: 'CAC 40', note: 'EUR 1 per point mini; monthly expiries' },
  // Rates
  { symbol: 'ZN=F', name: 'US 10-year T-note', assetClass: 'rates', ibkr: '10Y (CBOT Micro 10-Year Yield) — price proxy ZN', exchange: 'CBOT', multiplier: 1000, currency: 'USD', rollsPerYear: 4, note: 'Micro yield futures trade on yield, not price; sign of a price-trend signal is inverted when mapped' },
  { symbol: 'ZB=F', name: 'US 30-year T-bond', assetClass: 'rates', ibkr: '30Y (CBOT Micro 30-Year Yield) — price proxy ZB', exchange: 'CBOT', multiplier: 1000, currency: 'USD', rollsPerYear: 4, note: 'As above' },
  { symbol: 'ZF=F', name: 'US 5-year T-note', assetClass: 'rates', ibkr: '5YY (CBOT Micro 5-Year Yield) — price proxy ZF', exchange: 'CBOT', multiplier: 1000, currency: 'USD', rollsPerYear: 4, note: 'As above' },
  // FX
  { symbol: '6E=F', name: 'Euro FX', assetClass: 'fx', ibkr: 'M6E', exchange: 'CME', multiplier: 12500, currency: 'USD', rollsPerYear: 4 },
  { symbol: '6J=F', name: 'Japanese yen', assetClass: 'fx', ibkr: 'M6J', exchange: 'CME', multiplier: 1250000, currency: 'USD', rollsPerYear: 4 },
  { symbol: '6B=F', name: 'British pound', assetClass: 'fx', ibkr: 'M6B', exchange: 'CME', multiplier: 6250, currency: 'USD', rollsPerYear: 4 },
  { symbol: '6A=F', name: 'Australian dollar', assetClass: 'fx', ibkr: 'M6A', exchange: 'CME', multiplier: 10000, currency: 'USD', rollsPerYear: 4 },
  { symbol: '6C=F', name: 'Canadian dollar', assetClass: 'fx', ibkr: 'MCD', exchange: 'CME', multiplier: 10000, currency: 'USD', rollsPerYear: 4, note: 'E-micro CAD/USD (MCD)' },
  // Commodities (the seven micros already mapped in lib/research/exit-amendment.js)
  { symbol: 'GC=F', name: 'Gold', assetClass: 'commodity', ibkr: 'MGC', exchange: 'COMEX', multiplier: 10, currency: 'USD', rollsPerYear: 6 },
  { symbol: 'SI=F', name: 'Silver', assetClass: 'commodity', ibkr: 'SIL', exchange: 'COMEX', multiplier: 1000, currency: 'USD', rollsPerYear: 5 },
  { symbol: 'CL=F', name: 'WTI crude', assetClass: 'commodity', ibkr: 'MCL', exchange: 'NYMEX', multiplier: 100, currency: 'USD', rollsPerYear: 12 },
  { symbol: 'HG=F', name: 'Copper', assetClass: 'commodity', ibkr: 'MHG', exchange: 'COMEX', multiplier: 2500, currency: 'USD', rollsPerYear: 5 },
  { symbol: 'PL=F', name: 'Platinum', assetClass: 'commodity', ibkr: 'PLM', exchange: 'NYMEX', multiplier: 10, currency: 'USD', rollsPerYear: 4 },
  { symbol: 'PA=F', name: 'Palladium', assetClass: 'commodity', ibkr: 'PAM', exchange: 'NYMEX', multiplier: 10, currency: 'USD', rollsPerYear: 4 },
  { symbol: 'NG=F', name: 'Natural gas', assetClass: 'commodity', ibkr: 'MNG', exchange: 'NYMEX', multiplier: 1000, currency: 'USD', rollsPerYear: 12 },
  // Crypto (CME micro proxies)
  { symbol: 'BTC-USD', name: 'Bitcoin', assetClass: 'crypto', ibkr: 'MBT', exchange: 'CME', multiplier: 0.1, currency: 'USD', rollsPerYear: 12, note: 'Spot series as proxy; MBT is 0.1 BTC' },
  { symbol: 'ETH-USD', name: 'Ether', assetClass: 'crypto', ibkr: 'MET', exchange: 'CME', multiplier: 0.1, currency: 'USD', rollsPerYear: 12, note: 'Spot series as proxy; MET is 0.1 ETH' },
  // Benchmarks for F13 (not traded)
  { symbol: 'SPY', name: 'SPY (benchmark)', assetClass: 'benchmark', ibkr: '—', exchange: '—', multiplier: 1, currency: 'USD', rollsPerYear: 0 },
  { symbol: 'AGG', name: 'AGG (60/40 bond leg)', assetClass: 'benchmark', ibkr: '—', exchange: '—', multiplier: 1, currency: 'USD', rollsPerYear: 0 },
]);

// Micro futures round trip, in percent of notional (commission + half spread
// + slippage both ways). Used for F12 and F13.
const MICRO_ROUND_TRIP_PCT = Object.freeze({
  equity: 0.04, rates: 0.03, fx: 0.03, commodity: 0.08, crypto: 0.25, benchmark: 0,
});

function fileFor(symbol) {
  return path.join(PRICE_DIR, `${String(symbol).replace(/^\^/, '_').replace(/[\\/]/g, '_')}.json`);
}
function dateOf(bar) {
  const value = Number(bar?.t ?? bar);
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
}
function pack(raw) {
  const bars = Array.isArray(raw) ? raw : (raw?.bars || []);
  const dates = []; const open = []; const high = []; const low = []; const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || !(Number(bar.c) > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) > 0 ? Number(bar.o) : Number(bar.c));
    high.push(Number(bar.h) > 0 ? Number(bar.h) : Number(bar.c));
    low.push(Number(bar.l) > 0 ? Number(bar.l) : Number(bar.c));
    close.push(Number(bar.c));
  }
  return { dates, open, high, low, close };
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function yahoo(symbol) {
  const period1 = Math.floor(Date.parse('2005-01-01') / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const response = await httpGet(url).catch(() => null);
  if (!response || response.status !== 200) return null;
  const result = JSON.parse(response.raw)?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const stamps = result?.timestamp || [];
  if (!quote || !stamps.length) return null;
  const bars = [];
  for (let index = 0; index < stamps.length; index += 1) {
    const close = Number(quote.close?.[index]);
    if (!(close > 0)) continue;
    bars.push({
      t: stamps[index],
      o: Number(quote.open?.[index]) || close,
      h: Number(quote.high?.[index]) || close,
      l: Number(quote.low?.[index]) || close,
      c: close,
    });
  }
  return bars;
}
/** Load from the fund-program cache; fetch from Yahoo when missing (unless offline). */
async function ensureSeries(symbol, { offline = false } = {}) {
  const file = fileFor(symbol);
  if (fs.existsSync(file)) return pack(JSON.parse(fs.readFileSync(file, 'utf8')));
  // The amendment caches hold ~10 years; use them only when they reach 2010 or
  // when we cannot fetch a longer history.
  let fallback = null;
  for (const dir of FALLBACK_DIRS) {
    const candidate = path.join(dir, path.basename(file));
    if (!fs.existsSync(candidate)) continue;
    const packed = pack(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    if (packed.dates.length && packed.dates[0] <= '2010-01-05') return packed;
    if (!fallback) fallback = packed;
  }
  if (offline) return fallback;
  const bars = await yahoo(symbol);
  if (!bars || !bars.length) return fallback;
  const packed = pack(bars);
  if (fallback && fallback.dates.length > packed.dates.length) return fallback;
  fs.mkdirSync(PRICE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ symbol, fetchedAt: new Date().toISOString(), source: 'yahoo-chart-v8', bars }));
  return packed;
}

/** Business-day gaps longer than `maxGapDays` calendar days inside 2010+. */
function gapReport(series, { maxGapDays = 7 } = {}) {
  if (!series || !series.dates.length) {
    return { first: null, last: null, bars: 0, barsSince2010: 0, coversFrom2010: false, gaps: [], missingYears: [] };
  }
  const since = series.dates.filter(date => date >= HISTORY_START);
  const gaps = [];
  for (let index = 1; index < since.length; index += 1) {
    const days = (Date.parse(since[index]) - Date.parse(since[index - 1])) / 86400000;
    if (days > maxGapDays) gaps.push({ from: since[index - 1], to: since[index], days });
  }
  const years = new Set(since.map(date => date.slice(0, 4)));
  const missingYears = [];
  for (let year = 2010; year <= new Date().getUTCFullYear(); year += 1) {
    if (!years.has(String(year))) missingYears.push(year);
  }
  return {
    first: series.dates[0],
    last: series.dates[series.dates.length - 1],
    bars: series.dates.length,
    barsSince2010: since.length,
    coversFrom2010: series.dates[0] <= '2010-01-05',
    gaps,
    missingYears,
  };
}

module.exports = {
  PRICE_DIR,
  HISTORY_START,
  INSTRUMENTS,
  MICRO_ROUND_TRIP_PCT,
  fileFor,
  pack,
  dateOf,
  ensureSeries,
  gapReport,
};
