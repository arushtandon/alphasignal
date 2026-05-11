const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ── Price headers ─────────────────────────────────────────────────────────
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com'
};

// ── Fetch price for a single symbol via Yahoo Finance ─────────────────────
// Normalize symbol for Yahoo Finance (BRK.B -> BRK-B for some endpoints)
function yfSymbol(s) {
  // Yahoo Finance uses both formats; try original first, then with hyphen
  return s;
}

async function fetchSinglePrice(symbol) {
  const base = String(symbol || '').trim();
  /** Yahoo often serves VOW3-DE vs VOW3.DE interchangeably depending on endpoint. */
  const symVariants = [...new Set([base, base.replace(/\./g, '-')])].filter(Boolean);

  for (const sym of symVariants) {
    const endpoints = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,currency,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,currency`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`
    ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.log(`${symbol} ${url.includes('v7')? 'v7' : 'v8'}: HTTP ${r.status}`); continue; }
      const data = await r.json();

      // v7 quote response
      if (data?.quoteResponse?.result?.length > 0) {
        const q = data.quoteResponse.result[0];
        if (q.regularMarketPrice) {
          return {
            price: q.regularMarketPrice,
            change: q.regularMarketChangePercent ? +q.regularMarketChangePercent.toFixed(2) : 0,
            prevClose: q.regularMarketPreviousClose,
            open: q.regularMarketOpen,
            high: q.regularMarketDayHigh,
            low: q.regularMarketDayLow,
            currency: q.currency || 'USD',
            source: 'yahoo_v7'
          };
        }
      }

      // v8 chart response  
      if (data?.chart?.result?.[0]) {
        const meta = data.chart.result[0].meta;
        if (meta?.regularMarketPrice) {
          return {
            price: meta.regularMarketPrice,
            change: meta.regularMarketPrice && meta.chartPreviousClose
              ? +((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)
              : 0,
            prevClose: meta.chartPreviousClose,
            currency: meta.currency || 'USD',
            source: 'yahoo_v8'
          };
        }
      }
    } catch(e) {
      console.log(`${symbol} fetch error: ${e.message}`);
    }
  }
    } // end symVariants loop
  return null;
}

/** Normalize one Yahoo Finance v7 quote row into fetchSinglePrice() shape */
function normalizeV7Quote(q) {
  if (!q?.symbol || q.regularMarketPrice == null) return null;
  return {
    price: q.regularMarketPrice,
    change:
      q.regularMarketChangePercent != null ? +(+q.regularMarketChangePercent).toFixed(2) : 0,
    prevClose: q.regularMarketPreviousClose,
    open: q.regularMarketOpen,
    high: q.regularMarketDayHigh,
    low: q.regularMarketDayLow,
    currency: q.currency || 'USD',
    source: 'yahoo_v7_bulk'
  };
}

/**
 * Multi-symbol Yahoo v7 quotes (comma-separated — one HTTP call per chunk).
 */
function sameYahooSymbol(requested, yahooSym) {
  const a = String(requested || '').toUpperCase();
  const b = String(yahooSym || '').toUpperCase();
  if (a === b) return true;
  if (a.includes('.')) return a.replace(/\./g, '-') === b || a === b.replace(/-/g, '.');
  return a.replace(/-/g, '.') === b;
}

async function fetchQuotesV7Bulk(symbols) {
  const map = {};
  const BATCH = 45;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const qs = batch.map((s) => encodeURIComponent(String(s))).join('%2C');
    const urls = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${qs}`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: YF_HEADERS,
          signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) continue;
        const data = await r.json();
        const arr = data?.quoteResponse?.result || [];
        for (const q of arr) {
          const row = normalizeV7Quote(q);
          if (!row || !q.symbol) continue;
          const orig = batch.find((b) => sameYahooSymbol(b, q.symbol));
          if (!orig) continue;
          map[orig] = row;
        }
        break;
      } catch (e) {
        console.log('v7 bulk err:', batch.slice(0, 5).join(','), e.message);
      }
    }
  }
  return map;
}

async function quoteSummary(symbol, modules) {
  const symVariants = [symbol];
  if (symbol.includes('.') && !String(symbol).includes('=')) {
    symVariants.push(String(symbol).replace(/\./g, '-'));
  }
  const uniq = [...new Set(symVariants)];
  const hosts = ['query2', 'query1'];
  for (const sym of uniq) {
    for (const host of hosts) {
      const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}`;
      try {
        const r = await fetch(url, {
          headers: YF_HEADERS,
          signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.quoteSummary?.result?.length) return j;
      } catch (e) {
        console.log('quoteSummary', sym, host, e.message);
      }
    }
  }
  return null;
}

// ── Prices endpoint ───────────────────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.json({});

  const results = {};

  const bulkMap = await fetchQuotesV7Bulk(symbols);
  Object.assign(results, bulkMap);

  const failed = symbols.filter(s => !results[s]);
  if (!failed.length) {
    console.log(`Prices Yahoo v7 bulk: ${Object.keys(results).length}/${symbols.length}`);
    return res.json(results);
  }

  // Fallback for anything the bulk endpoint missed — per-symbol
  const BATCH = 8;
  for (let i = 0; i < failed.length; i += BATCH) {
    const batch = failed.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(s => fetchSinglePrice(s)));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        results[batch[idx]] = r.value;
      }
    });
  }

  // For any symbols that failed, try getting latest close from chart endpoint
  const stillMissing = symbols.filter((s) => !results[s]);
  if (stillMissing.length > 0) {
    console.log(`Trying chart fallback for: ${stillMissing.join(',')}`);
    const chartFallbacks = await Promise.allSettled(stillMissing.map(async sym => {
      const variants = [...new Set([sym, String(sym).replace(/\./g, '-')])].filter(Boolean);
      for (const vs of variants) {
        try {
          const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(vs)}?range=1d&interval=1m`;
          const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const json = await r.json();
          const meta = json?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            return { sym, data: {
              price: meta.regularMarketPrice,
              change: meta.regularMarketPrice && meta.chartPreviousClose
                ? +((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)
                : 0,
              prevClose: meta.chartPreviousClose,
              currency: meta.currency || 'USD',
              source: 'chart_fallback'
            }};
          }
        } catch(e) { /* try next variant */ }
      }
      return null;
    }));
    chartFallbacks.forEach(r => {
      if (r.status === 'fulfilled' && r.value) results[r.value.sym] = r.value.data;
    });
  }

  console.log(`Prices final: ${Object.keys(results).length}/${symbols.length} fetched`);
  res.json(results);
});

// ── Debug price check ─────────────────────────────────────────────────────
app.get('/api/price/:symbol', async (req, res) => {
  const result = await fetchSinglePrice(req.params.symbol);
  if (result) {
    res.json({ symbol: req.params.symbol, ...result });
  } else {
    res.status(404).json({ error: 'Price not available', symbol: req.params.symbol });
  }
});

// ── OHLCV chart data ─────────────────────────────────────────────────────
app.get('/api/chart', async (req, res) => {
  const { symbol, range = '1mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const chartVariants = [...new Set([symbol, String(symbol).replace(/\./g, '-')])].filter(Boolean);
  const urls = [];
  for (const cs of chartVariants) {
    const enc = encodeURIComponent(cs);
    urls.push(
      `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?range=${range}&interval=${interval}&includePrePost=false`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${enc}?range=${range}&interval=${interval}&includePrePost=false`
    );
  }

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta || {};
      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const adjclose = result.indicators?.adjclose?.[0]?.adjclose;

      // Return clean data
      return res.json({
        ticker: symbol,
        currency: meta.currency || 'USD',
        regularMarketPrice: meta.regularMarketPrice,
        timestamps,
        dates: timestamps.map((t) =>
          typeof t === 'number' && Number.isFinite(t)
            ? new Date(t * 1000).toISOString().slice(0, 10)
            : null
        ),
        opens:   (quote.open   || []).map(v => v != null ? +v.toFixed(4) : null),
        highs:   (quote.high   || []).map(v => v != null ? +v.toFixed(4) : null),
        lows:    (quote.low    || []).map(v => v != null ? +v.toFixed(4) : null),
        closes:  (adjclose || quote.close || []).map(v => v != null ? +v.toFixed(4) : null),
        volumes: (quote.volume || []).map(v => v || 0)
      });
    } catch(e) {
      console.error('Chart error:', e.message);
    }
  }
  res.status(500).json({ error: 'Chart data unavailable for ' + symbol });
});

// ── Quantitative Technical Indicator Engine ───────────────────────────────
// Hedge-fund grade: ATR, RSI, MACD, Bollinger, Volume, MA regime scoring

async function fetchOHLCVForAnalysis(symbol) {
  /** Match fetchOHLCV: Yahoo often keys intl listings as VOW3-DE vs VOW3.DE */
  const symVariants = [...new Set([symbol, String(symbol).replace(/\./g, '-')])].filter(Boolean);
  for (const sym of symVariants) {
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=12mo&interval=1d&includePrePost=false`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=12mo&interval=1d&includePrePost=false`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const json = await r.json();
        const result = json?.chart?.result?.[0];
        if (!result) continue;
        const q = result.indicators?.quote?.[0] || {};
        const closes = q.close || [];
        const valid = closes.map((c, i) => ({
          close: c, high: q.high?.[i], low: q.low?.[i], volume: q.volume?.[i] || 0
        })).filter(d => d.close != null && d.high != null && d.low != null);
        if (valid.length >= 20) return valid;
      } catch(e) { console.log(`OHLCV ${sym}: ${e.message}`); }
    }
  }
  return null;
}

function computeEMAArray(values, period) {
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeTechnicals(ohlcv) {
  if (!ohlcv || ohlcv.length < 20) return null;
  const closes = ohlcv.map(d => d.close);
  const highs  = ohlcv.map(d => d.high);
  const lows   = ohlcv.map(d => d.low);
  const vols   = ohlcv.map(d => d.volume || 0);
  const n = closes.length;
  const price = closes[n - 1];

  // ── ATR(14) — True Range average ──────────────────────────────────────────
  const trueRanges = [];
  for (let i = 1; i < n; i++) {
    trueRanges.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const atr14 = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length);
  const atrPct = (atr14 / price) * 100;

  // ── RSI(14) ───────────────────────────────────────────────────────────────
  const rsi14 = (() => {
    const deltas = closes.slice(-15).slice(1).map((c, i, arr) => c - (i === 0 ? closes[n - 15] : arr[i - 1]));
    const gains = deltas.map(d => Math.max(0, d));
    const losses = deltas.map(d => Math.max(0, -d));
    const avgG = gains.reduce((a, b) => a + b, 0) / gains.length;
    const avgL = losses.reduce((a, b) => a + b, 0) / losses.length;
    if (avgL === 0) return 100;
    return +(100 - 100 / (1 + avgG / avgL)).toFixed(1);
  })();

  // ── Moving Averages ───────────────────────────────────────────────────────
  const ma = (p) => n >= p ? +(closes.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(4) : null;
  const ma20  = ma(20);
  const ma50  = ma(50);
  const ma200 = ma(200);

  // ── MACD(12,26,9) ─────────────────────────────────────────────────────────
  let macdHistogram = null, macdBullish = null;
  if (n >= 35) {
    const ema12 = computeEMAArray(closes, 12);
    const ema26 = computeEMAArray(closes, 26);
    const macdArr = ema12.slice(25).map((v, i) => v - ema26[i + 25]);
    if (macdArr.length >= 9) {
      const sigArr = computeEMAArray(macdArr, 9);
      macdHistogram = +(macdArr[macdArr.length - 1] - sigArr[sigArr.length - 1]).toFixed(4);
      macdBullish = macdHistogram > 0;
    }
  }

  // ── Bollinger Bands(20,2) ─────────────────────────────────────────────────
  let bollingerPos = null;
  if (ma20 != null) {
    const sl20 = closes.slice(-20);
    const std20 = Math.sqrt(sl20.reduce((acc, c) => acc + Math.pow(c - ma20, 2), 0) / 20);
    const upper = ma20 + 2 * std20;
    const lower = ma20 - 2 * std20;
    if (upper !== lower) bollingerPos = +((price - lower) / (upper - lower)).toFixed(3);
  }

  // ── Volume ratio (today vs 20-day avg) ───────────────────────────────────
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol20 > 0 ? +(vols[n - 1] / avgVol20).toFixed(2) : 1;

  // ── Trend regime ──────────────────────────────────────────────────────────
  const aboveMa20  = ma20  != null ? price > ma20  : null;
  const aboveMa50  = ma50  != null ? price > ma50  : null;
  const aboveMa200 = ma200 != null ? price > ma200 : null;
  const goldenCross = ma50 != null && ma200 != null ? ma50 > ma200 : null;

  // ── Quantitative Signal Score (hedge-fund multi-factor) ───────────────────
  // Each gate is justified by industry-standard quant research
  let score = 10; // neutral baseline

  // Factor 1: Long-term trend (MA200) — most important regime filter
  if (aboveMa200 === true)  score += 3;
  if (aboveMa200 === false) score -= 4; // bear regime penalty is asymmetric

  // Factor 2: Medium trend (golden/death cross MA50 vs MA200)
  if (goldenCross === true)  score += 2;
  if (goldenCross === false) score -= 2;

  // Factor 3: Short-term momentum (price vs MA50, MA20)
  if (aboveMa50 === true)   score += 1;
  if (aboveMa50 === false)  score -= 1;
  if (aboveMa20 === true)   score += 1;
  if (aboveMa20 === false)  score -= 1;

  // Factor 4: RSI momentum — sweet spot 45-65 for longs
  if (rsi14 >= 45 && rsi14 <= 65) score += 2;       // ideal momentum window
  else if (rsi14 >= 35 && rsi14 < 45) score += 1;   // oversold recovery candidate
  else if (rsi14 > 70 && rsi14 <= 78) score -= 2;   // overbought warning
  else if (rsi14 > 78) score -= 4;                   // extreme overbought: high reversal risk
  else if (rsi14 < 25) score -= 1;                   // deeply oversold: potential bounce

  // Factor 5: MACD histogram (momentum direction)
  if (macdBullish === true)  score += 2;
  if (macdBullish === false) score -= 1;

  // Factor 6: Volume confirmation
  if (volRatio > 1.5)       score += 1;  // above-avg volume = conviction
  else if (volRatio < 0.7)  score -= 1;  // thin volume = weak signal

  // Factor 7: Bollinger Band position (avoid chasing extended moves)
  if (bollingerPos != null) {
    if (bollingerPos > 0.88) score -= 2; // near upper band, overextended
    if (bollingerPos < 0.15) score += 1; // near lower band, potential mean-reversion
  }

  // ── Quant recommendation derived from score ───────────────────────────────
  let quantAction, signalStrength;
  if      (score >= 18) { quantAction = 'Strong Buy';  signalStrength = 'very_strong'; }
  else if (score >= 15) { quantAction = 'Buy';          signalStrength = 'strong'; }
  else if (score >= 12) { quantAction = 'Buy';          signalStrength = 'moderate'; }
  else if (score >= 9)  { quantAction = 'Hold';         signalStrength = 'neutral'; }
  else if (score >= 6)  { quantAction = 'Sell';         signalStrength = 'bearish'; }
  else                  { quantAction = 'Strong Sell';  signalStrength = 'very_bearish'; }

  return {
    price, atr14: +atr14.toFixed(4), atrPct: +atrPct.toFixed(2),
    rsi14, ma20, ma50, ma200, macdHistogram, macdBullish,
    bollingerPos, volRatio, score, quantAction, signalStrength,
    aboveMa20, aboveMa50, aboveMa200, goldenCross
  };
}

// ── Classic TA helper functions (used by /api/technicals endpoints) ──────────
// These functions use the {t,o,h,l,c,v} OHLCV format from fetchOHLCV

async function fetchOHLCV(symbol, range = '6mo', interval = '1d') {
  const variants = [symbol, symbol.replace(/\./g, '-')].filter((v, i, a) => a.indexOf(v) === i);
  for (const sym of variants) {
    for (const host of ['query1', 'query2']) {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
      try {
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const d = await r.json();
        const res = d?.chart?.result?.[0];
        if (!res) continue;
        const ts = res.timestamp || [];
        const q = res.indicators?.quote?.[0] || {};
        const data = ts.map((t, i) => ({
          t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i]
        })).filter(x => x.c != null && x.h != null && x.l != null);
        if (data.length >= 15) return data;
      } catch(e) { console.log('fetchOHLCV', sym, e.message); }
    }
  }
  return null;
}

function calcSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(4));
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(4));
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const recent = closes.slice(-(period * 2 + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = recent[i] - recent[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
}

function calcMACDFull(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  const macdValues = [];
  for (let i = closes.length - 9; i <= closes.length - 1; i++) {
    const e12 = calcEMA(closes.slice(0, i + 1), 12);
    const e26 = calcEMA(closes.slice(0, i + 1), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signal = macdValues.length >= 9 ? calcSMA(macdValues, 9) : null;
  return {
    macd: parseFloat(macdLine.toFixed(4)),
    signal: signal ? parseFloat(signal.toFixed(4)) : null,
    histogram: signal ? parseFloat((macdLine - signal).toFixed(4)) : null,
    trend: macdLine > (signal || 0) ? 'bullish' : 'bearish'
  };
}

function calcBollingerFull(closes, period = 20) {
  const sma = calcSMA(closes, period);
  if (!sma) return null;
  const slice = closes.slice(-period);
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period);
  const upper = parseFloat((sma + 2 * std).toFixed(2));
  const lower = parseFloat((sma - 2 * std).toFixed(2));
  const last = closes[closes.length - 1];
  const pct = parseFloat(((last - lower) / (upper - lower) * 100).toFixed(1));
  return { upper, middle: parseFloat(sma.toFixed(2)), lower, pct, width: parseFloat((2 * std / sma * 100).toFixed(2)) };
}

function calcATRFull(data, period = 14) {
  if (!data || data.length < period + 1) return null;
  const recent = data.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].c;
    trs.push(Math.max(recent[i].h - recent[i].l, Math.abs(recent[i].h - prev), Math.abs(recent[i].l - prev)));
  }
  return parseFloat((trs.reduce((a, b) => a + b, 0) / period).toFixed(4));
}

function findSupportResistance(data, lookback = 60) {
  const recent = data.slice(-Math.min(lookback, data.length));
  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].h > recent[i-1].h && recent[i].h > recent[i-2].h && recent[i].h > recent[i+1].h && recent[i].h > recent[i+2].h)
      pivotHighs.push(recent[i].h);
    if (recent[i].l < recent[i-1].l && recent[i].l < recent[i-2].l && recent[i].l < recent[i+1].l && recent[i].l < recent[i+2].l)
      pivotLows.push(recent[i].l);
  }
  const last = recent[recent.length - 1].c;
  const supports    = pivotLows.filter(v => v < last * 0.995).sort((a, b) => b - a);
  const resistances = pivotHighs.filter(v => v > last * 1.005).sort((a, b) => a - b);
  return {
    support1:    supports[0]    ? parseFloat(supports[0].toFixed(2))    : null,
    support2:    supports[1]    ? parseFloat(supports[1].toFixed(2))    : null,
    resistance1: resistances[0] ? parseFloat(resistances[0].toFixed(2)) : null,
    resistance2: resistances[1] ? parseFloat(resistances[1].toFixed(2)) : null,
  };
}

