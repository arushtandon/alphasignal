const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ── Price headers ─────────────────────────────────────────────────────────
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
};

// ── Fetch price for a single symbol via Yahoo Finance ─────────────────────
// Normalize symbol for Yahoo Finance (BRK.B -> BRK-B for some endpoints)
function yfSymbol(s) {
  // Yahoo Finance uses both formats; try original first, then with hyphen
  return s;
}

async function fetchSinglePrice(symbol) {
  // Try both the original symbol and hyphen variant (for BRK.B -> BRK-B)
  const symVariants = [symbol];
  if (symbol.includes('.') && !symbol.includes('.HK') && !symbol.includes('.L') 
      && !symbol.includes('.T') && !symbol.includes('.DE') && !symbol.includes('.PA')
      && !symbol.includes('.AS') && !symbol.includes('.SW') && !symbol.includes('.MC')
      && !symbol.includes('.BR') && !symbol.includes('.MI') && !symbol.includes('.=F')
      && symbol !== 'BTC-USD' && symbol !== 'ETH-USD') {
    symVariants.push(symbol.replace('.', '-'));
  }

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
  const symVariants = [
    symbol,
    ...(symbol.includes('.') &&
    !/[=-]/.test(symbol) &&
    !symbol.includes('.HK') &&
    !symbol.includes('.NS')
      ? [symbol.replace('.', '-')]
      : [])
  ];
  const hosts = ['query2', 'query1'];
  for (const sym of symVariants) {
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
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`;
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
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
      } catch(e) { return null; }
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

  // Try original and hyphen variant for BRK.B etc
  const chartSym = symbol;
  const chartSymAlt = (symbol.match(/^[A-Z]+\.[A-Z]$/)) ? symbol.replace('.', '-') : symbol;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(chartSym)}?range=${range}&interval=${interval}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(chartSym)}?range=${range}&interval=${interval}&includePrePost=false`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(chartSymAlt)}?range=${range}&interval=${interval}&includePrePost=false`,
  ];

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
  const symVariants = [symbol];
  if (symbol.includes('.') && !symbol.match(/\.(HK|L|T|DE|PA|AS|NS|SW|MC|BR|MI)$/)
      && !symbol.includes('=F') && !symbol.includes('-USD')) {
    symVariants.push(symbol.replace('.', '-'));
  }
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

// ── Server-side trade history (shared across devices) ──────────────────────
// In-memory store (persists while server is running, resets on redeploy)
// Use a simple JSON file for persistence on Render disk
const fs = require('fs');
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
      fmp_calendar: !!process.env.FMP_API_KEY,
      yahoo_fallback: true
    },
    hasKey: !!process.env.ANTHROPIC_API_KEY,
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

function fmpTimeToUi(row) {
  const t = String(row?.time || '').toLowerCase();
  if (t.includes('after')) return 'post-market';
  if (t.includes('pre') || t.includes('before')) return 'pre-market';
  return 'during-market';
}

let fmpCalCacheAll = { key: '', from: '', to: '', ts: 0, rows: [] };

async function fmpEarningCalendarByRange(fromISO, toISO) {
  const k = (process.env.FMP_API_KEY || '').trim();
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
      const r = await fetch(urlStr, { signal: AbortSignal.timeout(24000) });
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
    ['stable_hyphen', `https://financialmodelingprep.com/stable/earning-calendar?${q}`]
  ];

  let rows = [];
  for (const [label, u] of urls) {
    rows = await fetchOne(label, u);
    if (rows.length) break;
  }

  fmpCalCacheAll = { key: k, from: fromISO, to: toISO, ts: t, rows };
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
  const u = new URLSearchParams({ from: fromISO, to: toISO, token, international: 'true' });
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
    if (j && typeof j.error === 'string') console.warn('Finnhub calendar error:', j.error.slice(0, 200));
    return Array.isArray(j.earningsCalendar) ? j.earningsCalendar : [];
  } catch (e) {
    console.warn('Finnhub calendar', e.message);
    return [];
  }
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

