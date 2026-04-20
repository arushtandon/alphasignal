const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', hasKey: !!process.env.ANTHROPIC_API_KEY, ts: Date.now() });
});

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

// ── Prices endpoint ───────────────────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.json({});

  const results = {};
  // Fetch concurrently in groups of 8
  const BATCH = 8;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(s => fetchSinglePrice(s)));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        results[batch[idx]] = r.value;
      }
    });
  }

  // For any symbols that failed, try getting latest close from chart endpoint
  const failed = symbols.filter(s => !results[s]);
  if (failed.length > 0) {
    console.log(`Trying chart fallback for: ${failed.join(',')}`);
    const chartFallbacks = await Promise.allSettled(failed.map(async sym => {
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

// ── Server-side trade history (shared across devices) ──────────────────────
// In-memory store (persists while server is running, resets on redeploy)
// Use a simple JSON file for persistence on Render disk
const fs = require('fs');
const HISTORY_FILE = '/tmp/alphasignal_history.json';

function loadHistoryFile() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch(e) { console.warn('History file load error:', e.message); }
  return [];
}

function saveHistoryFile(data) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data)); } 
  catch(e) { console.warn('History file save error:', e.message); }
}

let tradeHistory = loadHistoryFile();

// GET all history
app.get('/api/history', (req, res) => {
  res.json(tradeHistory);
});

// POST add trades (called when dashboard scan completes)
app.post('/api/history/add', express.json(), async (req, res) => {
  const trades = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Expected array' });
  
  const today = new Date().toDateString();
  
  // Remove only today's entries for these tickers to avoid duplicates
  const tickers = new Set(trades.map(t => t.ticker + '_' + t.hz));
  tradeHistory = tradeHistory.filter(h => {
    const k = h.ticker + '_' + h.hz;
    const isToday = new Date(h.entryDate||h.timestamp).toDateString() === today;
    return !(tickers.has(k) && isToday);
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
    const idx = tradeHistory.findIndex(h => h.ticker === u.ticker && h.hz === u.hz && h.entryDate === u.entryDate);
    if (idx >= 0) {
      tradeHistory[idx].pnlDollar = u.pnlDollar;
      tradeHistory[idx].pnlPct    = u.pnlPct;
      tradeHistory[idx].status    = u.status;
      tradeHistory[idx].currentPrice = u.currentPrice;
      tradeHistory[idx].exitPrice = u.exitPrice;
    }
  });
  saveHistoryFile(tradeHistory);
  res.json({ ok: true });
});

// DELETE clear history
app.delete('/api/history', (req, res) => {
  tradeHistory = [];
  saveHistoryFile(tradeHistory);
  res.json({ ok: true });
});


// ── Claude proxy ─────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

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