function calcVolumeAnalysis(data, period = 20) {
  if (!data || data.length < period) return null;
  const recent = data.slice(-period);
  const avgVol  = recent.reduce((s, d) => s + (d.v || 0), 0) / period;
  const lastVol  = data[data.length - 1].v || 0;
  const lastClose = data[data.length - 1].c;
  const prevClose = data[data.length - 2]?.c;
  const priceUp   = prevClose && lastClose > prevClose;
  return {
    avgVolume: Math.round(avgVol),
    lastVolume: lastVol,
    relativeVolume: parseFloat((lastVol / avgVol).toFixed(2)),
    confirmation: priceUp && lastVol > avgVol * 1.2 ? 'bullish_volume'
                : !priceUp && lastVol > avgVol * 1.2 ? 'bearish_volume' : 'neutral'
  };
}

function detectCandlePattern(data) {
  if (!data || data.length < 3) return 'insufficient data';
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const body     = Math.abs(last.c - last.o);
  const range    = last.h - last.l;
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;
  if (body < range * 0.1) return range > 0.02 * last.c ? 'Doji (indecision)' : 'Small Doji';
  if (last.c > last.o && last.c > prev.c * 1.005 && body > prev.h - prev.l) return 'Bullish Engulfing';
  if (last.c < last.o && last.c < prev.c * 0.995 && body > prev.h - prev.l) return 'Bearish Engulfing';
  if (lowerWick > body * 2 && upperWick < body * 0.5) return last.c > last.o ? 'Hammer (bullish)' : 'Hanging Man';
  if (upperWick > body * 2 && lowerWick < body * 0.5) return last.c < last.o ? 'Shooting Star (bearish)' : 'Inverted Hammer';
  return last.c > last.o ? 'Bullish candle' : 'Bearish candle';
}

function calcTrend(data, period = 20) {
  if (!data || data.length < period) return 'unknown';
  const recent = data.slice(-period);
  const first = recent[0].c, last = recent[recent.length - 1].c;
  const n = recent.length;
  const meanX = (n - 1) / 2;
  const y = recent.map(d => d.c);
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  const slope = y.reduce((s, yi, i) => s + (i - meanX) * (yi - meanY), 0)
              / y.reduce((s, _, i) => s + Math.pow(i - meanX, 2), 0);
  const slopePct = slope / first * 100;
  if (slopePct > 0.3) return 'uptrend';
  if (slopePct < -0.3) return 'downtrend';
  return 'sideways';
}

// ── ADX(14): trend strength — >25 = trending, >40 = strong trend ──────────
function calcADX(data, period = 14) {
  if (!data || data.length < period * 2) return null;
  const rec = data.slice(-(period * 2 + 1));
  let plusDM = [], minusDM = [], trArr = [];
  for (let i = 1; i < rec.length; i++) {
    const prev = rec[i - 1];
    const curr = rec[i];
    const upMove   = curr.h - prev.h;
    const downMove = prev.l - curr.l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(curr.h - curr.l, Math.abs(curr.h - prev.c), Math.abs(curr.l - prev.c)));
  }
  // Wilder smoothing
  const smooth = (arr, p) => {
    let v = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [v];
    for (let i = p; i < arr.length; i++) { v = v - v / p + arr[i]; out.push(v); }
    return out;
  };
  const sTR   = smooth(trArr,   period);
  const sPDM  = smooth(plusDM,  period);
  const sMDM  = smooth(minusDM, period);
  const dxArr = sTR.map((tr, i) => {
    if (!tr) return 0;
    const pdi = 100 * sPDM[i] / tr;
    const mdi = 100 * sMDM[i] / tr;
    const sum = pdi + mdi;
    return sum ? 100 * Math.abs(pdi - mdi) / sum : 0;
  });
  const adx = parseFloat((dxArr.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(1));
  return adx;
}


// ══════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC QUANT SIGNAL ENGINE
// No AI involved — pure rule-based scoring matching published quant research.
// These same rules are used for BOTH live signals AND backtesting so the
// reported win rate is always honest.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Compute buy/sell scores deterministically from pre-computed indicators.
 * Returns { buyScore, sellScore, action, rating, conditions, winRateHint }
 * Scores 0-100. Mutual exclusivity enforced: both cannot exceed 55.
 */
function computeQuantSignal(tech, fund, hz) {
  if (!tech) return { buyScore: 30, sellScore: 30, action: 'Hold', rating: 'Hold', conditions: [], winRateHint: 40 };

  const rsi         = tech.rsi        ?? 50;
  const aboveMa20   = tech.aboveMa20  ?? false;
  const aboveMa50   = tech.aboveMa50  ?? false;
  const aboveMa200  = tech.aboveMa200 ?? false;
  const ma50        = tech.ma50       ?? null;
  const ma200       = tech.ma200      ?? null;
  const ma20        = tech.ma20       ?? null;
  const macdBullish = tech.macd?.trend === 'bullish';
  const adx         = tech.adx        ?? 15;
  const trend       = tech.trend20    ?? 'sideways';
  const weeklyTrend = tech.weeklyTrend ?? 'sideways';
  const volConf     = tech.volume?.confirmation ?? 'neutral';
  const volRatio    = tech.volume?.relativeVolume ?? 1;
  const pattern     = tech.candlePattern ?? '';
  const s1 = tech.support1 ?? null, s2 = tech.support2 ?? null;
  const r1 = tech.resistance1 ?? null, r2 = tech.resistance2 ?? null;
  const price = tech.currentPrice ?? 0;
  const bb = tech.bb ?? null;

  let buy = 0, sell = 0;
  const cond = [];

  if (hz === 'short') {
    const nearS1  = s1 && price >= s1 * 0.985 && price <= s1 * 1.020;
    const nearS2  = s2 && price >= s2 * 0.985 && price <= s2 * 1.020;
    const nearR1  = r1 && price >= r1 * 0.980 && price <= r1 * 1.015;
    const aboveR1 = r1 && price > r1 * 1.005;
    const belowS1 = s1 && price < s1 * 0.995;
    const nearMa20Buy = ma20 && price >= ma20 * 0.990 && price <= ma20 * 1.015 && aboveMa20;

    if ((nearS1 || nearS2) && rsi >= 28 && rsi <= 68) {
      buy += 45; cond.push(`At Support $${nearS1 ? s1 : s2}`);
    }
    if (!nearS1 && !nearS2 && nearMa20Buy && rsi >= 38 && rsi <= 65) {
      buy += 30; cond.push('Pullback to MA20 in uptrend');
    }
    if (aboveR1 && (volRatio >= 1.15 || volConf === 'bullish_volume')) {
      buy += 35; cond.push(`Breakout above $${r1} on ${volRatio.toFixed(1)}x volume`);
    }
    if (!nearS1 && !nearS2 && !aboveR1 && aboveMa20 && trend === 'uptrend' && rsi >= 42 && rsi <= 60 && macdBullish) {
      buy += 25; cond.push('Uptrend momentum entry');
    }
    if (macdBullish)  { buy += 14; }
    if (volConf === 'bullish_volume') { buy += 10; }
    if (pattern.includes('Bullish Engulfing')) { buy += 14; cond.push(pattern); }
    else if (pattern.includes('Hammer') || pattern.includes('Inverted Hammer')) { buy += 10; cond.push(pattern); }
    else if (pattern.includes('Bullish')) { buy += 6; }
    if (adx > 20 && trend === 'uptrend') { buy += 8; }
    if (bb && bb.pct < 25) { buy += 6; }

    if (rsi > 74) { buy = Math.min(buy, 25); cond.push(`RSI ${rsi} overbought`); }
    if (belowS1 && !nearS1)  { buy = Math.min(buy, 15); }
    if (bb && bb.pct > 88) { buy = Math.min(buy, 28); }

    if (nearR1 && rsi >= 58) {
      sell += 46; cond.push(`Rejected at Resistance $${r1}`);
    }
    if (belowS1 && (volRatio >= 1.1 || volConf === 'bearish_volume')) {
      sell += 40; cond.push(`Breakdown below $${s1}`);
    }
    if (!nearR1 && !belowS1 && !aboveMa20 && trend === 'downtrend' && rsi >= 40 && rsi <= 65 && !macdBullish) {
      sell += 28; cond.push('Downtrend continuation below MA20');
    }
    if (!macdBullish) { sell += 12; }
    if (volConf === 'bearish_volume') { sell += 10; }
    if (pattern.includes('Bearish Engulfing')) { sell += 16; cond.push(pattern); }
    else if (pattern.includes('Shooting Star') || pattern.includes('Hanging Man')) { sell += 12; cond.push(pattern); }
    else if (pattern.includes('Bearish')) { sell += 6; }
    if (rsi > 70) { sell += 18; cond.push(`RSI ${rsi} — overbought`); }
    if (adx > 20 && trend === 'downtrend') { sell += 8; }
    if (bb && bb.pct > 85) { sell += 8; }

    if (rsi < 28) { sell = Math.min(sell, 20); }

  } else if (hz === 'medium') {
    const goldenCross = ma50 && ma200 && ma50 > ma200;
    const deathCross  = ma50 && ma200 && ma50 < ma200;
    const weeklyUp    = weeklyTrend === 'uptrend';
    const weeklyDown  = weeklyTrend === 'downtrend';
    const pullbackToMa = aboveMa50 && price <= (ma50 || 0) * 1.03;

    if (aboveMa50)    { buy += 22; }
    if (goldenCross)  { buy += 22; cond.push('Golden Cross (MA50 > MA200)'); }
    if (macdBullish)  { buy += 14; }
    if (rsi >= 40 && rsi <= 65) { buy += 14; }
    if (adx > 22)     { buy += 10; cond.push(`ADX ${adx} — strong trend`); }
    if (weeklyUp)     { buy += 14; cond.push('Weekly uptrend confirms'); }
    if (pullbackToMa) { buy += 8;  cond.push('Healthy pullback to MA50'); }
    if (trend === 'uptrend') { buy += 6; }
    if (rsi > 70)     { buy = Math.round(buy * 0.65); }
    if (!aboveMa50)   { buy = Math.round(buy * 0.35); }
    if (weeklyDown)   { buy = Math.round(buy * 0.5);  }

    if (!aboveMa50)   { sell += 24; }
    if (deathCross)   { sell += 24; cond.push('Death Cross (MA50 < MA200)'); }
    if (!macdBullish) { sell += 14; }
    if (rsi > 62 && trend === 'downtrend') { sell += 14; }
    if (weeklyDown)   { sell += 14; cond.push('Weekly downtrend — bearish bias'); }
    if (adx > 22 && trend === 'downtrend') { sell += 10; }
    if (rsi < 32)     { sell = Math.round(sell * 0.5); }
    if (aboveMa50 && goldenCross) { sell = Math.round(sell * 0.4); }

  } else {
    const revGrowth  = fund?.revenueGrowth  ?? 0;
    const epsGrowth  = fund?.earningsGrowth ?? 0;
    const targetUpside = (fund?.targetMeanPrice && price)
      ? (fund.targetMeanPrice - price) / price * 100 : 0;
    const analystBull = ['strongBuy','buy'].includes(fund?.recommendationKey);
    const analystBear = ['sell','strongSell'].includes(fund?.recommendationKey);
    const forwardPE   = fund?.forwardPE  ?? 30;
    const peg         = fund?.pegRatio   ?? 2.5;

    if (aboveMa200)        { buy += 24; cond.push('Above MA200 — primary uptrend'); }
    if (epsGrowth > 12)    { buy += 20; cond.push(`EPS growth ${epsGrowth}%`); }
    else if (epsGrowth > 5){ buy += 10; }
    if (revGrowth > 10)    { buy += 16; cond.push(`Revenue growth ${revGrowth}%`); }
    else if (revGrowth > 4){ buy += 8; }
    if (analystBull)       { buy += 14; cond.push(`Analyst consensus: ${fund?.recommendationKey}`); }
    if (targetUpside > 18) { buy += 14; cond.push(`${targetUpside.toFixed(0)}% upside to analyst target`); }
    else if (targetUpside > 10) { buy += 8; }
    if (peg > 0 && peg < 1.8) { buy += 10; cond.push(`PEG ${peg} — good value`); }
    if (forwardPE > 0 && forwardPE < 20) { buy += 6; }
    if (rsi > 72)      { buy = Math.round(buy * 0.72); }
    if (!aboveMa200)   { buy = Math.round(buy * 0.42); }
    if (analystBear)   { buy = Math.round(buy * 0.55); }

    if (!aboveMa200)        { sell += 28; cond.push('Below MA200 — bear regime'); }
    if (epsGrowth < -8)     { sell += 24; cond.push(`Earnings declining ${epsGrowth}%`); }
    else if (epsGrowth < 0) { sell += 12; }
    if (revGrowth < -4)     { sell += 14; cond.push(`Revenue declining ${revGrowth}%`); }
    if (analystBear)        { sell += 14; cond.push('Analyst consensus: sell'); }
    if (targetUpside < -8)  { sell += 12; cond.push('Price above analyst target'); }
    if (peg > 4)            { sell += 10; cond.push(`PEG ${peg.toFixed(1)} — overvalued`); }
    if (rsi < 30)           { sell = Math.round(sell * 0.55); }
    if (aboveMa200 && analystBull) { sell = Math.round(sell * 0.45); }
  }

  buy  = Math.min(92, Math.max(0, Math.round(buy)));
  sell = Math.min(88, Math.max(0, Math.round(sell)));

  if (buy > 55 && sell > 55) {
    if (buy >= sell) sell = Math.min(sell, 22);
    else             buy  = Math.min(buy,  22);
  }

  let action, rating;
  if (buy > sell) {
    if      (buy >= 78) { action = 'Buy'; rating = 'Strong Buy'; }
    else if (buy >= 62) { action = 'Buy'; rating = 'Buy'; }
    else if (buy >= 45) { action = 'Hold'; rating = 'Hold'; }
    else                { action = 'Hold'; rating = 'Hold'; }
  } else {
    if      (sell >= 74) { action = 'Sell'; rating = 'Strong Sell'; }
    else if (sell >= 58) { action = 'Sell'; rating = 'Sell'; }
    else                 { action = 'Hold'; rating = 'Hold'; }
  }

  const dom = Math.max(buy, sell);
  const winRateHint = dom >= 80 ? 62 : dom >= 65 ? 55 : dom >= 50 ? 47 : 38;

  return { buyScore: buy, sellScore: sell, action, rating, conditions: cond.slice(0, 4), winRateHint };
}

/**
 * Fast walk-forward backtest — same rules as computeQuantSignal using
 * simplified per-bar indicators. Called only from /api/analyze.
 */
function backtestSignal(data, hz) {
  if (!data || data.length < 50) return null;

  const holdDays = hz === 'short' ? 3 : hz === 'medium' ? 15 : 60;
  const warmup   = hz === 'short' ? 28 : 45;

  const { support1: globalS1, resistance1: globalR1 } = findSupportResistance(data, Math.min(60, data.length - 2));

  let wins = 0, losses = 0, totalReturn = 0, trades = 0;

  for (let i = warmup; i < data.length - holdDays - 1; i++) {
    const closes = data.slice(0, i + 1).map(d => d.c);
    const price  = closes[closes.length - 1];

    const ma20  = calcSMA(closes, 20);
    const ma50  = closes.length >= 50 ? calcSMA(closes, 50) : null;
    const rsi   = calcRSI(closes, 14);
    const macd  = calcMACDFull(closes);
    const atr   = calcATRFull(data.slice(0, i + 1), 14);
    if (!atr || atr <= 0) continue;

    const aboveMa20  = ma20  ? price > ma20  : false;
    const aboveMa50  = ma50  ? price > ma50  : false;
    const macdBull   = macd?.trend === 'bullish';
    const nearS1     = globalS1 && price >= globalS1 * 0.985 && price <= globalS1 * 1.020;
    const nearR1     = globalR1 && price >= globalR1 * 0.980 && price <= globalR1 * 1.015;
    const belowS1    = globalS1 && price < globalS1 * 0.995;
    const vol20avg   = data.slice(Math.max(0, i-20), i).reduce((s, d) => s + (d.v || 0), 0) / 20;
    const volRatio   = vol20avg > 0 ? (data[i].v || 0) / vol20avg : 1;

    let isBuy = false, isSell = false;

    if (hz === 'short') {
      isBuy  = (nearS1 && rsi >= 28 && rsi <= 68 && rsi < 74) ||
                (aboveMa20 && macdBull && rsi >= 38 && rsi <= 65 && !nearR1);
      isSell = (nearR1 && rsi >= 58) ||
                (belowS1 && volRatio >= 1.1) ||
                (!aboveMa20 && !macdBull && rsi > 50);
    } else if (hz === 'medium') {
      const ma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
      const aboveMa200 = ma200 ? price > ma200 : true;
      isBuy  = aboveMa50 && macdBull && rsi >= 40 && rsi <= 68 && aboveMa200;
      isSell = !aboveMa50 && !macdBull && rsi >= 38 && rsi <= 72;
    }

    if (!isBuy && !isSell) continue;

    const entry = data[i + 1]?.o;
    if (!entry) continue;

    const tpMult = hz === 'short' ? 3.0 : 5.0;
    const slMult = hz === 'short' ? 2.0 : 3.0;
    const tpDist = atr * tpMult;
    const slDist = atr * slMult;
    const tpPrice = isBuy  ? entry + tpDist : entry - tpDist;
    const slPrice = isBuy  ? entry - slDist : entry + slDist;

    let exitPnl = null;
    for (let j = i + 1; j <= Math.min(i + holdDays, data.length - 1); j++) {
      const bar = data[j];
      if (isBuy) {
        if (bar.h >= tpPrice) { exitPnl =  tpDist / entry; break; }
        if (bar.l <= slPrice) { exitPnl = -slDist / entry; break; }
        if (j === i + holdDays) exitPnl = (bar.c - entry) / entry;
      } else {
        if (bar.l <= tpPrice) { exitPnl =  tpDist / entry; break; }
        if (bar.h >= slPrice) { exitPnl = -slDist / entry; break; }
        if (j === i + holdDays) exitPnl = (entry - bar.c) / entry;
      }
    }

    if (exitPnl !== null) {
      trades++; totalReturn += exitPnl;
      if (exitPnl > 0) wins++; else losses++;
    }
  }

  if (trades < 3) return null;
  return {
    winRate:      Math.round(wins / trades * 100),
    trades,
    avgReturnPct: parseFloat((totalReturn / trades * 100).toFixed(2))
  };
}