async function yahooEarningsGapRow(ticker) {
  const tryOne = async (t) => {
    try {
      const qs = await quoteSummary(t, 'calendarEvents,summaryProfile');
      const cal = nextEarningsFromCalendar(qs);
      if (!cal.nextDate) return null;
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
  return row;
}

async function mergedEarningsCalendarWidget(fromISO, toISO) {
  const fhRaw = await finnhubEarningsCalendar(fromISO, toISO);
  const fmpRows = await fmpEarningCalendarByRange(fromISO, toISO);

  const byTicker = new Map();

  // Full-window merge (not limited to ~55 watchlist names) so the widget reflects the real market.
  fhRaw
    .filter((x) => x && x.symbol && isUpcomingCalRow(x, fromISO, toISO))
    .forEach((e) => {
      const row = mapFinnhubCalRow(e);
      const k = normalizeTickerMatch(row.ticker);
      if (!k) return;
      if (!byTicker.has(k)) byTicker.set(k, row);
    });

  fmpRows.forEach((e) => {
    const sym = fmpSymbol(e);
    if (!sym || !isUpcomingCalRow(e, fromISO, toISO)) return;
    const k = normalizeTickerMatch(sym);
    if (!k) return;
    if (!byTicker.has(k)) byTicker.set(k, mapFmpCalRow(e));
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

  await Promise.all(
    EARNINGS_CAL_SYMBOLS.map(async (tick) => {
      const nk = normalizeTickerMatch(tick);
      if (byTicker.has(nk)) return;
      const gap = await yahooEarningsGapRow(tick);
      if (
        gap &&
        gap.date &&
        gap.date >= fromISO &&
        gap.date <= toISO
      ) {
        byTicker.set(nk, gap);
      }
    })
  );

  const sorted = [...byTicker.values()]
    .filter((row) =>
      row && row.date && isValidEarningsCalendarRow(row.date, fromISO, toISO)
    )
    .sort((a, b) => {
      const da = a.date.localeCompare(b.date);
      if (da !== 0) return da;
      const pa = earningsTickerPriority(a.ticker);
      const pb = earningsTickerPriority(b.ticker);
      if (pa !== pb) return pa - pb;
      return normalizeTickerMatch(a.ticker).localeCompare(normalizeTickerMatch(b.ticker));
    });
  return sorted.slice(0, EARNINGS_CALENDAR_MAX);
}

// ── Earnings data — multi-source calendar (Finnhub / FMP preferred; Yahoo fallback) ─
app.get('/api/earnings/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const todayISO = new Date().toISOString().slice(0, 10);
  try {
    let nextDate = null;
    let nextDateEnd = null;
    let epsEst = null;
    let callTime = null;
    let quarter = null;
    let epsHistory = [];

    const toFar = new Date();
    toFar.setDate(toFar.getDate() + 120);
    const toISOsym = toFar.toISOString().slice(0, 10);

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
    const fhFuture = fhRows.filter((r) => String(r.date).slice(0, 10) >= todayISO);
    fhFuture.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let calendarPrimary = '';

    if (fhFuture.length) {
      const e = fhFuture[0];
      nextDate = String(e.date).slice(0, 10);
      if (e.epsEstimate != null && Number.isFinite(+e.epsEstimate)) epsEst = String(e.epsEstimate);
      if (finnhubHourToUi(e.hour) !== 'during-market') callTime = finnhubHourToUi(e.hour);
      if (e.quarter != null && e.year != null) quarter = `Q${e.quarter} FY${e.year}`;
      calendarPrimary = 'finnhub';
    }

    if (!nextDate && process.env.FMP_API_KEY) {
      const fmpArr = await fmpEarningCalendarByRange(todayISO, toISOsym);
      const hit =
        fmpArr.find((r) => normalizeTickerMatch(r.symbol) === normalizeTickerMatch(sym)) ||
        (sym === 'GOOGL'
          ? fmpArr.find((r) => normalizeTickerMatch(r.symbol) === 'GOOG')
          : sym === 'GOOG'
            ? fmpArr.find((r) => normalizeTickerMatch(r.symbol) === 'GOOGL')
            : null);
      if (hit?.date) {
        nextDate = String(hit.date).slice(0, 10);
        if (hit.epsEstimated != null) epsEst = String(hit.epsEstimated);
        else if (hit.eps != null) epsEst = String(hit.eps);
        calendarPrimary = 'fmp';
      }
    }

    let qs = await quoteSummary(sym, 'calendarEvents,earnings,earningsHistory');
    let fromCal = nextEarningsFromCalendar(qs);
    if ((!fromCal.nextDate || fromCal.nextDate < todayISO) && (sym === 'GOOGL' || sym === 'GOOG')) {
      const altQs = await quoteSummary(sym === 'GOOGL' ? 'GOOG' : 'GOOGL', 'calendarEvents,earnings,earningsHistory');
      const altCal = nextEarningsFromCalendar(altQs);
      if (altCal.nextDate && (!fromCal.nextDate || fromCal.nextDate < todayISO)) fromCal = altCal;
    }
    if (!nextDate && fromCal.nextDate && fromCal.nextDate >= todayISO) {
      nextDate = fromCal.nextDate;
      epsEst = epsEst || fromCal.epsEstimate || null;
      calendarPrimary = calendarPrimary || 'yahoo_quoteSummary';
    } else if (fromCal.epsEstimate && !epsEst) {
      epsEst = fromCal.epsEstimate;
    }

    let historySource = 'yahoo_chart_events';
    epsHistory = earningsHistoryFromQuoteSummary(qs);
    if (epsHistory.length) historySource = 'yahoo_quoteSummary_earningsHistory';
    else if (sym === 'GOOGL' || sym === 'GOOG') {
      const altQsHist = await quoteSummary(sym === 'GOOGL' ? 'GOOG' : 'GOOGL', 'earningsHistory');
      const altH = earningsHistoryFromQuoteSummary(altQsHist);
      if (altH.length) {
        epsHistory = altH;
        historySource = 'yahoo_quoteSummary_earningsHistory';
      }
    }

    const symbolsForChart =
      sym === 'GOOGL' || sym === 'GOOG' ? ['GOOGL', 'GOOG'] : [sym];
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
              const nowTs = Date.now() / 1000;
              const evts = Object.values(result.events?.earnings || {}).sort((a, b) => a.date - b.date);
              const fut = evts.filter((e) => e.date > nowTs).sort((a, b) => a.date - b.date);
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
    if (!epsHistory.length) {
      const histSyms =
        sym === 'GOOGL' || sym === 'GOOG' ? ['GOOGL', 'GOOG'] : symbolsForChart;
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
    const sourcesUsed = {};
    if (process.env.FINNHUB_API_KEY) sourcesUsed.finnhub = true;
    if (process.env.FMP_API_KEY) sourcesUsed.fmp = true;
    sourcesUsed.yahoo = true;

    res.json({
      symbol: sym,
      nextEarningsDate: nextDate,
      nextEarningsDateEnd: nextDateEnd,
      epsEstimate: epsEst,
      earningsTime: callTime || null,
      quarter,
      calendarPrimarySource: calendarPrimary || null,
      calendarSourcesConsulted: sourcesUsed,
      history: Array.isArray(epsHistory) ? epsHistory.slice(0, 4) : [],
      historySource
    });
  } catch (e) {
    console.error('Earnings err:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
 * Overwrite all entry / TP / SL fields using ATR-based levels (preferred)
 * or % fallback if ATR unavailable. Horizons always mathematically distinct.
 */
function applyServerPriceLevels(row, livePrice, atr14 = null) {
  if (!row || !livePrice || livePrice <= 0) return row;
  const hzKeys = ['short', 'medium', 'long'];
  const ratingKeys = { short: 'shortRating', medium: 'mediumRating', long: 'longRating' };

  for (const hz of hzKeys) {
    const sell = ratingImpliesSell(row[ratingKeys[hz]]);
    const side = sell ? 'sell' : 'buy';
    const e = livePrice;
    let tp1, tp2, sl;

    if (atr14 && atr14 > 0) {
      // ATR-based: stops clear daily noise, R:R guaranteed ≥1.5:1
      const m = HORIZON_ATR[hz][side];
      tp1 = e + m.tp1 * atr14;
      tp2 = e + m.tp2 * atr14;
      sl  = e + m.sl  * atr14;
    } else {
      // % fallback (wider than old v75 defaults)
      const p = HORIZON_PCT[hz][side];
      tp1 = e * (1 + p.tp1);
      tp2 = e * (1 + p.tp2);
      sl  = e * (1 + p.sl);
    }

    row[hz + 'Entry']    = String(roundPrice(e));
    row[hz + 'Target1']  = String(roundPrice(tp1));
    row[hz + 'Target2']  = String(roundPrice(tp2));
    row[hz + 'StopLoss'] = String(roundPrice(sl));
  }

  // Back-compat aliases (short horizon)
  row.entry    = row.shortEntry;
  row.target1  = row.shortTarget1;
  row.target2  = row.shortTarget2;
  row.stopLoss = row.shortStopLoss;

  // Sell overlay: mirror short-horizon sell levels
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

  // ── Step 2: OHLCV → real technical indicators (parallel) ──────────────────
  const techBySym = {};
  await Promise.all(
    clean.filter(s => priceBySym[s]).map(async sym => {
      const ohlcv = await fetchOHLCVForAnalysis(sym);
      if (ohlcv) {
        const tech = computeTechnicals(ohlcv);
        if (tech) techBySym[sym] = tech;
      }
    })
  );

  // ── Step 3: Build rich quantitative prompt ────────────────────────────────
  const tickerBlocks = clean.filter(s => priceBySym[s]).map(s => {
    const p = priceBySym[s];
    const t = techBySym[s];
    let block = `### ${s}  price=${p.price} ${p.currency || 'USD'}  chg=${p.change ?? 0}%`;
    if (t) {
      const maStatus = [
        t.aboveMa20  != null ? (t.aboveMa20  ? 'Above MA20'  : 'Below MA20')  : '',
        t.aboveMa50  != null ? (t.aboveMa50  ? 'Above MA50'  : 'Below MA50')  : '',
        t.aboveMa200 != null ? (t.aboveMa200 ? 'Above MA200' : 'Below MA200') : ''
      ].filter(Boolean).join(' | ');
      block += `
  ATR(14)=${t.atr14} (${t.atrPct}% daily range)
  RSI(14)=${t.rsi14}${t.rsi14 > 70 ? ' ⚠ OVERBOUGHT' : t.rsi14 < 30 ? ' ⚠ OVERSOLD' : ''}
  MA Status: ${maStatus}
  MA20=${t.ma20 ?? 'N/A'} | MA50=${t.ma50 ?? 'N/A'} | MA200=${t.ma200 ?? 'N/A'}
  Golden Cross: ${t.goldenCross === true ? 'YES (bullish)' : t.goldenCross === false ? 'NO — Death Cross (bearish)' : 'N/A'}
  MACD Histogram=${t.macdHistogram ?? 'N/A'} → ${t.macdBullish === true ? 'BULLISH momentum' : t.macdBullish === false ? 'BEARISH momentum' : 'N/A'}
  Bollinger Position=${t.bollingerPos ?? 'N/A'} (0.0=lower band, 1.0=upper band${t.bollingerPos != null && t.bollingerPos > 0.85 ? ' ⚠ OVEREXTENDED' : ''})
  Volume Ratio=${t.volRatio}x vs 20d avg${t.volRatio > 1.5 ? ' ✓ strong' : t.volRatio < 0.7 ? ' ⚠ weak' : ''}
  ── QUANT SCORE: ${t.score}/20 → ${t.quantAction} (${t.signalStrength}) ──`;
    } else {
      block += '\n  [Technical data unavailable — use price context only]';
    }
    return block;
  }).join('\n\n');

  let hintBlock = '';
  if (dashHint?.ticker) {
    hintBlock = `\n\nDashboard context for ${dashHint.ticker}: keep ratings broadly consistent with prior analysis — Short=${dashHint.shortRating || '—'}, Medium=${dashHint.mediumRating || '—'}, Long=${dashHint.longRating || '—'}.`;
  }

  const prompt =
    `You are a quantitative analyst at a top-tier hedge fund (think Renaissance Technologies / Two Sigma methodology). `
    + `Analyze the instruments below using ONLY the provided quantitative data. Do NOT guess or fabricate values.\n\n`
    + `INSTRUMENT DATA:\n${tickerBlocks}`
    + hintBlock
    + `\n\n`
    + `MANDATORY ANALYSIS RULES — violating these disqualifies the analysis:\n`
    + `1. TREND GATE: Only rate Buy/Strong Buy if price is Above MA50 AND MA50 > MA200 (uptrend regime). If either fails → Hold or Sell.\n`
    + `2. RSI GATE: RSI > 75 → CANNOT rate Buy (overbought, immediate pullback risk). RSI < 25 → CANNOT rate Sell (oversold bounce risk).\n`
    + `3. MACD GATE: MACD Histogram must be positive (bullish momentum) for any Buy rating in short/medium horizon.\n`
    + `4. BOLLINGER GATE: Bollinger Position > 0.88 → do NOT add new longs (price overextended above mean).\n`
    + `5. SCORE MAPPING — your ratings MUST align with the Quant Score:\n`
    + `   20-18: Strong Buy | 17-15: Buy | 14-9: Hold | 8-6: Sell | 5-0: Strong Sell\n`
    + `   You may adjust ±1 tier for strong fundamental catalysts, but NEVER override poor scores with generic optimism.\n`
    + `6. DIFFERENT HORIZONS: Short (1-3d) = pure technical momentum. Medium (1-3wk) = trend + momentum. Long (1-6mo) = trend + fundamentals.\n`
    + `   Each horizon MUST be independently justified — don't just clone the short rating.\n`
    + `7. backtestedWinRate: 60-72 only for score≥15, 50-59 for score 12-14, 40-49 for score 9-11, 30-39 for weaker setups. Be CONSERVATIVE.\n`
    + `8. risks: provide 3 SPECIFIC risks (not generic ones like "market volatility") based on the actual indicator readings.\n`
    + `\nReturn ONE JSON array (start with [) with one object per ticker. `
    + `Omit entry/target/stop/sellEntry/sellTarget fields — server computes those from ATR.\n`
    + `Schema:\n${ANALYSIS_SCHEMA_HINT}\n`
    + `Output ONLY the JSON array. No markdown, no code fences, no commentary.`;

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

    // ── Step 4: Merge prices + ATR-based deterministic levels ─────────────────
    stocks = stocks.map(row => {
      const sym = (row.ticker || '').toUpperCase();
      const pq = priceBySym[sym];
      if (!pq) return row;
      const tech = techBySym[sym];
      row.price  = String(pq.price);
      row.change = pq.change != null ? String(pq.change) : row.change;
      // Attach quant score metadata for UI display
      if (tech) {
        row.quantScore = tech.score;
        row.atr14      = tech.atr14;
        row.atrPct     = tech.atrPct;
      }
      return applyServerPriceLevels(row, +pq.price, tech?.atr14 || null);
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
let calEndISO = '';

app.get('/api/earnings-calendar', async (req, res) => {
  const todayISO = new Date().toISOString().slice(0, 10);
  const days = Math.min(45, Math.max(7, parseInt(String(req.query.days || ''), 10) || 14));
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + days);
  const endISO = horizon.toISOString().slice(0, 10);

  if (
    !req.query.force &&
    calCache &&
    calEndISO === endISO &&
    Date.now() - calTs < 21600000
  ) {
    return res.json(calCache);
  }

  try {
    const merged = await mergedEarningsCalendarWidget(todayISO, endISO);
    if (merged.length) {
      calCache = merged;
      calTs = Date.now();
      calEndISO = endISO;
    } else {
      calCache = null;
      calTs = 0;
      calEndISO = '';
    }
    const src = `${process.env.FINNHUB_API_KEY ? 'finnhub ' : ''}${process.env.FMP_API_KEY ? 'fmp ' : ''}yahoo`;
    console.log('Earnings calendar merged:', merged.length, 'events', src.trim());
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

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
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
  // Test price fetch on startup
  fetchSinglePrice('AAPL').then(p => {
    if (p) console.log('✓ Yahoo Finance working - AAPL:', p.price, p.currency);
    else console.warn('✗ Yahoo Finance not working - prices will be unavailable');
  });
});
