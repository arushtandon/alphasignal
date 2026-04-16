const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', hasKey: !!process.env.ANTHROPIC_API_KEY, ts: Date.now() });
});

// ── Live prices from Yahoo Finance ─────────────────────────────────────────
// Yahoo Finance v8 API — no auth required, works server-side
app.get('/api/prices', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.json({});

  const results = {};

  // Yahoo Finance accepts comma-separated symbols
  // Batch in groups of 20 to be safe
  const BATCH = 20;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const joined = batch.join(',');
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(joined)}&range=1d&interval=1d`;

    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      
      if (r.ok) {
        const data = await r.json();
        const spark = data?.spark?.result || [];
        spark.forEach(item => {
          const sym = item.symbol;
          const resp = item.response && item.response[0];
          const meta = resp && resp.meta;
          if (meta) {
            results[sym] = {
              price: meta.regularMarketPrice || meta.chartPreviousClose || null,
              prevClose: meta.chartPreviousClose || null,
              change: meta.regularMarketPrice && meta.chartPreviousClose
                ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)
                : null,
              currency: meta.currency || 'USD',
              marketState: meta.currentTradingPeriod ? 'open' : 'closed'
            };
          }
        });
      } else {
        console.warn('Yahoo Finance error:', r.status, r.statusText);
      }
    } catch(e) {
      console.error('Price fetch error:', e.message);
    }
  }

  // Fallback: try v7 quote API for any symbols that failed
  const failed = symbols.filter(s => !results[s]);
  if (failed.length > 0) {
    try {
      const joined = failed.join(',');
      const url2 = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(joined)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,currency`;
      const r2 = await fetch(url2, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (r2.ok) {
        const d2 = await r2.json();
        const quotes = d2?.quoteResponse?.result || [];
        quotes.forEach(q => {
          results[q.symbol] = {
            price: q.regularMarketPrice || null,
            prevClose: q.regularMarketPreviousClose || null,
            change: q.regularMarketChangePercent ? q.regularMarketChangePercent.toFixed(2) : null,
            currency: q.currency || 'USD',
            marketState: q.marketState || 'unknown'
          };
        });
      }
    } catch(e) {
      console.error('Fallback price fetch error:', e.message);
    }
  }

  console.log(`Prices fetched: ${Object.keys(results).length}/${symbols.length} symbols`);
  res.json(results);
});

// ── OHLCV chart data from Yahoo Finance ─────────────────────────────────────
app.get('/api/chart', async (req, res) => {
  const { symbol, range = '1mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!r.ok) {
      console.warn('Chart fetch error:', r.status, symbol);
      return res.status(r.status).json({ error: `Yahoo returned ${r.status}` });
    }

    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No chart data' });

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const adjclose = result.indicators?.adjclose?.[0]?.adjclose || quote.close;

    // Return clean OHLCV arrays
    res.json({
      ticker: symbol,
      currency: meta.currency || 'USD',
      timezone: meta.timezone || 'UTC',
      regularMarketPrice: meta.regularMarketPrice,
      timestamps,
      opens:   (quote.open   || []).map(v => v ? +v.toFixed(4) : null),
      highs:   (quote.high   || []).map(v => v ? +v.toFixed(4) : null),
      lows:    (quote.low    || []).map(v => v ? +v.toFixed(4) : null),
      closes:  (adjclose     || quote.close || []).map(v => v ? +v.toFixed(4) : null),
      volumes: (quote.volume || []).map(v => v || 0)
    });

  } catch(e) {
    console.error('Chart endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Claude AI proxy ─────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  }

  console.log('Model:', req.body && req.body.model);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const text = await upstream.text();
    console.log('Anthropic status:', upstream.status, text.substring(0, 200));

    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Models list ─────────────────────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
    const data = await r.text();
    res.status(r.status).send(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('AlphaSignal on port', PORT);
  console.log('API key set:', !!process.env.ANTHROPIC_API_KEY);
});