// ── Fetch fundamentals: P/E, EPS growth, analyst target ──────────────────
async function fetchFundamentalsYahoo(symbol) {
  try {
    const qs = await quoteSummary(symbol, 'financialData,defaultKeyStatistics,summaryDetail');
    const res = qs?.quoteSummary?.result?.[0];
    if (!res) return null;
    const fd = res.financialData || {};
    const ks = res.defaultKeyStatistics || {};
    const sd = res.summaryDetail || {};
    const num = v => { const n = v?.raw ?? v; return Number.isFinite(+n) ? +n : null; };
    const pct = v => { const n = num(v); return n != null ? +(n * 100).toFixed(1) : null; };
    const fmt = (v, dec = 2) => { const n = num(v); return n != null ? +n.toFixed(dec) : null; };
    return {
      targetMeanPrice: fmt(fd.targetMeanPrice),
      targetHighPrice: fmt(fd.targetHighPrice),
      targetLowPrice: fmt(fd.targetLowPrice),
      analystCount: num(fd.numberOfAnalystOpinions),
      recommendationMean: fmt(fd.recommendationMean, 1),
      recommendationKey: fd.recommendationKey || null,
      revenueGrowth: pct(fd.revenueGrowth),
      earningsGrowth: pct(fd.earningsGrowth),
      grossMargins: pct(fd.grossMargins),
      operatingMargins: pct(fd.operatingMargins),
      currentRatio: fmt(fd.currentRatio, 2),
      debtToEquity: fmt(fd.debtToEquity, 1),
      forwardPE: fmt(ks.forwardPE, 1),
      pegRatio: fmt(ks.pegRatio, 2),
      trailingEps: fmt(ks.trailingEps),
      forwardEps: fmt(ks.forwardEps),
      trailingPE: fmt(sd.trailingPE, 1),
      dividendYield: pct(sd.dividendYield),
      marketCap: num(sd.marketCap)
    };
  } catch (e) {
    console.warn('fetchFundamentalsYahoo', symbol, e.message);
    return null;
  }
}

/** Lightweight v7 quote — often still returns forward/trailing P/E when quoteSummary modules are empty from the server IP. */
async function fetchYahooQuotePE(symbol) {
  const variants = [...new Set([symbol, symbol.replace(/\./g, '-')])];
  const num = v => {
    const n = v?.raw ?? v;
    return Number.isFinite(+n) ? +n : null;
  };
  async function parseQuote(url) {
    const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    const q = d?.quoteResponse?.result?.[0];
    if (!q) return null;
    const fp = num(q.forwardPE);
    const tp = num(q.trailingPE);
    const peg = num(q.trailingPegRatio ?? q.pegRatio);
    if (fp != null || tp != null || peg != null) {
      return { forwardPE: fp, trailingPE: tp, pegRatio: peg, _source: 'yahoo_v7_quote' };
    }
    return null;
  }
  for (const sym of variants) {
    for (const base of ['query1', 'query2']) {
      try {
        const narrow = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=forwardPE,trailingPE,pegRatio,trailingPegRatio`;
        let hit = await parseQuote(narrow);
        if (hit) return hit;
        const wide = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;
        hit = await parseQuote(wide);
        if (hit) return hit;
      } catch (e) {
        console.warn('fetchYahooQuotePE', sym, e.message);
      }
    }
  }
  return null;
}

function fmpAnyApiKey() {
  return (
    process.env.FMP_API_KEY ||
    process.env.FMP_KEY ||
    process.env.FINANCIAL_MODELING_PREP_API_KEY ||
    ''
  ).trim();
}

function fmpEnvKeyFund() {
  return fmpAnyApiKey();
}

async function fetchFundamentalsFMP(symbol) {
  const k = fmpEnvKeyFund();
  if (!k) return null;
  const variants = [...new Set([symbol, symbol.replace(/\./g, '-')])];
  for (const raw of variants) {
    try {
      const enc = encodeURIComponent(raw);
      const kmUrl = `https://financialmodelingprep.com/api/v3/key-metrics-ttm/${enc}?apikey=${encodeURIComponent(k)}`;
      const grUrl = `https://financialmodelingprep.com/api/v3/financial-growth/${enc}?limit=1&apikey=${encodeURIComponent(k)}`;
      const prUrl = `https://financialmodelingprep.com/api/v3/profile/${enc}?apikey=${encodeURIComponent(k)}`;
      const [kmTxt, grTxt, prTxt] = await Promise.all([
        fetch(kmUrl, { signal: AbortSignal.timeout(12000) }).then(r => (r.ok ? r.text() : '')),
        fetch(grUrl, { signal: AbortSignal.timeout(12000) }).then(r => (r.ok ? r.text() : '')),
        fetch(prUrl, { signal: AbortSignal.timeout(12000) }).then(r => (r.ok ? r.text() : ''))
      ]);
      let km = null;
      try {
        const a = kmTxt ? JSON.parse(kmTxt) : [];
        km = Array.isArray(a) && a[0] ? a[0] : null;
      } catch (_) { /* noop */ }
      let gr = null;
      try {
        const a = grTxt ? JSON.parse(grTxt) : [];
        gr = Array.isArray(a) && a[0] ? a[0] : null;
      } catch (_) { /* noop */ }
      let pf = null;
      try {
        const a = prTxt ? JSON.parse(prTxt) : [];
        pf = Array.isArray(a) && a[0] ? a[0] : null;
      } catch (_) { /* noop */ }
      if (!km && !gr && !pf) continue;
      const num = x => {
        const v = x?.raw ?? x;
        const t = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
        return Number.isFinite(t) ? t : null;
      };
      const pctGrowth = x => {
        const t = num(x);
        if (t == null) return null;
        /* FMP often returns decimal (0.12) vs percent (12); normalize to GUI % */
        const asPct = Math.abs(t) < 25 ? +(t * 100).toFixed(1) : +t.toFixed(1);
        return Number.isFinite(asPct) ? asPct : null;
      };
      const revenueGrowth = pctGrowth(gr?.revenueGrowth) ?? pctGrowth(gr?.growthRevenue);
      const earningsGrowth = pctGrowth(gr?.epsgrowth ?? gr?.growthEps ?? gr?.netIncomeGrowth);
      const peRatio = num(km?.peRatio);
      const pegRatio = num(km?.pegRatio);
      if (peRatio == null && pegRatio == null && revenueGrowth == null && pf == null) continue;
      console.log('fetchFundamentalsFMP', normalizeTickerMatch(raw));
      return {
        targetMeanPrice: null,
        analystCount: null,
        recommendationKey: null,
        revenueGrowth,
        earningsGrowth,
        grossMargins: pctGrowth(km?.grossProfitMargin ?? gr?.growthGrossProfit),
        operatingMargins: pctGrowth(km?.operatingProfitMargin),
        debtToEquity: km?.debtToEquity != null ? Number(num(km.debtToEquity).toFixed(1)) : null,
        /* key-metrics-ttm peRatio is TTM — never treat as forward P/E */
        forwardPE: null,
        pegRatio,
        trailingPE: peRatio,
        dividendYield: pctGrowth(km?.dividendYield),
        marketCap: num(km?.marketCap ?? pf?.mktCap),
        _fmpSector: pf?.sector || pf?.industry || null,
        _source: 'fmp'
      };
    } catch (e) {
      console.warn('fetchFundamentalsFMP', raw, e.message);
    }
  }
  return null;
}

function mergeFundSnapshots(y, f) {
  if (!y) return f;
  if (!f) return y;
  const out = { ...y };
  for (const k of Object.keys(f)) {
    if (String(k).startsWith('_')) continue;
    const yv = out[k];
    const fv = f[k];
    if ((yv === null || yv === undefined) && fv != null && fv !== undefined) out[k] = fv;
  }
  return out;
}

/** Map app ticker to Bloomberg equity string for Desktop API ref() (examples: `AAPL US Equity`, `ASML NA Equity`, `9988 HK Equity`). */
function toBloombergEquity(sym) {
  const s = String(sym || '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  if (s === 'BRK.B' || s === 'BRK-B') return 'BRK/B US Equity';
  if (/^\d+\.HK$/i.test(s)) return `${s.replace(/\.HK$/i, '')} HK Equity`;
  if (/\.L$/i.test(s)) return `${s.replace(/\.L$/i, '')} LN Equity`;
  if (/\.PA$/i.test(s)) return `${s.replace(/\.PA$/i, '')} FP Equity`;
  if (/\.DE$/i.test(s)) return `${s.replace(/\.DE$/i, '')} GR Equity`;
  if (/\.AS$/i.test(s)) return `${s.replace(/\.AS$/i, '')} NA Equity`;
  if (/\.NS$/i.test(s)) return `${s.replace(/\.NS$/i, '')} IS Equity`;
  if (/\.T$/i.test(s)) return `${s.replace(/\.T$/i, '')} JT Equity`;
  if (/^[A-Z]{1,5}$/.test(s.replace(/\./g, '')) && !s.includes('.')) return `${s} US Equity`;
  return `${s.replace(/\./g, '/')} US Equity`;
}

/** Bloomberg Enterprise HTTP API (ReferenceDataRequest). Your Bloomberg team supplies host + often mTLS certs. */
const BBG_ENT_FIELDS = [
  'BEST_PE_NTM',
  'PE_RATIO',
  'BEST_PEG_RATIO',
  'BEST_TARGET_MEDIAN',
  'SALES_YOY_GR',
  'BEST_EPS_GROWTH'
];

function bloombergEnterpriseBase() {
  return (process.env.BLOOMBERG_ENTERPRISE_API_BASE || '').trim().replace(/\/$/, '');
}

function loadBloombergEnterpriseTls() {
  const ca = (process.env.BLOOMBERG_ENTERPRISE_CA_PATH || '').trim();
  const cert = (process.env.BLOOMBERG_ENTERPRISE_CERT_PATH || '').trim();
  const key = (process.env.BLOOMBERG_ENTERPRISE_KEY_PATH || '').trim();
  const o = {};
  try {
    if (ca && fs.existsSync(ca)) o.ca = fs.readFileSync(ca);
    if (cert && fs.existsSync(cert)) o.cert = fs.readFileSync(cert);
    if (key && fs.existsSync(key)) o.key = fs.readFileSync(key);
  } catch (e) {
    console.warn('Bloomberg Enterprise TLS read', e.message);
  }
  return o;
}

function enterpriseHttpsRequest(urlStr, bodyStr) {
  const tls = loadBloombergEnterpriseTls();
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const token = (process.env.BLOOMBERG_ENTERPRISE_TOKEN || '').trim();
  const insecure = String(process.env.BLOOMBERG_ENTERPRISE_TLS_INSECURE || '').trim() === '1';
  const opts = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'accept-version': '1.0.0',
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    timeout: 28000
  };
  if (isHttps) {
    Object.assign(opts, tls);
    if (insecure) opts.rejectUnauthorized = false;
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 240)}`));
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Bloomberg Enterprise request timeout'));
    });
    req.write(bodyStr);
    req.end();
  });
}

function parseBloombergEnterpriseRefData(respJson) {
  if (!respJson || respJson.message !== 'OK' || respJson.status !== 0) return null;
  const block = respJson.data?.[0];
  const arr = block?.securityData;
  if (!Array.isArray(arr) || !arr.length) return null;
  const row = arr[0];
  const fd = row.fieldData || {};
  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const out = {
    _source: 'bloomberg_enterprise',
    forwardPE: num(fd.BEST_PE_NTM),
    trailingPE: num(fd.PE_RATIO),
    pegRatio: num(fd.BEST_PEG_RATIO),
    targetMeanPrice: num(fd.BEST_TARGET_MEDIAN),
    revenueGrowth: num(fd.SALES_YOY_GR),
    earningsGrowth: num(fd.BEST_EPS_GROWTH),
    _bbSecurity: row.security || null
  };
  const hasAny = Object.keys(out).some(
    k => !k.startsWith('_') && out[k] != null && out[k] !== ''
  );
  return hasAny ? out : null;
}

async function fetchBloombergEnterpriseFundamentals(symbol) {
  const base = bloombergEnterpriseBase();
  if (!base) return null;
  const sec = toBloombergEquity(symbol);
  if (!sec) return null;
  const path =
    '/request?ns=blp&service=refdata&type=ReferenceDataRequest';
  const url = `${base}${path}`;
  const body = JSON.stringify({
    securities: [sec],
    fields: BBG_ENT_FIELDS
  });
  try {
    const txt = await enterpriseHttpsRequest(url, body);
    const j = JSON.parse(txt);
    return parseBloombergEnterpriseRefData(j);
  } catch (e) {
    console.warn('Bloomberg Enterprise', symbol, e.message);
    return null;
  }
}

function bloombergBridgeUrl() {
  return (process.env.BLOOMBERG_BRIDGE_URL || '').trim().replace(/\/$/, '');
}

/** LAN/loopback bridge URLs are never reachable from public cloud (e.g. Render). */
function bloombergBridgeUrlIsUnreachableFromInternet() {
  const base = bloombergBridgeUrl();
  if (!base) return false;
  try {
    const h = new URL(base).hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Local Bloomberg Desktop API bridge (Terminal on your PC). Set BLOOMBERG_BRIDGE_URL=http://127.0.0.1:5055
 * See bloomberg-bridge/README.md. Bloomberg fields override Yahoo/FMP when present.
 */
async function fetchBloombergBridgeFundamentals(symbol) {
  const base = bloombergBridgeUrl();
  if (!base) return null;
  const sec = toBloombergEquity(symbol);
  if (!sec) return null;
  try {
    const u = new URL('/snapshot', base + '/');
    u.searchParams.set('symbol', symbol);
    u.searchParams.set('bb', sec);
    const secret = (process.env.BLOOMBERG_BRIDGE_SECRET || '').trim();
    const headers = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      console.warn('Bloomberg bridge HTTP', r.status, symbol);
      return null;
    }
    const j = await r.json();
    if (j?.error || !j || typeof j !== 'object') return null;
    const num = v => {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const out = {
      _source: 'bloomberg_bridge',
      forwardPE: num(j.forwardPE),
      trailingPE: num(j.trailingPE),
      pegRatio: num(j.pegRatio),
      targetMeanPrice: num(j.targetMeanPrice),
      revenueGrowth: num(j.revenueGrowth),
      earningsGrowth: num(j.earningsGrowth),
      recommendationKey: j.recommendationKey || null,
      analystCount: num(j.analystCount),
      _bbSecurity: j.bbSecurity || sec
    };
    const hasAny = Object.keys(out).some(
      k => !k.startsWith('_') && out[k] != null && out[k] !== ''
    );
    return hasAny ? out : null;
  } catch (e) {
    console.warn('Bloomberg bridge', symbol, e.message);
    return null;
  }
}

/**
 * Earnings snapshot from LAN Bloomberg bridge (/earnings).
 * See bloomberg-bridge/README.md — run bridge on the PC where Terminal is logged in.
 */
async function fetchBloombergBridgeEarnings(symbol) {
  const base = bloombergBridgeUrl();
  if (!base) return null;
  const bb = toBloombergEquity(symbol);
  if (!bb) return null;
  try {
    const u = new URL('/earnings', base + '/');
    u.searchParams.set('symbol', String(symbol || '').trim());
    u.searchParams.set('bb', bb);
    const secret = (process.env.BLOOMBERG_BRIDGE_SECRET || '').trim();
    const headers = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(22000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && typeof j === 'object' && j.error))
      return j && typeof j === 'object' ? { ...j, _httpStatus: r.status } : null;
    return j && typeof j === 'object' ? j : null;
  } catch (e) {
    console.warn('Bloomberg bridge earnings', symbol, e.message);
    return null;
  }
}

function normalizeBbBridgeHistRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .map((row) => {
      const ds = row?.date != null ? String(row.date).trim().slice(0, 10) : '';
      const quarter = row?.quarter != null ? String(row.quarter).trim() : '';
      const epsA = row?.epsActual != null ? String(row.epsActual).trim() : null;
      const epsE = row?.epsEstimate != null ? String(row.epsEstimate).trim() : null;
      let beat = typeof row.beat === 'boolean' ? row.beat : null;
      let surp = row?.epsSurprise != null ? String(row.epsSurprise) : null;
      if ((!surp || surp === 'null') && epsA != null && epsE != null) {
        const a = Number(epsA);
        const e = Number(epsE);
        if (Number.isFinite(a) && Number.isFinite(e) && Math.abs(e) > 1e-12) {
          const p = ((a - e) / Math.abs(e)) * 100;
          surp = (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
          if (beat === null) beat = p >= 0;
        }
      }
      return {
        quarter: quarter || ds,
        date: /^\d{4}-\d{2}-\d{2}$/.test(ds) ? ds : '',
        epsActual: epsA,
        epsEstimate: epsE,
        epsSurprise: surp,
        beat,
        revenueActual: row?.revenueActual ?? null,
        stockReaction: null
      };
    })
    .filter((r) => r.date || r.quarter);
}

/** Merge Bloomberg bridge earnings into computed fields (priority configurable). */
function applyBloombergBridgeEarningsOverlay(
  { nextDate, epsEst, callTime, quarter, epsHistory, historySource, calendarPrimary },
  bbEarn
) {
  if (!bbEarn || bbEarn.error) {
    return {
      nextDate,
      epsEst,
      callTime,
      quarter,
      epsHistory,
      historySource,
      calendarPrimary
    };
  }
  const gap =
    String(process.env.BLOOMBERG_BRIDGE_EARNINGS_PRIORITY || '1').trim() === '0';
  const candDate =
    bbEarn.nextEarningsDate != null ? String(bbEarn.nextEarningsDate).trim().slice(0, 10) : '';
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(candDate);
  let outNext = nextDate;
  let outCal = calendarPrimary;
  let outEst = epsEst;
  let outCall = callTime;
  let outQ = quarter;
  if (dateOk) {
    if (!gap || !outNext) {
      outNext = candDate;
      outCal = 'bloomberg_bridge';
    }
  }
  if ((!gap || outEst == null || String(outEst).trim() === '') && bbEarn.epsEstimate != null) {
    const e = String(bbEarn.epsEstimate).trim();
    if (e) outEst = e;
  }
  if (
    bbEarn.earningsTime &&
    ['pre-market', 'post-market', 'during-market'].includes(String(bbEarn.earningsTime))
  ) {
    if (!gap || !outCall) outCall = bbEarn.earningsTime;
  }
  if ((!gap || !outQ) && bbEarn.quarter != null && String(bbEarn.quarter).trim())
    outQ = String(bbEarn.quarter).trim();

  let outHist = epsHistory;
  let outHistSrc = historySource;
  const norm = normalizeBbBridgeHistRows(bbEarn.history);
  if (norm.length) {
    if (!gap || !Array.isArray(outHist) || outHist.length === 0) {
      outHist = norm.slice(0, 4);
      outHistSrc = 'bloomberg_bridge';
    }
  }
  return {
    nextDate: outNext,
    epsEst: outEst,
    callTime: outCall,
    quarter: outQ,
    epsHistory: Array.isArray(outHist) ? outHist : epsHistory,
    historySource: outHistSrc,
    calendarPrimary: outCal
  };
}

/** Prefer Bloomberg values over existing when bridge returns numbers/strings. */
function mergeBloombergPriority(base, bb) {
  if (!bb || !base) return base;
  const out = { ...base };
  for (const k of Object.keys(bb)) {
    const v = bb[k];
    if (String(k).startsWith('_') && k !== '_source' && k !== '_bbSecurity') continue;
    if (v != null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

async function fetchFundamentals(symbol) {
  const useBridge = bloombergBridgeUrl();
  const [yFund, fMp, bb] = await Promise.all([
    fetchFundamentalsYahoo(symbol),
    fmpEnvKeyFund() ? fetchFundamentalsFMP(symbol) : Promise.resolve(null),
    useBridge ? fetchBloombergBridgeFundamentals(symbol) : Promise.resolve(null)
  ]);
  let merged = mergeFundSnapshots(yFund, fMp);
  if (!merged && fMp) merged = { ...fMp };
  if (!merged && yFund) merged = { ...yFund };
  if (!merged) merged = {};
  const qPe = await fetchYahooQuotePE(symbol);
  if (qPe) {
    if (merged.forwardPE == null && qPe.forwardPE != null) merged.forwardPE = qPe.forwardPE;
    if (merged.trailingPE == null && qPe.trailingPE != null) merged.trailingPE = qPe.trailingPE;
    if (merged.pegRatio == null && qPe.pegRatio != null) merged.pegRatio = qPe.pegRatio;
  }
  const ent = await fetchBloombergEnterpriseFundamentals(symbol);
  if (ent) merged = mergeBloombergPriority(merged, ent);
  if (bb) {
    if (ent) merged = mergeFundSnapshots(merged, bb);
    else merged = mergeBloombergPriority(merged, bb);
  }
  const hasAny = Object.keys(merged).some(
    k => !k.startsWith('_') && merged[k] != null && merged[k] !== ''
  );
  return hasAny ? merged : null;
}

/** Overlay server fundamentals; P/E and PEG always taken from snapshot when present. */
function mergeFundamentalsForUi(row, fund) {
  if (!fund || !row || typeof row !== 'object') return row;
  const gap = v =>
    v == null ||
    v === '' ||
    (typeof v === 'string' &&
      /\b(not\s+provided|not\s+specified|unspecified|n\/a|tbd|placeholder|unknown|omit|dataset|no\s+data)\b/i.test(
        String(v).trim()
      ));
  const set = (k, v) => {
    if (!gap(row[k])) return;
    if (v === null || v === undefined || v === '') return;
    row[k] = v;
  };
  const fmtPe = x => {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    if (n >= 99) return String(Math.round(n));
    if (n > 35) return n.toFixed(1).replace(/\.0$/, '');
    return n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  };
  const fwd = fund.forwardPE;
  const tr = fund.trailingPE;
  if (fwd != null && Number.isFinite(+fwd)) {
    const s = fmtPe(fwd);
    if (s) row.pe = `${s} (forward)`;
  } else if (tr != null && Number.isFinite(+tr)) {
    const s = fmtPe(tr);
    if (s) row.pe = `${s} (TTM)`;
  }
  if (fund.pegRatio != null && Number.isFinite(+fund.pegRatio)) {
    row.peg = String(+Number(fund.pegRatio).toFixed(2));
  }
  if (fund.revenueGrowth != null) set('revenueGrowth', `${fund.revenueGrowth}%`);
  if (fund.earningsGrowth != null) set('earningsGrowth', `${fund.earningsGrowth}%`);
  let finGuess = '';
  const de = fund.debtToEquity;
  if (typeof de === 'number')
    finGuess = de > 200 ? 'Weak' : de > 100 ? 'Moderate' : 'Strong';
  if (fund.grossMargins != null && fund.grossMargins > 42) finGuess = finGuess || 'Strong';
  if (fund.grossMargins != null && fund.grossMargins < 22) finGuess = 'Weak';
  if (finGuess) set('financialHealth', finGuess);
  if (fund._fmpSector) set('industryPos', String(fund._fmpSector).slice(0, 72));

  const bits = [];
  if (fund._source === 'bloomberg_enterprise')
    bits.push(`Bloomberg Enterprise ${fund._bbSecurity ? '(' + fund._bbSecurity + ')' : ''}`.trim());
  else if (fund._source === 'bloomberg_bridge')
    bits.push(`Bloomberg ${fund._bbSecurity ? '(' + fund._bbSecurity + ')' : ''}`.trim());
  if (fund.forwardPE != null) bits.push(`fP/E ${fund.forwardPE}`);
  else if (fund.trailingPE != null) bits.push(`P/E ${fund.trailingPE} TTM`);
  if (fund.revenueGrowth != null) bits.push(`rev YoY ~${fund.revenueGrowth}%`);
  if (fund.earningsGrowth != null) bits.push(`EPS YoY ~${fund.earningsGrowth}%`);
  if (fund.targetMeanPrice != null && fund.marketCap != null)
    bits.push(`mktCap data available · targetMean ${fund.targetMeanPrice}`);
  if (bits.length) set('fundSummary', `Fundamentals (server merge): ${bits.join(' · ')}`);
  if (fund.analystCount != null && gap(row.newsImpact))
    row.newsImpact = `${fund.analystCount} analysts (consensus: ${fund.recommendationKey || 'n/a'})`;
  return row;
}

// Cache technicals — 15 min TTL
const techCache  = new Map();
const fundCache  = new Map();
const TECH_TTL   = 15 * 60 * 1000;

function buildFullTechResult(sym, daily, weekly) {
  const closes = daily.map(d => d.c);
  const cp = closes[closes.length - 1];
  const ma20  = calcSMA(closes, 20);
  const ma50  = calcSMA(closes, 50);
  const ma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
  const rsi   = calcRSI(closes, 14);
  const macd  = calcMACDFull(closes);
  const bb    = calcBollingerFull(closes, 20);
  const atr   = calcATRFull(daily, 14);
  const atrPct = atr ? parseFloat((atr / cp * 100).toFixed(2)) : null;
  const { support1, support2, resistance1, resistance2 } = findSupportResistance(daily, 60);
  const volume  = calcVolumeAnalysis(daily, 20);
  const pattern = detectCandlePattern(daily);
  const trend20 = calcTrend(daily, 20);
  const aboveMa20  = ma20  != null ? cp > ma20  : null;
  const aboveMa50  = ma50  != null ? cp > ma50  : null;
  const aboveMa200 = ma200 != null ? cp > ma200 : null;
  const bullishMAs = [aboveMa20, aboveMa50, aboveMa200].filter(Boolean).length;
  const totalMAs   = [aboveMa20, aboveMa50, aboveMa200].filter(x => x !== null).length;

  const adx = calcADX(daily, 14);
  let weeklyRSI = null, weeklyTrend = null, weeklyMA50 = null;
  if (weekly && weekly.length >= 14) {
    const wc = weekly.map(d => d.c);
    weeklyRSI   = calcRSI(wc, 14);
    weeklyTrend = calcTrend(weekly.slice(-20), 20);
    weeklyMA50  = calcSMA(wc, 50);
  }

  return {
    symbol: sym, currentPrice: cp, ma20, ma50, ma200,
    aboveMa20, aboveMa50, aboveMa200, bullishMAs, totalMAs,
    maAlignmentStr: `${bullishMAs}/${totalMAs} MAs bullish`,
    rsi, rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
    macd, trend20, trend: trend20,
    atr, atrPct, bb, adx,
    adxSignal: adx ? (adx > 40 ? 'strong_trend' : adx > 25 ? 'trending' : 'weak/ranging') : null,
    bbSignal: bb ? (bb.pct > 80 ? 'near_upper_band' : bb.pct < 20 ? 'near_lower_band' : 'mid_band') : null,
    support1, support2, resistance1, resistance2,
    volume, candlePattern: pattern,
    weeklyRSI, weeklyTrend, weeklyMA50,
    summary: `RSI ${rsi} (${rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral'}), ADX ${adx ?? 'N/A'}, ${bullishMAs}/${totalMAs} MAs bullish, ${trend20}, S1@${support1}, R1@${resistance1}`
  };
}

// GET /api/technicals/:symbol — full indicator set (single ticker)
app.get('/api/technicals/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  const cached = techCache.get(sym);
  if (cached && Date.now() - cached.ts < TECH_TTL) return res.json(cached.data);
  try {
    const [daily, weekly] = await Promise.all([
      fetchOHLCV(sym, '6mo', '1d'),
      fetchOHLCV(sym, '2y', '1wk').catch(() => null)
    ]);
    if (!daily || daily.length < 20) return res.status(404).json({ error: 'Insufficient data' });
    const result = buildFullTechResult(sym, daily, weekly);
    techCache.set(sym, { ts: Date.now(), data: result });
    res.json(result);
  } catch(e) {
    console.error('Technicals error:', sym, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/technicals/batch — fast batch for dashboard scan
// quantSignal is instant (no OHLCV loop). Real backtest only in /api/analyze.
app.post('/api/technicals/batch', async (req, res) => {
  const { symbols } = req.body;
  if (!symbols?.length) return res.json({});
  const results = {};

  await Promise.allSettled(symbols.map(async sym => {
    try {
      const cached = techCache.get(sym);
      if (cached && Date.now() - cached.ts < TECH_TTL && cached.data?.quantSignal) {
        results[sym] = cached.data;
        return;
      }

      const daily = await fetchOHLCV(sym, '3mo', '1d');
      if (!daily || daily.length < 20) return;
      const closes  = daily.map(d => d.c);
      const cp      = closes[closes.length - 1];
      const ma20    = calcSMA(closes, 20);
      const ma50    = calcSMA(closes, 50);
      const ma200   = closes.length >= 200 ? calcSMA(closes, 200) : null;
      const rsi     = calcRSI(closes, 14);
      const macd    = calcMACDFull(closes);
      const atr     = calcATRFull(daily, 14);
      const volume  = calcVolumeAnalysis(daily, 20);
      const trend20 = calcTrend(daily, 20);
      const adx     = calcADX(daily, 14);
      const { support1, support2, resistance1, resistance2 } = findSupportResistance(daily, 40);
      const bb      = calcBollingerFull(closes, 20);

      let weeklyTrend = null, weeklyRSI = null;
      try {
        const weekly = await fetchOHLCV(sym, '1y', '1wk');
        if (weekly && weekly.length >= 14) {
          weeklyTrend = calcTrend(weekly.slice(-20), 20);
          weeklyRSI   = calcRSI(weekly.map(d => d.c), 14);
        }
      } catch (_) {}

      const data = {
        symbol: sym, currentPrice: cp,
        ma20, ma50, ma200, rsi, macd, atr, bb,
        atrPct: atr ? parseFloat((atr / cp * 100).toFixed(2)) : null,
        adx, adxSignal: adx ? (adx > 40 ? 'strong_trend' : adx > 25 ? 'trending' : 'weak/ranging') : null,
        volume, trend20, trend: trend20, weeklyTrend, weeklyRSI,
        aboveMa20:  ma20  != null ? cp > ma20  : null,
        aboveMa50:  ma50  != null ? cp > ma50  : null,
        aboveMa200: ma200 != null ? cp > ma200 : null,
        support1, support2, resistance1, resistance2,
        candlePattern: detectCandlePattern(daily),
        rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
        summary: `RSI ${rsi}, ADX ${adx ?? '?'}, ${cp > ma20 ? 'above' : 'below'} MA20, ${trend20}, S@${support1}, R@${resistance1}`
      };

      data.quantSignal = {
        short:  computeQuantSignal(data, null, 'short'),
        medium: computeQuantSignal(data, null, 'medium'),
        long:   computeQuantSignal(data, null, 'long')
      };

      techCache.set(sym, { ts: Date.now(), data });
      results[sym] = data;
    } catch(e) { console.warn('Batch tech fail:', sym, e.message); }
  }));

  console.log(`Technicals batch: ${Object.keys(results).length}/${symbols.length} succeeded`);
  res.json(results);
});

// POST /api/fundamentals/batch — fundamental data for long-term analysis
app.post('/api/fundamentals/batch', async (req, res) => {
  const { symbols } = req.body;
  if (!symbols?.length) return res.json({});
  const results = {};
  // Only fetch for equity symbols (skip BTC-USD, GC=F etc.)
  const equities = symbols.filter(s => !s.includes('=F') && !s.includes('-USD') && !s.includes('-EUR'));
  await Promise.allSettled(equities.map(async sym => {
    try {
      const cached = fundCache.get(sym);
      if (cached && Date.now() - cached.ts < TECH_TTL * 4) { results[sym] = cached.data; return; }
      const data = await fetchFundamentals(sym);
      if (data) { fundCache.set(sym, { ts: Date.now(), data }); results[sym] = data; }
    } catch(e) { console.warn('Fund batch fail:', sym, e.message); }
  }));
  console.log(`Fundamentals batch: ${Object.keys(results).length}/${equities.length} succeeded`);
  res.json(results);
});

// ── Server-side trade history (shared across devices) ──────────────────────
// In-memory store (persists while server is running, resets on redeploy)
// Use a simple JSON file for persistence on Render disk
// Persist history: VPS / Render disk / local ./data / tmp (self-hosted: ./data wins)
const HISTORY_FILE = (() => {
  const dataDir = path.join(__dirname, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}
  const paths = [
    path.join(dataDir, 'history_data.json'),
    '/opt/render/project/src/history_data.json',
    path.join(__dirname, 'history_data.json'),
    '/tmp/alphasignal_history.json'
  ];
  for(const p of paths) {
    try { fs.writeFileSync(p, fs.existsSync(p) ? fs.readFileSync(p) : '[]'); return p; }
    catch(e) {}
  }
  return '/tmp/alphasignal_history.json';
})();
console.log('History file:', HISTORY_FILE);

const HISTORY_VERSION = 3; // increment to wipe old incompatible data

function loadHistoryFile() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      // If it's a versioned wrapper
      if(raw && raw.version === HISTORY_VERSION) return raw.data || [];
      // Old format array — try to keep it
      if(Array.isArray(raw)) { console.log('Old format, keeping', raw.length, 'entries'); return raw; }
      return [];
    }
  } catch(e) { console.warn('History file load error:', e.message); }
  return [];
}

function saveHistoryFile(data) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({version: HISTORY_VERSION, data})); } 
  catch(e) { console.warn('History file save error:', e.message); }
}

let tradeHistory = loadHistoryFile();

// ── Health (after tradeHistory — used in payload) ────────────────────────────
app.get('/api/history/status', (req, res) => {
  const today = new Date().toDateString();
  const todayCnt = tradeHistory.filter(h => new Date(h.entryDate||h.timestamp).toDateString()===today).length;
  const byHz = {};
  tradeHistory.forEach(h => { const hz=h.hz||'none'; byHz[hz]=(byHz[hz]||0)+1; });
  res.json({total:tradeHistory.length, todayCount:todayCnt, byHz, file:HISTORY_FILE});
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    quotes: 'yahoo_finance',
    earnings: {
      finnhub_calendar: !!process.env.FINNHUB_API_KEY,
      fmp_calendar: !!(
        process.env.FMP_API_KEY ||
        process.env.FMP_KEY ||
        process.env.FINANCIAL_MODELING_PREP_API_KEY ||
        ''
      ).trim(),
      yahoo_fallback: true
    },
    /** After first /api/earnings-calendar request: how many rows the merge produced (-1 = not run yet). */
    earnings_calendar_merge: {
      last_event_count: earningsMergeDiag.eventsOut,
      last_merge_at_ms: earningsMergeDiag.ts,
      window: earningsMergeDiag.window || null,
      finnhub_raw_rows: earningsMergeDiag.finnhubIn,
      fmp_raw_rows: earningsMergeDiag.fmpIn,
      merged_before_cap: earningsMergeDiag.uniqBeforeCap,
      bloomberg_tracked_symbols_with_date: earningsMergeDiag.bloombergTrackedHits,
      finnhub_query_path: earningsMergeDiag.finnhubPath || null,
      yahoo_seed_hits: earningsMergeDiag.yahooSeedHits,
      calendar_display_through: earningsMergeDiag.displayEndISO || null,
      vendor_calendar_fetch_through: earningsMergeDiag.vendor_fetch_through || null,
      /** true if last merge was >24h ago — values may not reflect current calendar settings */
      stats_stale:
        earningsMergeDiag.ts > 0 && Date.now() - earningsMergeDiag.ts > 86400000
    },
    /** Prefer passing ?anchor / ?from & ?to from the browser — wrong host clocks otherwise query the wrong year */
    earnings_calendar_default_window: (() => {
      const anchor = new Date().toISOString().slice(0, 10);
      return `${addUTCISODays(anchor, -1)}→${addUTCISODays(anchor, 45)}`;
    })(),
    server_now_utc: new Date().toISOString(),
    bloomberg_equity_example_samples: {
      AAPL: toBloombergEquity('AAPL'),
      ASML_AS: toBloombergEquity('ASML.AS'),
      HK9988: toBloombergEquity('9988.HK')
    },
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    bloomberg_bridge_configured: Boolean(bloombergBridgeUrl()),
    bloomberg_bridge_lan_unreachable_from_cloud:
      bloombergBridgeUrlIsUnreachableFromInternet(),
    bloomberg_bridge_hint:
      bloombergBridgeUrl() && bloombergBridgeUrlIsUnreachableFromInternet()
        ? 'Bridge URL is loopback/LAN-only; hosts like Render cannot reach it — use HTTPS tunnel URL or deploy API on same LAN.'
        : '',
    bloomberg_bridge_manual_test_hint:
      '401 on /snapshot or /earnings via browser: Bloomberg bridge expects HTTP header Authorization: Bearer <BLOOMBERG_BRIDGE_SECRET> when that env var is set on the Terminal PC. Use curl/Postman, or temporarily unset secret for local debugging. AlphaSignal sends this header automatically when Render BLOOMBERG_BRIDGE_SECRET matches.',
    bloomberg_enterprise_configured: Boolean(bloombergEnterpriseBase()),
    ts: Date.now(),
    historyVersion: HISTORY_VERSION,
    historyCount: tradeHistory.length
  });
});

// GET all history
app.get('/api/history', (req, res) => {
  res.json(tradeHistory);
});

// POST add trades (called when dashboard scan completes)
app.post('/api/history/add', express.json(), async (req, res) => {
  const trades = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Expected array' });
  
  const today = new Date().toDateString();
  
  // Remove ALL today entries for incoming tickers (clears old hz=undefined records too)
  const incomingTickers = new Set(trades.map(t => t.ticker));
  tradeHistory = tradeHistory.filter(h => {
    const isToday = new Date(h.entryDate||h.timestamp).toDateString() === today;
    return !(incomingTickers.has(h.ticker) && isToday);
  });
  
  // Add new trades
  tradeHistory.unshift(...trades);
  
  // Keep max 500 entries (50 days × 10 trades)
  if (tradeHistory.length > 500) tradeHistory = tradeHistory.slice(0, 500);
  
  saveHistoryFile(tradeHistory);
  console.log('History: added', trades.length, 'trades, total:', tradeHistory.length);
  res.json({ ok: true, total: tradeHistory.length });
});

// POST update PnL for existing trades
app.post('/api/history/update-pnl', express.json(), (req, res) => {
  const updates = req.body; // array of { ticker, hz, pnl, pct, status, currentPrice }
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  
  updates.forEach(u => {
    const idx = tradeHistory.findIndex(h => 
      h.ticker === u.ticker && 
      new Date(h.entryDate||h.timestamp).toDateString() === new Date(u.entryDate).toDateString()
    );
    if (idx >= 0) {
      const h = tradeHistory[idx];
      // Update all horizon PnL fields
      ['short','medium','long'].forEach(hz => {
        if(u[hz+'PnlDollar'] !== undefined) h[hz+'PnlDollar'] = u[hz+'PnlDollar'];
        if(u[hz+'PnlPct']    !== undefined) h[hz+'PnlPct']    = u[hz+'PnlPct'];
        if(u[hz+'Status']    !== undefined) h[hz+'Status']     = u[hz+'Status'];
      });
      if(u.currentPrice !== undefined) h.currentPrice = u.currentPrice;
    }
  });
  saveHistoryFile(tradeHistory);
  res.json({ ok: true });
});

// POST clear today's entries for specific tickers
app.post('/api/history/clear-today', express.json(), (req, res) => {
  const { tickers } = req.body;
  if(!Array.isArray(tickers)) return res.status(400).json({error:'Expected tickers array'});
  const today = new Date().toDateString();
  const before = tradeHistory.length;
  tradeHistory = tradeHistory.filter(h => {
    const isToday = new Date(h.entryDate||h.timestamp).toDateString() === today;
    return !(isToday && tickers.includes(h.ticker));
  });
  saveHistoryFile(tradeHistory);
  console.log('Cleared today entries:', before - tradeHistory.length, 'removed');
  res.json({ok:true, removed: before - tradeHistory.length});
});

// DELETE clear history
app.delete('/api/history', (req, res) => {
  tradeHistory = [];
  saveHistoryFile(tradeHistory);
  res.json({ ok: true });
});


/** Next earnings ISO date + optional EPS avg from Yahoo quoteSummary.calendarEvents. */
function nextEarningsFromCalendar(qs) {
  const out = {};
  try {
    const ce = qs?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    if (!ce?.earningsDate) return {};
    const edArr = ce.earningsDate;
    const slots = Array.isArray(edArr) ? edArr : [edArr];
    const candidates = [];
    for (const ed of slots) {
      let ms = null;
      if (typeof ed === 'number') ms = ed > 1e12 ? ed : ed * 1000;
      else if (ed && typeof ed === 'object') {
        if (ed.raw != null && Number.isFinite(Number(ed.raw))) {
          const n = Number(ed.raw);
          ms = n > 1e12 ? n : n * 1000;
        } else if (ed.fmt != null) {
          const fmts =
            typeof ed.fmt === 'string' && /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,2})/.test(ed.fmt.trim())
              ? Date.parse(ed.fmt)
              : Date.parse(String(ed.fmt).replace(/,/g, ''));
          if (!Number.isNaN(fmts)) ms = fmts;
        }
      }
      if (ms == null || !Number.isFinite(ms)) continue;
      const year = new Date(ms).getFullYear();
      if (year < 2020 || year > 2100) continue;
      candidates.push(ms);
    }
    if (!candidates.length) return {};
    const now = Date.now();
    const slack = 86400000 * 14;
    const future = candidates.filter((m) => m >= now - slack);
    const todayUtc0 =
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 86400000;
    const nextLike = candidates.filter((m) => m >= todayUtc0);
    const pickMs =
      nextLike.length ? Math.min(...nextLike) : future.length ? Math.min(...future) : Math.min(...candidates);
    const d = new Date(pickMs);
    const nextDate = d.toISOString().slice(0, 10);
    let eps = null;
    if (ce.epsAverage?.fmt != null) eps = String(ce.epsAverage.fmt);
    else if (ce.epsEstimate?.average?.fmt != null) eps = String(ce.epsEstimate.average.fmt);
    out.nextDate = nextDate;
    out.epsEstimate = eps;
  } catch (_) {}
  return out;
}

/** Past quarters when chart `events=earnings` is empty — Yahoo quoteSummary earningsHistory module */
function earningsHistoryFromQuoteSummary(qs) {
  const hist = qs?.quoteSummary?.result?.[0]?.earningsHistory?.history;
  if (!Array.isArray(hist) || !hist.length) return [];
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'object' && Number.isFinite(Number(v.raw))) return Number(v.raw);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function periodToDateStr(row) {
    const per = row.period;
    const perFmt =
      typeof per === 'object' && per != null && per.fmt != null
        ? String(per.fmt).trim()
        : per != null && typeof per !== 'object'
          ? String(per).trim()
          : '';
    const perRaw =
      typeof per === 'object' && per != null && per.raw != null ? Number(per.raw) : null;
    if (Number.isFinite(perRaw)) {
      if (perRaw > 1e11) return new Date(perRaw).toISOString().slice(0, 10);
      if (perRaw > 1e8) return new Date(perRaw * 1000).toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(perFmt)) return perFmt.slice(0, 10);
    if (perFmt) {
      const t = Date.parse(perFmt.replace(',', ''));
      if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    }
    return '';
  }
  const pick = hist.slice(-8).reverse().slice(0, 4);
  return pick
    .map((row) => {
      const epsA = num(row.epsActual);
      const epsE = num(row.epsEstimate);
      let surp = num(row.surprisePercent);
      if ((surp == null || Number.isNaN(surp)) && epsA != null && epsE != null && Math.abs(epsE) > 1e-9) {
        surp = ((epsA - epsE) / Math.abs(epsE)) * 100;
      }
      const dateStr = periodToDateStr(row);
      const quarter =
        (typeof row.quarter === 'object' && row.quarter?.fmt ? row.quarter.fmt : row.quarter) ||
        (dateStr
          ? new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
          : '');
      const surpLabel =
        surp != null && Number.isFinite(surp) ? (surp >= 0 ? '+' : '') + surp.toFixed(1) + '%' : null;
      return {
        quarter,
        date: dateStr,
        epsActual: epsA != null ? String(epsA) : null,
        epsEstimate: epsE != null ? String(epsE) : null,
        epsSurprise: surpLabel,
        beat: surp != null ? surp >= 0 : null,
        revenueActual: null,
        stockReaction: null
      };
    })
    .filter((r) => r.date || r.quarter);
}

/** Past quarters from Yahoo chart earnings events — same logic as legacy fallback. */
function earningsHistoryFromChart(result) {
  const nowTs = Date.now() / 1000;
  const evts = Object.values(result?.events?.earnings || {}).sort((a, b) => a.date - b.date);
  const past = evts.filter((e) => e.date <= nowTs);
  if (!past.length) return [];
  return past
    .slice(-4)
    .reverse()
    .map((e) => {
      const ea = e.epsActual != null && Number.isFinite(Number(e.epsActual)) ? Number(e.epsActual) : null;
      const ee = e.epsEstimate != null && Number.isFinite(Number(e.epsEstimate)) ? Number(e.epsEstimate) : null;
      const surp = ea != null && ee != null && Math.abs(ee) > 1e-9 ? ((ea - ee) / Math.abs(ee)) * 100 : null;
      return {
        quarter: new Date(e.date * 1000).toLocaleDateString('en-GB', {
          month: 'short',
          year: 'numeric'
        }),
        date: new Date(e.date * 1000).toISOString().slice(0, 10),
        epsActual: e.epsActual != null ? String(e.epsActual) : null,
        epsEstimate: e.epsEstimate != null ? String(e.epsEstimate) : null,
        epsSurprise:
          surp != null ? (surp >= 0 ? '+' : '') + surp.toFixed(1) + '%' : null,
        beat: surp != null ? surp >= 0 : null,
        revenueActual: null,
        stockReaction: null
      };
    });
}

/** Tracked universe (same intent as client TRACKED_TICKERS) — calendar merge + Yahoo gap-fill */
const EARNINGS_CAL_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'BRK.B',
  'V', 'MA', 'JNJ', 'UNH', 'PG', 'HD', 'AVGO', 'LLY', 'XOM', 'CVX', 'ABBV', 'KO', 'PEP',
  'COST', 'WMT', 'NFLX', 'AMD', 'ADBE', 'CRM', 'TMO', 'ORCL', 'ACN', 'IBM', 'GS',
  'MS', 'BAC', 'MCD', 'ASML.AS', 'SAP.DE', 'MC.PA', 'AZN.L', 'SHEL.L',
  '9988.HK', '7203.T',
  // India / HK names also on dashboard watchlist widget
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'BAJFINANCE.NS',
  '0700.HK'
];

function normalizeTickerMatch(s) {
  return String(s || '').trim().toUpperCase().replace(/^BRK-B$/i, 'BRK.B').replace(/-/g, '.');
}

/** Drop bogus vendor dates (wrong field / stale cache shapes) outside the fetch window */
function isValidEarningsCalendarRow(dateStr, fromISO, toISO) {
  const d = (dateStr && String(dateStr).trim().slice(0, 10)) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (d < fromISO || d > toISO) return false;
  const rowY = parseInt(d.slice(0, 4), 10);
  const fy = parseInt(fromISO.slice(0, 4), 10);
  const ty = parseInt(toISO.slice(0, 4), 10);
  if (!Number.isFinite(rowY)) return false;
  if (rowY < fy - 1 || rowY > ty + 1) return false;
  return true;
}

/** Lower sort index = larger / watchlist-first in the sidebar */
function earningsTickerPriority(sym) {
  const k = normalizeTickerMatch(sym);
  for (let i = 0; i < EARNINGS_CAL_SYMBOLS.length; i++) {
    if (normalizeTickerMatch(EARNINGS_CAL_SYMBOLS[i]) === k) return i;
  }
  return EARNINGS_CAL_SYMBOLS.length + 500;
}

function finnhubHourToUi(h) {
  const x = String(h || '').toLowerCase();
  if (x === 'amc' || x === 'after') return 'post-market';
  if (x === 'bmo' || x === 'bmh' || x === 'before') return 'pre-market';
  return 'during-market';
}

/** Symbol query variants for Finnhub /calendar/earnings?s= (global feed is often empty on free tier). */
function finnhubTickerVariants(tick) {
  const t = String(tick || '').trim().toUpperCase();
  if (!t) return [];
  if (t === 'GOOGL' || t === 'GOOG') return [...new Set(['GOOGL', 'GOOG'])];
  if (t.includes('.')) return [...new Set([t, t.replace(/\./g, '-')])];
  return [t];
}

function fmpTimeToUi(row) {
  const t = String(row?.time || '').toLowerCase();
  if (t.includes('after')) return 'post-market';
  if (t.includes('pre') || t.includes('before')) return 'pre-market';
  return 'during-market';
}

let fmpCalCacheAll = { key: '', from: '', to: '', ts: 0, rows: [] };

async function fmpEarningCalendarByRange(fromISO, toISO) {
  const k = fmpAnyApiKey();
  if (!k) return [];
  const t = Date.now();
  const ttlMs = 45 * 60 * 1000;
  if (
    fmpCalCacheAll.key === k &&
    fmpCalCacheAll.from === fromISO &&
    fmpCalCacheAll.to === toISO &&
    t - fmpCalCacheAll.ts < ttlMs
  ) {
    return fmpCalCacheAll.rows;
  }

  async function fetchOne(label, urlStr) {
    try {
      const r = await fetch(urlStr, {
        headers: {
          Accept: 'application/json',
          'User-Agent': YF_HEADERS['User-Agent']
        },
        signal: AbortSignal.timeout(24000)
      });
      const txt = await r.text();
      let parsed;
      try {
        parsed = JSON.parse(txt);
      } catch {
        console.warn(`FMP calendar ${label}: non-JSON`, txt.slice(0, 160));
        return [];
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const errMsg = parsed['Error Message'] || parsed.error || parsed.message;
        if (errMsg) console.warn(`FMP calendar ${label}:`, String(errMsg).slice(0, 200));
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Array.isArray(parsed.data)
      )
        parsed = parsed.data;
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (e) {
      console.warn(`FMP calendar ${label}:`, e.message);
      return [];
    }
  }

  const q = `from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&apikey=${encodeURIComponent(k)}`;
  const urls = [
    ['v3_underscore', `https://financialmodelingprep.com/api/v3/earning_calendar?${q}`],
    ['stable_underscore', `https://financialmodelingprep.com/stable/earning_calendar?${q}`],
    ['stable_hyphen', `https://financialmodelingprep.com/stable/earning-calendar?${q}`],
    ['stable_confirmed', `https://financialmodelingprep.com/stable/earning-calendar-confirmed?${q}`],
    ['v4_calendar', `https://financialmodelingprep.com/api/v4/earning-calendar?${q}`]
  ];

  let rows = [];
  for (const [label, u] of urls) {
    rows = await fetchOne(label, u);
    if (rows.length) break;
  }

  /* Do not cache empty arrays — a transient key/rate-limit error would poison merges for 45m. */
  if (rows.length) fmpCalCacheAll = { key: k, from: fromISO, to: toISO, ts: t, rows };
  return rows;
}

function fmpSymbol(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const s = raw.symbol ?? raw.Symbol ?? raw.ticker ?? raw.companySymbol ?? raw.stock;
  return s ? String(s).trim().toUpperCase() : '';
}

async function finnhubEarningsCalendar(fromISO, toISO, opts = {}) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token) return [];

  function extractCalendar(j) {
    if (!j || typeof j !== 'object') return [];
    if (Array.isArray(j.earningsCalendar)) return j.earningsCalendar;
    if (Array.isArray(j.data)) return j.data;
    return [];
  }

  async function fetchOnce(useInternational) {
    const u = new URLSearchParams({ from: fromISO, to: toISO, token });
    if (useInternational) u.set('international', 'true');
    if (opts.symbol) u.set('symbol', opts.symbol);
    try {
      const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?${u}`, {
        signal: AbortSignal.timeout(25000)
      });
      if (!r.ok) {
        console.warn('Finnhub calendar', r.status);
        return [];
      }
      const j = await r.json();
      if (j && typeof j.error === 'string')
        console.warn('Finnhub calendar error:', j.error.slice(0, 200));
      return extractCalendar(j);
    } catch (e) {
      console.warn('Finnhub calendar', e.message);
      return [];
    }
  }

  let rows = await fetchOnce(true);
  if (!rows.length) rows = await fetchOnce(false);
  return rows;
}

function mapFinnhubCalRow(e) {
  const q = e.quarter != null && e.year != null ? `Q${e.quarter} FY${e.year}` : '';
  const est =
    e.epsEstimate != null && Number.isFinite(+e.epsEstimate) ? String(e.epsEstimate) : '';
  const act =
    e.epsActual != null && Number.isFinite(+e.epsActual) ? String(e.epsActual) : '';
  return {
    ticker: String(e.symbol || '').replace(/^BRK-B$/i, 'BRK.B'),
    name: String(e.symbol || ''),
    date: String(e.date || '').slice(0, 10),
    time: finnhubHourToUi(e.hour),
    epsEst: est,
    epsPrior: act,
    note: q,
    market: 'US',
    source: 'finnhub'
  };
}

function mapFmpCalRow(e) {
  const est =
    e.epsEstimated != null
      ? String(e.epsEstimated)
      : e.eps != null
        ? String(e.eps)
        : '';
  return {
    ticker: fmpSymbol(e),
    name: e.name || String(fmpSymbol(e) || e.symbol || ''),
    date: calRowDateISO(e),
    time: fmpTimeToUi(e),
    epsEst: est,
    epsPrior: '',
    note: e.fiscalDateEnding ? `Period ${e.fiscalDateEnding}` : '',
    market: '',
    source: 'fmp'
  };
}

/** Map LAN bridge /earnings JSON to the same shape as Finnhub/FMP calendar rows. */
function bridgeEarningsToCalendarRow(bbEarn, tick) {
  if (!bbEarn || bbEarn.error) return null;
  const candDate =
    bbEarn.nextEarningsDate != null ? String(bbEarn.nextEarningsDate).trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candDate)) return null;
  let time = 'during-market';
  const et = bbEarn.earningsTime;
  if (et && ['pre-market', 'post-market', 'during-market'].includes(String(et))) time = et;
  const est = bbEarn.epsEstimate != null ? String(bbEarn.epsEstimate).trim() : '';
  const tkr = String(tick || '').trim();
  return {
    ticker: tkr.replace(/^BRK-B$/i, 'BRK.B'),
    name: tkr,
    date: candDate,
    time,
    epsEst: est,
    epsPrior: '',
    note: bbEarn.quarter ? String(bbEarn.quarter) : '',
    market: '',
    source: 'bloomberg_bridge'
  };
}

const WANT_SYM = new Set(EARNINGS_CAL_SYMBOLS.map((t) => normalizeTickerMatch(t)));

function tickerInOurUniverse(sym) {
  return WANT_SYM.has(normalizeTickerMatch(sym));
}

/** Cap payload / UI size when merging full-market calendars */
const EARNINGS_CALENDAR_MAX = 400;

function calRowDateISO(e) {
  if (!e) return '';
  const d = e.date ?? e.earningDate ?? e.earningsDate ?? e.earning_date;
  return d ? String(d).slice(0, 10) : '';
}

function isUpcomingCalRow(e, fromISO, toISO) {
  const d = calRowDateISO(e);
  if (!d || d < fromISO || d > toISO) return false;
  return true;
}

/**
 * Yahoo chart earnings events in calendar merge window (avoids server-"today" filter that breaks bad clocks).
 */
async function yahooChartFirstEarningsBetween(ticker, fromISO, endISO) {
  const lo = String(fromISO || '').slice(0, 10);
  const hi = String(endISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lo) || !/^\d{4}-\d{2}-\d{2}$/.test(hi) || lo > hi)
    return null;
  const extra = ticker === 'BRK.B' ? ['BRK-B'] : [];
  const variants = [...new Set([ticker, String(ticker).replace(/\./g, '-'), ...extra])].filter(
    Boolean
  );
  const ranges = ['2y', '5y', '1y'];
  const hosts = ['query2', 'query1'];
  for (const t of variants) {
    for (const host of hosts) {
      for (const range of ranges) {
        try {
          const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
            t
          )}?range=${range}&interval=1d&events=earnings&includePrePost=false`;
          const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(22000) });
          if (!r.ok) continue;
          const d = await r.json();
          const result = d?.chart?.result?.[0];
          const raw = result?.events?.earnings;
          if (!raw) continue;
          const evts = Object.values(raw).sort((a, b) => a.date - b.date);
          const meta = result.meta || {};
          const nm = meta.longName || meta.shortName || meta.symbol || t;
          for (const e of evts) {
            const ds = new Date(e.date * 1000).toISOString().slice(0, 10);
            if (ds >= lo && ds <= hi) {
              return {
                ticker: String(t).replace(/-/g, '.'),
                name: nm,
                date: ds,
                time: 'during-market',
                epsEst: '',
                epsPrior: '',
                note: '',
                market: '',
                source: 'yahoo_chart'
              };
            }
          }
        } catch (err) {
          console.warn('yahooChartFirstEarningsBetween', ticker, err.message);
        }
      }
    }
  }
  return null;
}

/** When quoteSummary omits calendarEvents (common from datacenter IPs), chart `events=earnings` often still lists the next report. */
async function yahooNextEarningsFromChartEvents(ticker) {
  const extra = ticker === 'BRK.B' ? ['BRK-B'] : [];
  const variants = [...new Set([ticker, ticker.replace(/\./g, '-'), ...extra])].filter(Boolean);
  const todayISO = new Date().toISOString().slice(0, 10);
  for (const t of variants) {
    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d&events=earnings&includePrePost=false`;
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const d = await r.json();
        const result = d?.chart?.result?.[0];
        if (!result?.events?.earnings) continue;
        const evts = Object.values(result.events.earnings).sort((a, b) => a.date - b.date);
        const fut = evts.filter((e) => {
          const ds = new Date(e.date * 1000).toISOString().slice(0, 10);
          return ds >= todayISO;
        });
        if (!fut.length) continue;
        const nx = fut[0].date;
        const dateStr = new Date(nx * 1000).toISOString().slice(0, 10);
        const meta = result.meta || {};
        const nm = meta.longName || meta.shortName || meta.symbol || t;
        return {
          ticker: String(t).replace(/-/g, '.'),
          name: nm,
          date: dateStr,
          time: 'during-market',
          epsEst: '',
          epsPrior: '',
          note: '',
          market: '',
          source: 'yahoo_chart'
        };
      } catch (e) {
        console.warn('yahooNextEarningsFromChartEvents', ticker, e.message);
      }
    }
  }
  return null;
}

async function yahooEarningsGapRow(ticker, mergeFromISO = null, mergeEndISO = null) {
  const calBounds =
    mergeFromISO &&
    mergeEndISO &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(mergeFromISO).slice(0, 10)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(mergeEndISO).slice(0, 10));
  const mf = calBounds ? String(mergeFromISO).slice(0, 10) : null;
  const mt = calBounds ? String(mergeEndISO).slice(0, 10) : null;

  if (mf && mt) {
    const ch = await yahooChartFirstEarningsBetween(ticker, mf, mt);
    if (ch) return ch;
  }

  const tryOne = async (t) => {
    try {
      const qs = await quoteSummary(t, 'calendarEvents,summaryProfile');
      const cal = nextEarningsFromCalendar(qs);
      if (!cal.nextDate) return null;
      const dStr = String(cal.nextDate).slice(0, 10);
      if (mf && mt && (!/^\d{4}-\d{2}-\d{2}$/.test(dStr) || dStr < mf || dStr > mt)) return null;
      const nm =
        qs?.quoteSummary?.result?.[0]?.summaryProfile?.longName ||
        qs?.quoteSummary?.result?.[0]?.summaryProfile?.shortName ||
        t;
      const ex = qs?.quoteSummary?.result?.[0]?.summaryProfile?.exchange?.toUpperCase() || '';
      const market = ex.includes('NMS') || ex.includes('NYQ')
        ? 'US'
        : ex.includes('LSE')
          ? 'UK'
          : ex.includes('HKG')
            ? 'HK'
            : '';
      return {
        ticker: t.replace(/-/g, '.'),
        name: nm,
        date: cal.nextDate,
        time: 'during-market',
        epsEst: cal.epsEstimate || '',
        epsPrior: '',
        note: '',
        market,
        source: 'yahoo'
      };
    } catch (_) {
      return null;
    }
  };
  let row = await tryOne(ticker);
  if (row) return row;
  if (ticker === 'GOOGL') row = await tryOne('GOOG');
  else if (ticker === 'GOOG') row = await tryOne('GOOGL');
  if (row) return row;
  /* Uncalibrated fallback (uses server UTC "today"); skip when merging an explicit date window */
  if (!mf || !mt) {
    row = await yahooNextEarningsFromChartEvents(ticker);
    if (row) return row;
    if (ticker === 'GOOGL') return yahooNextEarningsFromChartEvents('GOOG');
    if (ticker === 'GOOG') return yahooNextEarningsFromChartEvents('GOOGL');
  }
  return null;
}

/** Last merge stats for /api/health (keys set ≠ rows returned). */
let earningsMergeDiag = {
  eventsOut: -1,
  ts: 0,
  window: '',
  finnhubIn: -1,
  fmpIn: -1,
  uniqBeforeCap: -1,
  bloombergTrackedHits: -1,
  finnhubPath: '',
  yahooSeedHits: -1,
  displayEndISO: '',
  vendor_fetch_through: ''
};

async function mergedEarningsCalendarWidget(fromISO, toISO) {
  const byTicker = new Map();
  /**
   * Vendors are queried for [fromISO, toISO]; "next earnings" from Yahoo/Bloomberg often lands after toISO.
   * Keep merged rows through displayEndISO so the calendar is not empty while keys are valid.
   */
  const displayEndISO = addUTCISODays(toISO, 135);
  /** Widen Finnhub/FMP *request* range so bulk calendars include names whose next report is after the UI horizon. */
  const vendorEndISO = addUTCISODays(toISO, 90);

  let yahooSeedHits = 0;
  const SEED_CHUNK = 5;
  for (let i = 0; i < EARNINGS_CAL_SYMBOLS.length; i += SEED_CHUNK) {
    const chunk = EARNINGS_CAL_SYMBOLS.slice(i, i + SEED_CHUNK);
    await Promise.all(
      chunk.map(async (tick) => {
        try {
          const nk = normalizeTickerMatch(tick);
          if (!nk || byTicker.has(nk)) return;
          const gap = await yahooEarningsGapRow(tick, fromISO, displayEndISO);
          if (
            gap &&
            gap.date &&
            gap.date >= fromISO &&
            gap.date <= displayEndISO
          ) {
            byTicker.set(nk, gap);
            yahooSeedHits++;
          }
        } catch (_) {}
      })
    );
    if (i + SEED_CHUNK < EARNINGS_CAL_SYMBOLS.length) {
      await new Promise((r) => setTimeout(r, 140));
    }
  }

  let bloombergTrackedHits = 0;
  if (bloombergBridgeUrl()) {
    const BB_CHUNK = 5;
    for (let i = 0; i < EARNINGS_CAL_SYMBOLS.length; i += BB_CHUNK) {
      const chunk = EARNINGS_CAL_SYMBOLS.slice(i, i + BB_CHUNK);
      await Promise.all(
        chunk.map(async (tick) => {
          try {
            const bb = await fetchBloombergBridgeEarnings(tick);
            const row = bridgeEarningsToCalendarRow(bb, tick);
            if (!row || !isUpcomingCalRow(row, fromISO, displayEndISO)) return;
            const k = normalizeTickerMatch(tick);
            if (!k) return;
            byTicker.set(k, row);
            bloombergTrackedHits++;
          } catch (_) {
            /* ignore per-symbol bridge errors */
          }
        })
      );
      if (i + BB_CHUNK < EARNINGS_CAL_SYMBOLS.length) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  let fhRaw = await finnhubEarningsCalendar(fromISO, vendorEndISO);
  let finnhubPath = fhRaw.length ? 'global' : 'none';
  if (!fhRaw.length && (process.env.FINNHUB_API_KEY || '').trim()) {
    finnhubPath = 'symbol_fallback';
    const acc = [];
    const FH_SYM_CHUNK = 10;
    for (let i = 0; i < EARNINGS_CAL_SYMBOLS.length; i += FH_SYM_CHUNK) {
      const chunk = EARNINGS_CAL_SYMBOLS.slice(i, i + FH_SYM_CHUNK);
      await Promise.all(
        chunk.map(async (tick) => {
          for (const fv of finnhubTickerVariants(tick)) {
            const rows = await finnhubEarningsCalendar(fromISO, vendorEndISO, { symbol: fv });
            if (rows.length) {
              acc.push(...rows);
              break;
            }
          }
        })
      );
      if (i + FH_SYM_CHUNK < EARNINGS_CAL_SYMBOLS.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    fhRaw = acc;
  }

  const fmpRows = await fmpEarningCalendarByRange(fromISO, vendorEndISO);

  // Full-window merge (not limited to ~55 watchlist names) so the widget reflects the real market.
  fhRaw
    .filter((x) => x && x.symbol && isUpcomingCalRow(x, fromISO, displayEndISO))
    .forEach((e) => {
      const row = mapFinnhubCalRow(e);
      const k = normalizeTickerMatch(row.ticker);
      if (!k) return;
      const prev = byTicker.get(k);
      if (prev && prev.source === 'bloomberg_bridge') return;
      byTicker.set(k, row);
    });

  fmpRows.forEach((e) => {
    const sym = fmpSymbol(e);
    if (!sym || !isUpcomingCalRow(e, fromISO, displayEndISO)) return;
    const k = normalizeTickerMatch(sym);
    if (!k) return;
    const prev = byTicker.get(k);
    if (prev && (prev.source === 'bloomberg_bridge' || prev.source === 'finnhub')) return;
    byTicker.set(k, mapFmpCalRow(e));
  });

  for (const [, row] of byTicker) {
    if (
      row.source === 'finnhub' &&
      (!row.name || row.name === row.ticker || row.name === row.ticker.replace(/\./g, '-'))
    ) {
      const hit = fmpRows.find(
        (r) => fmpSymbol(r) && normalizeTickerMatch(fmpSymbol(r)) === normalizeTickerMatch(row.ticker)
      );
      const nm =
        hit && hit.name && String(hit.name).length > String(hit.symbol || '').length
          ? hit.name
          : null;
      if (nm) row.name = nm;
    }
  }

  const GAP_CHUNK = 6;
  for (let i = 0; i < EARNINGS_CAL_SYMBOLS.length; i += GAP_CHUNK) {
    const chunk = EARNINGS_CAL_SYMBOLS.slice(i, i + GAP_CHUNK);
    await Promise.all(
      chunk.map(async (tick) => {
        const nk = normalizeTickerMatch(tick);
        if (byTicker.has(nk)) return;
        const gap = await yahooEarningsGapRow(tick, fromISO, displayEndISO);
        if (gap && gap.date && gap.date >= fromISO && gap.date <= displayEndISO) {
          byTicker.set(nk, gap);
        }
      })
    );
    if (i + GAP_CHUNK < EARNINGS_CAL_SYMBOLS.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const sorted = [...byTicker.values()]
    .filter((row) => row?.date && isValidEarningsCalendarRow(row.date, fromISO, displayEndISO))
    .sort((a, b) => {
      const da = a.date.localeCompare(b.date);
      if (da !== 0) return da;
      const pa = earningsTickerPriority(a.ticker);
      const pb = earningsTickerPriority(b.ticker);
      if (pa !== pb) return pa - pb;
      return normalizeTickerMatch(a.ticker).localeCompare(normalizeTickerMatch(b.ticker));
    });
  const capped = sorted.slice(0, EARNINGS_CALENDAR_MAX);
  earningsMergeDiag = {
    eventsOut: capped.length,
    ts: Date.now(),
    window: `${fromISO}→${toISO}`,
    finnhubIn: fhRaw.length,
    fmpIn: fmpRows.length,
    uniqBeforeCap: sorted.length,
    bloombergTrackedHits,
    finnhubPath,
    yahooSeedHits,
    displayEndISO,
    vendor_fetch_through: vendorEndISO
  };
  return capped;
}

/** Last quarters EPS actual vs estimate when Yahoo earnings modules are blocked (same shape as other history helpers). */
async function fmpEarningsSurprisesHistory(sym) {
  const k = fmpAnyApiKey();
  if (!k) return [];
  function pickNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function normalizeRows(arr) {
    const sorted = [...arr].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return sorted
      .slice(0, 4)
      .map((row) => {
        const dateStr = String(row.date || '').slice(0, 10);
        const ea = pickNum(row.actualEPS ?? row.actual);
        const ee = pickNum(row.estimatedEPS ?? row.estimate ?? row.estimatesAvg);
        let surp = pickNum(row.surprisePercent);
        if ((surp == null || Number.isNaN(surp)) && ea != null && ee != null && Math.abs(ee) > 1e-9) {
          surp = ((ea - ee) / Math.abs(ee)) * 100;
        }
        const quarter = dateStr
          ? new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {
              month: 'short',
              year: 'numeric'
            })
          : '';
        const surpLabel =
          surp != null && Number.isFinite(surp) ? (surp >= 0 ? '+' : '') + surp.toFixed(1) + '%' : null;
        return {
          quarter,
          date: dateStr,
          epsActual: ea != null ? String(ea) : null,
          epsEstimate: ee != null ? String(ee) : null,
          epsSurprise: surpLabel,
          beat: surp != null ? surp >= 0 : null,
          revenueActual: null,
          stockReaction: null
        };
      })
      .filter((r) => r.date || r.quarter);
  }
  const variants = [...new Set([sym, sym.replace(/\./g, '-')])].filter(Boolean);
  for (const v of variants) {
    try {
      const enc = encodeURIComponent(v);
      const url = `https://financialmodelingprep.com/api/v3/earnings-surprises/${enc}?apikey=${encodeURIComponent(k)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      const out = normalizeRows(arr);
      if (out.length) return out;
    } catch (e) {
      console.warn('fmpEarningsSurprisesHistory', v, e.message);
    }
  }
  return [];
}

/** Calendar-day arithmetic in UTC (for earnings cutoffs vs vendor date strings). */
function addUTCISODays(iso, days) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function parseQueryCalendarISODate(v) {
  const s = String(v ?? '')
    .trim()
    .slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4);
  const mo = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return s;
}

/**
 * Calendar fetch window — prefer explicit from/to or anchor from the browser so a wrong server clock does not fetch 2024 dates while vendors return 2025+ rows.
 */
function resolveEarningsCalendarWindow(req) {
  const days = Math.min(120, Math.max(7, parseInt(String(req.query.days || ''), 10) || 45));
  const explicitFrom = parseQueryCalendarISODate(req.query.from);
  const explicitTo = parseQueryCalendarISODate(req.query.to);
  if (explicitFrom && explicitTo && explicitFrom <= explicitTo) {
    const ms0 = Date.UTC(
      +explicitFrom.slice(0, 4),
      +explicitFrom.slice(5, 7) - 1,
      +explicitFrom.slice(8, 10)
    );
    const ms1 = Date.UTC(
      +explicitTo.slice(0, 4),
      +explicitTo.slice(5, 7) - 1,
      +explicitTo.slice(8, 10)
    );
    const spanInclusive = Math.floor((ms1 - ms0) / 86400000) + 1;
    if (spanInclusive >= 1 && spanInclusive <= 120)
      return { fromISO: explicitFrom, endISO: explicitTo, windowSource: 'query_from_to' };
  }
  const anchor =
    parseQueryCalendarISODate(req.query.anchor) || new Date().toISOString().slice(0, 10);
  return {
    fromISO: addUTCISODays(anchor, -1),
    endISO: addUTCISODays(anchor, days),
    windowSource: parseQueryCalendarISODate(req.query.anchor) ? 'client_anchor' : 'server_anchor'
  };
}

// ── Earnings data — Bloomberg bridge first, Yahoo fallback, Finnhub/FMP last ─
app.get('/api/earnings/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const todayISO = new Date().toISOString().slice(0, 10);
  /** One-day grace: avoid dropping "today" rows on timezone / feed lag vs strict UTC midnight */
  const upcomingCutoff = addUTCISODays(todayISO, -1);
  const bbEarnPromise = bloombergBridgeUrl()
    ? fetchBloombergBridgeEarnings(sym)
    : Promise.resolve(null);
  try {
    let nextDate = null;
    let nextDateEnd = null;
    let epsEst = null;
    let callTime = null;
    let quarter = null;
    let epsHistory = [];
    let calendarPrimary = '';
    let historySource = 'yahoo_chart_events';

    const bbEarn = await bbEarnPromise.catch(() => null);
    if (bbEarn && !bbEarn.error) {
      const candDate =
        bbEarn.nextEarningsDate != null ? String(bbEarn.nextEarningsDate).trim().slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(candDate) && candDate >= upcomingCutoff) {
        nextDate = candDate;
        calendarPrimary = 'bloomberg_bridge';
      }
      const be = bbEarn.epsEstimate != null ? String(bbEarn.epsEstimate).trim() : '';
      if (be) epsEst = epsEst || be;
      if (
        bbEarn.earningsTime &&
        ['pre-market', 'post-market', 'during-market'].includes(String(bbEarn.earningsTime))
      ) {
        callTime = callTime || bbEarn.earningsTime;
      }
      const bq = bbEarn.quarter != null ? String(bbEarn.quarter).trim() : '';
      if (bq) quarter = quarter || bq;
      const normBb = normalizeBbBridgeHistRows(bbEarn.history);
      if (normBb.length) {
        epsHistory = normBb;
        historySource = 'bloomberg_bridge';
      }
    }

    const toFar = new Date();
    toFar.setUTCDate(toFar.getUTCDate() + 120);
    const toISOsym = toFar.toISOString().slice(0, 10);

    let qs = await quoteSummary(sym, 'calendarEvents,earnings,earningsHistory');
    let fromCal = nextEarningsFromCalendar(qs);
    if ((!fromCal.nextDate || fromCal.nextDate < todayISO) && (sym === 'GOOGL' || sym === 'GOOG')) {
      const altQs = await quoteSummary(
        sym === 'GOOGL' ? 'GOOG' : 'GOOGL',
        'calendarEvents,earnings,earningsHistory'
      );
      const altCal = nextEarningsFromCalendar(altQs);
      if (altCal.nextDate && (!fromCal.nextDate || fromCal.nextDate < todayISO)) fromCal = altCal;
    }
    if (!nextDate && fromCal.nextDate && fromCal.nextDate >= upcomingCutoff) {
      nextDate = fromCal.nextDate;
      epsEst = epsEst || fromCal.epsEstimate || null;
      calendarPrimary = calendarPrimary || 'yahoo_quoteSummary';
    } else if (fromCal.epsEstimate && !epsEst) {
      epsEst = fromCal.epsEstimate;
    }

    if (!epsHistory.length) {
      epsHistory = earningsHistoryFromQuoteSummary(qs);
      if (epsHistory.length) historySource = 'yahoo_quoteSummary_earningsHistory';
    }
    if (!epsHistory.length && (sym === 'GOOGL' || sym === 'GOOG')) {
      const altQsHist = await quoteSummary(sym === 'GOOGL' ? 'GOOG' : 'GOOGL', 'earningsHistory');
      const altH = earningsHistoryFromQuoteSummary(altQsHist);
      if (altH.length) {
        epsHistory = altH;
        historySource = 'yahoo_quoteSummary_earningsHistory';
      }
    }

    const symbolsForChart =
      sym === 'GOOGL' || sym === 'GOOG'
        ? ['GOOGL', 'GOOG']
        : sym.includes('.')
          ? [...new Set([sym, sym.replace(/\./g, '-')])].filter(Boolean)
          : [sym];
    const rangeQs = ['range=3y&interval=3mo', 'range=8y&interval=1wk'];
    for (const host of ['query1', 'query2']) {
      for (const cs of symbolsForChart) {
        for (const rq of rangeQs) {
          try {
            const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cs)}?${rq}&events=earnings&includePrePost=false`;
            const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
            if (!r.ok) continue;
            const d = await r.json();
            const result = d?.chart?.result?.[0];
            if (!result) continue;
            const chunk = earningsHistoryFromChart(result);
            if (chunk.length > epsHistory.length) {
              epsHistory = chunk;
              historySource = 'yahoo_chart_events';
            }
            if (!nextDate) {
              const cutoffISO = upcomingCutoff;
              const evts = Object.values(result.events?.earnings || {}).sort((a, b) => a.date - b.date);
              const fut = evts.filter((e) => {
                const d = new Date(e.date * 1000).toISOString().slice(0, 10);
                return d >= cutoffISO;
              });
              if (fut.length) {
                const nx = fut[0].date;
                nextDate = new Date(nx * 1000).toISOString().slice(0, 10);
                if (!calendarPrimary) calendarPrimary = 'yahoo_chart';
              }
            }
          } catch (e) {
            console.log('Yahoo chart earnings:', sym, e.message);
          }
        }
      }
    }
    if (!nextDate) {
      let g = await yahooNextEarningsFromChartEvents(sym);
      if (!g && (sym === 'GOOGL' || sym === 'GOOG'))
        g = await yahooNextEarningsFromChartEvents(sym === 'GOOGL' ? 'GOOG' : 'GOOGL');
      if (g?.date && String(g.date).slice(0, 10) >= upcomingCutoff) {
        nextDate = String(g.date).slice(0, 10);
        if (!calendarPrimary) calendarPrimary = 'yahoo_chart_gap';
      }
    }
    if (!epsHistory.length) {
      const histSyms = sym === 'GOOGL' || sym === 'GOOG' ? ['GOOGL', 'GOOG'] : symbolsForChart;
      for (const cs of histSyms) {
        const qHist = await quoteSummary(cs, 'earningsHistory');
        const chunk = earningsHistoryFromQuoteSummary(qHist);
        if (chunk.length) {
          epsHistory = chunk;
          historySource = 'yahoo_quoteSummary_earningsHistory';
          break;
        }
      }
    }
    if (!epsHistory.length && fmpAnyApiKey()) {
      const fmpH = await fmpEarningsSurprisesHistory(sym);
      if (fmpH.length) {
        epsHistory = fmpH;
        historySource = 'fmp_earnings_surprises';
      }
    }

    if (!nextDate) {
      const fhVariants =
        sym === 'GOOGL' || sym === 'GOOG'
          ? ['GOOGL', 'GOOG']
          : sym.includes('.')
            ? [sym, sym.replace(/\./g, '-')]
            : [sym];
      let fhRows = [];
      for (const fv of fhVariants) {
        fhRows = await finnhubEarningsCalendar(todayISO, toISOsym, { symbol: fv });
        if (fhRows.length) break;
      }
      const fhFuture = fhRows.filter((r) => String(r.date).slice(0, 10) >= upcomingCutoff);
      fhFuture.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (fhFuture.length) {
        const e = fhFuture[0];
        nextDate = String(e.date).slice(0, 10);
        if (e.epsEstimate != null && Number.isFinite(+e.epsEstimate)) epsEst = epsEst || String(e.epsEstimate);
        if (!callTime && finnhubHourToUi(e.hour) !== 'during-market')
          callTime = finnhubHourToUi(e.hour);
        if (!quarter && e.quarter != null && e.year != null)
          quarter = `Q${e.quarter} FY${e.year}`;
        calendarPrimary = calendarPrimary || 'finnhub';
      }
    }

    if (!nextDate && fmpAnyApiKey()) {
      const fmpArr = await fmpEarningCalendarByRange(todayISO, toISOsym);
      const symMatch = normalizeTickerMatch(sym);
      let fmpHits = fmpArr.filter(
        (r) => fmpSymbol(r) && normalizeTickerMatch(fmpSymbol(r)) === symMatch
      );
      const compact = symMatch.replace(/\./g, '');
      if (!fmpHits.length && compact.length >= 2) {
        fmpHits = fmpArr.filter((r) => {
          const fs = fmpSymbol(r);
          return fs && normalizeTickerMatch(fs).replace(/\./g, '') === compact;
        });
      }
      fmpHits.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      const hit =
        fmpHits[0] ||
        (sym === 'GOOGL'
          ? fmpArr.find((r) => fmpSymbol(r) && normalizeTickerMatch(fmpSymbol(r)) === 'GOOG')
          : sym === 'GOOG'
            ? fmpArr.find((r) => fmpSymbol(r) && normalizeTickerMatch(fmpSymbol(r)) === 'GOOGL')
            : null);
      if (hit?.date) {
        nextDate = String(hit.date).slice(0, 10);
        if (hit.epsEstimated != null) epsEst = epsEst || String(hit.epsEstimated);
        else if (hit.eps != null) epsEst = epsEst || String(hit.eps);
        calendarPrimary = calendarPrimary || 'fmp';
      }
    }

    const sourcesUsed = {};
    if (process.env.FINNHUB_API_KEY) sourcesUsed.finnhub = true;
    if (fmpAnyApiKey()) sourcesUsed.fmp = true;
    sourcesUsed.yahoo = true;
    if (bloombergBridgeUrl()) sourcesUsed.bloomberg_bridge = true;

    const merged = applyBloombergBridgeEarningsOverlay(
      {
        nextDate,
        epsEst,
        callTime,
        quarter,
        epsHistory,
        historySource,
        calendarPrimary
      },
      bbEarn
    );

    res.json({
      symbol: sym,
      nextEarningsDate: merged.nextDate,
      nextEarningsDateEnd: nextDateEnd,
      epsEstimate: merged.epsEst,
      earningsTime: merged.callTime || null,
      quarter: merged.quarter,
      calendarPrimarySource: merged.calendarPrimary || null,
      calendarSourcesConsulted: sourcesUsed,
      history: Array.isArray(merged.epsHistory) ? merged.epsHistory.slice(0, 4) : [],
      historySource: merged.historySource
    });
  } catch (e) {
    console.error('Earnings err:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function pickDailyWeeklyForAnalyze(sym) {
  /** Aligned with fetchOHLCV (≥15 bars); thin listings need longer ranges first */
  const MIN = 15;
  const ranges = ['12mo', '2y', '5y', 'max', '6mo', '3mo'];
  let bestDaily = null;
  for (const range of ranges) {
    const daily = await fetchOHLCV(sym, range, '1d');
    if (daily && daily.length >= MIN && (!bestDaily || daily.length > bestDaily.length)) {
      bestDaily = daily;
      if (daily.length >= 260) break;
    }
  }
  if (!bestDaily || bestDaily.length < MIN) return null;
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  return { daily: bestDaily, weekly };
}

// ── Single-ticker / batch analysis (Claude + server-computed levels) ───────

function extractAnthropicText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  let raw = '';
  for (const b of data.content) {
    if (b.type === 'text') raw += b.text;
    if (b.type === 'tool_result' && b.content) {
      (Array.isArray(b.content) ? b.content : [b.content]).forEach(tc => {
        if (tc && tc.type === 'text') raw += tc.text;
      });
    }
  }
  return raw.replace(/```json/gi, '').replace(/```/g, '').trim().replace(/^json\s*/i, '').trim();
}

function tryParseJsonArray(str) {
  if (!str) return null;
  let raw = String(str)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/^\uFEFF/, '');
  raw = raw.replace(/^json\s*/i, '').trim();
  const fi = raw.indexOf('[');
  const li = raw.lastIndexOf(']');
  if (fi !== -1 && li > fi) {
    try {
      const r = JSON.parse(raw.slice(fi, li + 1).replace(/,\s*([}\]])/g, '$1'));
      if (Array.isArray(r) && r.length) return r;
    } catch (_) {}
  }
  const oi = raw.indexOf('{');
  const oe = raw.lastIndexOf('}');
  if (oi !== -1 && oe > oi) {
    try {
      const wrapped = '[' + raw.slice(oi, oe + 1) + ']';
      const multi = JSON.parse(wrapped.replace(/,\s*([}\]])/g, '$1'));
      if (Array.isArray(multi) && multi.length) return multi;
    } catch (_) {}
    try {
      const one = JSON.parse(raw.slice(oi, oe + 1).replace(/,\s*([}\]])/g, '$1'));
      if (one && typeof one === 'object') return [one];
    } catch (_) {}
  }
  return null;
}

function ratingImpliesSell(rating) {
  const v = (rating || '').toLowerCase();
  return v.includes('sell');
}

/**
 * ATR-based TP/SL multipliers — hedge fund standard.
 * SL must clear daily noise (min 2×ATR). R:R ≥ 1.5:1 on TP1.
 *   Short  (1-3d):  SL=-2×ATR, TP1=+3×ATR  → R:R 1.5:1
 *   Medium (1-3w):  SL=-3×ATR, TP1=+5×ATR  → R:R 1.67:1
 *   Long   (1-6m):  SL=-5×ATR, TP1=+10×ATR → R:R 2.0:1
 */
const HORIZON_ATR = {
  short:  { buy: { tp1: 3.0, tp2: 5.0,  sl: -2.0 }, sell: { tp1: -3.0, tp2: -5.0,  sl: 2.0 } },
  medium: { buy: { tp1: 5.0, tp2: 8.5,  sl: -3.0 }, sell: { tp1: -5.0, tp2: -8.5,  sl: 3.0 } },
  long:   { buy: { tp1: 10.0, tp2: 17.0, sl: -5.0 }, sell: { tp1: -10.0, tp2: -17.0, sl: 5.0 } }
};

/** Fallback % levels when ATR unavailable — wider than v75 to survive daily volatility */
const HORIZON_PCT = {
  short:  { buy: { tp1: 0.04,  tp2: 0.07,  sl: -0.025 }, sell: { tp1: -0.04,  tp2: -0.07,  sl: 0.025 } },
  medium: { buy: { tp1: 0.10,  tp2: 0.17,  sl: -0.06  }, sell: { tp1: -0.10,  tp2: -0.17,  sl: 0.06  } },
  long:   { buy: { tp1: 0.22,  tp2: 0.38,  sl: -0.12  }, sell: { tp1: -0.22,  tp2: -0.38,  sl: 0.12  } }
};

function roundPrice(x) {
  if (x == null || Number.isNaN(x)) return x;
  const a = Math.abs(x);
  const d = a >= 100 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return +x.toFixed(d);
}

/**
 * Professional entry/exit levels using real S/R levels as TP and SL anchors.
 * ATR used as minimum buffer and fallback. Analyst target used for long-term TP.
 *
 * SHORT  (1-3d):  SL = just below support1; TP1 = resistance1; TP2 = resistance2
 * MEDIUM (1-3wk): SL = below support2 or MA50; TP1 = resistance1-2; TP2 = prior high
 * LONG   (1-6mo): SL = below MA200; TP1 = analyst target (or resistance); TP2 = extended
 */
function applyServerPriceLevels(row, livePrice, tech = null, fund = null) {
  if (!row || !livePrice || livePrice <= 0) return row;
  const e = livePrice;
  const atr = tech?.atr14 || tech?.atr || null;
  const s1  = tech?.support1    || null;
  const s2  = tech?.support2    || null;
  const r1  = tech?.resistance1 || null;
  const r2  = tech?.resistance2 || null;
  const ma50  = tech?.ma50  || null;
  const ma200 = tech?.ma200 || null;
  const analystTarget = fund?.targetMeanPrice || null;

  const ratingKeys = { short: 'shortRating', medium: 'mediumRating', long: 'longRating' };

  for (const hz of ['short', 'medium', 'long']) {
    const isSell = ratingImpliesSell(row[ratingKeys[hz]]);
    let tp1, tp2, sl;

    if (!isSell) {
      // ── BUY LEVELS ──────────────────────────────────────────────────────────
      if (hz === 'short') {
        // SL: just below nearest support (within 3% of entry), else 2×ATR
        const s1ok = s1 && s1 < e * 0.999 && s1 > e * 0.97;
        sl  = s1ok ? roundPrice(s1 * 0.995) : atr ? roundPrice(e - 2*atr) : roundPrice(e * 0.975);
        // TP1: nearest resistance (within 8% of entry)
        const r1ok = r1 && r1 > e * 1.005 && r1 < e * 1.08;
        tp1 = r1ok ? roundPrice(r1 * 0.999) : atr ? roundPrice(e + 3*atr) : roundPrice(e * 1.04);
        // TP2: next resistance or extend
        const r2ok = r2 && r2 > tp1;
        tp2 = r2ok ? roundPrice(r2 * 0.999) : atr ? roundPrice(e + 5*atr) : roundPrice(e * 1.07);
      } else if (hz === 'medium') {
        // SL: below deeper support or MA50
        const s2ok = s2 && s2 < e * 0.995 && s2 > e * 0.93;
        const ma50ok = ma50 && ma50 < e * 0.99 && ma50 > e * 0.93;
        const slBase = s2ok ? s2 : (ma50ok ? ma50 : null);
        sl  = slBase ? roundPrice(slBase * 0.99) : atr ? roundPrice(e - 3*atr) : roundPrice(e * 0.94);
        // TP1: resistance1 or resistance2
        const r1ok = r1 && r1 > e * 1.01;
        const r2ok = r2 && r2 > e * 1.01;
        tp1 = r1ok ? roundPrice(r1) : (r2ok ? roundPrice(r2 * 0.95) : (atr ? roundPrice(e + 5*atr) : roundPrice(e * 1.10)));
        tp2 = r2ok && r2 > tp1 ? roundPrice(r2) : (atr ? roundPrice(e + 9*atr) : roundPrice(e * 1.17));
      } else { // long
        // SL: below MA200 (best long-term floor) or deep support
        const ma200ok = ma200 && ma200 < e * 0.995 && ma200 > e * 0.85;
        sl  = ma200ok ? roundPrice(ma200 * 0.97) : (s2 && s2 < e * 0.99 ? roundPrice(s2 * 0.97) : (atr ? roundPrice(e - 5*atr) : roundPrice(e * 0.88)));
        // TP1: analyst consensus target (primary), else S/R extension
        const targetOk = analystTarget && analystTarget > e * 1.08 && analystTarget < e * 2.5;
        tp1 = targetOk ? roundPrice(analystTarget) : (atr ? roundPrice(e + 10*atr) : roundPrice(e * 1.22));
        tp2 = targetOk ? roundPrice(analystTarget * 1.15) : (atr ? roundPrice(e + 17*atr) : roundPrice(e * 1.38));
      }
    } else {
      // ── SELL/SHORT LEVELS ──────────────────────────────────────────────────
      if (hz === 'short') {
        const r1ok = r1 && r1 > e * 1.001 && r1 < e * 1.03;
        sl  = r1ok ? roundPrice(r1 * 1.005) : atr ? roundPrice(e + 2*atr) : roundPrice(e * 1.025);
        const s1ok = s1 && s1 < e * 0.995 && s1 > e * 0.92;
        tp1 = s1ok ? roundPrice(s1 * 1.002) : atr ? roundPrice(e - 3*atr) : roundPrice(e * 0.96);
        const s2ok = s2 && s2 < tp1;
        tp2 = s2ok ? roundPrice(s2 * 1.002) : atr ? roundPrice(e - 5*atr) : roundPrice(e * 0.93);
      } else if (hz === 'medium') {
        const r1ok = r1 && r1 > e * 1.001 && r1 < e * 1.06;
        sl  = r1ok ? roundPrice(r1 * 1.005) : atr ? roundPrice(e + 3*atr) : roundPrice(e * 1.06);
        const s1ok = s1 && s1 < e * 0.99;
        tp1 = s1ok ? roundPrice(s1) : atr ? roundPrice(e - 5*atr) : roundPrice(e * 0.90);
        const s2ok = s2 && s2 < tp1;
        tp2 = s2ok ? roundPrice(s2) : atr ? roundPrice(e - 9*atr) : roundPrice(e * 0.83);
      } else { // long short
        sl  = r2 && r2 > e * 1.01 && r2 < e * 1.15 ? roundPrice(r2 * 1.005) : (atr ? roundPrice(e + 5*atr) : roundPrice(e * 1.12));
        tp1 = ma200 && ma200 < e * 0.99 ? roundPrice(ma200 * 1.01) : (atr ? roundPrice(e - 10*atr) : roundPrice(e * 0.78));
        tp2 = atr ? roundPrice(e - 17*atr) : roundPrice(e * 0.62);
      }
    }

    // Sanity check: ensure direction is correct
    if (!isSell) {
      if (sl  >= e)   sl  = atr ? roundPrice(e - 2*atr) : roundPrice(e * 0.975);
      if (tp1 <= e)   tp1 = atr ? roundPrice(e + 3*atr) : roundPrice(e * 1.04);
      if (tp2 <= tp1) tp2 = roundPrice(tp1 * 1.04);
    } else {
      if (sl  <= e)   sl  = atr ? roundPrice(e + 2*atr) : roundPrice(e * 1.025);
      if (tp1 >= e)   tp1 = atr ? roundPrice(e - 3*atr) : roundPrice(e * 0.96);
      if (tp2 >= tp1) tp2 = roundPrice(tp1 * 0.96);
    }

    row[hz + 'Entry']    = String(roundPrice(e));
    row[hz + 'Target1']  = String(tp1);
    row[hz + 'Target2']  = String(tp2);
    row[hz + 'StopLoss'] = String(sl);
  }

  // Back-compat aliases
  row.entry    = row.shortEntry;
  row.target1  = row.shortTarget1;
  row.target2  = row.shortTarget2;
  row.stopLoss = row.shortStopLoss;

  const mainSell = String(row.action || '').toLowerCase() === 'sell' || ratingImpliesSell(row.shortRating);
  if (mainSell) {
    row.sellEntry    = row.shortEntry;
    row.sellTarget1  = row.shortTarget1;
    row.sellTarget2  = row.shortTarget2;
    row.sellStopLoss = row.shortStopLoss;
  } else {
    row.sellEntry = row.sellTarget1 = row.sellTarget2 = row.sellStopLoss = '';
  }
  return row;
}

const ANALYSIS_SCHEMA_HINT = `{"ticker":"AAPL","name":"Apple Inc","sector":"Technology","price":"","change":"","action":"Buy",
"shortRating":"Strong Buy","mediumRating":"Buy","longRating":"Hold","shortConf":82,"mediumConf":75,"longConf":68,
"shortAction":"Buy","mediumAction":"Buy","longAction":"Hold",
"shortAnalysis":"","mediumAnalysis":"","longAnalysis":"","sellReason":"",
"rsi":"","macd":"","trend":"","support":"","resistance":"","ma20":"above","ma50":"above","ma200":"above","volume":"","pattern":"","candlePattern":"","candleSignal":"Bullish","candleConf":75,"backtestedWinRate":62,
"shortWeighting":"100% Technical","mediumWeighting":"70% Technical 30% News","longWeighting":"60% Technical 20% Fundamental 20% News",
"newsImpact":"","momentum":"Bullish","bollingerPos":"","pe":"","peg":"","revenueGrowth":"","earningsGrowth":"","catalyst":"","financialHealth":"Strong","industryPos":"Leader",
"risks":["","",""],"techSummary":"","fundSummary":"","nextEarningsDate":"","earningsTime":"","epsEstimate":"","epsPrior":""}`;

app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : req.body?.ticker ? [req.body.ticker] : [];
  const clean = [...new Set(tickers.map(t => String(t || '').trim().toUpperCase()).filter(Boolean))];
  if (!clean.length) return res.status(400).json({ error: 'tickers required' });

  const dashHint = req.body?.dashHint || null;

  // ── Step 1: Live prices ────────────────────────────────────────────────────
  const priceBySym = {};
  for (const sym of clean) {
    const p = await fetchSinglePrice(sym);
    if (p?.price) priceBySym[sym] = p;
  }
  if (!Object.keys(priceBySym).length) {
    return res.status(502).json({ error: 'Could not fetch live prices for requested symbols' });
  }

  // ── Step 2: OHLCV → full technicals + store 12mo series for backtest ───────
  const techBySym = {}, ohlcvBySym = {};
  await Promise.all(
    clean.filter(s => priceBySym[s]).map(async sym => {
      try {
        const got = await pickDailyWeeklyForAnalyze(sym);
        if (got?.daily) {
          techBySym[sym]  = buildFullTechResult(sym, got.daily, got.weekly);
          ohlcvBySym[sym] = got.daily;
        }
      } catch(e) { console.warn('analyze tech', sym, e.message); }
    })
  );

  const requestedWithPrice = clean.filter(s => priceBySym[s]);
  const withTechCount = requestedWithPrice.filter(s => techBySym[s]).length;
  if (!withTechCount) {
    return res.status(502).json({
      error:
        'Could not load enough daily price history from Yahoo for this symbol (need ~15+ sessions). Try another exchange suffix or retry.'
    });
  }

  // ── Step 3: Fundamentals (parallel — equities only) ───────────────────────
  const fundBySym = {};
  await Promise.all(
    clean.filter(s => priceBySym[s] && !s.includes('=F') && !s.includes('-USD')).map(async sym => {
      try {
        const f = await fetchFundamentals(sym);
        if (f) fundBySym[sym] = f;
      } catch(e) {}
    })
  );

  // ── Fundamentals already loaded in Step 3; detailed blocks for Claude built below ──

  let hintBlock = '';
  if (dashHint?.ticker) {
    hintBlock = `\n\nPrior ratings for ${dashHint.ticker}: Short=${dashHint.shortRating || '—'}, Medium=${dashHint.mediumRating || '—'}, Long=${dashHint.longRating || '—'} — keep broadly consistent unless indicators have changed.`;
  }

  const signalBySym = {};
  for (const sym of clean) {
    const tech  = techBySym[sym];
    const fund  = fundBySym[sym];
    const ohlcv = ohlcvBySym[sym];
    if (!tech) continue;
    const btShort  = ohlcv ? backtestSignal(ohlcv, 'short')  : null;
    const btMedium = ohlcv ? backtestSignal(ohlcv, 'medium') : null;
    const sigShort  = computeQuantSignal(tech, fund, 'short');
    const sigMedium = computeQuantSignal(tech, fund, 'medium');
    const sigLong   = computeQuantSignal(tech, fund, 'long');
    signalBySym[sym] = {
      short:  { ...sigShort,  backtest: btShort  },
      medium: { ...sigMedium, backtest: btMedium },
      long:   { ...sigLong,   backtest: null }
    };
    console.log(`${sym}: short ${sigShort.action}(${sigShort.buyScore}/${sigShort.sellScore}) bt=${btShort?.winRate??'N/A'}% ${btShort?.trades??0}trades`);
  }

  const tickerBlocksForClaude = clean.filter(s => priceBySym[s]).map(sym => {
    const p = priceBySym[sym];
    const t = techBySym[sym];
    const f = fundBySym[sym];
    const sig = signalBySym[sym];
    if (!sig) return `${sym}: no signal computed`;
    const fmtSig = (h) => {
      const v = sig[h];
      const bt = v.backtest;
      return `${v.rating} (buy=${v.buyScore} sell=${v.sellScore}) | real backtest: ${bt ? bt.winRate + '% win, ' + bt.trades + ' trades, avg ' + bt.avgReturnPct + '% return' : 'insufficient history'} | why: ${v.conditions.join('; ') || 'no strong conditions'}`;
    };
    let block = `### ${sym} @ $${p.price} ${p.currency||'USD'} (${p.change??0}% today)
  SHORT SIGNAL:  ${fmtSig('short')}
  MEDIUM SIGNAL: ${fmtSig('medium')}
  LONG SIGNAL:   ${fmtSig('long')}`;
    if (t) {
      block += `
  TECHNICALS: RSI=${t.rsi} MACD=${t.macd?.trend} ADX=${t.adx} | S1=${t.support1} R1=${t.resistance1} ATR=${t.atr} Pattern=${t.candlePattern}`;
      block += `
  MAs: ${t.aboveMa20?'✓':'✗'}MA20 ${t.aboveMa50?'✓':'✗'}MA50 ${t.aboveMa200?'✓':'✗'}MA200 | Trend=${t.trend20} Weekly=${t.weeklyTrend}`;
    }
    if (f) {
      const up = f.targetMeanPrice && p.price ? ((f.targetMeanPrice-p.price)/p.price*100).toFixed(0)+'%' : 'N/A';
      block += `
  FUNDAMENTALS: fPE=${f.forwardPE??'N/A'} PEG=${f.pegRatio??'N/A'} EpsGrowth=${f.earningsGrowth!=null?f.earningsGrowth+'%':'N/A'} RevGrowth=${f.revenueGrowth!=null?f.revenueGrowth+'%':'N/A'} Analyst=${f.recommendationKey??'N/A'} Target=$${f.targetMeanPrice??'N/A'}(${up}up)`;
    }
    return block;
  }).join('\n\n');

  const prompt = `You are a sell-side research analyst writing trade notes. The SIGNALS and SCORES below have already been computed by our quant engine — DO NOT change them. Your job is ONLY to write clear, specific analysis text explaining each signal.

PRE-COMPUTED SIGNALS (DO NOT MODIFY buyScore/sellScore/rating/backtestedWinRate):
${tickerBlocksForClaude}${hintBlock}

For each ticker, write these text fields ONLY. Reference specific prices, levels and indicators:
- shortAnalysis: 1-2 sentences explaining the short-term signal using S/R, candle, RSI
- mediumAnalysis: 1-2 sentences on trend structure and MA alignment
- longAnalysis: 1-2 sentences on fundamentals + MA200 regime
- sellReason: if sell signal, why (if buy, leave empty)
- risks: array of 3 specific risks with actual numbers (e.g. "RSI 71 — pullback risk to MA20 at $185")
- catalyst: near-term catalyst (earnings date, breakout level, etc.)
- momentum: Bullish / Bearish / Neutral
- sector: sector name

Return ONE JSON array. Use EXACTLY the shortRating/mediumRating/longRating/shortScore/mediumScore/longScore/shortSellScore/mediumSellScore/longSellScore/backtestedWinRate values shown in PRE-COMPUTED SIGNALS above — do not invent your own.
Schema: ${ANALYSIS_SCHEMA_HINT}
Output ONLY the JSON array. No markdown.`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system:
          'You are a quantitative equities analyst. Follow ALL mandatory analysis rules. '
          + 'Output ONLY a valid JSON array starting with [. No markdown, no code fences, no commentary.',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(120000)
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch {
      return res.status(upstream.status >= 400 ? upstream.status : 500).json({
        error: 'Anthropic response not JSON', preview: rawText.slice(0, 200)
      });
    }

    if (!upstream.ok) {
      const msg = data?.error?.message || data?.message || rawText.slice(0, 300);
      return res.status(upstream.status).json({ error: msg });
    }

    const aiText = extractAnthropicText(data);
    let stocks = tryParseJsonArray(aiText);
    if (!stocks?.length) {
      console.warn('Analyze parse fail. Snippet:', aiText.slice(0, 400));
      return res.status(500).json({ error: 'Could not parse analysis JSON', preview: aiText.slice(0, 200) });
    }

    // ── Merge server signals + prices — override Claude's scores ────────────────
    stocks = stocks.map(row => {
      const sym  = (row.ticker || '').toUpperCase();
      const pq   = priceBySym[sym];
      const tech = techBySym[sym];
      const fund = fundBySym[sym] || null;
      const sig  = signalBySym[sym];
      if (!pq) return row;

      row.price  = String(pq.price);
      row.change = pq.change != null ? String(pq.change) : row.change;

      if (sig) {
        row.shortScore        = sig.short.buyScore;
        row.mediumScore       = sig.medium.buyScore;
        row.longScore         = sig.long.buyScore;
        row.shortSellScore    = sig.short.sellScore;
        row.mediumSellScore   = sig.medium.sellScore;
        row.longSellScore     = sig.long.sellScore;
        row.shortRating       = sig.short.rating;
        row.mediumRating      = sig.medium.rating;
        row.longRating        = sig.long.rating;
        row.shortAction       = sig.short.action;
        row.mediumAction      = sig.medium.action;
        row.longAction        = sig.long.action;
        row.action            = sig.short.action;
        const bt = sig.short.backtest;
        row.backtestedWinRate = bt ? bt.winRate : sig.short.winRateHint;
        row.backtestTrades    = bt?.trades ?? null;
        row.backtestAvgReturn = bt?.avgReturnPct ?? null;
        row.backtestMedium    = sig.medium.backtest ? sig.medium.backtest.winRate : null;
        row.quantConditions   = sig.short.conditions;
        row.quantScore        = sig.short.buyScore;
        row.atr14             = tech?.atr ?? null;
        row.support1          = tech?.support1 ?? null;
        row.resistance1       = tech?.resistance1 ?? null;
        row.analystTarget     = fund?.targetMeanPrice ?? null;
      } else if (tech) {
        row.atr14        = tech.atr14 || tech.atr;
        row.atrPct       = tech.atrPct;
        row.support1     = tech.support1;
        row.resistance1  = tech.resistance1;
        row.analystTarget = fund?.targetMeanPrice || null;
      }

      const mergedRow = applyServerPriceLevels(row, +pq.price, tech || null, fund || null);
      mergeFundamentalsForUi(mergedRow, fund || null);
      return mergedRow;
    });

    console.log(`Analyze: ${stocks.length} tickers, ATR data for ${Object.keys(techBySym).length}`);
    res.json({ stocks });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: e.message || 'analyze failed' });
  }
});

// ── Claude proxy ─────────────────────────────────────────────────────────

// ── Earnings calendar — merged Finnhub/FMP/Yahoo (6h cache) ───────────────
let calCache = null;
let calTs = 0;
let calRangeKey = '';

app.get('/api/earnings-calendar', async (req, res) => {
  const { fromISO, endISO, windowSource } = resolveEarningsCalendarWindow(req);
  const rangeKey = `${fromISO}|${endISO}`;

  if (
    !req.query.force &&
    calCache &&
    calRangeKey === rangeKey &&
    Date.now() - calTs < 21600000
  ) {
    return res.json(calCache);
  }

  try {
    const merged = await mergedEarningsCalendarWidget(fromISO, endISO);
    if (merged.length) {
      calCache = merged;
      calTs = Date.now();
      calRangeKey = rangeKey;
    } else {
      calCache = null;
      calTs = 0;
      calRangeKey = '';
    }
    const src = `${process.env.FINNHUB_API_KEY ? 'finnhub ' : ''}${fmpAnyApiKey() ? 'fmp ' : ''}yahoo`;
    console.log(
      'Earnings calendar merged:',
      merged.length,
      'events',
      src.trim(),
      `${fromISO}→${endISO}`,
      `(${windowSource})`
    );
    res.json(merged);
  } catch (e) {
    console.error('Calendar merge:', e.message);
    res.status(500).json({ error: e.message || 'calendar failed' });
  }
});

app.get('/api/test-claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'No API key set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
      signal: AbortSignal.timeout(10000)
    });
    const body = await r.text();
    res.json({ status: r.status, body: body.slice(0, 500), keyPrefix: apiKey.slice(0, 10) + '...' });
  } catch(e) {
    res.json({ error: e.message });
  }
});

function resolveAnthropicApiKey(req) {
  const raw = req.headers['x-anthropic-key'];
  const fromHeader = typeof raw === 'string' ? raw.trim() : '';
  if (fromHeader.startsWith('sk-ant-') && fromHeader.length > 24) return fromHeader;
  const env = (process.env.ANTHROPIC_API_KEY || '').trim();
  return env || '';
}

app.post('/api/claude', async (req, res) => {
  const apiKey = resolveAnthropicApiKey(req);
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'No Anthropic API key. Paste your key in the app or set ANTHROPIC_API_KEY on the server.' }
    });
  }
  try {
    // Only send web-search beta header if the request actually uses the web_search tool
    const usesWebSearch = Array.isArray(req.body?.tools) && req.body.tools.some(t => t.type === 'web_search_20250305');
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(usesWebSearch ? { 'anthropic-beta': 'web-search-2025-03-05' } : {})
    };
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body)
    });
    const text = await upstream.text();
    console.log('Claude proxy:', upstream.status, usesWebSearch ? '(web-search)' : '(standard)', text.slice(0, 100));
    let data; try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Recalibrate existing history TP/SL levels using current ATR (fixes legacy tight stops)
app.post('/api/history/recalibrate-levels', async (req, res) => {
  const updated = [];
  const failed = [];

  // Get unique tickers from history that are still open or recent
  const tickers = [...new Set(
    tradeHistory
      .filter(h => {
        const hz = h.hz || 'short';
        const status = h[hz + 'Status'] || h.status || 'open';
        return status === 'open';
      })
      .map(h => h.ticker)
      .filter(Boolean)
  )];

  console.log('Recalibrate: fetching ATR for', tickers.length, 'open tickers');

  // Fetch ATR for each open ticker
  const atrMap = {};
  await Promise.all(tickers.map(async ticker => {
    try {
      const ohlcv = await fetchOHLCVForAnalysis(ticker);
      if (ohlcv) {
        const tech = computeTechnicals(ohlcv);
        if (tech?.atr14) atrMap[ticker] = tech.atr14;
      }
    } catch(e) { console.log('Recalibrate ATR err', ticker, e.message); }
  }));

  // Update open trades with new ATR-based levels
  tradeHistory = tradeHistory.map(h => {
    const hz = h.hz || 'short';
    const status = h[hz + 'Status'] || h.status || 'open';
    if (status !== 'open') return h; // don't touch closed/SL-hit trades

    const ticker = h.ticker;
    const atr14 = atrMap[ticker];
    const entryPrice = parseFloat(h.entry || h[hz + 'Entry'] || 0);
    if (!entryPrice || !atr14) { failed.push(ticker); return h; }

    const isSell = (h.action || '').toLowerCase() === 'sell';
    const side = isSell ? 'sell' : 'buy';

    const newH = { ...h };
    // Recalibrate all horizons
    for (const hzKey of ['short', 'medium', 'long']) {
      const hzStatus = h[hzKey + 'Status'] || (hzKey === hz ? status : 'open');
      if (hzStatus !== 'open') continue;
      const m = HORIZON_ATR[hzKey][side];
      newH[hzKey + 'Target1']  = String(roundPrice(entryPrice + m.tp1 * atr14));
      newH[hzKey + 'Target2']  = String(roundPrice(entryPrice + m.tp2 * atr14));
      newH[hzKey + 'StopLoss'] = String(roundPrice(entryPrice + m.sl  * atr14));
    }
    // Back-compat
    newH.target1  = newH.shortTarget1;
    newH.target2  = newH.shortTarget2;
    newH.stopLoss = newH.shortStopLoss;
    updated.push(ticker);
    return newH;
  });

  saveHistoryFile(tradeHistory);
  console.log('Recalibrate: updated', updated.length, 'trades, failed:', failed.length);
  res.json({ updated: updated.length, failed: failed.length, failedTickers: [...new Set(failed)] });
});

// One-time cleanup: fix impossible entries in server history (must be before SPA GET *)
app.post('/api/history/cleanup-entries', async (req, res) => {
  let fixed = 0;
  tradeHistory = tradeHistory.map(h => {
    if(!h.hz || !h.ticker) return h;
    const hz = h.hz;
    const status = h[hz+'Status'] || 'open';
    const isSell = (h.action||'').toLowerCase() === 'sell';
    const entry = parseFloat(h.entry || h[hz+'Entry'] || 0);
    if(!entry) return h;
    const tp1 = parseFloat(h.target1 || h[hz+'Target1'] || 0);
    let isBadEntry = false;
    if(isSell && tp1 && entry > 0) {
      if(entry < tp1 * 0.98) isBadEntry = true;
    } else if(!isSell && tp1 && entry > 0) {
      if(entry > tp1 * 1.02) isBadEntry = true;
    }
    if(!isBadEntry) return h;
    const newH = {...h};
    newH.entry = null;
    newH[hz+'Entry'] = null;
    newH[hz+'PnlDollar'] = null;
    newH[hz+'PnlPct'] = null;
    if(status === 'tp1_hit' || status === 'tp2_hit') newH[hz+'Status'] = 'open';
    fixed++;
    return newH;
  });
  saveHistoryFile(tradeHistory);
  console.log('Cleanup: fixed', fixed, 'bad entries');
  res.json({ fixed, total: tradeHistory.length });
});

// Static files AFTER /api routes so `/api/*` never gets swallowed by filesystem lookup
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('AlphaSignal on port', PORT);
  console.log('API key set:', !!process.env.ANTHROPIC_API_KEY);
  const likelyRender =
    String(process.env.RENDER || '').toLowerCase() === 'true' ||
    /\bonrender\.com\b/i.test(
      String(process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME || '')
    );
  if (likelyRender && bloombergBridgeUrlIsUnreachableFromInternet()) {
    console.warn(
      '→ BLOOMBERG_BRIDGE_URL is private/localhost — this host cannot reach your Bloomberg PC on the LAN.'
    );
    console.warn('  Use Cloudflare Tunnel / ngrok to expose the bridge HTTPS URL, or self-host API on-premises.');
  }
  // Test price fetch on startup
  fetchSinglePrice('AAPL').then(p => {
    if (p) console.log('✓ Yahoo Finance working - AAPL:', p.price, p.currency);
    else console.warn('✗ Yahoo Finance not working - prices will be unavailable');
  });
});
