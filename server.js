const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { buildFullUniverse, MARKET_LABEL: UNIVERSE_MARKET_LABEL } = require('./universe');

const app = express();
const PORT = process.env.PORT || 3000;

// Defense-in-depth: never let a single request-scoped bug crash-loop the whole
// service on Render. Log loudly and keep serving. (The real fix is still to not
// throw, but this prevents one bad code path from taking the site down.)
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err && err.stack ? err.stack : err);
});

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

function yahooSearchNewsRegionsForTicker(raw) {
  const s = String(raw || '').trim().toUpperCase();
  /** US + WORLD first; then exchange hints so non-US RICs aren’t stuck with region=US-only empty results. */
  const regions = ['US', 'WORLD'];
  if (/\.L$/.test(s)) regions.push('GB');
  if (/\.HK$|^(\d+)\.HK$/i.test(s)) regions.push('HK');
  if (/\.ST$/.test(s)) regions.push('SE');
  if (/\.T$/.test(s) && !/\.ST$/.test(s)) regions.push('JP');
  if (/\.NS$/.test(s)) regions.push('IN');
  if (/\.AS$/.test(s)) regions.push('NL');
  if (/\.DE$/.test(s)) regions.push('DE');
  if (/\.PA$/.test(s)) regions.push('FR');
  if (/\.(TO|V)$/.test(s)) regions.push('CA');
  if (/\.AX$/.test(s)) regions.push('AU');
  if (/\.SI$/.test(s)) regions.push('SG');
  if (/\.SW$/.test(s)) regions.push('CH');
  if (/\.OL$/.test(s)) regions.push('NO');
  if (/\.CO$/.test(s)) regions.push('DK');
  if (/\.MI$/.test(s)) regions.push('IT');
  if (/\.MC$/.test(s)) regions.push('ES');
  return [...new Set(regions)];
}

async function fetchNews(symbol, count = 8) {
  const raw = String(symbol || '').trim();
  if (!raw) return [];
  const pack = (items) =>
    (items || [])
      .map(n => ({
        title: n.title || '',
        publisher: n.publisher || '',
        time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : '',
        link: n.link || ''
      }))
      .slice(0, count);

  const queryVariants = [...new Set([raw, raw.replace(/\./g, '-'), raw.replace(/-/g, '.')])].filter(Boolean);
  const regionList = yahooSearchNewsRegionsForTicker(raw);
  const hosts = ['query1', 'query2'];
  for (const qv of queryVariants) {
    const q = encodeURIComponent(qv);
    for (const region of regionList) {
      for (const host of hosts) {
        const url = `https://${host}.finance.yahoo.com/v1/finance/search?q=${q}&lang=en-US&region=${region}&newsCount=${count}`;
        try {
          const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const d = await r.json();
          const items = d?.news || [];
          if (items.length) return pack(items);
        } catch (e) {
          console.warn('fetchNews', symbol, e.message);
        }
      }
    }
  }
  /** Finnhub covers many global symbols when Yahoo search returns nothing (common on cloud IPs + intl tickers). */
  try {
    const fh = await fetchFinnhubCompanyNewsForSymbol(raw);
    if (Array.isArray(fh) && fh.length) {
      return fh.slice(0, count).map(n => ({
        title: n.headline || n.title || '',
        publisher: n.source || 'Finnhub',
        time: (() => {
          const dt = n.datetime;
          if (dt == null) return '';
          const ms = typeof dt === 'number' ? (dt < 1e12 ? dt * 1000 : dt) : Date.parse(String(dt));
          return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
        })(),
        link: n.url || n.link || ''
      }));
    }
  } catch (e) {
    console.warn('fetchNews finnhub', symbol, e.message);
  }
  return [];
}

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
    marketState: q.marketState || null, // REGULAR | PRE | POST | CLOSED — drives entry semantics
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

/** Market cap USD from Yahoo v7 bulk (used for dashboard earnings calendar filtering). */
async function fetchYahooMarketCapsBulk(symbols) {
  const map = {};
  const uniq = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!uniq.length) return map;
  const BATCH = 48;
  const chunks = [];
  for (let i = 0; i < uniq.length; i += BATCH) chunks.push(uniq.slice(i, i + BATCH));

  async function oneBatch(batch) {
    const qs = batch.map((s) => encodeURIComponent(String(s))).join('%2C');
    const urls = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${qs}`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: YF_HEADERS,
          signal: AbortSignal.timeout(14000)
        });
        if (!r.ok) continue;
        const data = await r.json();
        const arr = data?.quoteResponse?.result || [];
        for (const q of arr) {
          const mc = Number(q?.marketCap ?? q?.regularMarketMarketCap ?? q?.enterpriseValue);
          if (!Number.isFinite(mc) || mc <= 0) continue;
          const orig = batch.find((b) => sameYahooSymbol(b, q.symbol));
          if (orig) map[orig] = mc;
        }
        return;
      } catch (e) {
        console.log('v7 mcap bulk err:', batch.slice(0, 4).join(','), e.message);
      }
    }
  }

  const CONCURRENCY = 5;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + CONCURRENCY).map(oneBatch));
  }
  return map;
}

function marketCapUsdForTicker(sym, capMap) {
  if (!sym || !capMap) return null;
  const k = String(sym).trim();
  let v = capMap[k];
  if (v != null) return v;
  const altDot = k.includes('.') ? k.replace(/\./g, '-') : k.replace(/-/g, '.');
  v = capMap[altDot];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Dashboard widget: keep up to `topN` rows per earnings date (largest market cap first). Missing caps sort last. */
function sliceEarningsCalendarTopMcapPerDay(merged, capMap, topN) {
  const n = Math.floor(Number(topN));
  if (!Array.isArray(merged) || !merged.length || !Number.isFinite(n) || n < 1) return merged;
  const capSafe = capMap && typeof capMap === 'object' ? capMap : {};
  const capRank = sym => {
    const c = marketCapUsdForTicker(sym, capSafe);
    return Number.isFinite(c) && c > 0 ? c : -1;
  };
  const byDay = new Map();
  for (const row of merged) {
    const d = String(row?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(row);
  }
  const out = [];
  for (const d of [...byDay.keys()].sort()) {
    const rows = byDay.get(d);
    rows.sort((a, b) => {
      const ca = capRank(a.ticker);
      const cb = capRank(b.ticker);
      if (cb !== ca) return cb - ca;
      return earningsTickerPriority(a.ticker) - earningsTickerPriority(b.ticker);
    });
    out.push(...rows.slice(0, Math.min(n, 50)));
  }
  return out.sort((a, b) => {
    const da = String(a.date || '').slice(0, 10).localeCompare(String(b.date || '').slice(0, 10));
    if (da !== 0) return da;
    const ca = capRank(a.ticker);
    const cb = capRank(b.ticker);
    if (cb !== ca) return cb - ca;
    return earningsTickerPriority(a.ticker) - earningsTickerPriority(b.ticker);
  });
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
        // Candles MUST use raw OHLC together — mixing adjusted close with raw open
        // makes bodies render the wrong colour (systematically red the further back
        // you go). Adjusted close is exposed separately for any continuity needs.
        opens:    (quote.open   || []).map(v => v != null ? +v.toFixed(4) : null),
        highs:    (quote.high   || []).map(v => v != null ? +v.toFixed(4) : null),
        lows:     (quote.low    || []).map(v => v != null ? +v.toFixed(4) : null),
        closes:   (quote.close  || []).map(v => v != null ? +v.toFixed(4) : null),
        adjcloses:(adjclose     || []).map(v => v != null ? +v.toFixed(4) : null),
        volumes:  (quote.volume || []).map(v => v || 0)
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
  // ── Stooq.com fallback — free, no API key, good .NS/.T coverage ──────────
  // India NSE: TCS.NS → tcs.ns | Japan TSE: 7203.T → 7203.jp | HK: 0700.HK → 0700.hk
  if (interval === '1d' && /\.(NS|BO|T|HK)$/i.test(symbol)) {
    try {
      const stooqSym = /\.T$/i.test(symbol)
        ? symbol.toLowerCase().replace(/\.t$/i, '.jp')
        : symbol.toLowerCase();
      const rangeMap = {'1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825};
      const days = rangeMap[range] ?? 730;
      const cutoff = Date.now() - days * 86400000;
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv' },
        signal: AbortSignal.timeout(15000)
      });
      if (r.ok) {
        const csv = await r.text();
        const lines = csv.trim().split('\n').slice(1).filter(l => /^\d{4}/.test(l));
        if (lines.length >= 15) {
          const data = lines.map(l => {
            const [date,o,h,lo,c,v='0'] = l.split(',');
            return { t: new Date(date).getTime()/1000, o:+o, h:+h, l:+lo, c:+c, v:+v };
          }).filter(d => d.c > 0 && d.t*1000 >= cutoff);
          if (data.length >= 15) {
            console.log(`Stooq: ${symbol}→${stooqSym} ${data.length} bars`);
            return data.sort((a,b) => a.t - b.t);
          }
        }
      }
    } catch(e) { console.log('Stooq fallback', symbol, e.message); }
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

/** Fast Stochastic %K/%D — a noise-tolerant oscillator for short-term reversal
 *  timing in choppy/ranging markets (where trend tools whipsaw). */
function calcStochastic(daily, kPeriod = 14, dPeriod = 3) {
  if (!daily || daily.length < kPeriod + dPeriod) return null;
  const kArr = [];
  for (let i = daily.length - dPeriod; i < daily.length; i++) {
    const win = daily.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...win.map(d => d.h));
    const ll = Math.min(...win.map(d => d.l));
    const c = daily[i].c;
    kArr.push(hh > ll ? 100 * (c - ll) / (hh - ll) : 50);
  }
  const k = kArr[kArr.length - 1];
  const d = kArr.reduce((a, b) => a + b, 0) / kArr.length;
  return { k: parseFloat(k.toFixed(1)), d: parseFloat(d.toFixed(1)) };
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

/** Supertrend (ATR bands). Returns direction, value, and flip signals for Strong Buy/Sell. */
function calcSupertrend(daily, period = 10, multiplier = 3) {
  if (!daily || daily.length < period + 3) return null;
  // O(n) rolling ATR (SMA of True Range over `period`, matching calcATRFull).
  const tr = new Array(daily.length).fill(0);
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].c;
    tr[i] = Math.max(daily[i].h - daily[i].l, Math.abs(daily[i].h - prev), Math.abs(daily[i].l - prev));
  }
  let trSum = 0;
  for (let i = 1; i <= period && i < daily.length; i++) trSum += tr[i];
  let finalUpper = null, finalLower = null, direction = 1, prevDir = 1;
  for (let i = period; i < daily.length; i++) {
    if (i > period) trSum += tr[i] - tr[i - period]; // slide window [i-period+1 .. i]
    const atr = trSum / period;
    if (!atr || atr <= 0) continue;
    const hl2 = (daily[i].h + daily[i].l) / 2;
    const bu = hl2 + multiplier * atr;
    const bl = hl2 - multiplier * atr;
    if (finalUpper == null) {
      finalUpper = bu; finalLower = bl; direction = daily[i].c >= bl ? 1 : -1;
      prevDir = direction;
      continue;
    }
    finalUpper = (bu < finalUpper || daily[i - 1].c > finalUpper) ? bu : finalUpper;
    finalLower = (bl > finalLower || daily[i - 1].c < finalLower) ? bl : finalLower;
    prevDir = direction;
    if (direction === 1) {
      if (daily[i].c < finalLower) direction = -1;
    } else if (daily[i].c > finalUpper) {
      direction = 1;
    }
  }
  const stVal = direction === 1 ? finalLower : finalUpper;
  if (stVal == null || !Number.isFinite(stVal)) return null;
  const flippedBull = direction === 1 && prevDir === -1;
  const flippedBear = direction === -1 && prevDir === 1;
  return {
    value: parseFloat(stVal.toFixed(4)),
    direction: direction === 1 ? 'bull' : 'bear',
    flippedBull, flippedBear,
    signal: flippedBull ? 'Strong Buy' : flippedBear ? 'Strong Sell' : direction === 1 ? 'Buy' : 'Sell'
  };
}

// Per-horizon Supertrend params: faster/tighter for short, slower/wider for long.
// This lets each timeframe read its own trend regime instead of one shared ST.
const SUPERTREND_PARAMS = {
  short:  { period: 7,  mult: 2 },
  medium: { period: 10, mult: 3 },
  long:   { period: 14, mult: 4 }
};
function calcSupertrendByHorizon(daily) {
  return {
    short:  calcSupertrend(daily, SUPERTREND_PARAMS.short.period,  SUPERTREND_PARAMS.short.mult),
    medium: calcSupertrend(daily, SUPERTREND_PARAMS.medium.period, SUPERTREND_PARAMS.medium.mult),
    long:   calcSupertrend(daily, SUPERTREND_PARAMS.long.period,   SUPERTREND_PARAMS.long.mult)
  };
}

/** Build weekly OHLCV bars from daily series (for walk-forward backtest). */
function dailyToWeeklyBars(daily) {
  if (!daily || !daily.length) return null;
  const weeks = [];
  let w = null;
  for (const bar of daily) {
    const d = new Date((bar.t || 0) * 1000);
    const weekKey = `${d.getUTCFullYear()}-W${Math.floor((d.getUTCDate() + 6) / 7)}-${d.getUTCMonth()}`;
    if (!w || w.key !== weekKey) {
      if (w) weeks.push(w);
      w = { key: weekKey, t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
    } else {
      w.h = Math.max(w.h, bar.h);
      w.l = Math.min(w.l, bar.l);
      w.c = bar.c;
      w.v = (w.v || 0) + (bar.v || 0);
    }
  }
  if (w) weeks.push(w);
  return weeks.length >= 10 ? weeks : null;
}

function sliceWeeklyForDailyIndex(daily, weeklyAll, idx) {
  if (weeklyAll && weeklyAll.length) {
    const cutT = daily[idx]?.t || 0;
    const sliced = weeklyAll.filter(w => (w.t || 0) <= cutT);
    if (sliced.length >= 10) return sliced;
  }
  return dailyToWeeklyBars(daily.slice(0, idx + 1));
}

const BACKTEST_WINDOW_BARS = 1260; // ~5 years of daily bars
const BACKTEST_WARMUP = 220;
// Trailing window fed to buildFullTechResult during walk-forward. Must exceed 200
// (for MA200) plus enough warmup for MACD/Supertrend to stabilise. Using a bounded
// window keeps each per-bar tech recompute O(1) amortised instead of O(n).
const BACKTEST_TECH_WINDOW = 280;

function horizonHoldDaysServer(hz) {
  return hz === 'short' ? 20 : hz === 'medium' ? 63 : 180;
}

// Build full technicals for the bar at index `i` using only a bounded trailing
// window of daily bars (and the weekly bars up to that date). This is the key to
// a fast walk-forward backtest: indicator helpers all read the tail of the array,
// so a fixed-size window gives the same recent values without O(n) per-call cost.
function techAtBoundedIndex(data, weeklyAll, i) {
  const lo = Math.max(0, i - (BACKTEST_TECH_WINDOW - 1));
  const dw = data.slice(lo, i + 1);
  let weekly;
  if (weeklyAll && weeklyAll.length) {
    const cutT = data[i]?.t || 0;
    weekly = weeklyAll.filter(w => (w.t || 0) <= cutT).slice(-160);
    if (!weekly || weekly.length < 10) weekly = dailyToWeeklyBars(dw);
  } else {
    weekly = dailyToWeeklyBars(dw);
  }
  return buildFullTechResult('X', dw, weekly);
}

/** Trailing stop from current technicals (no TP — capture full move, ratchet SL at EOD). */
function computeTrailingStopFromTech(tech, entry, hz, isSell, fund = null) {
  if (!tech || !entry || entry <= 0) return null;
  const e = entry;
  const atr = tech.atr || null;
  const chan = tech.channels || null;
  const d20 = chan?.daily20 || null;
  const d50 = chan?.daily50 || null;
  const w20 = chan?.weekly20 || null;
  const w50 = chan?.weekly50 || null;
  const s1 = tech.support1 || null;
  const s2 = tech.support2 || null;
  const r1 = tech.resistance1 || null;
  const ma50 = tech.ma50 || null;
  const ma200 = tech.ma200 || null;
  const st = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend || null;
  const cur = tech.currentPrice || e;
  // Minimum stop distance from CURRENT price — ATR-based (volatility-adaptive).
  // A fixed % stop is wrong: a quiet stock needs a tight stop, a volatile one needs
  // room. We size the floor as an ATR multiple (wider for longer holds), with a
  // small fixed % as a safety floor for stocks with missing/near-zero ATR.
  const atrPctNow = (atr && cur) ? (atr / cur) : null;
  // ATR multiple widens with the horizon — longer holds need much more room.
  const atrMult = hz === 'short' ? 2.0 : hz === 'medium' ? 4.0 : 6.5;
  // Minimum stop distance = the horizon's floor % (short 2.5% / medium 5% / long 8%),
  // widened further for volatile names via the ATR multiple. This keeps a long-term
  // stop genuinely long-term (never a 2% noise stop) and keeps the displayed level,
  // the exit simulator, and the backtest all in agreement.
  const hzFloors = (typeof HORIZON_MIN_PCT !== 'undefined' && HORIZON_MIN_PCT[hz]) ? HORIZON_MIN_PCT[hz] : null;
  const pctSafetyFloor = hzFloors ? hzFloors.sl : (hz === 'short' ? 0.025 : hz === 'medium' ? 0.05 : 0.08);
  const minGap = atrPctNow
    ? Math.max(atrMult * atrPctNow, pctSafetyFloor)
    : pctSafetyFloor;
  let sl;

  if (!isSell) {
    if (hz === 'short') {
      const chanSL = d20?.lower2 ?? null;
      const srSL = s1 && s1 < e * 0.999 && s1 > e * 0.92 ? s1 * (tech.s1Confluence ? 0.992 : 0.994) : null;
      const candidates = [chanSL, srSL].filter(v => v != null && v < e * 0.999 && v > e * 0.88);
      sl = candidates.length ? Math.max(...candidates) : (atr ? e - 2.0 * atr : e * 0.975);
    } else if (hz === 'medium') {
      const candidates = [w20?.lower1, d20?.lower2, s2 && s2 < e * 0.995 ? s2 * 0.993 : null, s1 && s1 < e * 0.995 ? s1 * 0.993 : null, ma50 ? ma50 * 0.97 : null]
        .filter(v => v != null && v < e * 0.998 && v > e * 0.85);
      sl = candidates.length ? Math.max(...candidates) : (atr ? e - 3.0 * atr : e * 0.94);
    } else {
      const candidates = [w20?.lower2, w50?.lower1, ma200 ? ma200 * 0.96 : null]
        .filter(v => v != null && v < e * 0.998 && v > e * 0.78);
      sl = candidates.length ? Math.max(...candidates) : (atr ? e - 5.5 * atr : e * 0.88);
    }
    if (st?.direction === 'bull' && st.value && st.value < e * 0.999 && st.value > e * 0.80) {
      sl = Math.max(sl, st.value);
    }
    // Never tighter than minGap below current price (room appropriate to the horizon).
    sl = Math.min(sl, cur * (1 - minGap));
  } else {
    if (hz === 'short') {
      const candidates = [d20?.upper2, r1 && r1 > e * 1.001 ? r1 * 1.008 : null].filter(v => v != null && v > e * 1.001 && v < e * 1.12);
      sl = candidates.length ? Math.min(...candidates) : (atr ? e + 2.0 * atr : e * 1.028);
    } else if (hz === 'medium') {
      const candidates = [w20?.upper1, d20?.upper2, r1 && r1 > e ? r1 * 1.008 : null].filter(v => v != null && v > e * 1.001 && v < e * 1.15);
      sl = candidates.length ? Math.min(...candidates) : (atr ? e + 3.0 * atr : e * 1.06);
    } else {
      const candidates = [w20?.upper2, w50?.upper1, ma200 ? ma200 * 1.04 : null].filter(v => v != null && v > e * 1.001 && v < e * 1.22);
      sl = candidates.length ? Math.min(...candidates) : (atr ? e + 5.5 * atr : e * 1.12);
    }
    if (st?.direction === 'bear' && st.value && st.value > e * 1.001 && st.value < e * 1.20) {
      sl = Math.min(sl, st.value);
    }
    // Never tighter than minGap above current price.
    sl = Math.max(sl, cur * (1 + minGap));
  }
  return sl ? roundPrice(sl) : null;
}

/** ATR×momentum multiples for TP1 / TP2 — NOT a multiple of stop distance.
 *  Strong ADX / aligned MACD+trend stretches targets; chop pulls them in.
 *  Targets must be HORIZON-SIZED: the medium stop is 4×ATR and the long stop is
 *  6.5×ATR, so TP1 below those multiples makes RR<1 by construction and the
 *  min-RR gate then rejects nearly every medium/long setup (the few that passed
 *  were marginal and skewed to SL hits — 68% SL-hit rate on closed medium buys).
 *  A 1–3mo trend leg runs ~8–15%, not the 3–4% a short-term TP1 implies. */
function atrMomentumMultiples(tech, hz) {
  const base = {
    short:  { tp1: 1.6, tp2: 2.8 },
    medium: { tp1: 4.2, tp2: 7.0 },
    long:   { tp1: 7.0, tp2: 11.0 }
  }[hz] || { tp1: 2.0, tp2: 3.5 };
  const adx = Number(tech && tech.adx) || 20;
  const macd = tech && tech.macd;
  const hist = macd && macd.histogram;
  const macdTrend = String((macd && macd.trend) || '').toLowerCase();
  const trend = String((tech && (tech.trend20 || tech.trend)) || '').toLowerCase();
  let scale = 1;
  if (adx >= 28) scale += 0.15;
  else if (adx < 16) scale -= 0.15;
  const alignedBull = (trend === 'uptrend' || trend === 'bull') && (hist > 0 || macdTrend === 'bullish');
  const alignedBear = (trend === 'downtrend' || trend === 'bear') && (hist < 0 || macdTrend === 'bearish');
  if (alignedBull || alignedBear) scale += 0.10;
  if (trend === 'sideways' || trend === 'ranging' || trend === 'neutral') scale -= 0.10;
  scale = Math.max(0.70, Math.min(1.35, scale));
  return { tp1: base.tp1 * scale, tp2: base.tp2 * scale, atrScale: scale };
}

/** Prefer a structural level near the ATR anchor (within 0.55×–1.55× ATR of it). */
function pickStructureNearAtr(cands, atrAnchor, entry, isSell, atr) {
  const band = Math.max(atr * 0.55, entry * 0.004);
  let best = null, bestDist = Infinity;
  for (const raw of cands || []) {
    const v = parseFloat(raw);
    if (!(v > 0)) continue;
    if (!isSell && !(v > entry * 1.002)) continue;
    if (isSell && !(v < entry * 0.998)) continue;
    const d = Math.abs(v - atrAnchor);
    if (d <= Math.abs(atrAnchor - entry) * 0.9 + band && d < bestDist) {
      best = v; bestDist = d;
    }
  }
  return best;
}

/**
 * TP1 / TP2 from ATR + momentum + nearby structure (channels / S/R).
 * Stops stay independent — TPs are NOT "minRR × stop distance".
 */
function computeAtrMomentumTargets(tech, entry, hz, isSell) {
  if (!tech || !entry || entry <= 0) return { tp1: null, tp2: null };
  const atr = tech.atr || tech.atr14 || entry * 0.02;
  const m = atrMomentumMultiples(tech, hz);
  const atrTp1 = isSell ? entry - m.tp1 * atr : entry + m.tp1 * atr;
  const atrTp2 = isSell ? entry - m.tp2 * atr : entry + m.tp2 * atr;
  const chan = tech.channels || {};
  const d20 = chan.daily20 || null;
  const d50 = chan.daily50 || null;
  const w20 = chan.weekly20 || null;
  const w50 = chan.weekly50 || null;
  let c1 = [], c2 = [];
  if (!isSell) {
    if (hz === 'short') {
      c1 = [d20 && d20.mean, tech.resistance1, tech.ma20];
      c2 = [d20 && d20.upper1, tech.resistance2, tech.resistance1, d20 && d20.upper2];
    } else if (hz === 'medium') {
      c1 = [w20 && w20.mean, d50 && d50.mean, tech.resistance1, tech.ma50];
      c2 = [w20 && w20.upper1, d20 && d20.upper2, tech.resistance2, w20 && w20.upper2];
    } else {
      c1 = [w20 && w20.upper1, w50 && w50.mean, tech.resistance1, tech.ma200];
      c2 = [w20 && w20.upper2, w50 && w50.upper1, tech.resistance2];
    }
  } else {
    if (hz === 'short') {
      c1 = [d20 && d20.mean, tech.support1, tech.ma20];
      c2 = [d20 && d20.lower1, tech.support2, tech.support1, d20 && d20.lower2];
    } else if (hz === 'medium') {
      c1 = [w20 && w20.mean, d50 && d50.mean, tech.support1, tech.ma50];
      c2 = [w20 && w20.lower1, d20 && d20.lower2, tech.support2, w20 && w20.lower2];
    } else {
      c1 = [w20 && w20.lower1, w50 && w50.mean, tech.support1, tech.ma200];
      c2 = [w20 && w20.lower2, w50 && w50.lower1, tech.support2];
    }
  }
  let tp1 = pickStructureNearAtr(c1, atrTp1, entry, isSell, atr) || atrTp1;
  let tp2 = pickStructureNearAtr(c2, atrTp2, entry, isSell, atr) || atrTp2;
  // Cap runaway structure (e.g. distant weekly band) at 1.75× the ATR anchor distance
  const max1 = Math.abs(atrTp1 - entry) * 1.75;
  const max2 = Math.abs(atrTp2 - entry) * 1.75;
  if (!isSell) {
    if (tp1 - entry > max1) tp1 = entry + max1;
    if (tp2 - entry > max2) tp2 = entry + max2;
    if (!(tp2 > tp1)) tp2 = Math.max(tp1 + 0.35 * atr, atrTp2);
  } else {
    if (entry - tp1 > max1) tp1 = entry - max1;
    if (entry - tp2 > max2) tp2 = entry - max2;
    if (!(tp2 < tp1)) tp2 = Math.min(tp1 - 0.35 * atr, atrTp2);
  }
  return { tp1: roundPrice(tp1), tp2: roundPrice(tp2), atrMult: m };
}

/** First profit target — ATR + momentum + structure (legacy name kept for callers). */
function computeFirstTargetFromTech(tech, entry, hz, isSell, stopLevel = null) {
  const t = computeAtrMomentumTargets(tech, entry, hz, isSell);
  return t.tp1;
}

function computeSecondTargetFromTech(tech, entry, hz, isSell, tp1 = null) {
  const t = computeAtrMomentumTargets(tech, entry, hz, isSell);
  let tp2 = t.tp2;
  if (tp1 != null && Number.isFinite(+tp1)) {
    if (!isSell && !(tp2 > +tp1)) tp2 = roundPrice(+tp1 * 1.04);
    if (isSell && !(tp2 < +tp1)) tp2 = roundPrice(+tp1 * 0.96);
  }
  return tp2;
}

/** Hysteresis signal-flip test — only exit when the picture TRULY reverses, not on
 *  a 1-point dip below the 62 entry threshold (that churn was destroying win rate). */
function signalFlipped(sig, isSell, hz = 'short') {
  if (!sig) return false;
  // Horizon-aware: the "conviction collapse" clause (score < 45) is right for
  // short-term mean-reversion, but on a 1–3mo trend trade any healthy pullback
  // drains the momentum gates below 45 and dumped the position at the low —
  // signal_exit was 60% of long-horizon closes at −1.2% avg. Longer horizons
  // demand a REAL reversal (opposing side takes over), not a mid-pullback wobble.
  if (hz === 'medium') {
    return isSell ? (sig.buyScore >= 62 || sig.sellScore < 35)
                  : (sig.sellScore >= 62 || sig.buyScore < 35);
  }
  if (hz === 'long') {
    return isSell ? (sig.buyScore >= 66) : (sig.sellScore >= 66);
  }
  return isSell
    ? (sig.buyScore >= 62 || sig.sellScore < 45)   // short exits when longs take over or conviction collapses
    : (sig.sellScore >= 62 || sig.buyScore < 45);  // long exits when shorts take over or conviction collapses
}

/** Short-horizon MEAN-REVERSION levels — target = reversion to the SD-channel mean
 *  (or nearest resistance/support); stop = beyond the opposite band by ATR. Used by
 *  BOTH the exit sim and the displayed price levels so they always agree. */
function computeMeanReversionLevels(tech, entry, isSell) {
  if (!tech || !entry || entry <= 0) return null;
  const atr = tech.atr || entry * 0.02;
  const mean = tech.channels?.daily20?.mean ?? tech.ma20 ?? entry;
  if (!isSell) {
    const cands = [mean, tech.resistance1].filter(v => v && v > entry * 1.005);
    let target = cands.length ? Math.min(...cands) : entry + 1.5 * atr;
    target = Math.max(Math.min(target, entry * 1.12), entry * 1.02);
    const lower2 = tech.channels?.daily20?.lower2;
    // ATR-based stop: 1.5×ATR beyond entry, or the channel lower-2σ, whichever is wider.
    let stop = Math.min(entry - 1.5 * atr, lower2 || entry * 0.97);
    // Clamp: at least 1.2×ATR away (noise floor), at most 8% away (risk cap).
    const minDist = Math.max(1.5 * atr, entry * 0.025); // ≥1.5×ATR and ≥2.5% — a stop inside daily noise is a donation
    stop = Math.min(stop, entry - minDist);
    stop = Math.max(stop, entry * 0.92);
    // Enforce horizon min-% + reward:risk floors so the bounce justifies the cost.
    const fl = applyHorizonMinPctFloors(entry, target, null, stop, false, 'short');
    return { target: roundPrice(fl.tp1), stop: roundPrice(fl.sl) };
  } else {
    const cands = [mean, tech.support1].filter(v => v && v < entry * 0.995);
    let target = cands.length ? Math.max(...cands) : entry - 1.5 * atr;
    target = Math.min(Math.max(target, entry * 0.88), entry * 0.98);
    const upper2 = tech.channels?.daily20?.upper2;
    let stop = Math.max(entry + 1.5 * atr, upper2 || entry * 1.03);
    const minDistS = Math.max(1.5 * atr, entry * 0.025);
    stop = Math.max(stop, entry + minDistS);
    stop = Math.min(stop, entry * 1.08);
    const fl = applyHorizonMinPctFloors(entry, target, null, stop, true, 'short');
    return { target: roundPrice(fl.tp1), stop: roundPrice(fl.sl) };
  }
}

/** Short-horizon MEAN-REVERSION exit: bank the bounce at the channel mean/resistance
 *  (or when the fast oscillator normalises), with a fixed stop beyond the band. No
 *  trend trailing — this is a range/swing exit suited to choppy markets. */
/** ── $10k-notional WHOLE-SHARE split for the TP1 partial ─────────────────────
 *  User rule: sell HALF the shares at TP1; when the count is odd, sell the
 *  nearest whole number BELOW half (floor) and let the larger half ride.
 *  Names quoted above the notional (can't fill even 1 share, e.g. ¥-quoted
 *  large prices) → null counts + fractional 0.5 fallback so PnL math is
 *  unchanged for them. frac = sold/total feeds the exit sim's TP1 partial. */
function computeShareSplit(entry) {
  const NOTIONAL = 10000;
  const e = parseFloat(entry);
  if (!e || !Number.isFinite(e) || e <= 0) return { total: null, sold: null, runner: null, frac: 0.5 };
  const total = Math.floor(NOTIONAL / e);
  if (total < 1) return { total: null, sold: null, runner: null, frac: 0.5 };
  const sold = Math.floor(total / 2); // odd count → the SMALLER half is banked at TP1
  return { total, sold, runner: total - sold, frac: sold / total };
}

/** ── GIVEBACK DONATION: favorable extreme from startMs → exit (or CMP) ───────
 *  USER SPEC (v145): the donation clock starts at the TP1 PRINT, not at entry —
 *  pass the TP1-print epoch as startMs (see findTp1PrintMs). Rows where TP1
 *  never printed have NO donation (null → UI shows —). exitMs bounds the scan
 *  so post-exit market moves never count as giveback. */
function computeGivebackDonation(bars, startMs, refPx, isSell, exitMs = null) {
  if (!Array.isArray(bars) || !bars.length || !(refPx > 0)) return null;
  let fav = null;
  for (const b of bars) {
    const bt = (b.t || 0) * 1000;
    if (bt < startMs) continue;
    if (exitMs && bt > exitMs) break;
    fav = isSell ? (fav == null ? b.l : Math.min(fav, b.l)) : (fav == null ? b.h : Math.max(fav, b.h));
  }
  if (!(fav > 0)) return null;
  const d = isSell ? (refPx - fav) / fav : (fav - refPx) / fav;
  return { pct: +(Math.max(0, d) * 100).toFixed(2), fav: roundPrice(fav) };
}

/** First bar on/after entry that PRINTS the stored TP1 level → its epoch ms.
 *  Null when TP1 never printed — in which case no donation clock exists. */
function findTp1PrintMs(bars, entryMs, tp1, isSell) {
  if (!Array.isArray(bars) || !bars.length || !(tp1 > 0)) return null;
  for (const b of bars) {
    const bt = (b.t || 0) * 1000;
    if (bt < entryMs) continue;
    if (!isSell && b.h >= tp1) return bt;
    if (isSell && b.l <= tp1) return bt;
  }
  return null;
}

async function simulateMeanReversionExit(data, entryIdx, entry, isSell, weeklyAll, fund = null, markPrice = null, liveMark = false, partialFrac = 0.5) {
  const holdDays = Math.min(15, horizonHoldDaysServer('short')); // banks quickly
  const maxJ = Math.min(entryIdx + holdDays, data.length - 1);
  const lastIdx = data.length - 1;
  // Only a GENUINELY elapsed hold period is a time-limit exit. If we merely ran
  // out of bars (a recent trade), the position is still OPEN — don't close it.
  const heldFull = (entryIdx + holdDays) <= lastIdx;
  // Mark an unrealised position at the LIVE price (when we've simply run out of
  // historical bars) rather than the last daily close — otherwise a trade entered
  // at yesterday's close shows ~0 PnL until the next daily bar prints.
  const markAt = (idx, fallback) => (markPrice && idx >= lastIdx) ? markPrice : fallback;
  const eTech = techAtBoundedIndex(data, weeklyAll, entryIdx);
  const lv = computeMeanReversionLevels(eTech, entry, isSell) || {};
  const target = lv.target;
  let trailingSl = lv.stop;
  // CANONICAL EXIT SPEC: TP1 books the PARTIAL; remainder rides the ratchet TSL.
  // TP2 = ATR+momentum REFERENCE only (never an exit / never 2×TP1 invent).
  const PARTIAL = (Number.isFinite(partialFrac) && partialFrac >= 0 && partialFrac < 1) ? partialFrac : 0.5;
  let tp2 = computeSecondTargetFromTech(eTech, entry, 'short', isSell, target);
  let tp1Hit = false, realized = 0, remaining = 1.0, _yc = 0;
  let tp2AltRet = null; // hypothetical full exit at TP2 — ANALYSIS ONLY, never an exit
  const longRet  = px => (px - entry) / entry;
  const shortRet = px => (entry - px) / entry;
  const ret = px => isSell ? shortRet(px) : longRet(px);
  const finish = (status, exitIdx, px) => ({ ret: realized + remaining * ret(px), status, exitIdx, tp1Hit, stopLoss: trailingSl, exitPrice: px, tp2Ref: tp2 != null ? tp2 : null, tp2AltRet });
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    if ((++_yc & 15) === 0) await new Promise(r => setImmediate(r));
    const bar = data[j];
    if (!tp1Hit) {
      // Conservative intrabar precedence preserved: stop is checked BEFORE target.
      if (!isSell && trailingSl && bar.l <= trailingSl) return finish('sl_hit', j, trailingSl);
      if (isSell && trailingSl && bar.h >= trailingSl) return finish('sl_hit', j, trailingSl);
      if (target && ((!isSell && bar.h >= target) || (isSell && bar.l <= target))) {
        // TP1: book the partial, convert the stop to the breakeven-floored ratchet
        realized += PARTIAL * ret(target);
        remaining -= PARTIAL;
        tp1Hit = true;
        trailingSl = trailingSl == null ? entry : (isSell ? Math.min(trailingSl, entry) : Math.max(trailingSl, entry));
      } else {
        // Oscillator-normalised bank (reversion complete, in profit) — PRE-TP1 full exit only
        const bt = techAtBoundedIndex(data, weeklyAll, j);
        const r2 = bt.rsi2, rr = bt.rsi;
        if (!liveMark && !isSell && bar.c > entry && ((r2 != null && r2 > 70) || rr >= 58)) return finish('signal_exit', j, bar.c);
        if (!liveMark && isSell && bar.c < entry && ((r2 != null && r2 < 30) || rr <= 42)) return finish('signal_exit', j, bar.c);
      }
    } else {
      // TP2 reference print → freeze the hypothetical full-exit outcome (analysis only)
      if (tp2 != null && tp2AltRet == null) {
        if (!isSell && bar.h >= tp2) tp2AltRet = realized + remaining * longRet(tp2);
        else if (isSell && bar.l <= tp2) tp2AltRet = realized + remaining * shortRet(tp2);
      }
      // POST-TP1 DAILY-%-MOVE RATCHET — identical to medium/long: favorable-day %
      // moves the stop the same %, adverse days leave it unchanged, breakeven floor.
      const prevClose = data[j - 1] ? data[j - 1].c : entry;
      const dayMovePct = prevClose > 0 ? (bar.c - prevClose) / prevClose : 0;
      if (!isSell) {
        if (dayMovePct > 0 && trailingSl != null) trailingSl = Math.max(trailingSl, trailingSl * (1 + dayMovePct));
        if (trailingSl == null) trailingSl = entry;
        trailingSl = Math.max(trailingSl, entry); // never below breakeven post-TP1
        if (bar.l <= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      } else {
        if (dayMovePct < 0 && trailingSl != null) trailingSl = Math.min(trailingSl, trailingSl * (1 + dayMovePct));
        if (trailingSl == null) trailingSl = entry;
        trailingSl = Math.min(trailingSl, entry); // never above breakeven post-TP1
        if (bar.h >= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      }
    }
    if (j === maxJ) {
      const st = tp1Hit ? (heldFull ? 'tp1_then_time' : 'tp1_open') : (heldFull ? 'time_limit' : 'open');
      return finish(st, j, markAt(j, bar.c));
    }
  }
  return finish(tp1Hit ? 'tp1_open' : 'open', maxJ, markAt(maxJ, data[maxJ].c));
}

/** Unified HYBRID exit simulator used by BOTH the backtest and the history P&L
 *  refresh, so reported win rates match what the live rules would have done.
 *  SHORT horizon delegates to the mean-reversion exit; medium/long book a partial
 *  at TP1 (locks a win) and ride the remainder with a wide chandelier trail. */
async function simulateHybridExit(data, entryIdx, entry, hz, isSell, weeklyAll, fund = null, markPrice = null, liveMark = false, partialFrac = 0.5) {
  if (!data || entryIdx == null || !(entry > 0)) return null;
  if (hz === 'short') return simulateMeanReversionExit(data, entryIdx, entry, isSell, weeklyAll, fund, markPrice, liveMark, partialFrac);
  const holdDays = horizonHoldDaysServer(hz);
  const maxJ = Math.min(entryIdx + holdDays, data.length - 1);
  const lastIdx = data.length - 1;
  const markAt = (idx, fallback) => (markPrice && idx >= lastIdx) ? markPrice : fallback;
  // Genuine time-limit only if the full hold elapsed; otherwise still OPEN.
  const heldFull = (entryIdx + holdDays) <= lastIdx;
  const entryTech = techAtBoundedIndex(data, weeklyAll, entryIdx);
  const atrEntry = entryTech.atr || entry * 0.02;
  let trailingSl = computeTrailingStopFromTech(entryTech, entry, hz, isSell, fund);
  const tp1 = computeFirstTargetFromTech(entryTech, entry, hz, isSell, trailingSl);
  // TP2 reference = ATR + momentum + structure (same as displayed levels).
  let tp2 = computeSecondTargetFromTech(entryTech, entry, hz, isSell, tp1);
  const PARTIAL = (Number.isFinite(partialFrac) && partialFrac >= 0 && partialFrac < 1) ? partialFrac : 0.5; // whole-share TP1 fraction (default fractional 50%)
  // Chandelier multiple for the post-TP1 runner — wide so winners can actually run.
  const runK = hz === 'short' ? 3.0 : hz === 'medium' ? 4.0 : 5.5;
  let tp1Hit = false, realized = 0, remaining = 1.0, _yc = 0;
  let tp2AltRet = null; // hypothetical 'full exit at TP2' outcome — ANALYSIS ONLY, never an exit
  let peak = isSell ? entry : entry; // best favorable price since entry

  const longRet  = px => (px - entry) / entry;
  const shortRet = px => (entry - px) / entry;
  const ret = px => isSell ? shortRet(px) : longRet(px);
  const finish = (status, exitIdx, px) => ({ ret: realized + remaining * ret(px), status, exitIdx, tp1Hit, stopLoss: trailingSl, exitPrice: px, tp2Ref: tp2 != null ? tp2 : null, tp2AltRet });

  for (let j = entryIdx + 1; j <= maxJ; j++) {
    if ((++_yc & 15) === 0) await new Promise(r => setImmediate(r));
    const bar = data[j];
    // 1) TP1 partial — lock a win, move remainder stop to breakeven
    if (!tp1Hit && tp1) {
      if (!isSell && bar.h >= tp1) {
        realized += PARTIAL * longRet(tp1); remaining -= PARTIAL; tp1Hit = true;
        trailingSl = trailingSl == null ? entry : Math.max(trailingSl, entry);
      } else if (isSell && bar.l <= tp1) {
        realized += PARTIAL * shortRet(tp1); remaining -= PARTIAL; tp1Hit = true;
        trailingSl = trailingSl == null ? entry : Math.min(trailingSl, entry);
      }
    }

    if (!tp1Hit) {
      // ── PRE-TP1: entry-anchored stop + hysteresis signal-flip exit ──
      // A medium/long TREND trade must be able to sit through ordinary pullbacks.
      // Ratcheting the stop daily from each new high (chandelier) before TP1
      // turned every ~4×ATR wiggle into an sl_hit — 68% of closed medium buys
      // died at the stop while time-limit exits won 83%. So pre-TP1 the stop
      // stays where it was set AT ENTRY (structure-based, horizon-wide); genuine
      // trend deterioration is handled by the signal-flip exit at the close.
      const barTech = techAtBoundedIndex(data, weeklyAll, j);
      const barSig = computeQuantSignal(barTech, fund, hz);
      if (!isSell && trailingSl && bar.l <= trailingSl) return finish('sl_hit', j, trailingSl);
      if (isSell && trailingSl && bar.h >= trailingSl)  return finish('sl_hit', j, trailingSl);
      if (!liveMark && signalFlipped(barSig, isSell, hz)) return finish('signal_exit', j, bar.c);
    } else {
      // TP2 is a REFERENCE level only — NEVER an actual exit. The first time it
      // prints we freeze the hypothetical "closed the runner at TP2" outcome so
      // History can compare it against what the ratchet actually delivered
      // (exit-quality analysis for smarter exits). The position keeps riding
      // the trailing stop regardless.
      if (tp2 != null && tp2AltRet == null) {
        if (!isSell && bar.h >= tp2) tp2AltRet = realized + remaining * longRet(tp2);
        else if (isSell && bar.l <= tp2) tp2AltRet = realized + remaining * shortRet(tp2);
      }
      // ── POST-TP1: DAILY-%-MOVE RATCHET (ratchet up only, never down). ──
      //    Each day the stock moves favorably by X%, the trailing stop moves the
      //    SAME X% in the favorable direction. On an adverse day the stop is left
      //    UNCHANGED (it never loosens). Floored at breakeven so the runner can
      //    never turn into a loss after TP1.
      const prevClose = data[j - 1] ? data[j - 1].c : entry;
      const todayClose = bar.c;
      const dayMovePct = prevClose > 0 ? (todayClose - prevClose) / prevClose : 0;
      if (!isSell) {
        // Long: favorable = up day. Ratchet stop up by today's % gain.
        if (dayMovePct > 0 && trailingSl != null) {
          const ratcheted = trailingSl * (1 + dayMovePct);
          trailingSl = Math.max(trailingSl, ratcheted);
        }
        if (trailingSl == null) trailingSl = entry;
        trailingSl = Math.max(trailingSl, entry); // never below breakeven post-TP1
        if (bar.l <= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      } else {
        // Short: favorable = down day. Ratchet stop down by today's % drop.
        if (dayMovePct < 0 && trailingSl != null) {
          const ratcheted = trailingSl * (1 + dayMovePct); // dayMovePct negative → lowers stop
          trailingSl = Math.min(trailingSl, ratcheted);
        }
        if (trailingSl == null) trailingSl = entry;
        trailingSl = Math.min(trailingSl, entry); // never above breakeven post-TP1
        if (bar.h >= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      }
    }
    // horizon time cap (only if the hold genuinely elapsed; else still open)
    if (j === maxJ) {
      const st = tp1Hit ? (heldFull ? 'tp1_then_time' : 'tp1_open') : (heldFull ? 'time_limit' : 'open');
      return finish(st, j, markAt(j, bar.c));
    }
  }
  // Still open at the last available bar (history mark-to-market on the remainder).
  return finish(tp1Hit ? 'tp1_open' : 'open', maxJ, markAt(maxJ, data[maxJ].c));
}

/** Each ticker may appear in only ONE buy horizon and ONE sell horizon (best score wins). */
function dedupeCrossTimeframePicks(dashData) {
  if (!dashData || typeof dashData !== 'object') return dashData;
  const buyPanes = [
    { key: 'short', scoreKey: 'shortScore' },
    { key: 'medium', scoreKey: 'mediumScore' },
    { key: 'long', scoreKey: 'longScore' }
  ];
  const sellPanes = [
    { key: 'shortSell', scoreKey: 'shortSellScore' },
    { key: 'medSell', scoreKey: 'mediumSellScore' },
    { key: 'longSell', scoreKey: 'longSellScore' }
  ];
  const bestBuy = new Map();
  for (const p of buyPanes) {
    for (const row of (dashData[p.key] || [])) {
      if (!row?.ticker) continue;
      const sc = row[p.scoreKey] || 0;
      const cur = bestBuy.get(row.ticker);
      if (!cur || sc > cur.score) bestBuy.set(row.ticker, { hz: p.key, score: sc });
    }
  }
  for (const p of buyPanes) {
    dashData[p.key] = (dashData[p.key] || []).filter(r => bestBuy.get(r.ticker)?.hz === p.key);
  }
  const bestSell = new Map();
  for (const p of sellPanes) {
    for (const row of (dashData[p.key] || [])) {
      if (!row?.ticker) continue;
      const sc = row[p.scoreKey] || 0;
      const cur = bestSell.get(row.ticker);
      if (!cur || sc > cur.score) bestSell.set(row.ticker, { hz: p.key, score: sc });
    }
  }
  for (const p of sellPanes) {
    dashData[p.key] = (dashData[p.key] || []).filter(r => bestSell.get(r.ticker)?.hz === p.key);
  }
  return dashData;
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

/** Volume-weighted S/R merged with pivots — confluence flags for tighter stops. */
function findVolumeWeightedSR(data, lookback = 60, bins = 25) {
  if (!data || data.length < 10) {
    return {
      support1: null,
      support2: null,
      support3: null,
      resistance1: null,
      resistance2: null,
      resistance3: null,
      s1Confluence: false,
      r1Confluence: false
    };
  }
  const recent = data.slice(-Math.min(lookback, data.length));
  const price = recent[recent.length - 1].c;
  const high = Math.max(...recent.map(d => d.h));
  const low = Math.min(...recent.map(d => d.l));
  const range = high - low;
  if (range <= 0) {
    return {
      support1: null,
      support2: null,
      support3: null,
      resistance1: null,
      resistance2: null,
      resistance3: null,
      s1Confluence: false,
      r1Confluence: false
    };
  }
  const binSize = range / bins;
  const volByBin = new Array(bins).fill(0);
  const priceBin = new Array(bins).fill(0);
  recent.forEach(d => {
    const avgPrice = (d.h + d.l) / 2;
    const bin = Math.min(bins - 1, Math.floor((avgPrice - low) / binSize));
    volByBin[bin] += (d.v || 1);
    priceBin[bin] = low + (bin + 0.5) * binSize;
  });
  const supports = [];
  const resistances = [];
  for (let i = 0; i < bins; i++) {
    const levelPrice = priceBin[i] || (low + (i + 0.5) * binSize);
    const volScore = volByBin[i];
    if (volScore <= 0) continue;
    if (levelPrice < price * 0.998) supports.push({ price: levelPrice, vol: volScore });
    if (levelPrice > price * 1.002) resistances.push({ price: levelPrice, vol: volScore });
  }
  supports.sort((a, b) => b.vol - a.vol);
  resistances.sort((a, b) => b.vol - a.vol);
  const pivotHighs = [];
  const pivotLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (
      recent[i].h >= recent[i - 1].h &&
      recent[i].h >= recent[i - 2].h &&
      recent[i].h >= recent[i + 1].h &&
      recent[i].h >= recent[i + 2].h
    )
      pivotHighs.push(recent[i].h);
    if (
      recent[i].l <= recent[i - 1].l &&
      recent[i].l <= recent[i - 2].l &&
      recent[i].l <= recent[i + 1].l &&
      recent[i].l <= recent[i + 2].l
    )
      pivotLows.push(recent[i].l);
  }
  const pivSup = pivotLows.filter(v => v < price * 0.998).sort((a, b) => b - a);
  const pivRes = pivotHighs.filter(v => v > price * 1.002).sort((a, b) => a - b);
  const mergeLevel = (vol, pivot) => {
    if (!vol && !pivot) return null;
    if (!vol) return parseFloat(pivot.toFixed(2));
    if (!pivot) return parseFloat(vol.price.toFixed(2));
    const near = Math.abs(vol.price - pivot) / pivot < 0.005;
    return near ? parseFloat(((vol.price + pivot) / 2).toFixed(2)) : parseFloat(vol.price.toFixed(2));
  };
  return {
    support1: mergeLevel(supports[0], pivSup[0]),
    support2: mergeLevel(supports[1], pivSup[1]),
    support3: supports[2] ? parseFloat(supports[2].price.toFixed(2)) : pivSup[2] ? parseFloat(pivSup[2].toFixed(2)) : null,
    resistance1: mergeLevel(resistances[0], pivRes[0]),
    resistance2: mergeLevel(resistances[1], pivRes[1]),
    resistance3: resistances[2] ? parseFloat(resistances[2].price.toFixed(2)) : pivRes[2] ? parseFloat(pivRes[2].toFixed(2)) : null,
    s1Confluence: !!(supports[0] && pivSup[0] && Math.abs(supports[0].price - pivSup[0]) / pivSup[0] < 0.01),
    r1Confluence: !!(resistances[0] && pivRes[0] && Math.abs(resistances[0].price - pivRes[0]) / pivRes[0] < 0.01)
  };
}

/** Linear regression channel with ±1σ / ±2σ bands (trend-aware mean). */
function calcLinRegChannel(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const n = slice.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (!denom) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const regValues = slice.map((_, i) => intercept + slope * i);
  const residuals = slice.map((v, i) => v - regValues[i]);
  const meanRes = residuals.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(residuals.reduce((s, r) => s + (r - meanRes) ** 2, 0) / n);
  const ssTot = slice.reduce((s, v) => s + (v - sumY / n) ** 2, 0);
  const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
  const rSq = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const mean = regValues[n - 1];
  return {
    mean: parseFloat(mean.toFixed(2)),
    upper1: parseFloat((mean + stdDev).toFixed(2)),
    upper2: parseFloat((mean + 2 * stdDev).toFixed(2)),
    lower1: parseFloat((mean - stdDev).toFixed(2)),
    lower2: parseFloat((mean - 2 * stdDev).toFixed(2)),
    slope: parseFloat(slope.toFixed(4)),
    rSquared: parseFloat(rSq.toFixed(3)),
    stdDev: parseFloat(stdDev.toFixed(4)),
    channelWidth: parseFloat((4 * stdDev).toFixed(2)),
    slopePct: parseFloat(((slope / mean) * 100).toFixed(3)),
  };
}

function calcMultiTFChannels(dailyCloses, weeklyCloses) {
  return {
    daily20: calcLinRegChannel(dailyCloses, 20),
    daily50: calcLinRegChannel(dailyCloses, 50),
    daily100: dailyCloses.length >= 100 ? calcLinRegChannel(dailyCloses, 100) : null,
    weekly20: weeklyCloses ? calcLinRegChannel(weeklyCloses, 20) : null,
    weekly50: weeklyCloses ? calcLinRegChannel(weeklyCloses, 50) : null
  };
}

/** Where price sits vs multi-TF channels (dashboard / diagnostics). */
function getChannelPosition(price, channels) {
  if (!channels || !price) return null;
  const d20 = channels.daily20;
  const d50 = channels.daily50;
  const w20 = channels.weekly20;
  const dailyPos = d20 ? (() => {
    if (price <= d20.lower2) return 'extreme_oversold';
    if (price <= d20.lower1) return 'oversold';
    if (price >= d20.upper2) return 'extreme_overbought';
    if (price >= d20.upper1) return 'overbought';
    if (price >= d20.mean * 0.998 && price <= d20.mean * 1.002) return 'at_mean';
    return price > d20.mean ? 'above_mean' : 'below_mean';
  })() : null;
  const weeklyPos = w20 ? (() => {
    if (price <= w20.lower2) return 'extreme_oversold';
    if (price <= w20.lower1) return 'oversold';
    if (price >= w20.upper2) return 'extreme_overbought';
    if (price >= w20.upper1) return 'overbought';
    return price > w20.mean ? 'above_mean' : 'below_mean';
  })() : null;
  const buyQuality =
    dailyPos === 'extreme_oversold' ? 'excellent'
      : dailyPos === 'oversold' ? 'good'
        : dailyPos === 'below_mean' ? 'fair'
          : dailyPos === 'at_mean' ? 'neutral' : 'poor';
  const sellQuality =
    dailyPos === 'extreme_overbought' ? 'excellent'
      : dailyPos === 'overbought' ? 'good'
        : dailyPos === 'above_mean' ? 'fair' : 'poor';
  return {
    dailyPos,
    weeklyPos,
    buyQuality,
    sellQuality,
    daily20: d20,
    daily50: d50,
    weekly20: w20,
    weekly50: channels.weekly50,
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

// ══════════════════════════════════════════════════════════════════════════════
// MARKET / INDEX MOMENTUM REGIME  (the "capture the tide" overlay)
// ------------------------------------------------------------------------------
// The per-stock signal has no awareness of the broad market. In a rising tape we
// were fading strength and dip-buying pullbacks with no tailwind; in a falling
// tape we were catching knives. This builds a risk-on / risk-off state from a
// benchmark index (SPY by default) so longs only press when the market tide is
// with them, and are throttled when it is against them. Keyed by trading day so
// the backtest can look up the regime as of each historical bar.
// ══════════════════════════════════════════════════════════════════════════════
const MARKET_BENCHMARK = process.env.MARKET_BENCHMARK || 'SPY';
const MARKET_OVERLAY_ENABLED = process.env.MARKET_OVERLAY !== '0'; // default ON

function _sma(arr, i, n) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k];
  return s / n;
}

/** Build a Map<'YYYY-MM-DD', {riskOff,trend,aboveMa200,ma50Rising,score}> from
 *  benchmark daily bars. trend: 'up' | 'down' | 'flat'. */
function buildMarketRegime(bars) {
  const map = new Map();
  if (!Array.isArray(bars) || bars.length < 60) return map;
  const closes = bars.map(b => +b.c).filter(Number.isFinite);
  for (let i = 0; i < bars.length; i++) {
    const c = +bars[i].c;
    if (!Number.isFinite(c)) continue;
    const ma50 = _sma(closes, i, 50);
    const ma200 = _sma(closes, i, 200);
    const ma50Prev = _sma(closes, i - 10 >= 0 ? i - 10 : 0, 50);
    const aboveMa200 = ma200 != null ? c > ma200 : c >= closes[Math.max(0, i - 1)];
    const aboveMa50 = ma50 != null ? c > ma50 : true;
    const ma50Rising = ma50 != null && ma50Prev != null ? ma50 > ma50Prev : true;
    const goldMa = ma50 != null && ma200 != null ? ma50 > ma200 : aboveMa50;
    let trend = 'flat';
    if (aboveMa200 && aboveMa50 && goldMa && ma50Rising) trend = 'up';
    else if (!aboveMa200 && !ma50Rising) trend = 'down';
    const riskOff = ma200 != null ? (!aboveMa200 && !ma50Rising) : false;
    const score = (aboveMa200 ? 1 : 0) + (aboveMa50 ? 1 : 0) + (goldMa ? 1 : 0) + (ma50Rising ? 1 : 0);
    const day = new Date(bars[i].t * 1000).toISOString().slice(0, 10);
    map.set(day, { riskOff, trend, aboveMa200, aboveMa50, ma50Rising, score });
  }
  return map;
}

/** Look up market regime as of a bar timestamp (falls back to the latest known). */
function marketRegimeAt(map, t, latest) {
  if (!map || !map.size) return null;
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  if (map.has(day)) return map.get(day);
  return latest || null;
}

// Live market-regime cache. The backtest passes an explicit per-bar regime; live
// signals fall back to this cached "current tide" so every pick is overlay-gated
// without threading the param through every call site. Only refreshed in server
// context (never during the acceptance script), so backtests stay deterministic.
let _liveMarketRegime = null;
let _liveMarketRegimeAt = 0;
const MARKET_REGIME_TTL = 6 * 60 * 60 * 1000; // 6h
async function refreshMarketRegime(force = false) {
  if (!MARKET_OVERLAY_ENABLED) return null;
  if (!force && _liveMarketRegime && Date.now() - _liveMarketRegimeAt < MARKET_REGIME_TTL) {
    return _liveMarketRegime;
  }
  try {
    const bars = await fetchOHLCV(MARKET_BENCHMARK, '2y', '1d').catch(() => null);
    if (bars && bars.length >= 60) {
      const map = buildMarketRegime(bars);
      const lastDay = new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10);
      _liveMarketRegime = map.get(lastDay) || [...map.values()].pop() || null;
      _liveMarketRegimeAt = Date.now();
      if (_liveMarketRegime) {
        console.log(`Market regime (${MARKET_BENCHMARK}): trend=${_liveMarketRegime.trend} riskOff=${_liveMarketRegime.riskOff} score=${_liveMarketRegime.score}/4`);
      }
    }
  } catch (e) { console.warn('refreshMarketRegime:', e.message); }
  return _liveMarketRegime;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTOR-LEVEL MOMENTUM  (the tide that actually matters for each name)
// ------------------------------------------------------------------------------
// A stock is gated by its HOME-COUNTRY, SECTOR-SPECIFIC index — not a single
// global ETF. An Indian bank (Kotak/ICICI) follows Bank Nifty (^NSEBANK); a
// Japanese chipmaker (Tokyo Electron) follows the Japan semiconductor ETF
// (2644.T); a US chip follows SOXX; a German industrial follows the DAX.
// Resolution: home-country sector index → home-country broad index → global
// sector cycle (semis→SOXX, gold→GDX) → SPY. Country is read from the Yahoo
// ticker suffix (.NS→India, .T→Japan, .HK→HK, .DE→Germany, .KS→Korea, …).
// ══════════════════════════════════════════════════════════════════════════════
const SECTOR_OVERLAY_ENABLED = process.env.SECTOR_OVERLAY !== '0'; // default ON

// ── COUNTRY detection from ticker suffix ────────────────────────────────────
// Yahoo suffixes tell us the listing venue → the stock's home market.
function countryOfSymbol(sym) {
  const up = String(sym || '').toUpperCase();
  const dot = up.lastIndexOf('.');
  const suf = dot >= 0 ? up.slice(dot) : '';
  switch (suf) {
    case '.NS': case '.BO': return 'IN';
    case '.T':  return 'JP';
    case '.HK': return 'HK';
    case '.DE': case '.F': case '.DU': case '.MU': case '.SG': case '.BE': return 'DE';
    case '.PA': return 'FR';
    case '.L':  return 'UK';
    case '.KS': case '.KQ': return 'KR';
    case '.TW': case '.TWO': return 'TW';
    case '.AS': case '.BR': case '.MI': case '.MC': case '.SW': case '.LS':
    case '.VI': case '.ST': case '.HE': case '.CO': case '.OL': case '.IR':
      return 'EU';
    default: return 'US';
  }
}

// Broad home-market index per country (the country-wise "tide" fallback).
const COUNTRY_INDEX = {
  US: 'SPY', IN: '^NSEI', JP: '^N225', HK: '^HSI', DE: '^GDAXI',
  FR: '^FCHI', UK: '^FTSE', KR: '^KS11', TW: '^TWII', EU: '^STOXX50E'
};

// Explicit ticker → canonical SECTOR KEY (highest priority). Covers the global
// semiconductor/AI complex the user called out across US/EU/JP/KR/TW/HK listings.
const TICKER_SECTOR_KEY = {};
(function seedTickerSectorKey() {
  const add = (key, list) => list.forEach(t => { TICKER_SECTOR_KEY[t.toUpperCase()] = key; });
  add('semis', ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'TXN', 'AMAT', 'MU', 'LRCX', 'KLAC',
    'ADI', 'MRVL', 'NXPI', 'ON', 'MCHP', 'STM', 'TSM', 'ASML', 'ARM', 'SMCI', 'MPWR', 'TER',
    'ENTG', 'SWKS', 'QRVO', 'WOLF', 'ASML.AS', '2330.TW', '2454.TW', '000660.KS', '005930.KS',
    '8035.T', '6857.T', '6146.T', 'ASM.AS', 'BESI.AS', 'IFX.DE', 'STMPA.PA', 'AIXA.DE', '0981.HK']);
  add('software', ['MSFT', 'ORCL', 'CRM', 'ADBE', 'NOW', 'SNOW', 'PLTR', 'PANW', 'CRWD', 'FTNT',
    'DDOG', 'NET', 'ZS', 'TEAM', 'WDAY', 'INTU', 'SAP', 'SAP.DE', 'DSY.PA']);
  add('comms', ['GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'T', 'VZ', 'CMCSA']);
  add('tech', ['AAPL', 'DELL', 'HPQ', 'ANET', 'CSCO', '6758.T', '6752.T', '6501.T', '6702.T', '6503.T',
    'TCS.NS', 'INFY.NS', 'WIPRO.NS', 'HCLTECH.NS', 'TECHM.NS', 'LTIM.NS',
    '0700.HK', '9988.HK', '3690.HK', '1810.HK', '9618.HK']);
  // Banks / financials — incl. the user's Indian bank examples → Bank Nifty.
  add('banks', ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC', 'TFC',
    'ICICIBANK.NS', 'KOTAKBANK.NS', 'HDFCBANK.NS', 'SBIN.NS', 'AXISBANK.NS', 'INDUSINDBK.NS',
    'BANKBARODA.NS', 'PNB.NS', 'FEDERALBNK.NS', 'IDFCFIRSTB.NS',
    '8306.T', '8316.T', '8411.T', 'HSBA.L', 'BARC.L', 'LLOY.L', 'NWG.L', 'STAN.L',
    'DBK.DE', 'CBK.DE', 'BNP.PA', 'GLE.PA', 'ACA.PA', '0005.HK', '1288.HK', '3988.HK', '939.HK']);
  add('financials', ['BLK', 'SCHW', 'AXP', 'SPGI', 'CB', 'BAJFINANCE.NS', 'BAJAJFINSV.NS',
    'SBILIFE.NS', 'HDFCLIFE.NS', '8591.T', '8604.T', '1299.HK', '2318.HK']);
  // Energy / oil & gas
  add('energy', ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'OXY',
    'RELIANCE.NS', 'ONGC.NS', 'BPCL.NS', 'IOC.NS', 'GAIL.NS',
    'SHEL.L', 'BP.L', 'TTE.PA', 'SHEL.AS', '0857.HK', '0386.HK', '883.HK']);
  // Autos
  add('auto', ['TSLA', 'F', 'GM',
    'TATAMOTORS.NS', 'MARUTI.NS', 'M&M.NS', 'BAJAJ-AUTO.NS', 'EICHERMOT.NS', 'HEROMOTOCO.NS',
    '7203.T', '7267.T', '7201.T', '7269.T', 'MBG.DE', 'BMW.DE', 'VOW3.DE', 'P911.DE', 'STLA.MI', 'RNO.PA']);
  // Healthcare / pharma
  add('health', ['JNJ', 'PFE', 'MRK', 'LLY', 'ABBV', 'UNH', 'TMO', 'ABT', 'BMY', 'AMGN', 'GILD',
    'SUNPHARMA.NS', 'DRREDDY.NS', 'CIPLA.NS', 'DIVISLAB.NS', 'APOLLOHOSP.NS',
    'AZN.L', 'GSK.L', 'SAN.PA', 'BAYN.DE', 'NOVN.SW', '4502.T', '4503.T', '4568.T']);
  // Consumer staples
  add('staples', ['PG', 'KO', 'PEP', 'WMT', 'COST', 'MDLZ', 'CL', 'MO', 'PM',
    'HINDUNILVR.NS', 'ITC.NS', 'NESTLEIND.NS', 'BRITANNIA.NS', 'TATACONSUM.NS',
    'ULVR.L', 'DGE.L', 'BATS.L', 'OR.PA', 'BN.PA', '2503.T', '2802.T', '2914.T']);
  // Consumer discretionary / retail
  add('discretionary', ['AMZN', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'TJX', 'BKNG',
    'TITAN.NS', 'DMART.NS', 'TRENT.NS', 'MC.PA', 'RMS.PA', 'KER.PA', 'ADS.DE',
    '9983.T', '9984.T', '1928.HK']);
  // Industrials
  add('industrials', ['CAT', 'BA', 'GE', 'HON', 'UPS', 'RTX', 'LMT', 'DE', 'MMM', 'UNP',
    'LT.NS', 'ADANIPORTS.NS', 'SIEMENS.NS', 'SIE.DE', 'AIR.PA', 'SU.PA', '7011.T', '6301.T', '6367.T']);
  // Materials / metals
  add('materials', ['LIN', 'SHW', 'FCX', 'NEM', 'NUE',
    'TATASTEEL.NS', 'HINDALCO.NS', 'JSWSTEEL.NS', 'COALINDIA.NS', 'ULTRACEMCO.NS', 'GRASIM.NS',
    'BHP.L', 'RIO.L', 'GLEN.L', 'BAS.DE', 'AI.PA', '5401.T']);
  // Utilities
  add('utilities', ['NEE', 'DUK', 'SO', 'D', 'AEP',
    'NTPC.NS', 'POWERGRID.NS', 'TATAPOWER.NS', 'NG.L', 'SSE.L', 'ENGI.PA', 'RWE.DE', '9501.T', '9531.T']);
  // Real estate
  add('realestate', ['PLD', 'AMT', 'EQIX', 'SPG', 'DLF.NS', 'LODHA.NS', 'LAND.L', '1109.HK', '0016.HK', '8801.T']);
})();

// Sector / industry keyword → canonical SECTOR KEY (when no explicit override).
const SECTOR_KEYWORD_KEY = [
  [/semiconduct|chip|foundr/i, 'semis'],
  [/software|internet|application|cloud|cyber/i, 'software'],
  [/communication|media|telecom|entertainment|interactive/i, 'comms'],
  [/technolog|hardware|electronic|it services|information technolog/i, 'tech'],
  [/bank/i, 'banks'],
  [/financ|insurance|capital market|asset manage|broker/i, 'financials'],
  [/oil|gas|energy|petroleum|coal|drilling/i, 'energy'],
  [/gold|silver|precious|miner/i, 'gold'],
  [/health|pharma|biotech|medical|life science|drug/i, 'health'],
  [/material|chemical|metal|steel|mining|paper|packaging/i, 'materials'],
  [/auto|vehicle/i, 'auto'],
  [/retail|consumer discretion|apparel|restaurant|hotel|leisure|luxury/i, 'discretionary'],
  [/consumer staple|food|beverage|household|tobacco|grocery/i, 'staples'],
  [/industrial|aerospace|defense|machinery|transport|airline|logistics|construction/i, 'industrials'],
  [/utilit|electric|water|power/i, 'utilities'],
  [/real estate|reit|property/i, 'realestate']
];

// European sector benchmarks — iShares STOXX Europe 600 sector UCITS ETFs (Xetra).
// The STOXX Europe 600 spans DE/FR/UK/NL/CH/etc., so these serve all European
// listings. Only high-confidence, VERIFIED-fetchable tickers are mapped; sectors
// without a confident mapping fall back to the home-country broad index.
const EU_SECTOR = {
  banks: 'EXV1.DE', financials: 'EXV5.DE', comms: 'EXV2.DE', tech: 'EXV3.DE',
  software: 'EXV3.DE', semis: 'EXV3.DE', health: 'EXV4.DE', industrials: 'EXV6.DE',
  energy: 'EXH1.DE', staples: 'EXH3.DE', utilities: 'EXH4.DE', materials: 'EXH8.DE'
};

// (country → sector key → benchmark symbol). Only VERIFIED-fetchable symbols.
const COUNTRY_SECTOR = {
  US: { semis: 'SOXX', software: 'IGV', tech: 'XLK', comms: 'XLC', banks: 'XLF',
    financials: 'XLF', energy: 'XLE', health: 'XLV', materials: 'XLB', gold: 'GDX',
    discretionary: 'XLY', auto: 'XLY', staples: 'XLP', industrials: 'XLI',
    utilities: 'XLU', realestate: 'XLRE' },
  IN: { banks: '^NSEBANK', financials: '^NSEBANK', tech: '^CNXIT', software: '^CNXIT',
    semis: '^CNXIT', comms: '^CNXIT', auto: '^CNXAUTO', discretionary: '^CNXAUTO',
    health: '^CNXPHARMA', staples: '^CNXFMCG', materials: '^CNXMETAL', gold: '^CNXMETAL',
    energy: '^CNXENERGY', utilities: '^CNXENERGY', realestate: '^CNXREALTY',
    industrials: '^CNXINFRA' },
  JP: { semis: '2644.T', tech: '1625.T', software: '1625.T', banks: '1631.T',
    financials: '1631.T', health: '1621.T', staples: '1617.T', realestate: '1633.T' },
  HK: { tech: '3067.HK', semis: '3067.HK', software: '3067.HK', comms: '3067.HK' },
  DE: EU_SECTOR, FR: EU_SECTOR, UK: EU_SECTOR, EU: EU_SECTOR
};

// Commodity / crypto futures → their tracking ETF (or BTC as the crypto tide).
// Gates each commodity by its own complex's momentum (energy→USO, precious→metal
// ETF, base metal→copper, alt-coin→BTC), per the commodity-specific request.
const COMMODITY_BENCHMARK = {
  'GC=F': 'GLD', 'SI=F': 'SLV', 'PL=F': 'PPLT', 'PA=F': 'PALL',
  'CL=F': 'USO', 'BZ=F': 'BNO', 'NG=F': 'UNG', 'HG=F': 'CPER',
  'BTC-USD': 'BTC-USD', 'ETH-USD': 'BTC-USD'
};

// Genuinely global sector cycles — used only when the home country has no local
// sector index for that sector (a Taiwanese/Korean chipmaker → global semis).
const GLOBAL_SECTOR_FALLBACK = { semis: 'SOXX', gold: 'GDX' };

/** Canonical sector key for a symbol: explicit override → fundamentals keyword. */
function sectorKeyForSymbol(sym) {
  const up = String(sym || '').toUpperCase();
  if (TICKER_SECTOR_KEY[up]) return TICKER_SECTOR_KEY[up];
  const base = up.split('.')[0];
  if (TICKER_SECTOR_KEY[base]) return TICKER_SECTOR_KEY[base];
  const fe = fundCache.get(sym) || fundCache.get(base);
  const sect = fe && fe.data ? String(fe.data._fmpSector || fe.data._yahooSector || '') : '';
  if (sect) for (const [re, key] of SECTOR_KEYWORD_KEY) if (re.test(sect)) return key;
  return null;
}

/** The right benchmark for a stock: home-country SECTOR index → home-country broad
 *  index → global sector fallback → SPY. This is the country-wise, sector-wise
 *  tide (India bank → ^NSEBANK, Japan chip → 2644.T, US chip → SOXX, etc.). */
function sectorEtfForSymbol(sym) {
  if (!sym) return 'SPY';
  const up = String(sym).toUpperCase();
  if (COMMODITY_BENCHMARK[up]) return COMMODITY_BENCHMARK[up]; // commodity/crypto
  const country = countryOfSymbol(sym);
  const key = sectorKeyForSymbol(sym);
  if (key) {
    const cs = COUNTRY_SECTOR[country];
    if (cs && cs[key]) return cs[key];
    if (GLOBAL_SECTOR_FALLBACK[key]) return GLOBAL_SECTOR_FALLBACK[key];
  }
  return COUNTRY_INDEX[country] || 'SPY';
}

// Full set of benchmark symbols we may need to keep regimes for.
function allBenchmarkSymbols() {
  const s = new Set(Object.values(COUNTRY_INDEX));
  for (const cs of Object.values(COUNTRY_SECTOR)) for (const v of Object.values(cs)) s.add(v);
  for (const v of Object.values(GLOBAL_SECTOR_FALLBACK)) s.add(v);
  for (const v of Object.values(COMMODITY_BENCHMARK)) s.add(v);
  return [...s];
}

// Live benchmark-regime cache: Map<symbol, regime>. Refreshed with the market.
const _sectorRegimeCache = new Map();
let _sectorRegimeAt = 0;
async function refreshSectorRegimes(force = false) {
  if (!(MARKET_OVERLAY_ENABLED && SECTOR_OVERLAY_ENABLED)) return;
  if (!force && _sectorRegimeCache.size && Date.now() - _sectorRegimeAt < MARKET_REGIME_TTL) return;
  for (const sym of allBenchmarkSymbols()) {
    try {
      const bars = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
      if (bars && bars.length >= 60) {
        const map = buildMarketRegime(bars);
        const reg = map.get(new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10))
          || [...map.values()].pop() || null;
        if (reg) _sectorRegimeCache.set(sym, reg);
      }
    } catch (_) {}
  }
  _sectorRegimeAt = Date.now();
  if (_sectorRegimeCache.size) {
    const risky = [...(_sectorRegimeCache.entries())].filter(([, r]) => r.riskOff).map(([e]) => e);
    console.log(`Sector/country regimes: ${_sectorRegimeCache.size} benchmarks cached${risky.length ? ' | risk-off: ' + risky.join(',') : ''}`);
  }
}

/** Country+sector momentum regime for a symbol (live) → its benchmark, else market. */
function sectorRegimeForSymbol(sym) {
  if (!(MARKET_OVERLAY_ENABLED && SECTOR_OVERLAY_ENABLED)) return _liveMarketRegime;
  const bench = sectorEtfForSymbol(sym);
  if (bench && _sectorRegimeCache.has(bench)) return _sectorRegimeCache.get(bench);
  return _liveMarketRegime;
}

// Backtest helper: per-benchmark regime SERIES (Map<day,regime>) so the replay can
// gate each ticker by its home-sector index's HISTORICAL momentum. Cached per key.
const _etfSeriesCache = new Map();
async function getEtfRegimeSeries(etf, range) {
  if (!etf) return null;
  const key = etf + '|' + range;
  if (_etfSeriesCache.has(key)) return _etfSeriesCache.get(key);
  let series = null;
  try {
    const bars = await fetchOHLCV(etf, range, '1d').catch(() => null);
    if (bars && bars.length >= 60) series = buildMarketRegime(bars);
  } catch (_) {}
  _etfSeriesCache.set(key, series);
  return series;
}

// ════════════════════════════════════════════════════════════════════════════
// QUARTERLY-RESULTS (EARNINGS) OVERLAY — peer-group contagion
// When a sub-industry bellwether reports (NVDA beats → chip complex rallies),
// the whole group re-rates. We track the top 5–6 leaders per sub-industry,
// score their most recent reported quarters (EPS surprise), and blend that into
// every group member's buy/sell decision. A stock in a group whose leaders just
// beat gets a tailwind; one whose leaders missed gets throttled hard.
// ════════════════════════════════════════════════════════════════════════════
const EARNINGS_OVERLAY_ENABLED = process.env.EARNINGS_OVERLAY !== '0'; // default ON

// Top 5–6 bellwethers per sub-industry whose quarterly results move the group.
const EARNINGS_PEER_LEADERS = {
  semis:         ['NVDA', 'TSM', 'AVGO', 'AMD', 'ASML', 'MU'],
  software:      ['MSFT', 'ORCL', 'CRM', 'NOW', 'ADBE', 'SAP'],
  comms:         ['GOOGL', 'META', 'NFLX', 'DIS', 'VZ'],
  tech:          ['AAPL', 'MSFT', 'NVDA', 'CSCO', 'ANET'],
  banks:         ['JPM', 'BAC', 'GS', 'MS', 'WFC', 'C'],
  financials:    ['BLK', 'SCHW', 'AXP', 'SPGI', 'CB'],
  energy:        ['XOM', 'CVX', 'SHEL.L', 'TTE.PA', 'COP'],
  health:        ['LLY', 'UNH', 'JNJ', 'MRK', 'ABBV', 'AZN.L'],
  staples:       ['PG', 'KO', 'PEP', 'WMT', 'COST', 'ULVR.L'],
  discretionary: ['AMZN', 'HD', 'MCD', 'NKE', 'MC.PA', 'BKNG'],
  auto:          ['TSLA', 'TM', 'MBG.DE', 'BMW.DE', 'GM', 'F'],
  industrials:   ['CAT', 'GE', 'HON', 'SIE.DE', 'UNP', 'RTX'],
  materials:     ['LIN', 'BHP.L', 'RIO.L', 'BAS.DE', 'FCX'],
  utilities:     ['NEE', 'DUK', 'SO', 'IBE.MC', 'ENGI.PA'],
  realestate:    ['PLD', 'AMT', 'EQIX', 'SPG'],
  gold:          ['NEM', 'GOLD', 'AEM', 'FNV']
};
// Where the LOCAL reporting cycle dominates the global one (Indian banks trade
// on HDFC/ICICI results, not JPM's; Japanese tech on Tokyo Electron/Advantest).
const EARNINGS_PEER_LEADERS_CC = {
  'IN|banks':      ['HDFCBANK.NS', 'ICICIBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'AXISBANK.NS'],
  'IN|financials': ['BAJFINANCE.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'SBILIFE.NS'],
  'IN|tech':       ['TCS.NS', 'INFY.NS', 'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS'],
  'IN|software':   ['TCS.NS', 'INFY.NS', 'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS'],
  'IN|energy':     ['RELIANCE.NS', 'ONGC.NS', 'BPCL.NS', 'IOC.NS'],
  'IN|auto':       ['MARUTI.NS', 'TATAMOTORS.NS', 'M&M.NS', 'BAJAJ-AUTO.NS'],
  'IN|staples':    ['HINDUNILVR.NS', 'ITC.NS', 'NESTLEIND.NS', 'BRITANNIA.NS'],
  'JP|tech':       ['8035.T', '6857.T', '6758.T', '6501.T', '6981.T'],
  'JP|semis':      ['8035.T', '6857.T', '6146.T', '6963.T'],
  'JP|banks':      ['8306.T', '8316.T', '8411.T'],
  'JP|auto':       ['7203.T', '7267.T', '7269.T'],
  'HK|tech':       ['0700.HK', '9988.HK', '3690.HK', '1810.HK', '9618.HK'],
  'HK|banks':      ['0005.HK', '1288.HK', '3988.HK', '939.HK']
};

/** Earnings peer-group key for a symbol: country-specific list if one exists. */
function earningsGroupKeyForSymbol(sym) {
  const key = sectorKeyForSymbol(sym);
  if (!key) return null;
  const cc = countryOfSymbol(sym) + '|' + key;
  if (EARNINGS_PEER_LEADERS_CC[cc]) return cc;
  return EARNINGS_PEER_LEADERS[key] ? key : null;
}
function earningsLeadersForGroup(groupKey) {
  return EARNINGS_PEER_LEADERS_CC[groupKey] || EARNINGS_PEER_LEADERS[groupKey] || [];
}

// Per-leader earnings cache: sym → { rows, nextDate, at }. Quarterly data — 12h TTL.
const _earnLeaderCache = new Map();
const EARNINGS_TTL_MS = 12 * 3600 * 1000;
async function fetchLeaderEarnings(sym) {
  const hit = _earnLeaderCache.get(sym);
  if (hit && Date.now() - hit.at < EARNINGS_TTL_MS) return hit;
  let rows = [], nextDate = null;
  const todayISO = new Date().toISOString().slice(0, 10);
  // Source cascade — same order of preference as /api/earnings/:symbol.
  // 1) FMP stable earnings (the source that actually works from Render).
  try {
    const fmp = await fmpStableEarningsBundle(sym, todayISO);
    if (fmp) {
      if (Array.isArray(fmp.history) && fmp.history.length) rows = fmp.history;
      if (fmp.next && fmp.next.date) nextDate = fmp.next.date;
    }
  } catch (_) {}
  // 2) Yahoo quoteSummary (works when the IP passes Yahoo's crumb check).
  if (!rows.length || !nextDate) {
    try {
      const qs = await quoteSummary(sym, 'earningsHistory,calendarEvents');
      if (!rows.length) rows = earningsHistoryAllFromQuoteSummary(qs, 12) || [];
      if (!nextDate) nextDate = (nextEarningsFromCalendar(qs, sym) || {}).nextDate || null;
    } catch (_) {}
  }
  // 3) Alpha Vantage quarterly EPS history (if key present).
  if (!rows.length) {
    try { rows = (await alphaVantageEarningsHistory(sym, 8)) || []; } catch (_) {}
  }
  // 4) Yahoo chart events as a last resort for the next report date.
  if (!nextDate) {
    try {
      const ce = await yahooNextEarningsFromChartEvents(sym);
      if (ce && ce.date) nextDate = ce.date;
    } catch (_) {}
  }
  const entry = { rows, nextDate, at: Date.now() };
  _earnLeaderCache.set(sym, entry);
  return entry;
}

/** Leaders' reported quarters → events [{date, score, sym, surp}] (score ∈ [-1,1]). */
function groupEventsFromLeaderRows(leaderRows) {
  const events = [];
  for (const { sym, rows } of leaderRows) {
    for (const r of rows || []) {
      if (!r || !r.date) continue;
      const surp = r.epsSurprise != null ? parseFloat(String(r.epsSurprise).replace('%', '')) : null;
      if (surp == null || !Number.isFinite(surp)) continue;
      events.push({ date: r.date, score: Math.max(-25, Math.min(25, surp)) / 25, sym, surp });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

/** Blend group events into a tide at time `atMs`: newest quarters dominate
 *  (exp decay, ~45d half-life), reports older than ~120d have no say. */
function earningsTideFromEvents(events, atMs) {
  if (!events || !events.length) return null;
  const at = typeof atMs === 'number' ? (atMs > 1e12 ? atMs : atMs * 1000) : Date.parse(atMs);
  let wSum = 0, sSum = 0, n = 0, top = null, topW = 0;
  for (const ev of events) {
    const t = Date.parse(ev.date + 'T12:00:00Z');
    const ageD = (at - t) / 86400000;
    if (!(ageD >= 0 && ageD <= 120)) continue;
    const w = Math.exp(-ageD / 45);
    wSum += w; sSum += w * ev.score; n++;
    if (Math.abs(w * ev.score) > topW) { topW = Math.abs(w * ev.score); top = ev; }
  }
  if (!n || wSum <= 0) return null;
  return {
    score: sSum / wSum,
    n,
    top: top ? `${top.sym} ${top.surp >= 0 ? '+' : ''}${top.surp.toFixed(0)}% EPS` : null
  };
}

// Group tide cache: groupKey → { tide, events, at }.
const _earnGroupCache = new Map();
async function getGroupEarnings(groupKey, force = false) {
  const hit = _earnGroupCache.get(groupKey);
  if (!force && hit && Date.now() - hit.at < EARNINGS_TTL_MS) return hit;
  const leaders = earningsLeadersForGroup(groupKey);
  const leaderRows = [];
  for (const sym of leaders) {
    const e = await fetchLeaderEarnings(sym);
    leaderRows.push({ sym, rows: e.rows });
  }
  const events = groupEventsFromLeaderRows(leaderRows);
  const entry = { events, tide: earningsTideFromEvents(events, Date.now()), at: Date.now() };
  _earnGroupCache.set(groupKey, entry);
  return entry;
}

/** Live earnings tide for a symbol (cache-only — refreshed by scheduler). */
function earningsTideForSymbol(sym) {
  if (!EARNINGS_OVERLAY_ENABLED) return null;
  const gk = earningsGroupKeyForSymbol(sym);
  if (!gk) return null;
  const hit = _earnGroupCache.get(gk);
  return hit ? hit.tide : null;
}

/** Refresh all peer groups' earnings tides (boot + every 12h + before picks). */
let _earnRefreshAt = 0;
async function refreshEarningsTides(force = false) {
  if (!EARNINGS_OVERLAY_ENABLED) return;
  if (!force && _earnGroupCache.size && Date.now() - _earnRefreshAt < EARNINGS_TTL_MS) return;
  const keys = [...new Set([...Object.keys(EARNINGS_PEER_LEADERS), ...Object.keys(EARNINGS_PEER_LEADERS_CC)])];
  for (const gk of keys) {
    try { await getGroupEarnings(gk, force); } catch (_) {}
  }
  _earnRefreshAt = Date.now();
  const parts = [];
  for (const [gk, v] of _earnGroupCache) {
    if (v.tide && Math.abs(v.tide.score) >= 0.25) parts.push(`${gk} ${v.tide.score >= 0 ? '+' : ''}${v.tide.score.toFixed(2)}`);
  }
  console.log(`Earnings tides: ${_earnGroupCache.size} peer groups cached${parts.length ? ' | strong: ' + parts.join(', ') : ''}`);
}

/** Next earnings date within `days` calendar days for ANY symbol (cached fetch).
 *  Used as an entry blackout: never open a brand-new position into a report. */
async function nextEarningsWithinDays(sym, days = 5) {
  try {
    const e = await fetchLeaderEarnings(sym); // same cache works for non-leaders
    if (!e.nextDate) return false;
    const diffD = (Date.parse(e.nextDate + 'T12:00:00Z') - Date.now()) / 86400000;
    return diffD >= -1 && diffD <= days;
  } catch (_) { return false; }
}

/**
 * Compute buy/sell scores deterministically from pre-computed indicators.
 * Returns { buyScore, sellScore, action, rating, conditions, winRateHint }
 * Scores 0-100. Mutual exclusivity enforced: both cannot exceed 55.
 * @param {object|null} market  Optional index-momentum regime overlay (see buildMarketRegime).
 */
function computeQuantSignal(tech, fund, hz, market = null) {
  if (!tech) return { buyScore:0, sellScore:0, action:'Hold', rating:'Hold',
    conditions:[], winRateHint:40, gatesMet:0, tier:0, tierLabel:'No data' };

  // ── Extract tech fields ────────────────────────────────────────────────────
  const price   = tech.currentPrice ?? 0;
  const rsi     = tech.rsi ?? 50;
  const ma50    = tech.ma50 ?? price;
  const ma200   = tech.ma200 ?? price;
  const aboveMa20  = tech.aboveMa20  ?? null;
  const aboveMa50  = tech.aboveMa50  ?? false;
  const aboveMa200 = tech.aboveMa200 ?? false;
  const macdBull   = tech.macd?.trend === 'bullish';
  const macdHist   = tech.macd?.histogram ?? 0;
  const adx        = tech.adx ?? 15;
  const trend20    = tech.trend20    ?? 'sideways';
  const weeklyTrend= tech.weeklyTrend ?? trend20;
  const weeklyRSI  = tech.weeklyRSI  ?? rsi;
  const goldenCross= ma50>0&&ma200>0&&ma50>ma200;
  const deathCross = ma50>0&&ma200>0&&ma50<ma200;
  const macdTurnUp = tech.macdTurningUp   ?? macdBull;
  const macdTurnDn = tech.macdTurningDown ?? !macdBull;
  const rsiRising  = tech.rsiRising  ?? false;
  const rsiFalling = tech.rsiFalling ?? false;
  const obvBullish = tech.obvBullish ?? null;
  const healthyPull= tech.healthyPullback  ?? null;
  const bullStruct = tech.bullishStructure ?? null;
  const bearStruct = tech.bearishStructure ?? null;
  const chanPos    = tech.channelPos;
  const volConf    = tech.volume?.confirmation ?? 'neutral';
  const volRatio   = tech.volume?.relativeVolume ?? 1;
  const s1 = tech.support1??null, r1 = tech.resistance1??null;
  const nearS1 = s1&&price>=s1*0.985&&price<=s1*1.025;
  const nearR1 = r1&&price>=r1*0.978&&price<=r1*1.018;
  // Fast mean-reversion oscillators (short-term, noise-tolerant)
  const rsi2  = tech.rsi2 ?? null;
  const stochK = tech.stoch?.k ?? null;
  const bbPct = tech.bb?.pct ?? null;

  // ── SD Channel position (the core timing mechanism) ────────────────────────
  // excellent = price at/below lower 1σ band (statistically discounted entry)
  // good      = price near lower band (within 0.5σ)
  // fair      = mid-channel (neutral timing)
  // poor/sell = price at/above upper band (extended, avoid buying)
  const chanBuyQuality  = chanPos?.buyQuality  ?? 'fair';
  const chanSellQuality = chanPos?.sellQuality ?? 'fair';
  const inSDExcellent = chanBuyQuality === 'excellent';          // price ≤ lower 1σ
  const inSDGood      = chanBuyQuality === 'good' || inSDExcellent; // near lower band
  const inSDNeutral   = chanBuyQuality === 'fair';
  const atSDTop       = chanSellQuality === 'excellent' || chanSellQuality === 'good'; // extended
  const inSDSellZone  = chanSellQuality === 'excellent' || chanSellQuality === 'good';

  // ══ DYNAMIC MARKET REGIME DETECTION ═══════════════════════════════════════
  // Regime is determined per-stock from its own technicals — no external index needed.
  // The same stock has DIFFERENT optimal strategies in different market conditions:
  //   BULL:    Price > MA200 + Golden Cross + weekly uptrend + ADX>20
  //            → trend-following strategy, higher buy multipliers
  //   BEAR:    Price < MA200 + Death Cross + weekly downtrend
  //            → short-selling strategy, higher sell multipliers, no long buys
  //   NEUTRAL: Mixed signals — sideways, consolidating, or transitioning
  //            → mean-reversion strategy, SD channel timing dominates
  //
  // Regime scores (0-7 scale)
  const _bullPts = (aboveMa200?2:0) + (goldenCross?2:0)
                 + (weeklyTrend==='uptrend'?1:0) + (adx>22?0.5:0)
                 + (macdBull?0.5:0) + (obvBullish===true?0.5:0)
                 + (rsi>50&&rsi<70?0.5:0);
  const _bearPts = (!aboveMa200?2:0) + (deathCross?2:0)
                 + (weeklyTrend==='downtrend'?1:0)
                 + (!macdBull&&!macdTurnUp?0.5:0)
                 + (obvBullish===false?0.5:0)
                 + (rsi<40?0.5:0);
  const regime = _bearPts >= 4 ? 'bear'
               : _bullPts >= 4 ? 'bull'
               : 'neutral';

  // Strategy multipliers — applied to buyGates/sellGates scoring
  // BULL: reward momentum+trend, penalise counter-trend shorts
  // BEAR: reward breakdown+distribution, prevent false longs
  // NEUTRAL: reward mean-reversion timing (SD channel)
  const _buyMult  = regime==='bull'  ? 1.30 : regime==='bear' ? 0.45 : 1.00;
  const _sellMult = regime==='bear'  ? 1.35 : regime==='bull' ? 0.50 : 1.00;
  const _mrMult   = regime==='neutral' ? 1.25 : 1.00; // mean-reversion bonus
  // ════════════════════════════════════════════════════════════════════════════

  let buy=0, sell=0;
  const condBuy=[], condSell=[];
  let buyGates=0, sellGates=0;
  let tier = 0;  // 0=standard, 1=Danelfin≥8+SD, 2=+catalyst

  // ════════════════════════════════════════════════════════════════════════════
  // SHORT (1d–1mo): MEAN-REVERSION, noise-filtered. This horizon does NOT chase
  // trend — it buys statistical discounts (lower SD band + support + washed-out
  // fast oscillators) and fades extensions, with filters to avoid catching knives.
  // The SD channel + S/R levels + fast oscillators are the base, exactly as a
  // range-trading desk would run a choppy market. (Exit is mean-reversion too —
  // target the channel mean / resistance, not a trend trail; see simulateHybridExit.)
  // ════════════════════════════════════════════════════════════════════════════
  if (hz === 'short') {

    // Regime/noise context — mean-reversion edge is strongest in ranges & pullbacks,
    // weakest in strong directional trends (where you fight momentum).
    const ranging = adx < 24;
    const strongDown = adx >= 28 && (trend20 === 'downtrend' || weeklyTrend === 'downtrend');
    const lowerCloses = tech.consecutiveLowerCloses ?? 0;

    // ── BUY: buy the statistical discount ──────────────────────────────────────
    // Base 1: SD channel — price stretched below the regression mean = discount
    if (inSDExcellent) { buyGates += 2.5; condBuy.push('SD channel: below lower band (statistical discount)'); }
    else if (inSDGood) { buyGates += 1.5; condBuy.push('SD channel: near lower band'); }

    // Base 2: Support / MA confluence — buy into a level, not into thin air
    const _ma20 = tech.ma20 ?? null;
    const _nearMa50  = ma50 && Math.abs(price - ma50) / price < 0.02;
    const _nearMa20t = _ma20 && Math.abs(price - _ma20) / price < 0.015;
    if (nearS1)            { buyGates += 1.3; condBuy.push(`At support $${s1?.toFixed(2)}`); }
    else if (_nearMa50 && aboveMa50)  { buyGates += 0.9; condBuy.push('At MA50 support'); }
    else if (_nearMa20t)              { buyGates += 0.6; condBuy.push('At MA20 support'); }

    // Base 3: Fast oscillators — noise-tolerant reversal timing (RSI(2), Stochastic)
    if (rsi2 != null && rsi2 < 10) { buyGates += 1.6; condBuy.push(`RSI(2) ${rsi2} washed out`); }
    else if (rsi2 != null && rsi2 < 20) { buyGates += 1.0; condBuy.push(`RSI(2) ${rsi2} oversold`); }
    else if (stochK != null && stochK < 20) { buyGates += 0.9; condBuy.push(`Stochastic ${stochK} oversold`); }
    else if (rsi < 30) { buyGates += 0.9; condBuy.push(`RSI ${rsi} oversold`); }
    else if (rsi < 40 && rsiRising) buyGates += 0.4;

    // Base 4: Bollinger band confirmation
    if (bbPct != null && bbPct < 10) { buyGates += 0.8; condBuy.push('At lower Bollinger band'); }
    else if (bbPct != null && bbPct < 20) buyGates += 0.4;

    // Confirmation: a turn beginning + accumulation
    if (macdTurnUp) { buyGates += 0.5; condBuy.push('MACD turning up'); }
    if (obvBullish === true) buyGates += 0.3;

    // Noise/regime weighting
    if (ranging || (aboveMa50 && trend20 !== 'downtrend')) buyGates += 0.5; // range or pullback-in-uptrend
    if (volRatio < 0.80) buyGates += 0.3; // dip on light volume = healthier

    // Falling-knife filters — do NOT buy a crash (mean-reversion ≠ catching knives)
    if (strongDown)                              buyGates *= 0.45;
    if (lowerCloses >= 4)                        { buyGates *= 0.45; condBuy.push(`${lowerCloses} consecutive lower closes`); }
    if (aboveMa20 === false && trend20 === 'downtrend') buyGates *= 0.40;
    if (rsi > 66)  buyGates = Math.min(buyGates, 1.5); // not a discount anymore
    if (atSDTop)   buyGates *= 0.40;                   // extended — bad MR buy

    buyGates = Math.max(0, buyGates);
    buy = buyGates>=5.5?90:buyGates>=4.5?80:buyGates>=3.5?68:buyGates>=2.8?58:buyGates>=2?44:Math.min(24,Math.round(buyGates*16));

    // ── SELL: fade the statistical premium (conservative; global strict-short gate
    //    still applies afterward, so trend-up names won't be shorted) ────────────
    if (inSDSellZone) { sellGates += 2.0; condSell.push('SD channel: above upper band (extended)'); }
    if (nearR1)       { sellGates += 1.0; condSell.push(`At resistance $${r1?.toFixed(2)}`); }
    if (rsi2 != null && rsi2 > 90) { sellGates += 1.4; condSell.push(`RSI(2) ${rsi2} overbought`); }
    else if (stochK != null && stochK > 80) { sellGates += 0.8; condSell.push(`Stochastic ${stochK} overbought`); }
    else if (rsi > 70) { sellGates += 0.8; condSell.push(`RSI ${rsi} overbought`); }
    if (bbPct != null && bbPct > 90) { sellGates += 0.6; condSell.push('At upper Bollinger band'); }
    if (macdTurnDn) sellGates += 0.4;
    if (ranging) sellGates += 0.4;
    if (rsi < 35) sellGates *= 0.4; // washed out — bad place to short
    sellGates = Math.max(0, sellGates);
    sell = sellGates>=5?86:sellGates>=4?72:sellGates>=3?60:sellGates>=2?46:Math.min(22,Math.round(sellGates*11));

  // ════════════════════════════════════════════════════════════════════════════
  // MEDIUM (90 days = Danelfin 3M): Trend regime + Danelfin AI Score.
  // Entry via SD channel buys into established uptrend at a discount.
  // ════════════════════════════════════════════════════════════════════════════
  } else if (hz === 'medium') {

    // Gate 1: Primary trend regime (REQUIRED for a 90-day trade)
    if (aboveMa200&&goldenCross) { buyGates+=2; condBuy.push('MA200 bull regime + Golden Cross'); }
    else if (aboveMa200)          { buyGates++;  condBuy.push('Above MA200 — primary uptrend'); }
    else if (goldenCross)         { buyGates++;  condBuy.push('Golden Cross: MA50 > MA200'); }

    // Gate 2: Weekly trend (Danelfin weights weekly momentum heavily for 3M)
    if (weeklyTrend==='uptrend')                       { buyGates++; condBuy.push('Weekly uptrend confirmed'); }
    else if (weeklyTrend!=='downtrend'&&aboveMa200)    buyGates+=0.5;

    // Gate 3: ADX trend strength (trending regime = Danelfin's best environment)
    if (adx>=28&&aboveMa200)                           { buyGates++; condBuy.push(`ADX ${adx} — strong trending regime`); }
    else if (adx>=22&&aboveMa50)                       buyGates+=0.5;

    // Gate 4: SD channel — buy the pullback WITHIN the uptrend
    // For 90-day trades: entering at a discount to the channel mean is key
    if (inSDGood&&aboveMa200)    { buyGates++; condBuy.push('SD channel pullback in uptrend'); }
    else if (inSDNeutral&&aboveMa200) buyGates+=0.4;

    /** At SD top (extended): 60% score penalty vs permission model — avoids chasing breakouts */
    if (atSDTop) buyGates = Math.round(buyGates * 0.4);

    // Gate 5: OBV accumulation + RSI zone (3M needs institutional demand)
    if (obvBullish===true&&(rsi>=38&&rsi<=68)) { buyGates++; condBuy.push('OBV institutional accumulation'); }
    else if (obvBullish===true)                  buyGates+=0.7;
    else if (bullStruct&&(rsi>=38&&rsi<=68))     { buyGates+=0.7; condBuy.push('HH/HL structure + healthy RSI'); }

    // Hard disqualifiers for medium
    if (rsi>74)                    buyGates=Math.round(buyGates*0.50); // very overbought
    if (!aboveMa200&&!goldenCross) buyGates=Math.round(buyGates*0.20); // bear regime = no 3M buy
    if (deathCross)                buyGates=Math.round(buyGates*0.30);

    // Regime-scaled medium buy — BEAR prevents false medium-term longs
    buyGates *= _buyMult; buyGates = Math.max(0, buyGates);
    if (regime==='bear') buyGates = Math.min(buyGates, 1.5); // no medium buys in bear
    buy = buyGates>=5.5?90:buyGates>=4.5?78:buyGates>=3.5?62:buyGates>=2.5?46:Math.min(22,Math.round(buyGates*14));

    // SELL: structural regime breakdown
    // Structure gates establish PERMISSION (bear regime). Weights trimmed slightly:
    // structural conditions persist for MONTHS after the damage, so on their own
    // they short far too late — timing gates below decide if the short is LIVE.
    if (!aboveMa200&&deathCross&&weeklyTrend==='downtrend') { sellGates+=3.5; condSell.push('BEAR BREAKDOWN: MA200+DC+weekly down'); }
    else if (!aboveMa200&&deathCross)         { sellGates+=2.5; condSell.push('Bear regime: below MA200 + Death Cross'); }
    else if (!aboveMa200)                { sellGates+=1.5; condSell.push('Below MA200 — bear regime'); }
    else if (deathCross)                 { sellGates+=1.5; condSell.push('Death Cross — trend reversal'); }
    if (weeklyTrend==='downtrend')       { sellGates++;  condSell.push('Weekly downtrend'); }
    if (!macdBull&&!aboveMa200)          { sellGates++;  condSell.push('MACD bearish in bear regime'); }
    if (inSDSellZone&&bearStruct)        { sellGates++;  condSell.push('SD top + distribution'); }
    else if (bearStruct||obvBullish===false) sellGates+=0.5;
    // Bear-rally REJECTION — the highest-quality medium short entry: price pulled
    // up into MA20/MA50 from below and momentum is rolling back over (not chasing
    // the hole, not fighting a live recovery).
    const _ma20m = tech.ma20 ?? null;
    const _nearMaReject = (!aboveMa50 && ma50 && price > ma50*0.94 && price < ma50*1.01)
                       || (!aboveMa200 && _ma20m && price > _ma20m*0.97 && price < _ma20m*1.02);
    if (_nearMaReject && !macdBull && rsi>=40 && rsi<=60) { sellGates+=1.5; condSell.push('Bear-rally rejection at resistance'); }

    // ── TIMING & EXHAUSTION GUARDS (fix for medium shorts bleeding) ─────────
    // 1) The downtrend must be ACTIVE. Price re-claiming its MAs = live recovery;
    //    a structural bear score alone was shorting stocks mid-rebound.
    if (aboveMa50)       sellGates = Math.round(sellGates*0.35); // recovery underway — stand aside
    else if (aboveMa20)  sellGates = Math.round(sellGates*0.50); // near-term bounce in progress
    // 2) Momentum turning UP = bear-market rally / short-squeeze risk.
    if (rsiRising && macdBull) sellGates = Math.round(sellGates*0.35);
    // 3) Don't short the hole — graduated oversold protection (was only rsi<30).
    if (rsi<30)      sellGates = Math.round(sellGates*0.30);
    else if (rsi<38) sellGates = Math.round(sellGates*0.60);
    // 4) Overextended downside: >22% below MA200 → most of the move has happened;
    //    1–3 month mean-reversion makes fresh shorts here consistently lose.
    if (ma200 && price < ma200*0.78) sellGates = Math.round(sellGates*0.50);
    // 5) Active rally: 3+ consecutive higher closes → wait for the bounce to stall.
    const _consHigher = tech.consecutiveHigherCloses ?? 0;
    if (_consHigher >= 3) sellGates = Math.round(sellGates*0.40);
    // Regime-scaled medium sell — BEAR amplifies breakdown trades
    sellGates *= _sellMult; sellGates = Math.max(0, sellGates);
    sell = sellGates>=5.5?88:sellGates>=4.5?75:sellGates>=3.5?62:sellGates>=2.5?50:Math.min(24,Math.round(sellGates*11));

  // ════════════════════════════════════════════════════════════════════════════
  // LONG (1–6 months): Structural bull regime + fundamental quality.
  // Danelfin Fundamental subscore confirms earnings/revenue durability.
  // SD channel entry gives favorable risk/reward over multi-month hold.
  // ════════════════════════════════════════════════════════════════════════════
  } else { // long (4–12 months) — SEPA + CANSLIM

    const sepaAlignment=aboveMa200&&aboveMa50&&ma50>ma200;
    const slopeBullish=weeklyTrend==='uptrend';
    if (sepaAlignment&&goldenCross&&slopeBullish){buyGates+=3;condBuy.push('SEPA: full MA alignment+rising');}
    else if(sepaAlignment&&goldenCross){buyGates+=2;condBuy.push('SEPA: MA alignment+Golden Cross');}
    else if(aboveMa200&&goldenCross){buyGates+=2;condBuy.push('MA200+Golden Cross');}
    else if(aboveMa200){buyGates++;condBuy.push('Above MA200 uptrend');}

    const high52w=tech.high52w??null,low52w=tech.low52w??null;
    const nearHigh52w=high52w?price>=high52w*0.75:true;
    const aboveLow52w=low52w?price>=low52w*1.25:true;
    if(nearHigh52w&&aboveLow52w){buyGates++;condBuy.push('Leader: near 52W high');}
    else if(nearHigh52w) buyGates+=0.5;

    if(weeklyTrend==='uptrend'&&aboveMa200){buyGates++;condBuy.push('Weekly uptrend');}
    else if(weeklyTrend==='uptrend') buyGates+=0.5;
    if(adx>=25&&aboveMa200){buyGates++;condBuy.push(`ADX ${adx} trending`);}
    else if(adx>=20) buyGates+=0.4;

    if(inSDGood&&aboveMa200){buyGates++;condBuy.push('SD channel VCP entry');}
    else if(inSDNeutral&&aboveMa200) buyGates+=0.3;
    if(atSDTop) buyGates=Math.round(buyGates*0.4);

    if(rsi>=35&&rsi<=65&&aboveMa200){buyGates++;}

    if(fund){
      const epsG=fund.earningsGrowth??null,revG=fund.revenueGrowth??null;
      const pegR=fund.pegRatio??null;
      const analystB=['strongBuy','buy'].includes(fund.recommendationKey??'');
      const analystBr=['sell','strongSell'].includes(fund.recommendationKey??'');
      const targetUp=fund.targetMeanPrice&&price?(fund.targetMeanPrice-price)/price*100:null;
      if(epsG!=null&&epsG>=25){buyGates+=2;condBuy.push(`CANSLIM: EPS +${epsG}%`);}
      else if(epsG!=null&&epsG>=15){buyGates++;condBuy.push(`EPS +${epsG}%`);}
      else if(epsG!=null&&epsG>=8) buyGates+=0.5;
      if(revG!=null&&revG>=20){buyGates++;condBuy.push(`Revenue +${revG}%`);}
      else if(revG!=null&&revG>=10) buyGates+=0.5;
      if(pegR!=null&&pegR>0&&pegR<1.5){buyGates+=0.5;condBuy.push(`PEG ${pegR.toFixed(1)} GARP`);}
      if(analystB&&targetUp!=null&&targetUp>15){buyGates++;condBuy.push(`${targetUp.toFixed(0)}% upside`);}
      else if(analystB&&targetUp!=null&&targetUp>8) buyGates+=0.5;
      if(analystBr) buyGates=Math.round(buyGates*0.50);
      if(epsG!=null&&epsG<-10){sellGates++;condSell.push(`EPS -${Math.abs(epsG)}%`);}
      if(revG!=null&&revG<-8){sellGates++;condSell.push(`Rev -${Math.abs(revG)}%`);}
    }

    if(obvBullish===true&&bullStruct){buyGates++;condBuy.push('OBV+HH/HL structure');}
    else if(obvBullish===true) buyGates+=0.5;

    if(rsi>76) buyGates=Math.round(buyGates*0.60);
    if(!aboveMa200) buyGates=0;
    // Regime-scaled long buy — BEAR absolutely prevents 4-12mo longs
    buyGates *= _buyMult; buyGates = Math.max(0, buyGates);
    if (regime==='bear') buyGates = 0; // structural bear = no 4-12mo buys
    buy=buyGates>=9?92:buyGates>=8?85:buyGates>=7?76:buyGates>=6?64:buyGates>=5?52:buyGates>=4?38:0;
    if(!aboveMa200) buy=0;

    // Structure = PERMISSION only. A 4-12 month short needs a confirmed bear
    // regime AND live downside momentum AND a non-exhausted move — structural
    // weakness alone was shorting bottoms and bleeding through recoveries.
    if(!aboveMa200&&deathCross){sellGates+=3;condSell.push('Bear regime: below MA200+Death Cross');}
    else if(!aboveMa200){sellGates+=2;condSell.push('Below MA200');}
    if(weeklyTrend==='downtrend'){sellGates++;condSell.push('Weekly downtrend');}
    if(!macdBull&&!aboveMa200) sellGates++;
    if(bearStruct&&obvBullish===false){sellGates++;condSell.push('Distribution pattern');}
    // ── TIMING & EXHAUSTION GUARDS (mirror of the medium-short fix) ─────────
    if (aboveMa50)       sellGates = Math.round(sellGates*0.30); // recovery underway
    else if (aboveMa20)  sellGates = Math.round(sellGates*0.45); // bounce in progress
    if (rsiRising && macdBull) sellGates = Math.round(sellGates*0.35); // squeeze risk
    if (rsi<28)      sellGates = Math.round(sellGates*0.30); // don't short the hole
    else if (rsi<36) sellGates = Math.round(sellGates*0.60);
    if (ma200 && price < ma200*0.75) sellGates = Math.round(sellGates*0.50); // >25% below MA200 — move done
    if ((tech.consecutiveHigherCloses ?? 0) >= 3) sellGates = Math.round(sellGates*0.40); // active rally
    // Multi-month shorts outside a confirmed bear regime carry drift risk — halve.
    if (regime !== 'bear' && weeklyTrend !== 'downtrend') sellGates = Math.round(sellGates*0.50);
    // Regime-scaled long sell — BEAR makes structural shorts primary
    sellGates *= _sellMult; sellGates = Math.max(0, sellGates);
    // Higher bar than before: weak long shorts (score 60 at 3.5 gates) no longer fire.
    sell=sellGates>=6.5?86:sellGates>=5.5?73:sellGates>=4.5?62:sellGates>=3?45:Math.min(22,Math.round(sellGates*10));
  }

  // ── SUPERTREND as a core PER-TIMEFRAME trend filter (not just a cosmetic boost) ──
  // Each horizon reads its own Supertrend (fast for short, slow for long). Rule:
  //   • Don't BUY against the timeframe's Supertrend (bear ST caps the buy below the
  //     Buy threshold) UNLESS price just flipped bull (fresh reversal entry).
  //   • Confirm/boost when ST agrees; Strong on a fresh flip.
  //   • Mirror for SELL.
  // This makes Supertrend a real gate across all timeframes, as requested.
  const stHz = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend || null;
  if (stHz) {
    const stBtOk = !tech._supertrendBacktestWR || tech._supertrendBacktestWR >= 50;
    if (stHz.direction === 'bull') {
      if (stHz.flippedBull && buy >= 50) { buy = Math.min(94, buy + 12); condBuy.unshift(`Supertrend ${hz} Strong Buy (fresh bull flip)`); }
      else if (buy >= 55)               { buy = Math.min(92, buy + 6);  condBuy.push(`Supertrend ${hz} bullish`); }
    } else if (stHz.direction === 'bear' && hz !== 'short') {
      // Buying against the TIMEFRAME trend is capped for trend horizons (medium/long).
      // Short is mean-reversion: it intentionally buys dips below the fast Supertrend,
      // so we do NOT cap it here (the falling-knife filters handle genuine breakdowns).
      if (!stHz.flippedBull) {
        // Structurally-intact pullback exception: above MA200 + golden cross +
        // weekly uptrend means the ST bear leg is a dip inside a healthy trend,
        // not a breakdown. Cap softer (66) so top-quality pullback entries can
        // still clear the 62 pick threshold — a hard 58 cap was blanking the
        // medium/long panes for weeks whenever growth sectors merely paused.
        const structIntact = aboveMa200 === true && goldenCross === true && weeklyTrend === 'uptrend';
        if (structIntact) { buy = Math.min(buy, 66); condBuy.push(`Below ${hz} Supertrend — pullback in intact uptrend (soft cap)`); }
        else { buy = Math.min(buy, 58); condBuy.push(`Below ${hz} Supertrend — buy capped`); }
      }
    }
    if (stHz.direction === 'bear') {
      if (stHz.flippedBear && sell >= 50) { sell = Math.min(92, sell + 12); condSell.unshift(`Supertrend ${hz} Strong Sell (fresh bear flip)`); }
      else if (sell >= 55)                { sell = Math.min(90, sell + 6);  condSell.push(`Supertrend ${hz} bearish`); }
    } else if (stHz.direction === 'bull') {
      // A short-horizon FADE is allowed to fire above a bull Supertrend — it is
      // counter-trend by construction (shorting an overbought extension back to
      // the mean). Everything else keeps the cap. Never exempt a fresh ignition.
      const _fadeCandidate = hz === 'short'
        && ((rsi2 != null && rsi2 > 90) || rsi >= 70 || (stochK != null && stochK > 80))
        && (inSDSellZone === true || (bbPct != null && bbPct > 90))
        && !stHz.flippedBull;
      if (!stHz.flippedBear && !_fadeCandidate) { sell = Math.min(sell, 58); condSell.push(`Above ${hz} Supertrend — sell capped`); }
    }
    // Backtest-validated extra confidence (when WR known and strong)
    if (stBtOk && tech._supertrendBacktestWR >= 60) {
      if (stHz.direction === 'bull' && buy >= 62) buy = Math.min(95, buy + 2);
      if (stHz.direction === 'bear' && sell >= 62) sell = Math.min(93, sell + 2);
    }
  }

  // ── STRICT SELECTIVE SHORTS ─────────────────────────────────────────────────
  // Shorting a broadly-rising universe loses money (history: SELL win rate ~12%).
  // A short is only allowed to reach "Sell" (≥62) when a real bearish confluence
  // exists. Otherwise we cap it below the threshold so it never gets recommended.
  //
  // Required confluence:
  //   1. Structural downtrend  — price below the 200-DMA
  //   2. Regime not bullish    — regime is bear/neutral, never bull
  //   3. Timeframe Supertrend bear — this horizon's ST points down
  //   4. Real distribution     — OBV falling / LH-LL structure / down-vol (not a
  //                              low-volume "fake" dip; the closest proxy we have to
  //                              order-book "real vs fake" pressure without L2 data)
  //   5. Fundamentals not strong — don't short a high-growth name into a squeeze
  //   6. Earnings-event aware  — avoid shorting right before earnings (squeeze risk)
  if (sell >= 62) {
    const stBearHz = stHz && stHz.direction === 'bear';
    const realDistribution = (obvBullish === false) || bearStruct === true
      || rsiFalling === true || (volConf === 'bearish') || (volRatio >= 1.2 && rsi < 45);
    const epsG = fund?.earningsGrowth ?? null;
    const revG = fund?.revenueGrowth ?? null;
    const fundamentallyStrong = (epsG != null && epsG >= 15) && (revG != null && revG >= 12);
    // Earnings proximity (only applied when the date is known; no-op otherwise).
    const dte = fund?.daysToEarnings ?? tech?.daysToEarnings ?? null;
    const earningsSoon = dte != null && dte >= 0 && dte <= 5;

    // PATH A — BREAKDOWN SHORT (medium/long trend shorts): the original strict
    // confluence. Correct for multi-week/month shorts; backtests confirm these
    // only earn in bear regimes, so the requirements stay hard.
    // Backtest (594 symbols × 252 bars): breakdown shorts fired 1.8k/1.5k times
    // on medium/long at 36-39% win rate — they were shorting NEUTRAL-regime
    // pullbacks that recovered. Tightened: a 1-3mo short needs the WEEKLY trend
    // confirming down; a 4-12mo short needs a CONFIRMED BEAR regime, full stop.
    const breakdownValid = aboveMa200 === false
      && regime !== 'bull'
      && (hz !== 'medium' || weeklyTrend === 'downtrend')
      && (hz !== 'long' || regime === 'bear')
      && stBearHz
      && realDistribution
      && !fundamentallyStrong
      && !earningsSoon;

    // PATH B — MEAN-REVERSION FADE (short horizon only): shorting an OVERBOUGHT
    // EXTENSION back to its mean. Counter-trend by design — demanding "below
    // MA200" here is a contradiction and was strangling short-term sells to
    // ZERO trades (backtest evidence). A fade qualifies on STRETCH, not
    // structure: genuinely overbought + at/above a statistical band + momentum
    // cresting + no earnings gap risk + never against a fresh bull ignition.
    const _stretch20 = (tech.ma20 && price) ? (price - tech.ma20) / tech.ma20 : 0;
    const _overbought = (rsi2 != null && rsi2 > 90) || rsi >= 70 || (stochK != null && stochK > 80);
    const _atExtension = inSDSellZone === true || (bbPct != null && bbPct > 90) || _stretch20 >= 0.08;
    const _cresting = rsiFalling === true || macdTurnDn === true || !macdBull;
    const _freshIgnition = stHz && stHz.direction === 'bull' && stHz.flippedBull === true;
    // REWARD:RISK requirement — the fade backtested at 61% win rate yet NEGATIVE
    // expectancy: wins (reversion to MA20) were smaller than losses (~1.5×ATR
    // stop). A fade only pays when the stretch itself exceeds the stop risk:
    // require price ≥ 1.65×ATR above MA20 (≈1.1:1 reward:risk at entry).
    const _atrF = tech.atr || null;
    const _rrOk = (_atrF > 0 && tech.ma20)
      ? ((price - tech.ma20) / _atrF) >= 1.65
      : _stretch20 >= 0.06; // ATR unknown → fall back to a hard 6% stretch
    const fadeValid = hz === 'short'
      && _overbought && _atExtension && _cresting && _rrOk
      && !_freshIgnition && !earningsSoon;

    if (!breakdownValid && !fadeValid) {
      sell = Math.min(sell, 55); // demote to Hold — not a high-conviction short
    } else if (fadeValid && !breakdownValid) {
      condSell.unshift('Fade short: overbought extension, momentum cresting');
    } else {
      condSell.unshift('Strict short: below MA200 + ST bear + distribution');
      if (epsG != null && epsG < 0) condSell.push(`Earnings declining ${epsG}%`);
    }
  }

  // ── MARKET / INDEX MOMENTUM OVERLAY ─────────────────────────────────────────
  // Align every long with the broad-market tide and throttle counter-tide trades.
  // This is the fix for "we can't capture index/market momentum": stop pressing
  // longs into a falling market and stop fading a strong one.
  // Prefer the stock's SECTOR-level tide (attached to tech), then broad market.
  if (MARKET_OVERLAY_ENABLED && !market) market = (tech && tech._sectorRegime) || _liveMarketRegime;
  if (MARKET_OVERLAY_ENABLED && market) {
    if (hz === 'short') {
      // Short = mean-reversion dip-buying. Fine in up/flat tapes; a knife-catch in
      // a risk-off market — throttle hard rather than buy the falling market.
      if (market.riskOff)              { buy = Math.round(buy * 0.45); condBuy.push('Market risk-off — dip-buy throttled'); }
      else if (market.trend === 'down') buy = Math.round(buy * 0.70);
      else if (market.trend === 'up')   buy = Math.min(94, Math.round(buy * 1.05));
    } else {
      // Medium/long = trend-following. Only press longs with the market tide.
      if (market.riskOff)               { buy = Math.round(buy * 0.30); condBuy.push('Market risk-off — trend-long suppressed'); }
      else if (!market.aboveMa200)       buy = Math.round(buy * 0.60);
      else if (market.trend === 'up' && market.ma50Rising) { buy = Math.min(95, Math.round(buy * 1.08)); condBuy.push('Market uptrend tailwind'); }
    }
    // Shorts (when enabled) only earn with the tide against the market.
    if (market.riskOff)             sell = Math.min(94, Math.round(sell * 1.10));
    else if (market.trend === 'up') sell = Math.round(sell * 0.45);
  }

  // ── QUARTERLY-RESULTS (EARNINGS) OVERLAY ────────────────────────────────────
  // Peer-group contagion: when the sub-industry's bellwethers (NVDA for chips,
  // HDFC/ICICI for Indian banks, Tokyo Electron for JP tech) just delivered
  // strong quarters, group members get a buy tailwind; after leader misses the
  // group is throttled hard. Attached per-symbol as tech._earningsTide.
  const _etide = EARNINGS_OVERLAY_ENABLED ? (tech && tech._earningsTide) : null;
  if (_etide && _etide.score != null) {
    const who = _etide.top ? ` (${_etide.top})` : '';
    if (_etide.score >= 0.25) {
      buy = Math.min(95, Math.round(buy * 1.08));
      sell = Math.round(sell * 0.85);
      condBuy.push('Peer quarterly beats — group re-rating tailwind' + who);
    } else if (_etide.score <= -0.25) {
      buy = Math.round(buy * 0.62);
      sell = Math.min(94, Math.round(sell * 1.08));
      condSell.push('Peer quarterly misses — group headwind' + who);
    }
  }

  // Clamp and mutual exclusivity
  buy  = Math.min(92,Math.max(0,Math.round(buy)));
  sell = Math.min(88,Math.max(0,Math.round(sell)));
  if (buy>55&&sell>55) { if(buy>=sell) sell=Math.min(sell,20); else buy=Math.min(buy,20); }

  const { action, rating } = deriveActionRating(buy, sell);

  const gates = buy>=sell ? buyGates : sellGates;

  // ── Win rate hint: base rates from quantitative research ─────────────────
  // These are BASE hints before Danelfin/FMP overlay in batch endpoint.
  // The batch endpoint upgrades tier based on Danelfin score + SD channel.
  const winRateHint = hz==='short'
    ? (gates>=5?62:gates>=4?56:gates>=3?50:42)   // SD channel is gate 2 here
    : hz==='medium'
    ? (gates>=5?62:gates>=4?56:gates>=3?50:42)   // regime + weekly + ADX
    : (gates>=7?65:gates>=6?60:gates>=5?55:gates>=4?49:42); // fundamental quality layer

  // Structural context (strict — null MA means "unknown", not "below"). Used by applyTierScoreCaps
  // so fundamental/Danelfin overlays can't resurrect a structurally broken chart into a Buy.
  const _belowMa200 = tech.aboveMa200 === false;
  const _belowMa50  = tech.aboveMa50  === false;
  const _belowMa20  = tech.aboveMa20 === false;
  const _trendDown  = trend20 === 'downtrend' || weeklyTrend === 'downtrend';
  const _fallingKnife = _belowMa200 && _belowMa20 && (tech.rsi ?? 50) < 45;

  return {
    buyScore:buy, sellScore:sell, action, rating,
    conditions:(buy>=sell?condBuy:condSell).slice(0,5),
    winRateHint,
    gatesMet: Math.floor(buy>=sell?buyGates:sellGates),
    regime,        // 'bull' | 'bear' | 'neutral' — for UI display and history filtering
    tier: 0,       // upgraded to 1 or 2 in batch endpoint based on Danelfin/FMP
    tierLabel: '', // set by batch endpoint
    belowMa200: _belowMa200,
    belowMa50: _belowMa50,
    belowMa20: _belowMa20,
    trendDown: _trendDown,
    fallingKnife: _fallingKnife,
  };
}

// Canonical action/rating from final scores — used everywhere so the dashboard card,
// the server picks, and the full-analysis view never disagree. Thresholds match the
// client (renderPicksPane gate at 62; Strong at 78/74).
function deriveActionRating(buy, sell) {
  buy = buy || 0; sell = sell || 0;
  if (buy >= sell) {
    if (buy >= 78) return { action: 'Buy', rating: 'Strong Buy' };
    if (buy >= 62) return { action: 'Buy', rating: 'Buy' };
    return { action: 'Hold', rating: 'Hold' };
  }
  if (sell >= 74) return { action: 'Sell', rating: 'Strong Sell' };
  if (sell >= 62) return { action: 'Sell', rating: 'Sell' };
  return { action: 'Hold', rating: 'Hold' };
}


/**
 * Walk-forward backtest aligned with live computeQuantSignal + the SAME hybrid exit
 * (TP1 partial + trailing remainder + hysteresis signal-flip) used in live history.
 * Uses the last ~5 years of daily bars. Reports supertrendWinRate separately.
 */
async function backtestSignal(data, hz, weeklyData = null, fund = null, opts = {}) {
  if (!data || data.length < BACKTEST_WARMUP + 30) return null;
  const windowBars = opts.windowBars || BACKTEST_WINDOW_BARS;
  const entryStep = Math.max(1, opts.entryStep || 2);
  const windowStart = Math.max(BACKTEST_WARMUP, data.length - windowBars);
  const weeklyAll = weeklyData || dailyToWeeklyBars(data);
  const marketSeries = opts.marketSeries || null; // Map<'YYYY-MM-DD', regime>
  const earningsEvents = opts.earningsEvents || null; // [{date, score, sym, surp}]
  let marketLatest = null;

  let wins = 0, losses = 0, trades = 0, totalReturn = 0, grossWin = 0, grossLoss = 0;
  let stWins = 0, stTrades = 0;
  let nextAllowed = windowStart;
  let _yc = 0;

  for (let i = windowStart; i < data.length - 2; i += entryStep) {
    if (i < nextAllowed) continue;
    if ((++_yc & 15) === 0) await new Promise(r => setImmediate(r));
    const tech = techAtBoundedIndex(data, weeklyAll, i);
    let market = null;
    if (marketSeries) {
      market = marketRegimeAt(marketSeries, data[i].t, marketLatest);
      if (market) marketLatest = market;
    }
    // Historical peer-earnings tide at this bar (same decay math as live).
    if (earningsEvents) tech._earningsTide = earningsTideFromEvents(earningsEvents, data[i].t);
    const sig = computeQuantSignal(tech, fund, hz, market);
    const stHz = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend;

    // Entry only on a real, dominant signal (same 62 threshold as live picks).
    const buyOk = sig.buyScore >= 62 && sig.buyScore > sig.sellScore;
    const sellOk = sig.sellScore >= 62 && sig.sellScore > sig.buyScore;
    if (!buyOk && !sellOk) continue;
    const isBuy = buyOk && (!sellOk || sig.buyScore >= sig.sellScore);
    const isSell = !isBuy;
    // Optional side filter — lets the backtest endpoint measure ONE side in isolation
    if (opts.side === 'sell' && !isSell) continue;
    if (opts.side === 'buy' && !isBuy) continue;

    const entry = data[i + 1]?.o ?? data[i].c;
    if (!entry || entry <= 0) continue;

    // Same hard 1.1:1 TP1-vs-SL gate as live recommendations — no TP2 escape.
    if (hz !== 'short') {
      const gSl = computeTrailingStopFromTech(tech, entry, hz, isSell, fund);
      const gTp = computeFirstTargetFromTech(tech, entry, hz, isSell, gSl);
      if (gSl != null && gTp != null && !levelsMeetMinRR(entry, gTp, gSl, isSell, PICKS_MIN_RR)) {
        continue;
      }
    }

    const res = await simulateHybridExit(data, i + 1, entry, hz, isSell, weeklyAll, fund);
    if (!res || res.exitIdx == null) continue;

    trades++;
    totalReturn += res.ret;
    if (res.ret > 0) { wins++; grossWin += res.ret; } else { losses++; grossLoss += Math.abs(res.ret); }
    nextAllowed = res.exitIdx + 1;

    const stAligned = (isBuy && stHz?.direction === 'bull') || (isSell && stHz?.direction === 'bear');
    if (stAligned) { stTrades++; if (res.ret > 0) stWins++; }
  }

  if (trades < 5) return null;
  return {
    winRate: Math.round(wins / trades * 100),
    trades,
    avgReturnPct: parseFloat((totalReturn / trades * 100).toFixed(2)),
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : 99,
    supertrendWinRate: stTrades >= 5 ? Math.round(stWins / stTrades * 100) : null,
    supertrendTrades: stTrades,
    hybridExit: true,
    windowYears: 5
  };
}




async function fetchFundamentalsYahoo(symbol) {
  const variants = [...new Set(intlVendorSymbolVariants(symbol))].slice(0, 8);
  const num = v => {
    const n = v?.raw ?? v;
    return Number.isFinite(+n) ? +n : null;
  };
  const pct = v => {
    const n = num(v);
    return n != null ? +(n * 100).toFixed(1) : null;
  };
  const fmt = (v, dec = 2) => {
    const n = num(v);
    return n != null ? +n.toFixed(dec) : null;
  };
  for (const sym of variants) {
    try {
      const qs = await quoteSummary(
        sym,
        'financialData,defaultKeyStatistics,summaryDetail,assetProfile'
      );
      const res = qs?.quoteSummary?.result?.[0];
      if (!res) continue;
      const fd = res.financialData || {};
      const ks = res.defaultKeyStatistics || {};
      const sd = res.summaryDetail || {};
      const ap = res.assetProfile || {};
      const sect = String(ap.sector || ap.industry || '')
        .trim()
        .slice(0, 120);
      const snap = {
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
      marketCap: num(sd.marketCap),
      /** Populates Industry Pos tile when FMP omit (_fmpSector); merge prefers first non-null. */
      _fmpSector: sect || null,
      _yahooSector: sect || null,
      _source: 'yahoo'
    };
    const hasAny = Object.keys(snap).some(
      k => !k.startsWith('_') && snap[k] != null && snap[k] !== ''
    );
      if (hasAny) {
        console.log(`fetchFundamentalsYahoo ${symbol} ← ${sym}`);
        return snap;
      }
    } catch (e) {
      console.warn('fetchFundamentalsYahoo', sym, e.message);
    }
  }
  return null;
}

/** Lightweight v7 quote — often still returns forward/trailing P/E when quoteSummary modules are empty from the server IP. */
async function fetchYahooQuotePE(symbol) {
  const hit = await fetchFundamentalsFromYahooV7Quote(symbol);
  if (!hit) return null;
  if (hit.forwardPE != null || hit.trailingPE != null || hit.pegRatio != null) {
    return {
      forwardPE: hit.forwardPE,
      trailingPE: hit.trailingPE,
      pegRatio: hit.pegRatio,
      _source: 'yahoo_v7_quote'
    };
  }
  return null;
}

/** Strip BOM / zero-width chars Render sometimes injects when pasting API keys. */
function normalizeApiKeyString(raw) {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function fmpAnyApiKey() {
  const candidates = [
    process.env.FMP_API_KEY,
    process.env.FMP_KEY,
    process.env.FINANCIAL_MODELING_PREP_API_KEY
  ];
  for (const c of candidates) {
    const t = normalizeApiKeyString(c);
    if (t) return t;
  }
  return '';
}

function fmpEnvKeyFund() {
  return fmpAnyApiKey();
}

function alphaVantageApiKey() {
  const candidates = [
    process.env.ALPHA_VANTAGE_API_KEY,
    process.env.ALPHAVANTAGE_API_KEY,
    process.env.ALPHA_VANTAGE_KEY
  ];
  for (const c of candidates) {
    const t = normalizeApiKeyString(c);
    if (t) return t;
  }
  return '';
}

/**
 * Claude / Anthropic — same normalization as FMP keys (Render UI pastes sometimes include BOM/zero-width).
 * Prefer ANTHROPIC_API_KEY; CLAUDE_API_KEY is accepted as a typo alias only on the server.
 */
function anthropicApiKey() {
  const candidates = [
    process.env.ANTHROPIC_API_KEY,
    process.env.CLAUDE_API_KEY,
    process.env.ANTHROPIC_KEY
  ];
  for (const c of candidates) {
    const t = normalizeApiKeyString(c);
    if (t) return t;
  }
  return '';
}

/**
 * Yahoo NSE root → Bloomberg mnemonic + FMP alternate listing (keep in sync with bloomberg-bridge `NSE_BB_OVERRIDES`).
 */
const NSE_BB_OVERRIDES = /** @type {Record<string,string>} */ ({
  'BAJAJ-AUTO': 'BAJAUT',
  'M&M': 'MM',
  /** Yahoo NSE ticker ≠ Bloomberg mnemonic (Bloomberg ICICIBC:IN) — FMP often uses the same root */
  ICICIBANK: 'ICICIBC'
});

/** Must match bloomberg-bridge `BRIDGE_BUILD` — bridge echoes this on /snapshot, /earnings, /health. */
const BLOOMBERG_BRIDGE_BUILD_EXPECTED = '20260519-bridge-scores-from-fmp-only';

/** Non-US exchange suffixes — used for intl-first FMP variant ordering and diagnostics. */
function isIntlEquitySymbol(symbol) {
  return /\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW|TO|V|MX)$/i.test(
    String(symbol || '')
  );
}

/** Set FMP_PLAN=starter on Render only if still on US-only tier; default ultimate (global coverage). */
function fmpPlanTier() {
  const p = String(process.env.FMP_PLAN || 'ultimate').trim().toLowerCase();
  return p === 'starter' ? 'starter' : 'ultimate';
}

function fmpGlobalCoverageEnabled() {
  return fmpPlanTier() === 'ultimate';
}

const FMP_INTL_DATA_MISS_HINT =
  'FMP returned no fundamentals/scores for this symbol — check ticker spelling or FMP exchange listing (e.g. ASIANPAINT.NS).';

/** Lazy probe — confirms Ultimate global endpoints return data (surfaced in /api/health). */
let fmpGlobalCoverageProbe = {
  ts: 0,
  symbol: 'ASIANPAINT.NS',
  ok: false,
  fundamentals: false,
  scores: false,
  piotroski: null,
  altmanZ: null,
  trailingPE: null,
  error: null
};

async function probeFmpGlobalCoverage(force = false) {
  const key = fmpEnvKeyFund();
  if (!key || !fmpGlobalCoverageEnabled()) return fmpGlobalCoverageProbe;
  const now = Date.now();
  const age = fmpGlobalCoverageProbe.ts ? now - fmpGlobalCoverageProbe.ts : Infinity;
  const cacheTtl = fmpGlobalCoverageProbe.ok ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000;
  if (!force && fmpGlobalCoverageProbe.ts && age < cacheTtl) {
    return fmpGlobalCoverageProbe;
  }
  const sym = fmpGlobalCoverageProbe.symbol;
  const next = {
    ...fmpGlobalCoverageProbe,
    ts: now,
    ok: false,
    fundamentals: false,
    scores: false,
    piotroski: null,
    altmanZ: null,
    trailingPE: null,
    error: null
  };
  try {
    const fund = await fetchFundamentalsFMP(sym).catch(() => null);
    if (fund?.trailingPE || fund?.pegRatio || fund?.revenueGrowth) {
      next.fundamentals = true;
      next.trailingPE = fund.trailingPE ?? null;
    }
    const fmpQ = await fetchFmpScore(sym).catch(() => null);
    if (fmpQ?.piotroski != null || fmpQ?.altmanZ != null) {
      next.scores = true;
      next.piotroski = fmpQ.piotroski ?? null;
      next.altmanZ = fmpQ.altmanZ ?? null;
    }
    next.ok = next.fundamentals || next.scores;
    fmpGlobalCoverageProbe = next;
  } catch (e) {
    next.error = e.message || String(e);
    fmpGlobalCoverageProbe = next;
  }
  return fmpGlobalCoverageProbe;
}

function sanitizePe(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 9000) return null;
  return n;
}

function sanitizePeg(v) {
  const n = sanitizePe(v);
  if (n == null || n > 99) return null;
  return n;
}

/** Drop bogus zeros from Yahoo/FMP (e.g. trailingPE: 0 for .NS when field is missing). */
function sanitizeFundSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const out = { ...snap };
  if ('trailingPE' in out) out.trailingPE = sanitizePe(out.trailingPE);
  if ('forwardPE' in out) out.forwardPE = sanitizePe(out.forwardPE);
  if ('pegRatio' in out) out.pegRatio = sanitizePeg(out.pegRatio);
  return out;
}

/** Map app ticker to Bloomberg equity string for Desktop API ref() (e.g. `AAPL US Equity`, `9988 HK Equity`). */
function toBloombergEquity(sym) {
  const s = String(sym || '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  if (s === 'BRK.B' || s === 'BRK-B') return 'BRK/B US Equity';
  let m;
  if ((m = /^(\d+)\s+HK$/i.exec(s))) return `${m[1]} HK Equity`;
  if ((m = /^(\d+)\s+JT$/i.exec(s))) return `${m[1]} JT Equity`;
  if (/^\d+\.HK$/i.test(s)) return `${s.replace(/\.HK$/i, '')} HK Equity`;
  if (/\.L$/i.test(s)) return `${s.replace(/\.L$/i, '')} LN Equity`;
  if (/\.PA$/i.test(s)) return `${s.replace(/\.PA$/i, '')} FP Equity`;
  if (/\.DE$/i.test(s)) return `${s.replace(/\.DE$/i, '')} GR Equity`;
  if (/\.AS$/i.test(s)) return `${s.replace(/\.AS$/i, '')} NA Equity`;
  if (/\.NS$/i.test(s)) {
    let root = s.replace(/\.NS$/i, '');
    root = NSE_BB_OVERRIDES[root] || root.replace(/-/g, ' ');
    root = root.replace(/\s+/g, ' ').trim();
    return `${root} IN Equity`;
  }
  if (/\.ST$/i.test(s)) return `${s.replace(/\.ST$/i, '')} SS Equity`;
  if (/\.T$/i.test(s)) return `${s.replace(/\.T$/i, '')} JT Equity`;
  if (/\.SW$/i.test(s)) return `${s.replace(/\.SW$/i, '')} SW Equity`;
  if (/\.SI$/i.test(s)) return `${s.replace(/\.SI$/i, '')} SP Equity`;
  if (/\.AX$/i.test(s)) return `${s.replace(/\.AX$/i, '')} AU Equity`;
  if (/\.OL$/i.test(s)) return `${s.replace(/\.OL$/i, '')} NO Equity`;
  if (/\.CO$/i.test(s)) return `${s.replace(/\.CO$/i, '')} DC Equity`;
  if (/\.MI$/i.test(s)) return `${s.replace(/\.MI$/i, '')} IM Equity`;
  if (/\.MC$/i.test(s)) return `${s.replace(/\.MC$/i, '')} SM Equity`;
  if (/\.TO$/i.test(s)) return `${s.replace(/\.TO$/i, '')} CN Equity`;
  if (/\.V$/i.test(s)) return `${s.replace(/\.V$/i, '')} CN Equity`;
  if (/^[A-Z]{1,5}$/.test(s.replace(/\./g, '')) && !s.includes('.')) return `${s} US Equity`;
  if (s.includes('.')) return `${s.replace(/\./g, '/')} Equity`;
  return `${s} US Equity`;
}

/** Bloomberg Enterprise HTTP API base (optional). When unset, enterprise fetches are skipped. */
function bloombergEnterpriseBase() {
  return (process.env.BLOOMBERG_ENTERPRISE_API_BASE || '').trim().replace(/\/$/, '');
}

const BBG_ENT_FIELDS = [
  'BEST_PE_NTM',
  'PE_RATIO',
  'BEST_PEG_RATIO',
  'BEST_TARGET_MEDIAN',
  'SALES_GROWTH',
  'SALES_YOY_GR',
  'EPS_GROWTH',
  'BEST_EPS_GROWTH',
  'IS_EPS'
];

/** Placeholder — full mTLS client lives in enterprise deployments; keeps symbol references valid. */
async function enterpriseHttpsRequest(_url, _body) {
  throw new Error('Bloomberg Enterprise HTTPS client not configured');
}

function parseBloombergEnterpriseRefData(_j) {
  return null;
}

/**
 * Alternate symbol spellings FMP indexes (HK padding; NSE Yahoo root vs FMP/Bloomberg root).
 */
function fmpSymbolVariantsForApi(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return [];
  const u = raw.toUpperCase();
  const out = [];
  const seen = new Set();
  const add = cand => {
    const t = String(cand || '').trim();
    if (!t) return;
    const k = t.toUpperCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
    const hy = k.replace(/\./g, '-');
    if (!seen.has(hy)) {
      seen.add(hy);
      out.push(k.replace(/\./g, '-'));
    }
  };
  add(raw);
  add(u);
  const dotNs = /^(.+)\.NS$/i.exec(u);
  if (dotNs) {
    const r0 = dotNs[1].trim().toUpperCase();
    const bloomListing = NSE_BB_OVERRIDES[r0];
    if (bloomListing) {
      add(`${bloomListing}.NS`);
      add(`${bloomListing}`);
    }
  }
  const mhk = /^(\d+)[.](HK)$/i.exec(u);
  if (mhk) {
    const suf = 'HK';
    const rawNum = mhk[1];
    /** Keep Yahoo-style spelling and common FMP HKEX paddings */
    add(`${rawNum}.${suf}`);
    const noLeading = rawNum.replace(/^0+/, '') || '0';
    if (noLeading !== rawNum) add(`${noLeading}.${suf}`);
    add(`${noLeading.padStart(5, '0')}.${suf}`);
    add(`${noLeading.padStart(4, '0')}.${suf}`);
  }
  const bare = u.replace(
    /\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i,
    ''
  );
  if (bare && bare !== u) add(bare);
  return out;
}

/** Yahoo / vendor spellings for intl earnings + Finnhub (NSE/HK padding, Bloomberg root overrides). */
function intlVendorSymbolVariants(symbol) {
  return [
    ...new Set([
      ...fmpSymbolVariantsForApi(symbol),
      ...alphaVantageSymbolVariantsForApi(symbol),
      String(symbol || '').trim(),
      String(symbol || '')
        .trim()
        .toUpperCase(),
      String(symbol || '')
        .trim()
        .replace(/\./g, '-')
    ])
  ].filter(Boolean);
}

const _avCache = new Map();
const _AV_TTL_MS = 60 * 60 * 1000;
/** Separate AV lanes — earnings/fundamentals must not block each other for 12s+ on every variant. */
const _avLanes = {
  default: { chain: Promise.resolve(), lastMs: 0, gapMs: 12500 },
  fast: { chain: Promise.resolve(), lastMs: 0, gapMs: 1200 }
};

async function alphaVantageQuery(params, opts = {}) {
  const key = alphaVantageApiKey();
  if (!key) return null;
  const cacheKey = JSON.stringify({ params, fast: !!opts.fast });
  const hit = _avCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < _AV_TTL_MS) return hit.data;

  const lane = opts.fast ? _avLanes.fast : _avLanes.default;
  const run = async () => {
    const wait = lane.gapMs - (Date.now() - lane.lastMs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lane.lastMs = Date.now();
    const u = new URL('https://www.alphavantage.co/query');
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
    u.searchParams.set('apikey', key);
    const r = await fetch(u.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(18000)
    });
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== 'object') return null;
    if (j.Note || j.Information || j['Error Message']) {
      console.warn('AlphaVantage throttle/info:', String(j.Note || j.Information || j['Error Message']).slice(0, 120));
      return null;
    }
    _avCache.set(cacheKey, { ts: Date.now(), data: j });
    return j;
  };
  lane.chain = lane.chain.then(run, run);
  return lane.chain;
}

/**
 * Alpha Vantage symbol spellings (NSE:ROOT, INFY.NS, padded HK, etc.).
 */
function alphaVantageSymbolVariantsForApi(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return [];
  const u = raw.toUpperCase();
  const out = [];
  const seen = new Set();
  const add = cand => {
    const t = String(cand || '').trim();
    if (!t) return;
    const k = t.toUpperCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  add(raw);
  add(u);
  const dotNs = /^(.+)\.NS$/i.exec(u);
  if (dotNs) {
    const r0 = dotNs[1].trim().toUpperCase();
    const bloom = NSE_BB_OVERRIDES[r0] || r0;
    add(`${r0}.NS`);
    add(`NSE:${r0}`);
    add(`NSE:${bloom}`);
    if (bloom !== r0) {
      add(`${bloom}.NS`);
      add(`NSE:${bloom}`);
    }
  }
  const dotBo = /^(.+)\.BO$/i.exec(u);
  if (dotBo) {
    const r0 = dotBo[1].trim().toUpperCase();
    add(`${r0}.BO`);
    add(`BSE:${r0}`);
  }
  const mhk = /^(\d+)\.HK$/i.exec(u);
  if (mhk) {
    const num = mhk[1];
    add(`${num}.HK`);
    const noLead = num.replace(/^0+/, '') || '0';
    if (noLead !== num) add(`${noLead}.HK`);
    add(`${noLead.padStart(4, '0')}.HK`);
    add(`${noLead.padStart(5, '0')}.HK`);
  }
  add(u.replace(/\./g, '-'));
  const bare = u.replace(
    /\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|SI|AX|BK|ST|CO|OL|MI|MC|VI|SW|TO|V)$/i,
    ''
  );
  if (bare && bare !== u) add(bare);
  return out;
}

async function fetchFundamentalsAlphaVantage(symbol) {
  if (!alphaVantageApiKey()) return null;
  const searchSyms = await alphaVantageSearchSymbolVariants(symbol).catch(() => []);
  const variants = [
    ...new Set([...searchSyms, ...alphaVantageSymbolVariantsForApi(symbol)])
  ].filter(Boolean);
  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const pctGrowth = v => {
    const n = num(v);
    if (n == null) return null;
    if (Math.abs(n) < 5 && Math.abs(n) > 1e-8) return +((n * 100).toFixed(2));
    return +n.toFixed(2);
  };
  for (const sym of variants.slice(0, 10)) {
    const j = await alphaVantageQuery({ function: 'OVERVIEW', symbol: sym }, { fast: true });
    if (!j || !j.Symbol || j.Symbol === 'None') continue;
    const trailingPE = sanitizePe(j.PERatio ?? j.TrailingPE);
    const forwardPE = sanitizePe(j.ForwardPE);
    const pegRatio = sanitizePeg(j.PEGRatio);
    const revenueGrowth = pctGrowth(j.QuarterlyRevenueGrowthYOY ?? j.RevenueGrowth);
    const earningsGrowth = pctGrowth(j.QuarterlyEarningsGrowthYOY ?? j.EarningsGrowth);
    const marketCap = num(j.MarketCapitalization);
    const sector = j.Sector || j.Industry || null;
    if (
      trailingPE == null &&
      forwardPE == null &&
      pegRatio == null &&
      revenueGrowth == null &&
      earningsGrowth == null &&
      !sector
    )
      continue;
    console.log(`AlphaVantage OVERVIEW ${symbol} ← ${sym}`);
    return {
      _source: 'alpha_vantage',
      trailingPE,
      forwardPE,
      pegRatio,
      revenueGrowth,
      earningsGrowth,
      marketCap,
      dividendYield: pctGrowth(j.DividendYield),
      _fmpSector: sector
    };
  }
  return (await fetchFundamentalsAlphaVantageQuote(symbol)) || null;
}

/** Alpha Vantage symbol search — resolves NSE/HK spellings AV accepts for OVERVIEW. */
async function alphaVantageSearchSymbolVariants(symbol) {
  const bare = String(symbol || '')
    .trim()
    .replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW|TO|V|MX)$/i, '');
  if (!bare) return [];
  const j = await alphaVantageQuery({ function: 'SYMBOL_SEARCH', keywords: bare }, { fast: true });
  const out = [];
  const seen = new Set();
  for (const m of j?.bestMatches || []) {
    const sym = String(m['1. symbol'] || '').trim();
    if (!sym) continue;
    const k = sym.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(sym);
  }
  return out;
}

/** Quarterly EPS history — same row shape as FMP/Yahoo earnings helpers. */
async function alphaVantageEarningsHistory(sym, maxRows = 4) {
  if (!alphaVantageApiKey() || !sym) return [];
  const pickNum = v => {
    if (v == null || v === '' || v === 'None') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  for (const v of intlVendorSymbolVariants(sym).slice(0, 6)) {
    const j = await alphaVantageQuery({ function: 'EARNINGS', symbol: v }, { fast: true });
    const reports = j?.quarterlyEarnings || j?.quarterlyReports;
    if (!Array.isArray(reports) || !reports.length) continue;
    const out = reports
      .slice(0, maxRows)
      .map(row => {
        const dateStr = String(row.reportedDate || row.fiscalDateEnding || '').slice(0, 10);
        const ea = pickNum(row.reportedEPS ?? row.actual);
        const ee = pickNum(row.estimatedEPS ?? row.estimate);
        let surpPct = pickNum(row.surprisePercentage);
        if (surpPct == null && ea != null && ee != null && Math.abs(ee) > 1e-9) {
          surpPct = ((ea - ee) / Math.abs(ee)) * 100;
        }
        const quarter = dateStr
          ? new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
          : '';
        const surpLabel =
          surpPct != null && Number.isFinite(surpPct)
            ? (surpPct >= 0 ? '+' : '') + surpPct.toFixed(1) + '%'
            : null;
        return {
          quarter,
          date: dateStr,
          epsActual: ea != null ? String(ea) : null,
          epsEstimate: ee != null ? String(ee) : null,
          epsSurprise: surpLabel,
          beat: surpPct != null ? surpPct >= 0 : null,
          revenueActual: null,
          stockReaction: null
        };
      })
      .filter(r => r.date || r.quarter);
    if (out.length) {
      console.log(`AlphaVantage EARNINGS ${sym} ← ${v} (${out.length} rows)`);
      return out;
    }
  }
  return [];
}

/** Next earnings date from Alpha Vantage calendar (horizon=3month), matched via intl symbol variants. */
async function alphaVantageNextEarningsDate(sym, fromISO, toISO) {
  if (!alphaVantageApiKey() || !sym) return null;
  const j = await alphaVantageQuery({ function: 'EARNINGS_CALENDAR', horizon: '3month' }, { fast: true });
  const rows = j?.earningsCalendar || j?.earnings;
  if (!Array.isArray(rows) || !rows.length) return null;
  const symVariants = new Set(
    intlVendorSymbolVariants(sym).map(s => normalizeTickerMatch(String(s).trim().toUpperCase()))
  );
  const compactSet = new Set([...symVariants].map(s => s.replace(/\./g, '').replace(/^NSE:/, '').replace(/^BSE:/, '')));
  const inWindow = rows.filter(r => {
    const d = String(r.reportDate || r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (fromISO && d < fromISO) return false;
    if (toISO && d > toISO) return false;
    const rs = normalizeTickerMatch(String(r.symbol || '').trim().toUpperCase());
    if (symVariants.has(rs)) return true;
    const rc = rs.replace(/\./g, '').replace(/^NSE:/, '').replace(/^BSE:/, '');
    return compactSet.has(rc);
  });
  inWindow.sort((a, b) => String(a.reportDate || a.date).localeCompare(String(b.reportDate || b.date)));
  const hit = inWindow[0];
  if (!hit) return null;
  const date = String(hit.reportDate || hit.date).slice(0, 10);
  const epsEst = hit.estimate != null ? String(hit.estimate) : hit.epsEstimate != null ? String(hit.epsEstimate) : null;
  console.log(`AlphaVantage EARNINGS_CALENDAR ${sym} → ${date}`);
  return { date, epsEst, source: 'alpha_vantage' };
}

/** Finnhub often wants bare NSE root or NSE: prefix — not only Yahoo-style *.NS. */
function finnhubSymbolVariants(symbol) {
  const u = String(symbol || '').trim().toUpperCase();
  const out = [...intlVendorSymbolVariants(symbol)];
  const dotNs = /^(.+)\.NS$/i.exec(u);
  if (dotNs) {
    const r0 = dotNs[1].trim();
    out.unshift(r0, `NSE:${r0}`);
    const bloom = NSE_BB_OVERRIDES[r0];
    if (bloom && bloom !== r0) out.unshift(bloom, `NSE:${bloom}`);
  }
  const dotBo = /^(.+)\.BO$/i.exec(u);
  if (dotBo) {
    const r0 = dotBo[1].trim();
    out.unshift(r0, `BSE:${r0}`);
  }
  const mhk = /^(\d+)\.HK$/i.exec(u);
  if (mhk) {
    const rawNum = mhk[1];
    const noLead = rawNum.replace(/^0+/, '') || '0';
    out.unshift(`${noLead}.HK`, `${noLead.padStart(4, '0')}.HK`, `${noLead.padStart(5, '0')}.HK`, noLead);
  }
  return [...new Set(out.filter(Boolean))];
}

/** FMP exchange-variant lookup — maps 9988.HK / ASIANPAINT.NS to the symbol FMP indexes for metrics/scores. */
async function fmpExchangeSymbolVariants(symbol, key) {
  if (!symbol || !key) return [];
  const found = [];
  const seen = new Set();
  const add = s => {
    const t = String(s || '').trim();
    if (!t) return;
    const k = t.toUpperCase();
    if (seen.has(k)) return;
    seen.add(k);
    found.push(t);
  };
  for (const seed of intlVendorSymbolVariants(symbol).slice(0, 8)) {
    try {
      const url = `https://financialmodelingprep.com/stable/search-exchange-variants?symbol=${encodeURIComponent(seed)}&apikey=${encodeURIComponent(key)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
      for (const row of rows) {
        add(row?.symbol ?? row?.ticker ?? row?.companySymbol);
      }
    } catch (_) {}
  }
  return found;
}

/** All FMP API symbol spellings: intl variants + exchange-variant discovery. */
async function fmpAllSymbolVariants(symbol, key) {
  const staticV = intlVendorSymbolVariants(symbol);
  const exch = key ? await fmpExchangeSymbolVariants(symbol, key).catch(() => []) : [];
  return [...new Set([...exch, ...staticV])].filter(Boolean);
}

const YAHOO_PRICE_FIELDS =
  'regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,currency,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow';
const YAHOO_QUOTE_FUND_FIELDS = [
  YAHOO_PRICE_FIELDS,
  'trailingPE',
  'forwardPE',
  'pegRatio',
  'trailingPegRatio',
  'epsTrailingTwelveMonths',
  'revenueGrowth',
  'earningsGrowth',
  'sector',
  'industry',
  'marketCap'
].join(',');

/** FMP wins over Yahoo/AV/Finnhub for numeric fundamentals (Ultimate global path). */
function mergeFmpPrimary(base, fmp) {
  if (!fmp || typeof fmp !== 'object') return base || {};
  const out = { ...(base || {}) };
  const snap = sanitizeFundSnapshot(fmp);
  for (const [k, v] of Object.entries(snap)) {
    if (v == null || v === '') continue;
    if (String(k).startsWith('_') && !FUNDAMENTAL_MERGE_META.has(k)) continue;
    out[k] = v;
  }
  out._source = 'fmp';
  return out;
}

/** Merge overlay into base only where base keys are still empty (Bloomberg backup mode). */
function mergeGapFillOnly(base, overlay) {
  if (!overlay || typeof overlay !== 'object') return base || {};
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v == null || v === '') continue;
    if (String(k).startsWith('_') && !FUNDAMENTAL_MERGE_META.has(k)) continue;
    if (out[k] == null || out[k] === '') out[k] = v;
  }
  if (overlay._source && !out._source) out._source = overlay._source;
  if (overlay._bbSecurity && !out._bbSecurity) out._bbSecurity = overlay._bbSecurity;
  return out;
}

/** Yahoo v7 quote fundamentals — same symbol variants as fetchSinglePrice (intl spellings often 401). */
async function fetchFundamentalsFromYahooV7Quote(symbol) {
  const base = String(symbol || '').trim();
  const variants = [
    ...new Set([
      base,
      base.replace(/\./g, '-'),
      ...intlVendorSymbolVariants(symbol).slice(0, 6)
    ])
  ].filter(Boolean);
  const num = v => {
    const n = v?.raw ?? v;
    return Number.isFinite(+n) ? +n : null;
  };
  const pct = v => {
    const n = num(v);
    if (n == null) return null;
    if (Math.abs(n) <= 4.5 && Math.abs(n) > 1e-8) return +((n * 100).toFixed(1));
    return +n.toFixed(1);
  };
  const parseQ = (q, symLabel) => {
    if (!q) return null;
    const price = num(q.regularMarketPrice);
    const eps = num(
      q.epsTrailingTwelveMonths ?? q.trailingEps ?? q.epsCurrentYear ?? q.epsForward
    );
    let trailingPE = sanitizePe(num(q.trailingPE));
    if (trailingPE == null && price != null && eps != null && Math.abs(eps) > 1e-6) {
      trailingPE = sanitizePe(+Math.abs(price / eps).toFixed(2));
    }
    const forwardPE = sanitizePe(num(q.forwardPE));
    const pegRatio = sanitizePeg(num(q.trailingPegRatio ?? q.pegRatio));
    const revenueGrowth = pct(q.revenueGrowth);
    const earningsGrowth = pct(q.earningsGrowth);
    const sector = String(q.sector || q.industry || '').trim() || null;
    if (
      trailingPE == null &&
      forwardPE == null &&
      pegRatio == null &&
      revenueGrowth == null &&
      earningsGrowth == null &&
      !sector
    )
      return null;
    console.log(`fetchFundamentalsFromYahooV7Quote ${symbol} ← ${symLabel}`);
    return {
      forwardPE,
      trailingPE,
      pegRatio,
      revenueGrowth,
      earningsGrowth,
      marketCap: num(q.marketCap),
      _fmpSector: sector,
      _source: 'yahoo_v7_quote'
    };
  };
  for (const sym of variants) {
    for (const base of ['query1', 'query2']) {
      try {
        const narrow = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=${YAHOO_QUOTE_FUND_FIELDS}`;
        let r = await fetch(narrow, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          const hit = parseQ(d?.quoteResponse?.result?.[0], sym);
          if (hit) return hit;
        }
        const priceOnly = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=${YAHOO_PRICE_FIELDS},trailingPE,forwardPE,pegRatio,epsTrailingTwelveMonths`;
        r = await fetch(priceOnly, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          const hit = parseQ(d?.quoteResponse?.result?.[0], sym);
          if (hit) return hit;
        }
        const wide = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;
        r = await fetch(wide, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          const hit = parseQ(d?.quoteResponse?.result?.[0], sym);
          if (hit) return hit;
        }
      } catch (e) {
        console.warn('fetchFundamentalsFromYahooV7Quote', sym, e.message);
      }
    }
    try {
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const r = await fetch(chartUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const meta = d?.chart?.result?.[0]?.meta;
        if (meta) {
          const price = num(meta.regularMarketPrice);
          let trailingPE = sanitizePe(num(meta.trailingPE));
          const eps = num(meta.epsTrailingTwelveMonths);
          if (trailingPE == null && price != null && eps != null && Math.abs(eps) > 1e-6) {
            trailingPE = sanitizePe(+Math.abs(price / eps).toFixed(2));
          }
          const hit = parseQ(
            {
              regularMarketPrice: price,
              trailingPE,
              forwardPE: meta.forwardPE,
              pegRatio: meta.pegRatio,
              epsTrailingTwelveMonths: eps
            },
            sym + ':v8'
          );
          if (hit) return hit;
        }
      }
    } catch (e) {
      console.warn('fetchFundamentalsFromYahooV7Quote chart', sym, e.message);
    }
  }
  return null;
}

/** FMP /quote — often returns pe + eps for .NS/.HK when key-metrics endpoints are empty on plan. */
async function fetchFundamentalsFromFmpQuote(symbol) {
  const k = fmpEnvKeyFund();
  if (!k) return null;
  const variants = await fmpAllSymbolVariants(symbol, k).catch(() => intlVendorSymbolVariants(symbol));
  const num = x => {
    const t = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/,/g, ''));
    return Number.isFinite(t) ? t : null;
  };
  for (const raw of variants.slice(0, 14)) {
    for (const makeUrl of [
      () =>
        `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(raw)}?apikey=${encodeURIComponent(k)}`,
      () =>
        `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(raw)}&apikey=${encodeURIComponent(k)}`
    ]) {
      try {
        const url = makeUrl();
        const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        let arr = await r.json().catch(() => []);
        if (!Array.isArray(arr) && arr && typeof arr === 'object') {
          arr = Array.isArray(arr.data) ? arr.data : [arr];
        }
        const row = Array.isArray(arr) && arr[0] ? arr[0] : null;
        if (!row) continue;
        const price = num(row.price ?? row.close);
        const eps = num(row.eps);
        let trailingPE = sanitizePe(num(row.pe ?? row.peRatio));
        if (trailingPE == null && price != null && eps != null && Math.abs(eps) > 1e-6) {
          trailingPE = sanitizePe(+Math.abs(price / eps).toFixed(2));
        }
        if (trailingPE == null && eps == null) continue;
        console.log(`fetchFundamentalsFromFmpQuote ${symbol} ← ${raw}`);
        return {
          trailingPE,
          fundamentalTrailingEps: eps,
          marketCap: num(row.marketCap),
          _source: 'fmp'
        };
      } catch (e) {
        console.warn('fetchFundamentalsFromFmpQuote', raw, e.message);
      }
    }
  }
  return null;
}

/** Finnhub profile2 — sector + market cap when /stock/metric is empty for intl listings. */
async function fetchFinnhubProfileFundamentals(symbol) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token || !symbol) return null;
  for (const v of finnhubSymbolVariants(symbol).slice(0, 12)) {
    try {
      const url = new URL('https://finnhub.io/api/v1/stock/profile2');
      url.searchParams.set('symbol', v);
      url.searchParams.set('token', token);
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || typeof j !== 'object' || j.error) continue;
      const sector = j.finnhubIndustry || j.industry || null;
      const marketCap = Number(j.marketCapitalization);
      if (!sector && !Number.isFinite(marketCap)) continue;
      console.log(`fetchFinnhubProfileFundamentals ${symbol} ← ${v}`);
      return {
        marketCap: Number.isFinite(marketCap) ? marketCap * 1e6 : null,
        _fmpSector: sector,
        _source: 'finnhub_metric'
      };
    } catch (e) {
      console.warn('fetchFinnhubProfileFundamentals', v, e.message);
    }
  }
  return null;
}

/** Yahoo v8 chart meta — fallback when v7 quote omits fundamentals (same path as live price chart). */
async function fetchFundamentalsFromYahooV8Chart(symbol) {
  const base = String(symbol || '').trim();
  const variants = [
    ...new Set([base, base.replace(/\./g, '-'), ...intlVendorSymbolVariants(symbol).slice(0, 6)])
  ].filter(Boolean);
  const num = v => (Number.isFinite(+v) ? +v : null);
  for (const sym of variants) {
    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const d = await r.json().catch(() => null);
        const meta = d?.chart?.result?.[0]?.meta;
        if (!meta) continue;
        const price = num(meta.regularMarketPrice);
        let trailingPE = num(meta.trailingPE);
        const forwardPE = num(meta.forwardPE);
        const pegRatio = num(meta.pegRatio ?? meta.trailingPegRatio);
        if (trailingPE == null && price != null && meta.epsTrailingTwelveMonths != null) {
          const eps = num(meta.epsTrailingTwelveMonths);
          if (eps != null && Math.abs(eps) > 1e-6) trailingPE = +Math.abs(price / eps).toFixed(2);
        }
        if (trailingPE == null && forwardPE == null && pegRatio == null) continue;
        console.log(`fetchFundamentalsFromYahooV8Chart ${symbol} ← ${sym}`);
        return {
          trailingPE,
          forwardPE,
          pegRatio,
          marketCap: num(meta.marketCap),
          _source: 'yahoo_v8_chart'
        };
      } catch (e) {
        console.warn('fetchFundamentalsFromYahooV8Chart', sym, e.message);
      }
    }
  }
  return null;
}

/** FMP income statement + live price → trailing P/E and YoY growth when key-metrics endpoints are empty. */
async function fetchFmpIncomeDerivedFundamentals(symbol, livePrice) {
  const k = fmpEnvKeyFund();
  if (!k) return null;
  const variants = await fmpAllSymbolVariants(symbol, k).catch(() => intlVendorSymbolVariants(symbol));
  const num = x => {
    const t = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/,/g, ''));
    return Number.isFinite(t) ? t : null;
  };
  for (const raw of variants.slice(0, 14)) {
    for (const isUrl of [
      `https://financialmodelingprep.com/api/v3/income-statement/${encodeURIComponent(raw)}?limit=2&apikey=${encodeURIComponent(k)}`,
      `https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(raw)}&limit=2&apikey=${encodeURIComponent(k)}`
    ]) {
      try {
        const r = await fetch(isUrl, { signal: AbortSignal.timeout(14000) });
        if (!r.ok) continue;
        let arr = await r.json().catch(() => []);
        if (!Array.isArray(arr) && arr && typeof arr === 'object') {
          arr = Array.isArray(arr.data) ? arr.data : [];
        }
        if (!Array.isArray(arr) || !arr.length) continue;
        const cur = arr[0];
        const prev = arr.length > 1 ? arr[1] : null;
        const calcG = (c, p) =>
          c != null && p != null && p !== 0 && Math.abs(p) > 1
            ? Math.round(((c - p) / Math.abs(p)) * 1000) / 10
            : null;
        const revenueGrowth = calcG(cur?.revenue ?? cur?.totalRevenue, prev?.revenue ?? prev?.totalRevenue);
        const earningsGrowth = calcG(cur?.netIncome, prev?.netIncome);
        let eps = num(cur?.eps ?? cur?.epsDiluted);
        if (eps == null && cur?.netIncome != null && cur?.weightedAverageShsOut) {
          const sh = num(cur.weightedAverageShsOut);
          if (sh && Math.abs(sh) > 1) eps = cur.netIncome / sh;
        }
        let trailingPE = null;
        if (livePrice != null && eps != null && Math.abs(eps) > 1e-6) {
          trailingPE = +Math.abs(Number(livePrice) / eps).toFixed(2);
        }
        if (
          trailingPE == null &&
          revenueGrowth == null &&
          earningsGrowth == null &&
          eps == null
        )
          continue;
        console.log(`fetchFmpIncomeDerivedFundamentals ${symbol} ← ${raw}`);
        return {
          trailingPE,
          revenueGrowth,
          earningsGrowth,
          fundamentalTrailingEps: eps,
          _source: 'fmp'
        };
      } catch (e) {
        console.warn('fetchFmpIncomeDerivedFundamentals', raw, e.message);
      }
    }
  }
  if (livePrice != null) {
    const q = await fetchFundamentalsFromFmpQuote(symbol).catch(() => null);
    if (q?.fundamentalTrailingEps && q.trailingPE == null) {
      q.trailingPE = +Math.abs(Number(livePrice) / q.fundamentalTrailingEps).toFixed(2);
    }
    if (q?.trailingPE != null) return q;
  }
  return null;
}

/** Finnhub annual income statement — growth + implied metrics for intl when /stock/metric is empty. */
async function fetchFinnhubFinancialsFundamentals(symbol) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token || !symbol) return null;
  const num = v => {
    const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(x) ? x : null;
  };
  for (const v of finnhubSymbolVariants(symbol).slice(0, 12)) {
    try {
      const url = new URL('https://finnhub.io/api/v1/stock/financials');
      url.searchParams.set('symbol', v);
      url.searchParams.set('statement', 'ic');
      url.searchParams.set('freq', 'annual');
      url.searchParams.set('token', token);
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(14000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !Array.isArray(j.financials) || !j.financials.length) continue;
      const rows = j.financials.filter(x => x && x.period);
      if (rows.length < 2) continue;
      const cur = rows[0];
      const prev = rows[1];
      const calcG = (c, p) =>
        c != null && p != null && p !== 0 && Math.abs(p) > 1
          ? Math.round(((c - p) / Math.abs(p)) * 1000) / 10
          : null;
      const revenueGrowth = calcG(num(cur.revenue ?? cur.netSales), num(prev.revenue ?? prev.netSales));
      const earningsGrowth = calcG(num(cur.netIncome), num(prev.netIncome));
      if (revenueGrowth == null && earningsGrowth == null) continue;
      console.log(`fetchFinnhubFinancialsFundamentals ${symbol} ← ${v}`);
      return {
        revenueGrowth,
        earningsGrowth,
        _source: 'finnhub_metric'
      };
    } catch (e) {
      console.warn('fetchFinnhubFinancialsFundamentals', v, e.message);
    }
  }
  return null;
}

/** Alpha Vantage GLOBAL_QUOTE — PERatio when OVERVIEW is empty/throttled. */
async function fetchFundamentalsAlphaVantageQuote(symbol) {
  if (!alphaVantageApiKey()) return null;
  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  for (const sym of alphaVantageSymbolVariantsForApi(symbol).slice(0, 6)) {
    const j = await alphaVantageQuery({ function: 'GLOBAL_QUOTE', symbol: sym }, { fast: true });
    const q = j?.['Global Quote'] || j?.globalQuote;
    if (!q || typeof q !== 'object') continue;
    const trailingPE = num(q['PERatio'] ?? q.pe);
    const pegRatio = num(q['PEGRatio'] ?? q.pegRatio);
    if (trailingPE == null && pegRatio == null) continue;
    console.log(`AlphaVantage GLOBAL_QUOTE ${symbol} ← ${sym}`);
    return {
      trailingPE,
      pegRatio,
      _source: 'alpha_vantage'
    };
  }
  return null;
}

/** FMP /stable/* bundle — often the only path that returns TTM metrics for .NS/.HK on newer FMP plans. */
async function fetchFmpStableFundamentalsBundle(raw, key) {
  if (!raw || !key) return null;
  const enc = encodeURIComponent(raw);
  const q = `apikey=${encodeURIComponent(key)}`;
  const base = 'https://financialmodelingprep.com/stable';
  const H = { Accept: 'application/json' };
  const t = 12000;
  const num = x => {
    const v = x?.raw ?? x;
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const pctGrowth = x => {
    const t0 = num(x);
    if (t0 == null) return null;
    const asPct = Math.abs(t0) < 25 ? +(t0 * 100).toFixed(1) : +t0.toFixed(1);
    return Number.isFinite(asPct) ? asPct : null;
  };
  try {
    const [kmR, ratR, prR, isR, isgR] = await Promise.allSettled([
      fetch(`${base}/key-metrics-ttm?symbol=${enc}&${q}`, { headers: H, signal: AbortSignal.timeout(t) }),
      fetch(`${base}/ratios-ttm?symbol=${enc}&${q}`, { headers: H, signal: AbortSignal.timeout(t) }),
      fetch(`${base}/profile?symbol=${enc}&${q}`, { headers: H, signal: AbortSignal.timeout(t) }),
      fetch(`${base}/income-statement?symbol=${enc}&limit=2&${q}`, { headers: H, signal: AbortSignal.timeout(t) }),
      fetch(`${base}/income-statement-growth?symbol=${enc}&limit=1&${q}`, { headers: H, signal: AbortSignal.timeout(t) })
    ]);
    const parseArr = async settled => {
      if (settled.status !== 'fulfilled' || !settled.value.ok) return null;
      const j = await settled.value.json().catch(() => null);
      if (Array.isArray(j) && j[0]) return j[0];
      if (j && typeof j === 'object' && Array.isArray(j.data) && j.data[0]) return j.data[0];
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    };
    const km = await parseArr(kmR);
    const rat = await parseArr(ratR);
    const pf = await parseArr(prR);
    let isGr = null;
    if (isR.status === 'fulfilled' && isR.value.ok) {
      const arr = await isR.value.json().catch(() => []);
      const rows = Array.isArray(arr) ? arr : Array.isArray(arr?.data) ? arr.data : [];
      if (rows.length >= 2) {
        const cur = rows[0];
        const prev = rows[1];
        const calcG = (c, p) =>
          c != null && p != null && p !== 0 && Math.abs(p) > 1
            ? Math.round(((c - p) / Math.abs(p)) * 1000) / 10
            : null;
        isGr = {
          revenueGrowth: calcG(cur?.revenue ?? cur?.totalRevenue, prev?.revenue ?? prev?.totalRevenue),
          earningsGrowth: calcG(cur?.netIncome, prev?.netIncome)
        };
      }
    }
    const peRatio =
      num(km?.peRatioTTM ?? km?.peRatio ?? rat?.priceToEarningsRatioTTM ?? rat?.priceEarningsRatioTTM);
    const fwdPE = num(km?.forwardPE ?? km?.priceToEarningsRatioFwd ?? rat?.forwardPE);
    const pegRatio = num(
      km?.pegRatioTTM ?? km?.pegRatio ?? rat?.priceToEarningsGrowthRatioTTM ?? rat?.pegRatioTTM
    );
    let revenueGrowth =
      pctGrowth(km?.revenueGrowth ?? rat?.revenueGrowth) ?? isGr?.revenueGrowth ?? null;
    let earningsGrowth =
      pctGrowth(km?.epsgrowth ?? km?.netIncomeGrowth ?? rat?.netIncomeGrowth) ??
      isGr?.earningsGrowth ??
      null;
    const isg = await parseArr(isgR);
    if (isg) {
      revenueGrowth =
        revenueGrowth ??
        pctGrowth(isg?.growthRevenue ?? isg?.growthTotalRevenue ?? isg?.revenueGrowth);
      earningsGrowth =
        earningsGrowth ??
        pctGrowth(
          isg?.growthNetIncome ?? isg?.growthEPS ?? isg?.growthEpsDiluted ?? isg?.netIncomeGrowth
        );
    }
    const hasNumeric =
      peRatio != null ||
      pegRatio != null ||
      fwdPE != null ||
      revenueGrowth != null ||
      earningsGrowth != null ||
      num(km?.marketCap ?? pf?.mktCap) != null;
    if (!hasNumeric) return null;
    console.log(`fetchFmpStableFundamentals ${normalizeTickerMatch(raw)}`);
    return sanitizeFundSnapshot({
      targetMeanPrice: num(pf?.priceTarget ?? pf?.targetConsensus) ?? null,
      revenueGrowth,
      earningsGrowth,
      grossMargins: pctGrowth(km?.grossProfitMarginTTM ?? rat?.grossProfitMarginTTM),
      operatingMargins: pctGrowth(km?.operatingProfitMarginTTM ?? rat?.operatingProfitMarginTTM),
      debtToEquity:
        num(km?.debtToEquityTTM ?? rat?.debtToEquityRatioTTM) != null
          ? Number(num(km?.debtToEquityTTM ?? rat?.debtToEquityRatioTTM).toFixed(1))
          : null,
      forwardPE: sanitizePe(fwdPE),
      pegRatio: sanitizePeg(pegRatio),
      trailingPE: sanitizePe(peRatio),
      dividendYield: pctGrowth(km?.dividendYieldTTM ?? rat?.dividendYieldTTM),
      marketCap: num(km?.marketCap ?? pf?.mktCap),
      _fmpSector: pf?.sector || pf?.industry || null,
      _source: 'fmp'
    });
  } catch (e) {
    console.warn('fetchFmpStableFundamentals', raw, e.message);
    return null;
  }
}

async function fetchFundamentalsFMP(symbol) {
  const k = fmpEnvKeyFund();
  if (!k) return null;
  const _fmpFundBare = symbol.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i,'');
  const variants = [
    ...new Set([
      ...(await fmpAllSymbolVariants(symbol, k).catch(() => [])),
      ...intlVendorSymbolVariants(symbol),
      symbol,
      _fmpFundBare,
      symbol.replace(/\./g, '-')
    ])
  ];
  for (const raw of variants) {
    const stableHit = await fetchFmpStableFundamentalsBundle(raw, k).catch(() => null);
    if (stableHit) return stableHit;
    try {
      const enc = encodeURIComponent(raw);
      const kmUrl = `https://financialmodelingprep.com/api/v3/key-metrics-ttm/${enc}?apikey=${encodeURIComponent(k)}`;
      const grUrl = `https://financialmodelingprep.com/api/v3/financial-growth/${enc}?limit=1&apikey=${encodeURIComponent(k)}`;
      // Income statement: best source for YoY growth for .NS/.T/.HK where financial-growth is sparse
      const isUrl=`https://financialmodelingprep.com/api/v3/income-statement/${enc}?limit=2&apikey=${encodeURIComponent(k)}`;
      const prUrl = `https://financialmodelingprep.com/api/v3/profile/${enc}?apikey=${encodeURIComponent(k)}`;
      const anUrl=`https://financialmodelingprep.com/api/v3/analyst-stock-recommendations/${enc}?limit=1&apikey=${encodeURIComponent(k)}`;
      const ptUrl=`https://financialmodelingprep.com/api/v3/price-target-consensus/${enc}?apikey=${encodeURIComponent(k)}`;
      const [kmTxt,grTxt,prTxt,anTxt,ptTxt,isTxt]=await Promise.all([
        fetch(kmUrl,{signal:AbortSignal.timeout(12000)}).then(r=>r.ok?r.text():''),
        fetch(grUrl,{signal:AbortSignal.timeout(12000)}).then(r=>r.ok?r.text():''),
        fetch(prUrl,{signal:AbortSignal.timeout(12000)}).then(r=>r.ok?r.text():''),
        fetch(anUrl,{signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.text():'').catch(()=>''),
        fetch(ptUrl,{signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.text():'').catch(()=>''),
        fetch(isUrl,{signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.text():'').catch(()=>''),
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
      // YoY from income statement — best for .NS/.T/.HK where financial-growth is sparse
      let isGr = null;
      try {
        const a = isTxt ? JSON.parse(isTxt) : [];
        if (Array.isArray(a) && a.length >= 2) {
          const cur = a[0], prev = a[1];
          const calcG = (c,p) => (c!=null&&p!=null&&p!==0&&Math.abs(p)>1) ? Math.round((c-p)/Math.abs(p)*1000)/10 : null;
          isGr = {
            revenueGrowth:  calcG(cur?.revenue??cur?.totalRevenue, prev?.revenue??prev?.totalRevenue),
            earningsGrowth: calcG(cur?.netIncome, prev?.netIncome)
          };
        }
      } catch(_){}
      let pf=null;try{const a=prTxt?JSON.parse(prTxt):[];pf=Array.isArray(a)&&a[0]?a[0]:null;}catch(_){}
      let an=null;try{const a=anTxt?JSON.parse(anTxt):[];an=Array.isArray(a)&&a[0]?a[0]:null;}catch(_){}
      let pt=null;try{const a=ptTxt?JSON.parse(ptTxt):[];pt=Array.isArray(a)&&a[0]?a[0]:null;}catch(_){}
      if (!km && !gr && !pf && !isGr?.revenueGrowth && !isGr?.earningsGrowth) continue;
      const anBuy=(an?.analystRatingsBuy||0)+(an?.analystRatingsStrongBuy||0);
      const anHold=an?.analystRatingsHold||0;
      const anSell=(an?.analystRatingsSell||0)+(an?.analystRatingsStrongSell||0);
      const anTotal=anBuy+anHold+anSell;
      const bR=anTotal>0?anBuy/anTotal:0,brR=anTotal>0?anSell/anTotal:0;
      const derivedRecKey=anTotal>0?(bR>=0.70?'strongBuy':bR>=0.55?'buy':brR>=0.55?'strongSell':brR>=0.40?'sell':'hold'):null;
      const derivedTarget=pt?.targetConsensus??pt?.lastMonthAvgPriceTarget??null;
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
      const revenueGrowth = pctGrowth(gr?.revenueGrowth) ?? pctGrowth(gr?.growthRevenue)
        ?? isGr?.revenueGrowth;  // YoY from income statement
      const earningsGrowth = pctGrowth(gr?.epsgrowth ?? gr?.growthEps ?? gr?.netIncomeGrowth)
        ?? isGr?.earningsGrowth;  // YoY from income statement
      // FMP key-metrics-ttm uses TTM suffix; key-metrics uses plain names — try both
      const peRatio  = num(km?.peRatioTTM ?? km?.peRatio ?? km?.priceEarningsRatio);
      const fwdPE    = num(km?.priceToEarningsRatioFwd ?? km?.forwardPE);
      const pegRatio = num(km?.pegRatioTTM ?? km?.pegRatio ?? km?.priceToEarningsGrowthRatio);
      // Skip profile-only rows — sector alone is not enough for fundamentals tiles
      if (
        peRatio == null &&
        pegRatio == null &&
        fwdPE == null &&
        revenueGrowth == null &&
        earningsGrowth == null
      )
        continue;
      console.log('fetchFundamentalsFMP', normalizeTickerMatch(raw));
      return sanitizeFundSnapshot({
        targetMeanPrice: derivedTarget!=null?parseFloat(derivedTarget):null,
        analystCount: anTotal||null,
        recommendationKey: derivedRecKey,
        analystBuyCount: anBuy||null,
        analystHoldCount: anHold||null,
        analystSellCount: anSell||null,
        revenueGrowth,
        earningsGrowth,
        grossMargins: pctGrowth(km?.grossProfitMarginTTM ?? km?.grossProfitMargin ?? gr?.growthGrossProfit),
        operatingMargins: pctGrowth(
          km?.operatingIncomeRatioTTM ?? km?.operatingProfitMarginTTM ?? km?.operatingProfitMargin
        ),
        debtToEquity:
          (km?.debtToEquityTTM ?? km?.debtToEquity) != null
            ? Number(num(km?.debtToEquityTTM ?? km?.debtToEquity).toFixed(1))
            : null,
        forwardPE: sanitizePe(fwdPE),
        pegRatio: sanitizePeg(pegRatio),
        trailingPE: sanitizePe(peRatio),
        dividendYield: pctGrowth(km?.dividendYield),
        marketCap: num(km?.marketCap ?? pf?.mktCap),
        _fmpSector: pf?.sector || pf?.industry || null,
        _source: 'fmp'
      });
    } catch (e) {
      console.warn('fetchFundamentalsFMP', raw, e.message);
    }
  }
  return null;
}

/** Metadata keys preserved when layering Yahoo ⇄ FMP ⇄ Bloomberg (underscore keys were wrongly dropped before). */
const FUNDAMENTAL_MERGE_META = new Set(['_source', '_bbSecurity', '_fmpSector']);

function mergeFundSnapshots(y, f) {
  y = y ? sanitizeFundSnapshot(y) : y;
  f = f ? sanitizeFundSnapshot(f) : f;
  if (!y) return f;
  if (!f) return y;
  const out = { ...y };
  const sourceRank = s => {
    if (s === 'bloomberg_bridge' || s === 'bloomberg_enterprise') return 4;
    if (s === 'fmp' || s === 'finnhub_metric' || s === 'alpha_vantage' || s === 'yahoo_v7_quote') return 2;
    if (s) return 1;
    return 0;
  };
  for (const k of Object.keys(f)) {
    if (String(k).startsWith('_')) {
      if (!FUNDAMENTAL_MERGE_META.has(k)) continue;
      const fv = f[k];
      if (fv == null || fv === '') continue;
      if (k === '_source') {
        if (sourceRank(fv) > sourceRank(out[k])) out[k] = fv;
        continue;
      }
      out[k] = fv;
      continue;
    }
    const yv = out[k];
    const fv = f[k];
    if ((yv === null || yv === undefined) && fv != null && fv !== undefined) out[k] = fv;
  }
  return out;
}

/** FMP stable financial health scores (Piotroski + Altman) — fills gaps when legacy /score is empty for some intl names. */
async function fetchFmpStableFinancialScores(symbol, key, tHttp) {
  if (!symbol || !key) return null;
  const q = `?apikey=${encodeURIComponent(key)}`;
  const H = { Accept: 'application/json' };
  const t = Number(tHttp) || 12000;

  const symVariants = [...new Set([...(await fmpAllSymbolVariants(symbol, key).catch(() => [])), ...intlVendorSymbolVariants(symbol)])].slice(0, 18);

  for (const sym of symVariants) {
    const enc = encodeURIComponent(sym);
    // Endpoints in order of Piotroski/AltmanZ coverage
    const endpoints = [
      `https://financialmodelingprep.com/stable/financial-scores${q}&symbol=${enc}`,
      `https://financialmodelingprep.com/api/v3/score/${enc}${q}`,
      `https://financialmodelingprep.com/api/v4/score${q}&symbol=${enc}`,
    ];
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(t) });
        if (!r.ok) continue;
        let d = await r.json().catch(() => null);
        if (!d) continue;
        if (typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.data)) d = d.data;
        const row = Array.isArray(d) ? d[0] : (typeof d === 'object' ? d : null);
        if (!row || row.error || row['Error Message']) continue;
        const pick = (o, keys) => {
          for (const k of keys) {
            if (o[k] == null || o[k] === '') continue;
            const n = typeof o[k] === 'number' ? o[k] : Number(String(o[k]).replace(/,/g, ''));
            if (Number.isFinite(n)) return n;
          }
          return null;
        };
        const pio = pick(row, [
          'piotroskiScore',
          'piotroski',
          'fScore',
          'f_score',
          'piotroskiFScore',
          'piotroskiScoreTTM'
        ]);
        const az = pick(row, [
          'altmanZScore',
          'altmanZ',
          'altman_z_score',
          'altmanZscore',
          'zScore',
          'altmanZScoreTTM'
        ]);
        if (pio != null || az != null) {
          console.log(`FMP scores ${symbol}→${sym} (${url.split('/').slice(-2,-1)[0]}): pio=${pio} az=${az}`);
          return { piotroski: pio, altmanZ: az };
        }
      } catch(e) { /* try next */ }
    }
  }
  console.log(`FMP scores ${symbol}: no Piotroski/AltmanZ data from any endpoint`);
  return null;
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

/** Last /snapshot fundamentals attempt — helps debug BB vs Yahoo vs FMP on cloud hosts. */
let lastBloombergSnapshotProbe = {
  ts: 0,
  symbol: '',
  ok: false,
  httpStatus: null,
  err: null,
  numericFieldsSeen: 0,
  bbSecurity: null,
  bridgeBuild: /** @type {string|null} */ (null),
  elapsedMs: null
};

/** Last /earnings bridge attempt — surfaces 401/no_tunnel/date_parse issues in /api/health */
let lastBloombergEarningsProbe = {
  ts: 0,
  symbol: '',
  ok: false,
  httpStatus: null,
  err: null,
  bbSecurity: null,
  nextDateSeen: null,
  bridgeBuild: /** @type {string|null} */ (null),
  elapsedMs: null
};

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

/** Ngrok free tiers may return an HTML interstitial unless this header is sent. */
function bloombergBridgeFetchHeaders() {
  const headers = {
    Accept: 'application/json',
    'User-Agent': YF_HEADERS['User-Agent']
  };
  try {
    const host = new URL(bloombergBridgeUrl()).hostname.toLowerCase();
    if (host.includes('ngrok')) {
      headers['ngrok-skip-browser-warning'] = '69420';
    }
    /** Cloudflare quick tunnels sometimes serve a browser interstitial without a crawler-like UA */
    if (
      host.includes('trycloudflare.com') ||
      host.endsWith('.cfargotunnel.com') ||
      host.includes('loca.lt')
    ) {
      headers['User-Agent'] = 'curl/8.7.1';
    }
  } catch (_) {}
  const secret = (process.env.BLOOMBERG_BRIDGE_SECRET || '').trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/**
 * Local Bloomberg Desktop API bridge (Terminal on your PC). Set BLOOMBERG_BRIDGE_URL=http://127.0.0.1:5055
 * See bloomberg-bridge/README.md. Bloomberg fields override Yahoo/FMP when present.
 */
async function fetchBloombergBridgeFundamentals(symbol) {
  const base = bloombergBridgeUrl();
  if (!base) return null;
  /** Cloud hosts cannot reach LAN/loopback — skip fast instead of blocking every analyze on a 28s timeout. */
  if (bloombergBridgeUrlIsUnreachableFromInternet()) {
    console.warn(
      'Bloomberg bridge skipped (LAN-only URL — set BLOOMBERG_BRIDGE_URL to an ngrok/HTTPS tunnel to reach Terminal from Render).',
      symbol
    );
    return null;
  }
  const sec = toBloombergEquity(symbol);
  if (!sec) return null;
  const t0 = Date.now();
  try {
    const u = new URL('/snapshot', base + '/');
    u.searchParams.set('symbol', symbol);
    u.searchParams.set('bb', sec);
    const r = await fetch(u.toString(), { headers: bloombergBridgeFetchHeaders(), signal: AbortSignal.timeout(28000) });
    let j = {};
    try {
      j = await r.json();
    } catch (_) {
      j = {};
    }
    if (!r.ok) {
      const jErr = typeof j?.error === 'string' ? j.error : '';
      console.warn('Bloomberg bridge HTTP', r.status, symbol, jErr.slice(0, 160));
      lastBloombergSnapshotProbe = {
        ts: Date.now(),
        symbol: String(symbol),
        ok: false,
        httpStatus: r.status,
        err: typeof j?.error === 'string' ? j.error : `HTTP ${r.status}`,
        numericFieldsSeen: 0,
        bbSecurity: j?.bbSecurity || sec || null,
        bridgeBuild: typeof j?.bridge_build === 'string' ? j.bridge_build : null,
        elapsedMs: Date.now() - t0
      };
      return null;
    }
    if (!j || typeof j !== 'object') {
      lastBloombergSnapshotProbe = {
        ts: Date.now(),
        symbol: String(symbol),
        ok: false,
        httpStatus: r.status,
        err: 'invalid_snapshot_json_body',
        numericFieldsSeen: 0,
        bbSecurity: sec,
        bridgeBuild: typeof j?.bridge_build === 'string' ? j.bridge_build : null,
        elapsedMs: Date.now() - t0
      };
      return null;
    }
    const num = v => {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const hasNumericPayload =
      num(j.forwardPE) != null ||
      num(j.trailingPE) != null ||
      num(j.currentPrice) != null ||
      num(j.marketCap) != null ||
      num(j.revenueGrowth) != null ||
      num(j.earningsGrowth) != null ||
      num(j.fundamentalTrailingEps) != null;
    if (j.error && !hasNumericPayload) {
      lastBloombergSnapshotProbe = {
        ts: Date.now(),
        symbol: String(symbol),
        ok: false,
        httpStatus: r.status,
        err: String(j.error),
        numericFieldsSeen: 0,
        bbSecurity: j.bbSecurity || sec,
        bridgeBuild: typeof j?.bridge_build === 'string' ? j.bridge_build : null,
        elapsedMs: Date.now() - t0
      };
      return null;
    }
    const out = {
      _source: 'bloomberg_bridge',
      forwardPE: num(j.forwardPE),
      trailingPE: num(j.trailingPE),
      pegRatio: num(j.pegRatio),
      targetMeanPrice: num(j.targetMeanPrice),
      revenueGrowth: num(j.revenueGrowth),
      earningsGrowth: num(j.earningsGrowth),
      fundamentalTrailingEps: num(j.fundamentalTrailingEps),
      debtToEquity: num(j.debtToEquity),
      returnOnEquity: num(j.returnOnEquity),
      returnOnAssets: num(j.returnOnAssets),
      returnOnCapital: num(j.returnOnCapital),
      currentRatio: num(j.currentRatio),
      grossMargins: num(j.grossMargins),
      operatingMargins: num(j.operatingMargins),
      freeCashFlowYield: num(j.freeCashFlowYield),
      shortInterestRatio: num(j.shortInterestRatio),
      currentPrice: num(j.currentPrice),
      marketCap: num(j.marketCap),
      financialQualityHint:
        j.financialQualityHint && typeof j.financialQualityHint === 'object' ? j.financialQualityHint : null,
      recommendationKey: j.recommendationKey || null,
      analystCount: num(j.analystCount),
      _bbSecurity: j.bbSecurity || sec
    };
    const hasAny = Object.keys(out).some(
      k => !k.startsWith('_') && out[k] != null && out[k] !== ''
    );
    const nNum = Object.keys(out).filter(
      k =>
        !k.startsWith('_') &&
        out[k] != null &&
        out[k] !== '' &&
        (typeof out[k] === 'number' || Number.isFinite(+out[k]))
    ).length;
    lastBloombergSnapshotProbe = {
      ts: Date.now(),
      symbol: String(symbol),
      ok: !!hasAny,
      httpStatus: r.status,
      err: null,
      numericFieldsSeen: nNum,
      bbSecurity: out._bbSecurity || sec,
      bridgeBuild: typeof j?.bridge_build === 'string' ? j.bridge_build : null,
      elapsedMs: Date.now() - t0
    };
    return hasAny ? out : null;
  } catch (e) {
    lastBloombergSnapshotProbe = {
      ts: Date.now(),
      symbol: String(symbol),
      ok: false,
      httpStatus: null,
      err: String(e.message || e),
      numericFieldsSeen: 0,
      bbSecurity: sec,
      bridgeBuild: null,
      elapsedMs: Date.now() - t0
    };
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
  const symTrim = String(symbol || '').trim();
  const t0 = Date.now();
  const stampFail = (httpStatus, err, bbSec, bridgeBuild) => {
    lastBloombergEarningsProbe = {
      ts: Date.now(),
      symbol: symTrim,
      ok: false,
      httpStatus,
      err,
      bbSecurity: bbSec || null,
      nextDateSeen: null,
      bridgeBuild: typeof bridgeBuild === 'string' ? bridgeBuild : null,
      elapsedMs: Date.now() - t0
    };
  };
  if (!base) {
    stampFail(null, 'bloomberg_bridge_url_not_set');
    return null;
  }
  if (bloombergBridgeUrlIsUnreachableFromInternet()) {
    stampFail(null, 'bloomberg_bridge_lan_unreachable_from_host');
    return null;
  }
  const bb = toBloombergEquity(symbol);
  if (!bb) {
    stampFail(null, 'toBloombergEquity_unmapped_symbol');
    return null;
  }
  try {
    const u = new URL('/earnings', base + '/');
    u.searchParams.set('symbol', symTrim);
    u.searchParams.set('bb', bb);
    const r = await fetch(u.toString(), { headers: bloombergBridgeFetchHeaders(), signal: AbortSignal.timeout(22000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && typeof j === 'object' && j.error)) {
      const errMsg =
        typeof j?.error === 'string'
          ? j.error
          : typeof j?.hint === 'string'
            ? j.hint
            : `HTTP_${r.status}`;
      stampFail(r.status, errMsg, j?.bbSecurity || bb, j?.bridge_build);
      return j && typeof j === 'object' ? { ...j, _httpStatus: r.status } : null;
    }
    const nd =
      j?.nextEarningsDate != null ? String(j.nextEarningsDate).trim().slice(0, 10) : null;
    lastBloombergEarningsProbe = {
      ts: Date.now(),
      symbol: symTrim,
      ok: true,
      httpStatus: r.status,
      err: null,
      bbSecurity: bb,
      nextDateSeen: /^\d{4}-\d{2}-\d{2}$/.test(nd || '') ? nd : null,
      bridgeBuild: typeof j?.bridge_build === 'string' ? j.bridge_build : null,
      elapsedMs: Date.now() - t0
    };
    return j && typeof j === 'object' ? j : null;
  } catch (e) {
    stampFail(null, String(e.message || e), bb);
    console.warn('Bloomberg bridge earnings', symbol, e.message);
    return null;
  }
}

/** Newest-first using fiscal / report dates when ISO strings exist. */
function sortEarningsHistDesc(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  return [...rows].sort((a, b) => {
    const da = String(a?.date || '').slice(0, 10);
    const db = String(b?.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(da) && /^\d{4}-\d{2}-\d{2}$/.test(db)) return db.localeCompare(da);
    return String(b?.quarter || '').localeCompare(String(a?.quarter || ''));
  });
}

function calendarDayDiffIso(a, b) {
  if (!a || !b) return 9999;
  try {
    const t0 = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    const t1 = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.abs(Math.round((t0 - t1) / 86400000));
  } catch (_) {
    return 9999;
  }
}

function isEmptyHistEps(v) {
  return v == null || v === '' || v === '—' || String(v).trim() === '';
}

function normalizeQuarterLabelForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** When Bloomberg rows omit estimates, copy EPS / surprise from nearest Yahoo quarter. */
function enrichEarningsHistFromYahooRows(hist, yahooRows) {
  if (!Array.isArray(hist) || !Array.isArray(yahooRows) || !yahooRows.length) return hist;
  /** Wider window: fiscal period-end vs announcement dates on NSE/ADR names often diverge. */
  const DATE_WIN = 420;
  for (const r of hist) {
    const d = r?.date ? String(r.date).slice(0, 10) : '';
    let best = null;
    let bestDx = 9999;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      for (const y of yahooRows) {
        const yd = y?.date ? String(y.date).slice(0, 10) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(yd)) continue;
        const dx = calendarDayDiffIso(d, yd);
        if (dx <= DATE_WIN && dx < bestDx) {
          bestDx = dx;
          best = y;
        }
      }
    }
    if (!best && r.quarter) {
      const rq = normalizeQuarterLabelForMatch(r.quarter);
      if (rq) {
        for (const y of yahooRows) {
          const yq = normalizeQuarterLabelForMatch(y.quarter);
          if (yq && yq === rq) {
            best = y;
            break;
          }
        }
      }
    }
    if (!best) continue;
    if (isEmptyHistEps(r.epsActual) && !isEmptyHistEps(best.epsActual)) r.epsActual = best.epsActual;
    if (isEmptyHistEps(r.epsEstimate) && !isEmptyHistEps(best.epsEstimate)) r.epsEstimate = best.epsEstimate;
    if (isEmptyHistEps(r.epsSurprise) && !isEmptyHistEps(best.epsSurprise)) r.epsSurprise = best.epsSurprise;
    if (r.beat == null && best.beat != null) r.beat = best.beat;
  }
  return hist;
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
        revenueActual: row?.revenueActual != null ? row.revenueActual : null,
        revenueEstimate: row?.revenueEstimate != null ? row.revenueEstimate : null,
        revenueSurprise: row?.revenueSurprise != null ? String(row.revenueSurprise) : null,
        earningsReleaseTiming:
          row?.earningsReleaseTiming != null ? String(row.earningsReleaseTiming).trim() : null,
        announcementDate:
          row?.announcementDate != null ? String(row.announcementDate).trim().slice(0, 10) : '',
        announcementTimeRaw: row?.announcementTimeRaw != null ? String(row.announcementTimeRaw) : null,
        announcementPeriod: row?.announcementPeriod != null ? String(row.announcementPeriod) : null,
        historyRowSource: row?.historyRowSource != null ? String(row.historyRowSource) : null,
        ebitdaActual: row?.ebitdaActual != null ? row.ebitdaActual : null,
        netIncomeActual: row?.netIncomeActual != null ? row.netIncomeActual : null,
        operatingProfitActual: row?.operatingProfitActual != null ? row.operatingProfitActual : null,
        reportOrAnnounceDate: row?.reportOrAnnounceDate ?? null,
        stockReaction: row?.stockReaction != null && typeof row.stockReaction === 'object' ? row.stockReaction : null
      };
    })
    .filter((r) => r.date || r.quarter);
}

/** Bloomberg quarter row wins non-empty fields; keep Yahoo/FMP estimates when BB omits them. */
function overlayQuarterYyWithBloomberg(existingRow, bbRow) {
  const a = existingRow || {};
  const merged = { ...a };
  for (const [k, v] of Object.entries(bbRow || {})) {
    if (v === null || v === undefined || v === '') continue;
    merged[k] = v;
  }
  const fillIfEmpty = (...keys) => {
    for (const k of keys) {
      const cur = merged[k];
      const prev = a[k];
      const empty = cur == null || cur === '';
      const back = prev != null && prev !== '';
      if (empty && back) merged[k] = prev;
    }
  };
  fillIfEmpty('epsActual', 'epsEstimate', 'epsSurprise', 'beat');
  fillIfEmpty('revenueActual', 'revenueEstimate', 'revenueSurprise');
  return merged;
}

function blendBloombergEarningsHistories(existingSlice, bloombergNorm) {
  const prior = Array.isArray(existingSlice) ? existingSlice : [];
  if (!Array.isArray(bloombergNorm) || !bloombergNorm.length) return prior.slice(0, 4);
  if (!prior.length) {
    return bloombergNorm.slice(0, 4).map((bb) => overlayQuarterYyWithBloomberg(null, bb));
  }
  const norm = bloombergNorm.slice(0, 8);
  const used = new Set();
  const out = [];
  for (const r of prior.slice(0, 8)) {
    if (out.length >= 4) break;
    const d = r?.date ? String(r.date).trim().slice(0, 10) : '';
    const rq = normalizeQuarterLabelForMatch(r.quarter);
    let bestI = -1;
    let bestScore = -1;
    for (let i = 0; i < norm.length; i++) {
      if (used.has(i)) continue;
      const bb = norm[i];
      const bbd = bb?.date ? String(bb.date).trim().slice(0, 10) : '';
      const bq = normalizeQuarterLabelForMatch(bb.quarter);
      let score = -1;
      if (rq && bq && rq === bq) score = 200;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(d) && /^\d{4}-\d{2}-\d{2}$/.test(bbd)) {
        const dx = calendarDayDiffIso(d, bbd);
        if (dx <= 220) score = 150 - Math.min(dx, 149);
      }
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    if (bestI >= 0 && bestScore > 0) {
      used.add(bestI);
      out.push(overlayQuarterYyWithBloomberg(r, norm[bestI]));
    } else {
      out.push({ ...r });
    }
  }
  for (let i = 0; i < norm.length && out.length < 4; i++) {
    if (used.has(i)) continue;
    out.push(overlayQuarterYyWithBloomberg(null, norm[i]));
  }
  return out.slice(0, 4);
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
      calendarPrimary,
      expectedReportTyp: null,
      expectedReportPeriod: null,
      expectedReportTime: null
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
  const norm = sortEarningsHistDesc(normalizeBbBridgeHistRows(bbEarn.history));
  if (norm.length) {
    const prior = Array.isArray(outHist) ? outHist.slice(0, 8) : [];
    if (!(gap && prior.length)) {
      let blended = prior.length ? blendBloombergEarningsHistories(prior, norm) : norm.slice(0, 4);
      blended = Array.isArray(blended)
        ? blended.filter((r) => r && (String(r.quarter || '').trim() || String(r.date || '').trim()))
        : [];
      if (!blended.length && prior.length) {
        outHist = sortEarningsHistDesc(prior.slice(0, 8)).slice(0, 4);
        outHistSrc = historySource || 'yahoo_fallback_bb_history_empty';
      } else if (blended.length) {
        outHist = sortEarningsHistDesc(blended).slice(0, 4);
        outHistSrc = prior.length ? 'bloomberg_bridge+yahoo_fallback' : 'bloomberg_bridge';
      }
    }
  }
  return {
    nextDate: outNext,
    epsEst: outEst,
    callTime: outCall,
    quarter: outQ,
    epsHistory: Array.isArray(outHist) ? outHist : epsHistory,
    historySource: outHistSrc,
    calendarPrimary: outCal,
    expectedReportTyp: bbEarn.expectedReportTyp ?? null,
    expectedReportPeriod: bbEarn.expectedReportPeriod ?? null,
    expectedReportTime: bbEarn.expectedReportTime ?? null
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

/** When vendors omit PEG but P/E + EPS growth exist, derive PEG ≈ P/E ÷ growth% (standard rule-of-thumb). */
function applyDerivedFundamentals(merged) {
  if (!merged || typeof merged !== 'object') return;
  try {
    const pe = Number(merged.forwardPE ?? merged.trailingPE);
    const g = Number(merged.earningsGrowth);
    if (
      merged.pegRatio == null &&
      Number.isFinite(pe) &&
      Number.isFinite(g) &&
      g > 0.2 &&
      g < 500 &&
      pe > 0
    ) {
      const peg = +((pe / g).toFixed(2));
      if (Number.isFinite(peg) && peg > 0 && peg <= 99) merged.pegRatio = peg;
    }
  } catch (_) {
    /* noop */
  }
}

async function fetchFundamentals(symbol) {
  // PRIMARY: FMP Ultimate (global) + Finnhub + Alpha Vantage + Yahoo (parallel). Bloomberg is backup only.
  let merged = {};
  const livePx = await fetchSinglePrice(symbol).catch(() => null);
  const fk = fmpEnvKeyFund();
  const vendorTasks = [];

  /** FMP first — stable bundle on exchange-resolved variants (Ultimate global coverage). */
  if (fk && fmpGlobalCoverageEnabled()) {
    vendorTasks.push(
      (async () => {
        const variants = await fmpAllSymbolVariants(symbol, fk).catch(() => intlVendorSymbolVariants(symbol));
        for (const v of variants.slice(0, isIntlEquitySymbol(symbol) ? 14 : 8)) {
          const hit = await fetchFmpStableFundamentalsBundle(v, fk).catch(() => null);
          if (hit) return hit;
        }
        return fetchFundamentalsFMP(symbol).catch(() => null);
      })()
    );
  } else if (fk) {
    vendorTasks.push(fetchFundamentalsFMP(symbol).catch(() => null));
  }
  if (fk) {
    vendorTasks.push(fetchFundamentalsFromFmpQuote(symbol).catch(() => null));
    if (livePx?.price) {
      vendorTasks.push(fetchFmpIncomeDerivedFundamentals(symbol, livePx.price).catch(() => null));
    }
  }
  if ((process.env.FINNHUB_API_KEY || '').trim()) {
    vendorTasks.push(fetchFundamentalsFinnhub(symbol).catch(() => null));
    vendorTasks.push(fetchFinnhubFinancialsFundamentals(symbol).catch(() => null));
    vendorTasks.push(fetchFinnhubProfileFundamentals(symbol).catch(() => null));
  }
  if (alphaVantageApiKey()) {
    vendorTasks.push(fetchFundamentalsAlphaVantage(symbol).catch(() => null));
  }
  vendorTasks.push(
    fetchFundamentalsFromYahooV7Quote(symbol).catch(() => null),
    fetchFundamentalsFromYahooV8Chart(symbol).catch(() => null),
    fetchFundamentalsYahoo(symbol).catch(() => null)
  );

  const vendorHits = await Promise.all(vendorTasks);
  for (const hit of vendorHits) {
    if (hit) merged = mergeFundSnapshots(merged, hit);
  }

  /** Re-apply best FMP row on top so Ultimate global data beats Yahoo/AV gap-fill. */
  if (fk && fmpGlobalCoverageEnabled()) {
    const fmpHits = vendorHits.filter(
      h => h && (h._source === 'fmp' || String(h._source || '').startsWith('fmp'))
    );
    const bestFmp = fmpHits.find(h => h.trailingPE || h.pegRatio || h.revenueGrowth) || fmpHits[0];
    if (bestFmp) merged = mergeFmpPrimary(merged, bestFmp);
  }

  if (
    livePx?.price &&
    merged.trailingPE == null &&
    merged.forwardPE == null &&
    fmpEnvKeyFund()
  ) {
    const fmpDer = await fetchFmpIncomeDerivedFundamentals(symbol, livePx.price).catch(() => null);
    if (fmpDer) merged = mergeFundSnapshots(merged, fmpDer);
  }

  applyDerivedFundamentals(merged);

  // BACKUP: Bloomberg Desktop bridge + Enterprise — fill null keys only, never override FMP/Finnhub/AV/Yahoo
  const bb = await fetchBloombergBridgeFundamentals(symbol).catch(() => null);
  if (bb) {
    merged = mergeGapFillOnly(merged, bb);
    console.log(`Fundamentals: Bloomberg bridge gap-fill for ${symbol}`);
  }
  const ent = await fetchBloombergEnterpriseFundamentals(symbol).catch(() => null);
  if (ent) merged = mergeGapFillOnly(merged, ent);

  // Last-resort Yahoo PE pass
  if (
    merged.trailingPE == null ||
    merged.forwardPE == null ||
    merged.pegRatio == null ||
    merged.revenueGrowth == null ||
    merged.earningsGrowth == null
  ) {
    const qPe = await fetchYahooQuotePE(symbol).catch(() => null);
    if (qPe) merged = mergeFundSnapshots(merged, qPe);
  }

  applyDerivedFundamentals(merged);
  if (isIntlEquitySymbol(symbol) && fmpGlobalCoverageEnabled()) {
    const hasFmpFund =
      merged._source === 'fmp' &&
      (merged.trailingPE != null || merged.pegRatio != null || merged.revenueGrowth != null);
    if (!hasFmpFund) merged._intlCoverageNote = FMP_INTL_DATA_MISS_HINT;
  } else if (isIntlEquitySymbol(symbol) && fmpPlanTier() === 'starter') {
    merged._intlCoverageNote =
      'FMP Starter is US-only for fundamentals/scores. Set FMP_PLAN=ultimate on Render (or upgrade plan) for NSE/HK/JP.';
  }
  const hasAny = Object.keys(merged).some(
    k => !k.startsWith('_') && merged[k] != null && merged[k] !== ''
  );
  if (hasAny) {
    console.log(
      `Fundamentals ${symbol}: src=${merged._source || 'multi'} pe=${merged.trailingPE ?? merged.forwardPE ?? 'n/a'} peg=${merged.pegRatio ?? 'n/a'} rev=${merged.revenueGrowth ?? 'n/a'}`
    );
  }
  return hasAny ? merged : null;
}

/** Placeholder-ish UI values — treat like empty so server fundamentals can overwrite bad model output. */
function isPlaceholderUiSlot(v) {
  if (v == null || v === '') return true;
  const t = String(v).trim();
  if (/^null$/i.test(t)) return true;
  if (/^[\u2012\u2013\u2014\u2015‐‑‒\-–—\u2212\s]+$/u.test(t))
    return true;
  if (/^n\/?a$/i.test(t) || /^n\.a\.?$/i.test(t) || /^placeholder$/i.test(t)) return true;
  if (/\b(not\s+provided|not\s+specified|unspecified|omit|dataset|no\s+data|unavailable|unknown|pending|tbd)\b/i.test(t))
    return true;
  return false;
}

/** Overlay server fundamentals; P/E and PEG always taken from snapshot when present. */
function mergeFundamentalsForUi(row, fund) {
  if (!fund || !row || typeof row !== 'object') return row;
  const gap = v => isPlaceholderUiSlot(v);
  /** When Bloomberg or FMP supplied the row, allow overwriting placeholder Claude text aggressively. */
  const bbSec =
    typeof fund._bbSecurity === 'string' && /\s+[A-Z]{2}\s+Equity$/i.test(fund._bbSecurity.trim());
  const forceBb =
    fund._source === 'bloomberg_bridge' ||
    fund._source === 'bloomberg_enterprise' ||
    bbSec ||
    fund._source === 'fmp' ||
    fund._source === 'alpha_vantage' ||
    fund._source === 'yahoo_v7_quote' ||
    fund._source === 'finnhub_metric';
  const set = (k, v, force) => {
    if (!force && !gap(row[k])) return;
    if (v === null || v === undefined || v === '') return;
    row[k] = v;
  };
  const fmtPe = x => {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0 || n >= 9000) return null;
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
  if (fund.pegRatio != null && Number.isFinite(+fund.pegRatio))
    row.peg = String(+Number(fund.pegRatio).toFixed(2));
  if (fund.revenueGrowth != null && Number.isFinite(+fund.revenueGrowth))
    row.revenueGrowth = `${fund.revenueGrowth}%`;
  if (fund.earningsGrowth != null && Number.isFinite(+fund.earningsGrowth))
    row.earningsGrowth = `${fund.earningsGrowth}%`;
  let finGuess = '';
  const de = fund.debtToEquity;
  if (typeof de === 'number')
    finGuess = de > 200 ? 'Weak' : de > 100 ? 'Moderate' : 'Strong';
  if (fund.grossMargins != null && fund.grossMargins > 42) finGuess = finGuess || 'Strong';
  if (fund.grossMargins != null && fund.grossMargins < 22) finGuess = 'Weak';
  if (fund.financialQualityHint?.label != null && String(fund.financialQualityHint.label).trim()) {
    const bbLabel = String(fund.financialQualityHint.label).trim();
    finGuess = bbLabel;
    set('financialHealth', bbLabel, forceBb);
    if (fund.financialQualityHint.reasons?.length && (forceBb || gap(row.fundSummary))) {
      const brief = fund.financialQualityHint.reasons.slice(0, 4).join(' · ');
      set('fundSummary', `Bloomberg quality hint (${bbLabel}): ${brief}`, forceBb);
    }
  } else if (finGuess) set('financialHealth', finGuess, forceBb);
  if (fund._fmpSector) set('industryPos', String(fund._fmpSector).slice(0, 72), forceBb);

  const bits = [];
  if (fund._source === 'bloomberg_enterprise')
    bits.push(`Bloomberg Enterprise ${fund._bbSecurity ? '(' + fund._bbSecurity + ')' : ''}`.trim());
  else if (fund._source === 'bloomberg_bridge' || bbSec)
    bits.push(`Bloomberg ${fund._bbSecurity ? '(' + fund._bbSecurity + ')' : ''}`.trim());
  if (fund.forwardPE != null && Number.isFinite(+fund.forwardPE)) {
    const s = fmtPe(fund.forwardPE);
    if (s) bits.push(`fP/E ~${s}`);
  } else if (fund.trailingPE != null && Number.isFinite(+fund.trailingPE)) {
    const s = fmtPe(fund.trailingPE);
    if (s) bits.push(`P/E ~${s} TTM`);
  }
  if (fund.revenueGrowth != null) bits.push(`rev YoY ~${fund.revenueGrowth}%`);
  if (fund.earningsGrowth != null) bits.push(`EPS YoY ~${fund.earningsGrowth}%`);
  if (fund.returnOnEquity != null && Number.isFinite(+fund.returnOnEquity))
    bits.push(`ROE ~${Number(+fund.returnOnEquity).toFixed(1)}%`);
  if (fund.currentRatio != null && Number.isFinite(+fund.currentRatio))
    bits.push(`curr ratio ${Number(fund.currentRatio).toFixed(2)}`);
  if (fund.debtToEquity != null && Number.isFinite(+fund.debtToEquity))
    bits.push(`D/E ${Math.round(fund.debtToEquity)}`);
  if (fund.targetMeanPrice != null && fund.marketCap != null)
    bits.push(`mktCap data available · targetMean ${fund.targetMeanPrice}`);
  if (bits.length) set('fundSummary', `Fundamentals (server merge): ${bits.join(' · ')}`, forceBb);
  const newsFromFund =
    fund.analystCount != null && fund.analystCount > 0
      ? `${fund.analystCount} analysts (consensus: ${fund.recommendationKey || 'n/a'})`
      : fund.recommendationKey
        ? `Analyst stance: ${fund.recommendationKey}`
        : null;
  if (newsFromFund && (forceBb || gap(row.newsImpact))) row.newsImpact = newsFromFund;
  return row;
}

// Cache technicals — 8 min TTL (reduced from 15 to minimise dashboard vs full-analysis drift)
const techCache  = new Map();
const fundCache  = new Map();
const newsCache  = new Map();
const TECH_TTL   = 8 * 60 * 1000;
const NEWS_TTL   = 30 * 60 * 1000;

// ── Previously-missing confirmation indicators (now computed so live + backtest
//    use the full feature set instead of silently defaulting to null/false). ──

/** On-Balance Volume direction: accumulation (true) vs distribution (false). */
function calcOBVSignal(daily, lookback = 20) {
  if (!daily || daily.length < lookback + 2) return null;
  const rec = daily.slice(-(lookback + 1));
  let obv = 0; const series = [];
  for (let i = 1; i < rec.length; i++) {
    const v = rec[i].v || 0;
    if (rec[i].c > rec[i - 1].c) obv += v;
    else if (rec[i].c < rec[i - 1].c) obv -= v;
    series.push(obv);
  }
  const half = Math.floor(series.length / 2);
  if (half < 2) return null;
  const fa = series.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const sa = series.slice(half).reduce((a, b) => a + b, 0) / (series.length - half);
  if (sa > fa * 1.0001) return true;
  if (sa < fa * 0.9999) return false;
  return null;
}

/** RSI slope over `back` bars → momentum rising / falling. */
function calcRsiSlope(closes, period = 14, back = 3) {
  if (!closes || closes.length < period * 2 + back + 2) return { rising: false, falling: false };
  const now = calcRSI(closes, period);
  const prev = calcRSI(closes.slice(0, closes.length - back), period);
  if (now == null || prev == null) return { rising: false, falling: false };
  return { rising: now > prev + 0.5, falling: now < prev - 0.5 };
}

/** Swing structure: HH+HL (bull) vs LH+LL (bear) from recent 2-bar pivots. */
function detectSwingStructure(daily, lookback = 40) {
  if (!daily || daily.length < 12) return { bull: false, bear: false };
  const rec = daily.slice(-Math.min(lookback, daily.length));
  const highs = [], lows = [];
  for (let i = 2; i < rec.length - 2; i++) {
    if (rec[i].h > rec[i - 1].h && rec[i].h > rec[i - 2].h && rec[i].h > rec[i + 1].h && rec[i].h > rec[i + 2].h) highs.push(rec[i].h);
    if (rec[i].l < rec[i - 1].l && rec[i].l < rec[i - 2].l && rec[i].l < rec[i + 1].l && rec[i].l < rec[i + 2].l) lows.push(rec[i].l);
  }
  const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
  return { bull: hh && hl, bear: lh && ll };
}

function buildFullTechResult(sym, daily, weekly) {
  const closes = daily.map(d => d.c);
  const cp = closes[closes.length - 1];
  const ma20  = calcSMA(closes, 20);
  const ma50  = calcSMA(closes, 50);
  const ma100 = closes.length >= 100 ? calcSMA(closes, 100) : null;
  const ma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
  const rsi   = calcRSI(closes, 14);
  const rsi2  = closes.length >= 6 ? calcRSI(closes, 2) : null; // fast MR oscillator
  const stoch = calcStochastic(daily, 14, 3);
  const macd  = calcMACDFull(closes);
  const bb    = calcBollingerFull(closes, 20);
  const atr   = calcATRFull(daily, 14);
  const atrPct = atr ? parseFloat((atr / cp * 100).toFixed(2)) : null;
  const srLevels = findVolumeWeightedSR(daily, 80, 30);
  const { support1, support2, support3, resistance1, resistance2, resistance3, s1Confluence, r1Confluence } =
    srLevels;
  const weeklyClosesChan = weekly && weekly.length >= 20 ? weekly.map(d => d.c) : null;
  const channels = calcMultiTFChannels(closes, weeklyClosesChan);
  const channelPos = getChannelPosition(cp, channels);
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

  // Previously-dead confirmation signals — now populated for live AND backtest.
  const obvBullish = calcOBVSignal(daily, 20);
  const _rsiSlope = calcRsiSlope(closes, 14, 3);
  const macdPrev = calcMACDFull(closes.slice(0, -1));
  const macdTurningUp   = macd && macdPrev && macd.histogram != null && macdPrev.histogram != null ? macd.histogram > macdPrev.histogram : null;
  const macdTurningDown = macd && macdPrev && macd.histogram != null && macdPrev.histogram != null ? macd.histogram < macdPrev.histogram : null;
  const _struct = detectSwingStructure(daily, 40);
  const healthyPullback = !!(aboveMa50 && trend20 !== 'downtrend' && ma20 && cp <= ma20 * 1.02 && ma50 && cp >= ma50 * 0.97
    && volume && volume.relativeVolume != null && volume.relativeVolume < 1.0);

  return {
    symbol: sym, currentPrice: cp, ma20, ma50, ma200,
    aboveMa20, aboveMa50, aboveMa200, bullishMAs, totalMAs,
    maAlignmentStr: `${bullishMAs}/${totalMAs} MAs bullish`,
    rsi, rsi2, stoch,
    rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
    macd, trend20, trend: trend20,
    atr, atrPct, bb, adx,
    adxSignal: adx ? (adx > 40 ? 'strong_trend' : adx > 25 ? 'trending' : 'weak/ranging') : null,
    bbSignal: bb ? (bb.pct > 80 ? 'near_upper_band' : bb.pct < 20 ? 'near_lower_band' : 'mid_band') : null,
    support1, support2, support3, resistance1, resistance2, resistance3,
    s1Confluence, r1Confluence,
    channels,
    channelPos,
    high52w: daily.length>=52?Math.max(...daily.slice(-252).map(d=>d.h??0)):null,
    low52w:  daily.length>=52?Math.min(...daily.slice(-252).filter(d=>d.l>0).map(d=>d.l)):null,
    volume, candlePattern: pattern,
    consecutiveLowerCloses: countConsecutiveLowerCloses(daily),
    consecutiveHigherCloses: countConsecutiveHigherCloses(daily),
    ma100, aboveMa100: ma100 ? cp > ma100 : null,
    recentTrend: (function(){
      const cl = closes; const c = cp;
      if (!cl || cl.length < 6 || !c) return 'sideways';
      const c5 = cl[cl.length-6];
      return c < c5*0.98 ? 'downtrend' : c > c5*1.02 ? 'uptrend' : 'sideways';
    })(),
    weeklyRSI, weeklyTrend, weeklyMA50,
    obvBullish,
    rsiRising: _rsiSlope.rising, rsiFalling: _rsiSlope.falling,
    macdTurningUp, macdTurningDown,
    bullishStructure: _struct.bull, bearishStructure: _struct.bear,
    healthyPullback,
    supertrend: calcSupertrend(daily),
    supertrendByHz: calcSupertrendByHorizon(daily),
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
      fetchOHLCV(sym, '2y', '1d').catch(() => fetchOHLCV(sym, '1y', '1d')),
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

  const _dbc = Number.parseInt(String(process.env.DASHBOARD_BATCH_CONCURRENCY || '2'), 10);
  let _chunks = Number.isFinite(_dbc) ? _dbc : 2;
  if (_chunks < 1) _chunks = 1;
  if (_chunks > 8) _chunks = 8;

  for (let _off = 0; _off < symbols.length; _off += _chunks) {
    const _slice = symbols.slice(_off, _off + _chunks);
    await Promise.allSettled(_slice.map(async sym => {
    try {
      const cached = techCache.get(sym);
      if (cached && Date.now() - cached.ts < TECH_TTL && cached.data?.quantSignal) {
        results[sym] = cached.data;
        return;
      }

      // Need 5y for aligned backtest; fallback to 2y / 1y
      let daily = await fetchOHLCV(sym, '5y', '1d').catch(() => null);
      if (!daily || daily.length < 400) {
        daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
      }
      if (!daily || daily.length < 100) {
        daily = await fetchOHLCV(sym, '1y', '1d').catch(() => null);
      }
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
      const srLevels = findVolumeWeightedSR(daily, 60, 30);
      const {
        support1,
        support2,
        support3,
        resistance1,
        resistance2,
        resistance3,
        s1Confluence,
        r1Confluence
      } = srLevels;
      const bb      = calcBollingerFull(closes, 20);

      let weeklyTrend = null, weeklyRSI = null;
      let weeklyClosesChan = null;
      try {
        const weekly = await fetchOHLCV(sym, '1y', '1wk');
        if (weekly && weekly.length >= 14) {
          weeklyTrend = calcTrend(weekly.slice(-20), 20);
          weeklyRSI   = calcRSI(weekly.map(d => d.c), 14);
          if (weekly.length >= 20) weeklyClosesChan = weekly.map(d => d.c);
        }
      } catch (_) {}

      const channels = calcMultiTFChannels(closes, weeklyClosesChan);
      const channelPos = getChannelPosition(cp, channels);

      const data = {
        symbol: sym, currentPrice: cp,
        ma20, ma50, ma200, rsi, macd, atr, bb,
        atrPct: atr ? parseFloat((atr / cp * 100).toFixed(2)) : null,
        adx, adxSignal: adx ? (adx > 40 ? 'strong_trend' : adx > 25 ? 'trending' : 'weak/ranging') : null,
        volume, trend20, trend: trend20, weeklyTrend, weeklyRSI,
        aboveMa20:  ma20  != null ? cp > ma20  : null,
        aboveMa50:  ma50  != null ? cp > ma50  : null,
        aboveMa200: ma200 != null ? cp > ma200 : null,
        support1, support2, support3, resistance1, resistance2, resistance3,
        s1Confluence, r1Confluence,
        channels,
        channelPos,
        candlePattern: detectCandlePattern(daily),
        consecutiveLowerCloses: countConsecutiveLowerCloses(daily),
        rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
        summary: `RSI ${rsi}, ADX ${adx ?? '?'}, ${cp > ma20 ? 'above' : 'below'} MA20, ${trend20}, S@${support1}, R@${resistance1}`
      };

      const _cachedFundEntry = fundCache.get(sym);
      const _cachedFund =
        _cachedFundEntry && Date.now() - _cachedFundEntry.ts < TECH_TTL * 4
          ? _cachedFundEntry.data
          : null;

      // NOTE: the full 5-year walk-forward backtest is intentionally NOT run here.
      // On the Render Starter instance, running 3 horizons × ~120 dashboard symbols
      // would block the event loop long enough to trigger 502s. The real, aligned
      // 5-year backtest runs on-demand in /api/analyze (single ticker). The dashboard
      // shows the quant winRateHint as an estimate until the user opens full analysis.
      data.supertrend = calcSupertrend(daily);
      data._sectorRegime = sectorRegimeForSymbol(sym); // sector-level momentum tide
      data._earningsTide = earningsTideForSymbol(sym); // peer quarterly-results tide
      data.quantSignal = {
        short:  computeQuantSignal(data, _cachedFund, 'short'),
        medium: computeQuantSignal(data, _cachedFund, 'medium'),
        long:   computeQuantSignal(data, _cachedFund, 'long')
      };

      await applyMarketTierOverlays(sym, data, { batchMode: true });
      applySLCooldownGate(sym, data);
      if (data.danelfin) {
        data.compositeAlphaShort = computeCompositeAlpha(data.danelfin, data, 0, 'short');
        data.compositeAlphaMedium = computeCompositeAlpha(data.danelfin, data, 0, 'medium');
        data.compositeAlphaLong = computeCompositeAlpha(data.danelfin, data, 0, 'long');
        data.compositeAlpha = data.compositeAlphaMedium;
      }
      // Institutional flow — fire-and-forget, cached 6h
      fetchInstitutionalFlow(sym).then(iFlow => {
        if (iFlow && data) {
          data.instNetShares = iFlow.netShares || 0;
          data.instFlowLabel = iFlow.netFlowLabel || '';
          data.instTopBuyers = (iFlow.topBuyers || []).slice(0, 3);
          data.instTopSellers = (iFlow.topSellers || []).slice(0, 3);
        }
      }).catch(() => {});

      techCache.set(sym, { ts: Date.now(), data });
      results[sym] = data;
    } catch(e) { console.warn('Batch tech fail:', sym, e.message); }
    }));
  }

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
  const _dbc = Number.parseInt(String(process.env.DASHBOARD_BATCH_CONCURRENCY || '2'), 10);
  let _chunks = Number.isFinite(_dbc) ? _dbc : 2;
  if (_chunks < 1) _chunks = 1;
  if (_chunks > 8) _chunks = 8;

  for (let _off = 0; _off < equities.length; _off += _chunks) {
    const _slice = equities.slice(_off, _off + _chunks);
    await Promise.allSettled(_slice.map(async sym => {
    try {
      const cached = fundCache.get(sym);
      if (cached && !req.body?.force && Date.now() - cached.ts < TECH_TTL * 4) { results[sym] = cached.data; return; }
      const data = await fetchFundamentals(sym);
      if (data) { fundCache.set(sym, { ts: Date.now(), data }); results[sym] = data; }
    } catch(e) { console.warn('Fund batch fail:', sym, e.message); }
    }));
  }

  console.log(`Fundamentals batch: ${Object.keys(results).length}/${equities.length} succeeded`);
  res.json(results);
});

// POST /api/news-sentiment/batch — Yahoo headlines + Claude JSON sentiment per symbol
app.post('/api/news-sentiment/batch', async (req, res) => {
  const { symbols } = req.body;
  const apiKey = anthropicApiKey();
  if (!symbols?.length || !apiKey) return res.json({});

  const results = {};
  const newsMap = {};
  await Promise.allSettled(symbols.map(async sym => {
    try {
      const cached = newsCache.get(sym);
      if (cached && Date.now() - cached.ts < NEWS_TTL) {
        newsMap[sym] = cached.data;
        return;
      }
      const items = await fetchNews(sym, 6);
      newsMap[sym] = items;
      newsCache.set(sym, { ts: Date.now(), data: items });
    } catch (e) {
      newsMap[sym] = [];
    }
  }));

  const symbolsWithNews = symbols.filter(s => newsMap[s]?.length > 0);
  if (!symbolsWithNews.length) return res.json({});

  const newsBlocks = symbolsWithNews.map(sym => {
    const headlines = newsMap[sym].map((n, i) => `  ${i + 1}. [${n.time}] ${n.title} (${n.publisher})`).join('\n');
    return `${sym}:\n${headlines}`;
  }).join('\n\n');

  const prompt = `You are a global financial news analyst covering US, European, Asian, and Indian equities. For each stock below (which may be listed on non-US exchanges such as LSE, TSE, NSE, HKEX, Euronext), analyze the recent news headlines and return a JSON sentiment assessment. Focus on what ACTUALLY MOVES stock prices: earnings beats/misses, analyst upgrades/downgrades, product launches, regulatory events, M&A, guidance changes, macro impacts.

NEWS HEADLINES:
${newsBlocks}

For each symbol return:
- sentiment: "bullish" | "bearish" | "neutral"
- score: integer -100 to +100 (0=neutral, +80=very bullish, -80=very bearish)
- catalysts: array of up to 3 specific catalysts found in the news
- risks: array of up to 2 news-based risks
- nearTermCatalyst: bool — is there an earnings/product event in the next 2-4 weeks?
- avoidBeforeEarnings: bool — should we avoid new positions due to upcoming earnings?
- summary: one sentence max explaining the dominant news theme

Return ONLY a JSON object like: {"AAPL": {"sentiment":"bullish","score":45,"catalysts":["iPhone demand"],"risks":["macro"],"nearTermCatalyst":false,"avoidBeforeEarnings":false,"summary":"..."}, ...}
Output ONLY the JSON object. No markdown.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system:
          'You are a financial news sentiment analyst. Output ONLY valid JSON. No markdown, no backticks.',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) return res.json({});
    const d = await r.json();
    const text = d?.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    Object.entries(parsed).forEach(([sym, data]) => {
      newsCache.set(sym + '_sentiment', { ts: Date.now(), data });
      results[sym] = data;
    });
  } catch (e) {
    console.warn('news-sentiment error:', e.message);
  }

  res.json(results);
});


// ══════════════════════════════════════════════════════════════════════════════
// MARKET COVERAGE CLASSIFIER
// ══════════════════════════════════════════════════════════════════════════════
function classifyMarket(symbol) {
  const sym=(symbol||'').toUpperCase().trim();
  if (sym.includes('=F')||sym.endsWith('-USD')||sym.endsWith('-EUR'))
    return {tier:'technical_only',label:'Technical Only',region:'commodity',danelfin:false,fmp:false,
            note:'No fundamental scoring for commodities — pure SD channel + momentum'};
  const eu=['.L','.DE','.PA','.AS','.AMS','.BR','.MI','.MC','.ST','.CO','.OL','.HE','.VI'];
  if (eu.some(sfx=>sym.endsWith(sfx)))
    return {tier:'danelfin_eu',label:'Danelfin AI (EU)',region:'europe',danelfin:true,fmp:true,
            note:'Danelfin European ML (since 2022) + FMP quality'};
  const asia=['.T','.HK','.NS','.BO','.KS','.KQ','.TW','.SI','.AX','.NZ','.BK'];
  if (asia.some(sfx=>sym.endsWith(sfx)))
    return {tier:'fmp_quality',label:'FMP Quality Score',region:'asia',danelfin:false,fmp:true,
            note:'FMP Piotroski F-Score + Altman Z + analyst consensus (no ML for Asian markets)'};
  return {tier:'danelfin_us',label:'Danelfin AI (US)',region:'us',danelfin:true,fmp:true,
          note:'Danelfin ML trained since 2017 on 10K features — highest quality signal'};
}

// ══════════════════════════════════════════════════════════════════════════════
// HORIZON-AWARE COMPOSITE ALPHA  (SHORT=Technical driven, MEDIUM=AI Score, LONG=Fundamental)
// ══════════════════════════════════════════════════════════════════════════════
function computeCompositeAlpha(dan, tech, newsScore, hz) {
  hz=hz||'medium';
  if (!dan||dan.aiscore==null) return null;
  const dAI=(dan.aiscore||0)*10, dT=(dan.technical||0)*10, dF=(dan.fundamental||0)*10;
  const dS=(dan.sentiment||0)*10, dR=(dan.low_risk||0)*10;
  const trk=dan.buy_track_record?5:-5;
  let ch=50;
  if (tech?.channelPos){const q=tech.channelPos.buyQuality;ch=q==='excellent'?95:q==='good'?80:q==='fair'?62:q==='neutral'?45:20;}
  let mo=55;
  if (tech){const r=tech.rsi||50;if(tech.macdTurningUp)mo+=18;if(r>=30&&r<=52)mo+=15;if(r>70)mo-=22;if(tech.rsiRising)mo+=12;if(tech.obvBullish===true)mo+=10;mo=Math.min(100,Math.max(0,mo));}
  const nw=Math.min(100,Math.max(0,((newsScore||0)+100)/2));
  let c;
  if (hz==='short') c=dT*0.20+dR*0.12+dS*0.08+dAI*0.10+ch*0.30+mo*0.15+nw*0.05+trk;
  else if(hz==='long') c=dAI*0.28+dF*0.25+dR*0.12+dS*0.08+dT*0.05+ch*0.05+mo*0.12+nw*0.05+trk;
  // Medium (3M) = Danelfin AI Score dominates — same 3-month horizon as their training
  else c=dAI*0.38+dT*0.14+dS*0.10+dR*0.08+dF*0.04+ch*0.10+mo*0.11+nw*0.05+trk;
  const score=Math.min(100,Math.max(0,Math.round(c)));
  const grade=score>=82?'A+':score>=74?'A':score>=65?'B+':score>=55?'B':score>=45?'C':'D';
  return {score,grade,hz};
}

// ══════════════════════════════════════════════════════════════════════════════
// FMP QUALITY SCORE — Asian equities (Piotroski + Altman Z + analyst consensus; all from FMP APIs, not Bloomberg)
// ══════════════════════════════════════════════════════════════════════════════
const _fmpCache = new Map(),
  _FMP_TTL = 6 * 60 * 60 * 1000,
  /** Retry shortly after misses so env-key fixes propagate without restarting */
  _FMP_MISS_SUPPRESS_MS = 90 * 1000;

function fmpLetterBucketToTen(overall) {
  const s = String(overall || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!s) return null;
  if (s.startsWith('A+')) return 10;
  if (s.startsWith('A')) return 9;
  if (s.startsWith('B+')) return 8;
  if (s.startsWith('B')) return 7;
  if (s.startsWith('C+')) return 6;
  if (s.startsWith('C')) return 6;
  if (s.startsWith('D')) return 4;
  return null;
}

async function fetchFmpScore(symbol, opts = {}) {
  const batchMode = !!(opts && opts.batchMode);
  const key = fmpEnvKeyFund();
  if (!key) return null;

  const cacheKey = batchMode ? `${String(symbol)}::fmp-lite-v5-ultimate` : `${String(symbol)}::fmp-v5-ultimate`;
  const now = Date.now();
  const prev = _fmpCache.get(cacheKey);
  if (prev && typeof prev.ts === 'number') {
    if (prev.data != null && now - prev.ts < _FMP_TTL) return prev.data;
    if (prev.data === null && now - prev.ts < _FMP_MISS_SUPPRESS_MS) return null;
  }

  let candidates = [
    ...new Set([
      ...(await fmpAllSymbolVariants(symbol, key).catch(() => [])),
      ...intlVendorSymbolVariants(symbol)
    ])
  ];
  if (batchMode) candidates = candidates.slice(0, 16);
  else if (isIntlEquitySymbol(symbol)) candidates = candidates.slice(0, 22);
  if (!batchMode) {
    console.log(`FMP fetchFmpScore variants for ${symbol}:`, candidates.slice(0, 12).join(' | '));
  }

  const tHttp = batchMode ? 9000 : 14000;

  for (const sym of candidates) {
    try {
      const enc = encodeURIComponent(sym);
      const q = `?apikey=${encodeURIComponent(key)}`;
      const H = { Accept: 'application/json' };
      const baseStable = 'https://financialmodelingprep.com/stable';

      const scorePathP = fetch(`https://financialmodelingprep.com/api/v3/score/${enc}${q}`, {
        headers: H,
        signal: AbortSignal.timeout(tHttp)
      });
      const scoreQueryP = batchMode
        ? null
        : fetch(`https://financialmodelingprep.com/api/v3/score${q}&symbol=${enc}`, {
            headers: H,
            signal: AbortSignal.timeout(tHttp)
          });

      const settled = await Promise.allSettled([
        fetch(`${baseStable}/ratings-snapshot${q}&symbol=${enc}`, {
          headers: H,
          signal: AbortSignal.timeout(tHttp)
        }),
        scorePathP,
        ...(scoreQueryP ? [scoreQueryP] : []),
        fetch(`${baseStable}/grades-summary${q}&symbol=${enc}`, {
          headers: H,
          signal: AbortSignal.timeout(tHttp)
        })
      ]);

      const rR = settled[0];
      const sRpath = settled[1];
      const sRqs = batchMode ? { status: 'rejected' } : settled[2];
      const gR = batchMode ? settled[2] : settled[3];

      let rating = null;
      let scores = null;
      let grades = null;

      if (rR.status === 'fulfilled' && rR.value.ok) {
        const d = await rR.value.json().catch(() => null);
        const r = Array.isArray(d) ? d[0] : d;
        if (r && typeof r === 'object' && !(r.error || r['Error Message'])) {
          const ov =
            (typeof r.rating === 'string' && r.rating.trim()) ||
            (typeof r.overallRating === 'string' && r.overallRating.trim()) ||
            (typeof r.letterRating === 'string' && r.letterRating.trim()) ||
            null;
          if (ov || r.roeScore != null || r.roaScore != null) {
            rating = {
              overall: ov || null,
              roe: r.roeScore ?? r.roe ?? null,
              roa: r.roaScore ?? r.roa ?? null
            };
          }
        }
      }

      if (!batchMode && !rating?.overall) {
        const qAmp = q.replace(/^\?/, '&');
        const ratingUrls = [
          `https://financialmodelingprep.com/api/v3/historical-rating/${enc}?limit=1${qAmp}`,
          `https://financialmodelingprep.com/api/v3/rating/${enc}${q}`
        ];
        for (let ri = 0; ri < ratingUrls.length && !rating?.overall; ri++) {
          try {
            const hr = await fetch(ratingUrls[ri], { headers: H, signal: AbortSignal.timeout(12000) });
            if (!hr.ok) continue;
            const arr = await hr.json().catch(() => null);
            const r2 = Array.isArray(arr) && arr[0] ? arr[0] : null;
            if (r2 && typeof r2 === 'object') {
              const ov =
                (typeof r2.rating === 'string' && r2.rating.trim()) ||
                (typeof r2.ratingRecommendation === 'string' && r2.ratingRecommendation.trim()) ||
                (typeof r2.recommendation === 'string' && r2.recommendation.trim()) ||
                null;
              rating = {
                overall: ov ?? rating?.overall ?? null,
                roe: r2.roeScore ?? r2.overallScore ?? rating?.roe ?? null,
                roa: rating?.roa ?? null
              };
            }
          } catch (_) {
            /* optional */
          }
        }
      }

      const mergeScoreTxt = txt => {
        try {
          const d = txt ? JSON.parse(txt) : null;
          const row = Array.isArray(d) ? d[0] : d;
          if (!row || typeof row !== 'object' || row.error || row['Error Message']) return false;
          const pio =
            scores?.piotroski ??
            row.piotroskiScore ??
            row.piotroski ??
            row.piotroski_score ??
            row.fScore ??
            null;
          const az =
            scores?.altmanZ ??
            row.altmanZScore ??
            row.altmanZ ??
            row.altman_z_score ??
            null;
          const toNum = v => {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string' && v.trim() !== '') {
              const n = Number(v);
              return Number.isFinite(n) ? n : null;
            }
            return null;
          };
          scores = {
            piotroski: toNum(pio),
            altmanZ: toNum(az)
          };
          return scores.piotroski != null || scores.altmanZ != null;
        } catch (_) {
          return false;
        }
      };

      let gotScoreUrl = false;
      if (sRpath.status === 'fulfilled' && sRpath.value.ok)
        gotScoreUrl = mergeScoreTxt(await sRpath.value.text());
      if (!gotScoreUrl && sRqs.status === 'fulfilled' && sRqs.value.ok)
        mergeScoreTxt(await sRqs.value.text());

      if (gR.status === 'fulfilled' && gR.value.ok) {
        const d = await gR.value.json().catch(() => null);
        const r = Array.isArray(d) ? d[0] : d?.data?.[0] ?? d;
        if (r && typeof r === 'object') {
          const sb = r.strongBuy || 0,
            b = r.buy || 0,
            hh = r.hold || 0,
            se = r.sell || 0,
            ss = r.strongSell || 0,
            t = sb + b + hh + se + ss;
          grades = {
            strongBuy: sb,
            buy: b,
            hold: hh,
            sell: se,
            strongSell: ss,
            total: t,
            consensus: t > 0 ? parseFloat(((sb * 2 + b - se - ss * 2) / t).toFixed(2)) : null
          };
        }
      }

      if (key && (scores == null || scores.piotroski == null || scores.altmanZ == null)) {
        const fsPlus = await fetchFmpStableFinancialScores(sym, key, Math.min(tHttp + 5000, 22000));
        if (fsPlus) {
          scores = {
            piotroski: scores?.piotroski ?? fsPlus.piotroski ?? null,
            altmanZ: scores?.altmanZ ?? fsPlus.altmanZ ?? null
          };
        }
      }

      if (key && (scores?.piotroski == null || scores?.altmanZ == null)) {
        const fsAll = await fetchFmpStableFinancialScores(symbol, key, Math.min(tHttp + 8000, 24000));
        if (fsAll) {
          scores = {
            piotroski: scores?.piotroski ?? fsAll.piotroski ?? null,
            altmanZ: scores?.altmanZ ?? fsAll.altmanZ ?? null
          };
        }
      }

      const hasNums = !!(scores?.piotroski != null || scores?.altmanZ != null);
      if (!rating?.overall && !hasNums && !grades) continue;

      const oS = fmpLetterBucketToTen(rating?.overall);

      const pS =
        scores?.piotroski != null && Number.isFinite(scores.piotroski)
          ? Math.round((scores.piotroski * 10) / 9)
          : null;
      const aS =
        scores?.altmanZ != null && Number.isFinite(scores.altmanZ)
          ? scores.altmanZ > 2.99
            ? 9
            : scores.altmanZ > 1.81
              ? 6
              : 3
          : null;
      const gS =
        grades?.consensus != null && Number.isFinite(parseFloat(String(grades.consensus)))
          ? Math.round(((parseFloat(String(grades.consensus)) + 2) / 4) * 10)
          : null;
      const inp = [oS, pS, aS, gS].filter(v => v != null && Number.isFinite(v));
      const qs =
        inp.length >= 1 ? Math.round(inp.reduce((acc, x) => acc + Number(x), 0) / inp.length) : null;
      const result = {
        qualityScore: qs,
        overallRating: rating?.overall ?? null,
        piotroski: scores?.piotroski ?? null,
        altmanZ: scores?.altmanZ ?? null,
        roeScore: rating?.roe ?? null,
        roaScore: rating?.roa ?? null,
        analystScore: gS,
        analystCounts: grades,
        buy_track_record: qs != null && qs >= 7
      };
      if (
        isIntlEquitySymbol(symbol) &&
        fmpPlanTier() === 'starter' &&
        result.piotroski == null &&
        result.altmanZ == null
      ) {
        result.intlCoverageNote =
          'FMP Starter is US-only for Piotroski/Altman. Set FMP_PLAN=ultimate on Render.';
      } else if (
        isIntlEquitySymbol(symbol) &&
        fmpGlobalCoverageEnabled() &&
        result.piotroski == null &&
        result.altmanZ == null
      ) {
        result.intlCoverageNote = FMP_INTL_DATA_MISS_HINT;
      }
      _fmpCache.set(cacheKey, { ts: Date.now(), data: result });
      if (batchMode) {
        console.log(`FMP lite ${symbol} ← ${sym} qs=${qs ?? 'n/a'}`);
      } else {
        console.log(
          `FMP fetchFmpScore hit ${symbol} via variant ${sym} qs=${qs} pio=${scores?.piotroski ?? 'n'} az=${scores?.altmanZ ?? 'n'}`
        );
      }
      return result;
    } catch (e) {
      console.warn('FMP score', sym, e.message);
    }
  }

  _fmpCache.set(cacheKey, { ts: Date.now(), data: null });
  if (!batchMode) {
    console.warn(`FMP fetchFmpScore miss for ${symbol} (checked ${candidates.length} variants)`);
  }
  return null;
}


/** Danelfin API: https://danelfin.com/docs/api — keyed by ticker as returned by the client batch. */
const DANELFIN_BASE_URL = 'https://apirest.danelfin.com';
function danelfinNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function danelfinLatestLeaf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.aiscore !== undefined || payload.fundamental !== undefined || payload.technical !== undefined) {
    return payload;
  }
  let chosen = null;
  let chosenKey = '';
  for (const [k, v] of Object.entries(payload)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const inner =
      v.aiscore !== undefined || v.fundamental !== undefined || v.technical !== undefined
        ? v
        : danelfinLatestLeaf(v);
    if (!inner) continue;
    if (!chosen || String(k) > chosenKey) {
      chosenKey = String(k);
      chosen = inner;
    }
  }
  return chosen;
}

async function fetchDanelfinRow(apiKey, symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) return null;
  const fld =
    'aiscore,technical,fundamental,sentiment,low_risk,buy_track_record,sell_track_record';

  async function ranking(marketEu) {
    const q = `ticker=${encodeURIComponent(sym)}&fields=${encodeURIComponent(fld)}`;
    const u = `${DANELFIN_BASE_URL}/ranking?${q}${marketEu ? '&market=europe' : ''}`;
    const r = await fetch(u, {
      headers: { Accept: 'application/json', 'x-api-key': apiKey },
      signal: AbortSignal.timeout(14000)
    });
    if (!r.ok) return null;
    let json;
    try {
      json = await r.json();
    } catch {
      return null;
    }
    const leaf = danelfinLatestLeaf(json);
    if (!leaf) return null;
    return {
      aiscore: danelfinNum(leaf.aiscore),
      technical: danelfinNum(leaf.technical),
      fundamental: danelfinNum(leaf.fundamental),
      sentiment: danelfinNum(leaf.sentiment),
      low_risk: danelfinNum(leaf.low_risk),
      buy_track_record:
        leaf.buy_track_record === true ||
        leaf.buy_track_record === 1 ||
        leaf.buy_track_record === '1',
      sell_track_record:
        leaf.sell_track_record === true ||
        leaf.sell_track_record === 1 ||
        leaf.sell_track_record === '1'
    };
  }
  try {
    const us = await ranking(false);
    if (us && us.aiscore != null) return us;
    return await ranking(true);
  } catch (e) {
    console.warn('Danelfin', sym, e.message);
    return null;
  }
}

/** Re-derive action/rating from buy/sell scores after tier overlays. */
function rerateQuantSignals(quantSignal) {
  if (!quantSignal) return;
  ['short', 'medium', 'long'].forEach(hz => {
    const q = quantSignal[hz];
    if (!q) return;
    const bs = q.buyScore || 0;
    const ss = q.sellScore || 0;
    if (bs >= ss) {
      if (bs >= 84) {
        q.action = 'Buy';
        q.rating = 'Strong Buy';
      } else if (bs >= 66) {
        q.action = 'Buy';
        q.rating = 'Buy';
      } else {
        q.action = 'Hold';
        q.rating = 'Hold';
      }
    } else if (ss >= 80) {
      q.action = 'Sell';
      q.rating = 'Strong Sell';
    } else if (ss >= 64) {
      q.action = 'Sell';
      q.rating = 'Sell';
    } else {
      q.action = 'Hold';
      q.rating = 'Hold';
    }
  });
}

function applyTierScoreCaps(quantSignal) {
  if (!quantSignal) return;
  ['short', 'medium', 'long'].forEach(hz => {
    const q = quantSignal[hz];
    if (!q) return;
    q.tier2Eligible = q.tier >= 1;
    if (q.tier === 0 && q.buyScore > 72) q.buyScore = 72;
    if (q.tier === 1 && q.buyScore > 88) q.buyScore = 88;
    if (q.tier >= 1) q.winRateHint = Math.max(q.winRateHint || 60, 70);

    // STRUCTURAL OVERRIDE (runs after all fundamental/Danelfin overlays).
    // No fundamental quality can make a structurally broken chart a Buy. Final word on score.
    if (q.fallingKnife) {
      if ((q.buyScore || 0) > 45) {
        q.buyScore = 45;
        q.conditions = q.conditions || [];
        if (!q.conditions.some(c => /falling knife/i.test(c))) {
          q.conditions.push('Falling knife: below MA20 & MA200, RSI<45 — buy blocked');
        }
        q.tierLabel = '⚠ Falling knife — buy blocked';
      }
    } else if (q.belowMa200 && hz === 'short') {
      // Counter-trend short-term buys below the 200DMA are low-probability regardless of fundamentals.
      if ((q.buyScore || 0) > 61) q.buyScore = 61;
    } else if (hz === 'short' && q.belowMa20 && q.belowMa50) {
      // Short-term timing is broken when price is below BOTH short MAs (e.g. oversold in a
      // downtrend). Strong fundamentals justify a longer-horizon dip-buy, NOT a short Buy.
      if ((q.buyScore || 0) > 61) {
        q.buyScore = 61;
        q.conditions = q.conditions || [];
        if (!q.conditions.some(c => /MA20 & MA50/i.test(c))) {
          q.conditions.push('Below MA20 & MA50 in pullback — short-term buy blocked');
        }
        q.tierLabel = q.tierLabel || 'Below MA20 & MA50 — short buy blocked';
      }
    }
    // Medium-term: a confirmed downtrend below the 50DMA caps the conviction at Buy (not Strong Buy),
    // even with top-tier fundamentals — you don't get max conviction fighting the trend.
    if (hz === 'medium' && q.belowMa50 && q.trendDown && (q.buyScore || 0) > 73) {
      q.buyScore = 73;
    }

    // FINAL: re-derive action/rating from the post-overlay, post-cap score so the dashboard
    // card, server picks, and full-analysis view are always consistent. (SL-cooldown gate,
    // which runs after this, may still override.)
    const ar = deriveActionRating(q.buyScore, q.sellScore);
    q.action = ar.action;
    q.rating = ar.rating;
    // Confidence (= winRateHint) must clear 62%. Score≥62 alone is not enough.
    const conf = Number(q.winRateHint) || 0;
    if ((q.action === 'Buy' || q.action === 'Sell') && conf < PICKS_MIN_CONF) {
      q.action = 'Hold';
      q.rating = 'Hold';
      q.tierLabel = (q.tierLabel ? q.tierLabel + ' · ' : '') + 'Conf ' + conf + '% < ' + PICKS_MIN_CONF + '%';
    }
  });
}

function applyFmpTierOverlay(dataShell, sym, fmp) {
  const quantSignal = dataShell?.quantSignal;
  if (!fmp || !quantSignal) return;
  dataShell.fmpScore = fmp;
  const _qs = fmp.qualityScore ?? 5;
  const _pio = fmp.piotroski ?? 0;
  const _az = fmp.altmanZ ?? 0;
  const _ast = fmp.analystScore ?? 5;
  const _hasBT = !!fmp.buy_track_record;
  const _sdBQ = dataShell?.channelPos?.buyQuality ?? 'fair';
  const _sdGd = _sdBQ === 'good' || _sdBQ === 'excellent';
  const _sdEx = _sdBQ === 'excellent';
  if (_pio >= 7 && _sdGd && _hasBT) {
    quantSignal.short.buyScore = Math.min(
      92,
      Math.max(quantSignal.short.buyScore || 0, 76) + Math.round((_pio - 6) * 2)
    );
    quantSignal.short.tier = 1;
    quantSignal.short.tierLabel = `Piotroski ${_pio}/9+SD`;
    quantSignal.short.winRateHint = 70;
  } else if (_pio >= 5 && _hasBT) {
    quantSignal.short.buyScore = Math.min(
      92,
      (quantSignal.short.buyScore || 0) + Math.round((_pio - 4) * 1.5)
    );
  } else if (_pio <= 3 || _qs <= 3) {
    quantSignal.short.buyScore = Math.min(40, Math.round((quantSignal.short.buyScore || 0) * 0.5));
  }
  if ((_qs >= 8 && _sdGd) || (_qs >= 7 && _sdEx)) {
    if (_hasBT) {
      quantSignal.medium.buyScore = Math.min(
        92,
        Math.max(quantSignal.medium.buyScore || 0, 78) + Math.round((_qs - 7) * 2)
      );
      quantSignal.medium.tier = 1;
      quantSignal.medium.tierLabel = `FMP Quality ${_qs}/10+SD`;
      quantSignal.medium.winRateHint = 71;
    }
  } else if (_qs >= 6 && _hasBT) {
    quantSignal.medium.buyScore = Math.min(
      92,
      (quantSignal.medium.buyScore || 0) + Math.round((_qs - 5) * 2.5)
    );
  } else if (_qs <= 4) {
    quantSignal.medium.buyScore = Math.min(38, Math.round((quantSignal.medium.buyScore || 0) * 0.4));
  }
  const _fmpLQ = _qs * 0.45 + _pio * 0.35 + _ast * 0.2;
  if (_fmpLQ >= 7 && _az > 2.99 && _sdGd && _hasBT) {
    quantSignal.long.buyScore = Math.min(
      92,
      Math.max(quantSignal.long.buyScore || 0, 76) + Math.round((_fmpLQ - 6) * 2)
    );
    quantSignal.long.tier = 1;
    quantSignal.long.tierLabel = `FMP ${_fmpLQ.toFixed(1)}/10+AltmanZ`;
    quantSignal.long.winRateHint = 70;
  } else if (_fmpLQ >= 5 && _hasBT) {
    quantSignal.long.buyScore = Math.min(
      92,
      (quantSignal.long.buyScore || 0) + Math.round((_fmpLQ - 5) * 2)
    );
  } else if (_fmpLQ <= 4 || _az <= 1.81) {
    quantSignal.long.buyScore = Math.min(35, Math.round((quantSignal.long.buyScore || 0) * 0.4));
  }
}

function applyDanelfinTierOverlay(dataShell, ds) {
  const quantSignal = dataShell?.quantSignal;
  if (!ds || ds.aiscore == null || !quantSignal) return;
  dataShell.danelfin = ds;
  const _danAI = ds.aiscore || 0;
  const _danTech = ds.technical || 0;
  const _danFund = ds.fundamental || 0;
  const _danRisk = ds.low_risk || 0;
  const _hasBuyTrack = !!ds.buy_track_record;
  const _hasSellTrack = !!ds.sell_track_record;
  const _sdQ = dataShell?.channelPos?.buyQuality ?? 'fair';
  const _sdExcellent = _sdQ === 'excellent';
  const _sdGood = _sdQ === 'good' || _sdExcellent;
  const _shortTier1 = _danTech >= 8 && _sdGood && _hasBuyTrack;
  const _shortTier1b = _danTech >= 7 && _danAI >= 7 && _sdExcellent && _hasBuyTrack;
  if (_shortTier1 || _shortTier1b) {
    quantSignal.short.buyScore = Math.min(
      92,
      Math.max(quantSignal.short.buyScore || 0, 78) + Math.round((_danTech - 7) * 2)
    );
    quantSignal.short.tier = 1;
    quantSignal.short.tierLabel = 'Danelfin≥8 + SD channel';
    quantSignal.short.winRateHint = 71;
  } else if (_danTech >= 8 && _hasBuyTrack) {
    quantSignal.short.buyScore = Math.min(
      92,
      (quantSignal.short.buyScore || 0) + Math.round((_danTech - 6) * 2)
    );
    quantSignal.short.tier = 0;
    quantSignal.short.winRateHint = 64;
  } else if (_danTech >= 6 && _hasBuyTrack) {
    quantSignal.short.buyScore = Math.min(
      92,
      (quantSignal.short.buyScore || 0) + Math.round((_danTech - 5) * 1.5)
    );
  } else if (_danTech <= 3 || (!_hasBuyTrack && _danAI <= 4)) {
    quantSignal.short.buyScore = Math.round((quantSignal.short.buyScore || 0) * 0.5);
    quantSignal.short.buyScore = Math.min(quantSignal.short.buyScore, 40);
  }
  if (_danTech <= 3 && _hasSellTrack) {
    quantSignal.short.sellScore = Math.min(
      88,
      (quantSignal.short.sellScore || 0) + Math.round((5 - _danTech) * 2.5)
    );
  }
  const _medTier1 = _danAI >= 8 && _sdGood && _hasBuyTrack;
  const _medTier1b = _danAI >= 7 && _danTech >= 7 && _sdExcellent && _hasBuyTrack;
  if (_medTier1 || _medTier1b) {
    quantSignal.medium.buyScore = Math.min(
      92,
      Math.max(quantSignal.medium.buyScore || 0, 80) + Math.round((_danAI - 7) * 2)
    );
    quantSignal.medium.tier = 1;
    quantSignal.medium.tierLabel = 'Danelfin≥8 + SD channel';
    quantSignal.medium.winRateHint = 72;
  } else if (_danAI >= 8 && _hasBuyTrack) {
    quantSignal.medium.buyScore = Math.min(
      92,
      (quantSignal.medium.buyScore || 0) + Math.round((_danAI - 6) * 3)
    );
    quantSignal.medium.tier = 0;
    quantSignal.medium.winRateHint = 64;
  } else if (_danAI >= 6 && _hasBuyTrack) {
    quantSignal.medium.buyScore = Math.min(
      92,
      (quantSignal.medium.buyScore || 0) + Math.round((_danAI - 5) * 2.5)
    );
  } else if (_danAI <= 4) {
    quantSignal.medium.buyScore = Math.round((quantSignal.medium.buyScore || 0) * 0.4);
    quantSignal.medium.buyScore = Math.min(quantSignal.medium.buyScore, 38);
  }
  if (_danAI <= 3 && _hasSellTrack) {
    quantSignal.medium.sellScore = Math.min(
      88,
      (quantSignal.medium.sellScore || 0) + Math.round((5 - _danAI) * 3)
    );
  }
  const _longQ = _danAI * 0.5 + _danFund * 0.35 + _danRisk * 0.15;
  const _longTier1 = _danAI >= 8 && _danFund >= 7 && _sdGood && _hasBuyTrack;
  const _longTier1b = _danAI >= 7 && _danFund >= 8 && _sdExcellent && _hasBuyTrack;
  if (_longTier1 || _longTier1b) {
    quantSignal.long.buyScore = Math.min(
      92,
      Math.max(quantSignal.long.buyScore || 0, 78) + Math.round((_longQ - 6) * 2)
    );
    quantSignal.long.tier = 1;
    quantSignal.long.tierLabel = 'Danelfin≥8 + Fund≥7 + SD channel';
    quantSignal.long.winRateHint = 71;
  } else if (_longQ >= 7 && _hasBuyTrack) {
    quantSignal.long.buyScore = Math.min(
      92,
      (quantSignal.long.buyScore || 0) + Math.round((_longQ - 5) * 2.5)
    );
    quantSignal.long.winRateHint = Math.max(quantSignal.long.winRateHint || 50, 60);
  } else if (_longQ <= 4 || (_danFund <= 3 && _danAI <= 3)) {
    quantSignal.long.buyScore = Math.round((quantSignal.long.buyScore || 0) * 0.4);
    quantSignal.long.buyScore = Math.min(quantSignal.long.buyScore, 35);
  }
  if (_danFund <= 3 && _danAI <= 4 && _hasSellTrack) {
    quantSignal.long.sellScore = Math.min(
      88,
      (quantSignal.long.sellScore || 0) + Math.round((5 - _danAI) * 2.5)
    );
  }
}

/** FMP + Danelfin tier overlays shared by dashboard batch, analyze, and history revalidation. */
async function applyMarketTierOverlays(sym, dataShell, opts = {}) {
  if (!dataShell?.quantSignal) return dataShell;
  const batchMode = !!opts.batchMode;
  const _mkt = classifyMarket(sym);
  dataShell.marketTier = _mkt.tier;
  dataShell.marketLabel = _mkt.label;
  dataShell.marketRegion = _mkt.region;
  dataShell.marketNote = _mkt.note;

  if (_mkt.tier === 'technical_only') {
    ['short', 'medium', 'long'].forEach(hz => {
      const q = dataShell.quantSignal[hz];
      if (!q) return;
      if (q.buyScore > 0) q.buyScore = Math.round(q.buyScore * 0.85);
      if (q.sellScore > 0) q.sellScore = Math.round(q.sellScore * 0.85);
      q.technicalOnly = true;
    });
  }

  if (_mkt.tier === 'fmp_quality' || (_mkt.tier === 'danelfin_eu' && _mkt.fmp)) {
    try {
      const _fk = fmpEnvKeyFund();
      if (_fk) {
        const _fmp = opts.fmpPre || (await fetchFmpScore(sym, { batchMode }));
        if (_fmp) applyFmpTierOverlay(dataShell, sym, _fmp);
      }
    } catch (e) {
      console.warn('FMP overlay', sym, e.message);
    }
  }

  if (_mkt.danelfin) {
    let _danApplied = false;
    try {
      const _dkey = (process.env.DANELFIN_API_KEY || '').trim();
      if (_dkey) {
        const _ds = opts.danelfinPre || (await cachedDanelfinRow(_dkey, sym));
        if (_ds && _ds.aiscore != null) { applyDanelfinTierOverlay(dataShell, _ds); _danApplied = true; }
      }
    } catch (e) {
      console.warn('Danelfin overlay', sym, e.message);
    }
    // FMP QUALITY FALLBACK: when Danelfin is unavailable (daily budget spent,
    // monthly limit hit, key missing, or API error) US names previously got NO
    // quality overlay at all — the FMP fetch only ran for non-US tiers. Fall back
    // to FMP financial scores so buys/sells stay quality-aware either way.
    if (!_danApplied) {
      try {
        const _fk2 = fmpEnvKeyFund();
        if (_fk2) {
          const _fmp2 = opts.fmpPre || dataShell.fmpScore || (await fetchFmpScore(sym, { batchMode }));
          if (_fmp2) {
            applyFmpTierOverlay(dataShell, sym, _fmp2);
            dataShell.qualitySource = 'fmp_fallback'; // visible in payloads for verification
          }
        }
      } catch (e) {
        console.warn('FMP fallback overlay', sym, e.message);
      }
    } else {
      dataShell.qualitySource = 'danelfin';
    }
  }

  // Piotroski / Altman Z — direct score boosts after FMP fetch (independent of tier/SD gates)
  const _fmpQS = dataShell.fmpScore || opts.fmpPre || null;
  if (_fmpQS) {
    ['short', 'medium', 'long'].forEach(hz => {
      const q = dataShell.quantSignal?.[hz];
      if (!q) return;
      const _pio = _fmpQS.piotroski;
      const _az = _fmpQS.altmanZ;
      const _qs = _fmpQS.qualityScore;

      if (_pio != null && Number.isFinite(_pio)) {
        if (_pio >= 7) {
          if (q.buyScore > 0) q.buyScore = Math.min(92, Math.round(q.buyScore * 1.12));
          if (q.sellScore > 0) q.sellScore = Math.round(q.sellScore * 0.88);
          (q.conditions = q.conditions || []).unshift(`Piotroski ${_pio}/9 ✓`);
        } else if (_pio >= 5) {
          if (q.buyScore > 0) q.buyScore = Math.min(92, Math.round(q.buyScore * 1.05));
        } else if (_pio <= 3) {
          if (q.buyScore > 0) q.buyScore = Math.round(q.buyScore * 0.72);
          if (q.sellScore > 0) q.sellScore = Math.min(88, Math.round(q.sellScore * 1.15));
          (q.conditions = q.conditions || []).push(`Pio ${_pio}/9 weak`);
        }
      }

      if (_az != null && Number.isFinite(_az) && hz !== 'short') {
        if (_az > 2.99) {
          if (q.buyScore > 0) q.buyScore = Math.min(92, Math.round(q.buyScore * 1.08));
        } else if (_az < 1.81) {
          if (q.buyScore > 0) q.buyScore = Math.round(q.buyScore * 0.65);
          if (q.sellScore > 0) q.sellScore = Math.min(88, Math.round(q.sellScore * 1.20));
          (q.conditions = q.conditions || []).push(`AltmanZ ${_az.toFixed(1)} distress`);
        }
      }

      if (_qs != null && (_mkt.tier === 'fmp_quality' || _mkt.tier === 'danelfin_eu')) {
        if (_qs >= 8 && q.buyScore > 0) q.buyScore = Math.min(92, Math.round(q.buyScore * 1.10));
        if (_qs <= 4 && q.buyScore > 0) q.buyScore = Math.round(q.buyScore * 0.75);
      }

      const bs = q.buyScore || 0;
      const ss = q.sellScore || 0;
      if (bs >= ss) {
        q.action = bs >= 84 ? 'Buy' : bs >= 62 ? 'Buy' : 'Hold';
        q.rating = bs >= 84 ? 'Strong Buy' : bs >= 62 ? 'Buy' : 'Hold';
      } else {
        q.action = ss >= 80 ? 'Sell' : ss >= 62 ? 'Sell' : 'Hold';
        q.rating = ss >= 80 ? 'Strong Sell' : ss >= 62 ? 'Sell' : 'Hold';
      }
    });
  }

  applyTierScoreCaps(dataShell.quantSignal);
  rerateQuantSignals(dataShell.quantSignal);
  return dataShell;
}

// ── No-repeat filter: is this ticker ALREADY open in the given direction? ──────
// A name that's already an open Buy should not be re-recommended as a Buy; only a
// DIRECTION CHANGE (Buy↔Sell) / regime flip that closes the open makes it eligible
// again. Looks across all horizons + dual-list aliases (AIR.DE≡AIR.PA).
const LIVE_STATUSES = new Set(['open', 'tp1_open', 'pending', 'n/a', '']);
function normalizeHistoryTicker(t) {
  const s = String(t || '').toUpperCase();
  const m = s.match(/^(\d+)\.HK$/);
  if (m) return m[1].padStart(4, '0') + '.HK';
  return s;
}
function historyTickerMatchSet(ticker) {
  const y = normalizeHistoryTicker(ticker);
  const out = new Set([y]);
  // Dual-list aliases (AIR.DE ≡ AIR.PA). Keep local map so this works before
  // IBKR_LISTING_ALIASES is initialized at module load.
  const LOCAL_ALIASES = { 'AIR.DE': ['AIR.PA'], 'AIR.PA': ['AIR.DE'] };
  for (const a of (LOCAL_ALIASES[y] || [])) out.add(normalizeHistoryTicker(a));
  try {
    if (typeof IBKR_LISTING_ALIASES !== 'undefined' && IBKR_LISTING_ALIASES[y]) {
      for (const a of IBKR_LISTING_ALIASES[y]) out.add(normalizeHistoryTicker(a));
    }
  } catch (_) { /* TDZ — local aliases suffice */ }
  return out;
}
/** Open emitted entry sides for ticker (any SGT day, no exit yet). */
function openEmittedSidesForTicker(ticker) {
  const aliases = historyTickerMatchSet(ticker);
  const open = new Map(); // key -> side
  try {
    if (!fs.existsSync(TRADE_EVENTS_FILE)) return new Set();
    for (const line of fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || !e.key) continue;
      const t = normalizeHistoryTicker(e.key.split('|')[0]);
      if (!aliases.has(t)) continue;
      if (e.type === 'entry' && (e.side === 'buy' || e.side === 'sell')) open.set(e.key, e.side);
      else if (e.type === 'exit') open.delete(e.key);
    }
  } catch (_) { return new Set(); }
  return new Set([...open.values()]);
}
function hasOpenTradeInDirection(ticker, wantSell) {
  if (!ticker) return false;
  const aliases = historyTickerMatchSet(ticker);
  if (Array.isArray(tradeHistory)) {
    for (const h of tradeHistory) {
      if (!h || !aliases.has(normalizeHistoryTicker(h.ticker))) continue;
      const hz = h.hz || 'short';
      const status = String(h[hz + 'Status'] || h.status || 'open').toLowerCase();
      if (!LIVE_STATUSES.has(status)) continue; // fully closed — eligible again
      const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
      if (act !== 'buy' && act !== 'sell') continue;
      if ((act === 'sell') === !!wantSell) return true; // same direction already live
    }
  }
  // Provenance: open emitted entry in the same direction also blocks re-recommend.
  try {
    const sides = openEmittedSidesForTicker(ticker);
    if (wantSell && sides.has('sell')) return true;
    if (!wantSell && sides.has('buy')) return true;
  } catch (_) { /* history check is enough */ }
  return false;
}

/** Tickers currently shown on the dashboard board (any pane). */
function collectDashTickers(dashData) {
  const out = new Set();
  if (!dashData || typeof dashData !== 'object') return out;
  for (const k of ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell']) {
    for (const s of dashData[k] || []) {
      if (s && s.ticker) out.add(String(s.ticker).toUpperCase());
    }
  }
  return out;
}

// Don't re-surface the SAME board names on the next morning regen — medium/long
// quant scores stick for days, which made "Refresh" look broken. Cooldown hours
// from the prior board snapshot (default 36h ≈ skip one trading session).
const PICKS_ROTATION_HOURS = Math.max(0, parseInt(process.env.PICKS_ROTATION_HOURS || '36', 10) || 36);
function priorBoardCooldownSet(opts = {}) {
  const allowRepeat = opts.allowRepeat === true || PICKS_ROTATION_HOURS <= 0;
  if (allowRepeat) return new Set();
  const prev = dashboardPicksCache && Array.isArray(dashboardPicksCache.priorPickTickers)
    ? dashboardPicksCache.priorPickTickers
    : [...collectDashTickers(dashboardPicksCache && dashboardPicksCache.dashData)];
  const prevTs = Number(dashboardPicksCache && (dashboardPicksCache.priorPickTs || dashboardPicksCache.dashTs)) || 0;
  if (!prev.length || !prevTs) return new Set();
  if (Date.now() - prevTs > PICKS_ROTATION_HOURS * 3600000) return new Set();
  return new Set(prev.map(t => String(t).toUpperCase()));
}

function topNRotating(arr, key, cooldownSet, n = 5) {
  const hzFromKey = String(key || '').replace(/SellScore$/i, '').replace(/Score$/i, '');
  const ratingKey = hzFromKey ? (hzFromKey + 'Rating') : 'rating';
  const sorted = (arr || []).slice().sort((a, b) => {
    const as = isStrongRecommendableRating(a[ratingKey]) ? 1 : 0;
    const bs = isStrongRecommendableRating(b[ratingKey]) ? 1 : 0;
    if (bs !== as) return bs - as; // Strong first
    return (b[key] || 0) - (a[key] || 0);
  });
  const cool = cooldownSet || new Set();
  // Never soft-fill from cooldown / already-shown names — empty pane beats a repeat.
  return sorted
    .filter(r => !cool.has(normalizeHistoryTicker(r.ticker)))
    .slice(0, n)
    .map(r => ({ ...r }));
}

function countDashPicks(dashData) {
  if (!dashData) return 0;
  return ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell']
    .reduce((n, k) => n + ((dashData[k] && dashData[k].length) || 0), 0);
}

/**
 * Rebuild board rows from live History opens. After a deploy gutting the picks
 * cache, open Buy/Sell names (IR/DLR/RCL…) were blocked from regen by
 * hasOpenTradeInDirection — so panes stayed empty even though the trades were live.
 * Put those opens back on today's board (display + cache), up to 5 per pane.
 */
function historyOpenToDashPick(h) {
  if (!h || !h.ticker) return null;
  const hz = h.hz || 'short';
  const isSell = String(h[hz + 'Action'] || h.action || '').toLowerCase() === 'sell';
  const entry = parseFloat(h[hz + 'Entry'] || h.entry || 0);
  const tp1 = parseFloat(h[hz + 'Target1'] || h.target1 || 0);
  const tp2 = parseFloat(h[hz + 'Target2'] || h.target2 || 0);
  const sl = parseFloat(h[hz + 'StopLoss'] || h.stopLoss || 0);
  if (!(entry > 0) || !(sl > 0)) return null;
  const score = Number(isSell
    ? (h[hz + 'SellScore'] || h.shortSellScore || h.conf || 0)
    : (h[hz + 'Score'] || h.shortScore || h.conf || 0)) || 0;
  const conf = Number(h[hz + 'Conf'] || h.conf || 0) || (score >= 62 ? score : 65);
  if (conf < PICKS_MIN_CONF && score < 62) return null;
  const rating = h[hz + 'Rating'] || h.rating
    || (isSell ? (score >= 74 ? 'Strong Sell' : 'Sell') : (score >= 78 ? 'Strong Buy' : 'Buy'));
  const action = isSell ? 'Sell' : 'Buy';
  const row = {
    ticker: h.ticker,
    name: h.name || h.ticker,
    sector: h.sector || '',
    market: h.market || '',
    action,
    reason: h.reason || h.sellReason || '',
    _fromOpenHistory: true
  };
  for (const z of ['short', 'medium', 'long']) {
    row[z + 'Action'] = 'Hold';
    row[z + 'Rating'] = 'Hold';
    row[z + 'Conf'] = 0;
    row[z + 'Score'] = Number(h[z + 'Score']) || 0;
    row[z + 'SellScore'] = Number(h[z + 'SellScore']) || 0;
  }
  row[hz + 'Action'] = action;
  row[hz + 'Rating'] = rating;
  row[hz + 'Conf'] = conf;
  if (isSell) row[hz + 'SellScore'] = score || conf;
  else row[hz + 'Score'] = score || conf;
  row[hz + 'Entry'] = entry;
  row[hz + 'Target1'] = tp1 || null;
  row[hz + 'Target2'] = tp2 || null;
  row[hz + 'StopLoss'] = sl;
  if (isSell) {
    row.sellEntry = entry;
    row.sellTarget1 = tp1 || null;
    row.sellTarget2 = tp2 || null;
    row.sellStopLoss = sl;
  } else {
    row.entry = entry;
    row.target1 = tp1 || null;
    row.target2 = tp2 || null;
    row.stopLoss = sl;
  }
  return row;
}

function mergeLiveOpenHistoryIntoDashData(dashData) {
  const LIVE = new Set(['open', 'partial', 'tp1_hit', 'tp1_open', 'pending', '']);
  const paneOf = (hz, sell) => (sell
    ? { short: 'shortSell', medium: 'medSell', long: 'longSell' }
    : { short: 'short', medium: 'medium', long: 'long' })[hz];
  const out = {
    short: [...((dashData && dashData.short) || [])],
    medium: [...((dashData && dashData.medium) || [])],
    long: [...((dashData && dashData.long) || [])],
    shortSell: [...((dashData && dashData.shortSell) || [])],
    medSell: [...((dashData && dashData.medSell) || [])],
    longSell: [...((dashData && dashData.longSell) || [])]
  };
  const today = singaporeToDateString();
  const candidates = [];
  for (const h of (Array.isArray(tradeHistory) ? tradeHistory : [])) {
    if (!isHistoryBuySellRecord(h)) continue;
    const hz = h.hz || 'short';
    const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
    if (act !== 'buy' && act !== 'sell') continue;
    const st = String(h[hz + 'Status'] || h.status || 'open').toLowerCase();
    if (!LIVE.has(st)) continue;
    if (act === 'sell' && !SELL_PICKS_ENABLED) continue;
    if (!bracketEnabled(act === 'sell' ? 'sell' : 'buy', hz)) continue;
    const pane = paneOf(hz, act === 'sell');
    if (!pane) continue;
    const pick = historyOpenToDashPick(h);
    if (!pick) continue;
    const conf = Number(pick[hz + 'Conf'] || 0);
    const todayBoost = historyTradeEntryDay(h) === today ? 1000 : 0;
    candidates.push({ pane, pick, rank: todayBoost + conf });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  let added = 0;
  for (const { pane, pick } of candidates) {
    const arr = out[pane];
    const tk = normalizeHistoryTicker(pick.ticker);
    if (arr.some(p => normalizeHistoryTicker(p.ticker) === tk)) continue;
    if (arr.length >= 5) continue;
    arr.push(pick);
    added++;
  }
  return { dashData: out, added };
}

function isHistoryBuySellRecord(h) {
  if (!h || !h.ticker) return false;
  const mainAct = String(h.action || '').toLowerCase();
  if (mainAct === 'buy' || mainAct === 'sell') return true;
  return ['short', 'medium', 'long'].some(hz => {
    const a = String(h[hz + 'Action'] || '').toLowerCase();
    return a === 'buy' || a === 'sell';
  });
}

function historyTradeEntryDay(trade) {
  if (!trade) return '';
  const ms = Date.parse(trade.entryDate || trade.timestamp || 0);
  return Number.isFinite(ms) ? singaporeToDateString(ms) : singaporeToDateString();
}

function isHistoryTradeFromToday(trade) {
  return historyTradeEntryDay(trade) === singaporeToDateString();
}

function compactFundSnapshot(fund) {
  if (!fund || typeof fund !== 'object') return null;
  return {
    trailingPE: fund.trailingPE ?? null,
    forwardPE: fund.forwardPE ?? null,
    pegRatio: fund.pegRatio ?? null,
    revenueGrowth: fund.revenueGrowth ?? null,
    earningsGrowth: fund.earningsGrowth ?? null,
    _fmpSector: fund._fmpSector ?? null,
    _source: fund._source ?? null
  };
}

function applyAnalyticsSnapshotToTrade(trade, shell, fund, hz) {
  if (!trade || !shell?.quantSignal) return;
  const q = shell.quantSignal[hz] || shell.quantSignal.short;
  if (!q) return;
  trade.fmpScore = shell.fmpScore || trade.fmpScore || null;
  trade.danelfin = shell.danelfin || trade.danelfin || null;
  trade.marketTier = shell.marketTier || trade.marketTier || null;
  trade.fundSnapshot = compactFundSnapshot(fund) || trade.fundSnapshot || null;
  trade.shortScore = shell.quantSignal.short?.buyScore ?? trade.shortScore;
  trade.mediumScore = shell.quantSignal.medium?.buyScore ?? trade.mediumScore;
  trade.longScore = shell.quantSignal.long?.buyScore ?? trade.longScore;
  trade.shortSellScore = shell.quantSignal.short?.sellScore ?? trade.shortSellScore;
  trade.mediumSellScore = shell.quantSignal.medium?.sellScore ?? trade.mediumSellScore;
  trade.longSellScore = shell.quantSignal.long?.sellScore ?? trade.longSellScore;
  trade.shortRating = shell.quantSignal.short?.rating ?? trade.shortRating;
  trade.mediumRating = shell.quantSignal.medium?.rating ?? trade.mediumRating;
  trade.longRating = shell.quantSignal.long?.rating ?? trade.longRating;
  trade.rating = q.rating ?? trade.rating;
  trade.quantTier = q.tier ?? trade.quantTier ?? null;
  trade.quantTierLabel = q.tierLabel ?? trade.quantTierLabel ?? null;
  if (fund?.trailingPE != null) trade.pe = fund.trailingPE;
  if (fund?.pegRatio != null) trade.peg = fund.pegRatio;
  if (fund?.revenueGrowth != null) trade.revenueGrowth = fund.revenueGrowth;
  if (fund?.earningsGrowth != null) trade.earningsGrowth = fund.earningsGrowth;
  trade.revalidatedAt = new Date().toISOString();
  trade.analyticsVersion = 2;
}

function shouldRemoveOpenHistoryTrade(trade, shell, hz) {
  if (!isHistoryTradeFromToday(trade)) return false;
  const sig = shell?.quantSignal?.[hz];
  if (!sig || !trade) return false;
  const isBuy = String(trade.action || '').toLowerCase() !== 'sell';
  const isSell = !isBuy;
  const regime = sig.regime || 'neutral';
  const bearKillsLong = isBuy && regime === 'bear';
  const bullKillsShort = isSell && regime === 'bull';
  const signalFlipped =
    (isBuy && sig.action === 'Sell' && (sig.sellScore || 0) >= 68) ||
    (isSell && sig.action === 'Buy' && (sig.buyScore || 0) >= 68);
  return bearKillsLong || bullKillsShort || signalFlipped;
}

async function enrichHistoryTradeRecord(trade, caches = {}) {
  if (!isHistoryBuySellRecord(trade)) return { ok: false, trade, shell: null };
  const ticker = String(trade.ticker || '').trim();
  const hz = trade.hz || 'short';
  if (!ticker) return { ok: false, trade, shell: null };

  if (!caches.techMap) caches.techMap = {};
  if (!caches.fundMap) caches.fundMap = {};
  if (!caches.fmpMap) caches.fmpMap = {};

  if (!caches.techMap[ticker]) {
    try {
      let daily = await fetchOHLCV(ticker, '2y', '1d').catch(() => null);
      if (!daily || daily.length < 30) daily = await fetchOHLCV(ticker, '1y', '1d').catch(() => null);
      const weekly = await fetchOHLCV(ticker, '2y', '1wk').catch(() => null);
      if (daily && daily.length >= 30) {
        caches.techMap[ticker] = buildFullTechResult(ticker, daily, weekly);
      }
    } catch (e) {
      console.warn('enrichHistory tech', ticker, e.message);
    }
  }

  if (!caches.fundMap[ticker]) {
    caches.fundMap[ticker] = (await fetchFundamentals(ticker).catch(() => null)) || null;
  }

  const tech = caches.techMap[ticker];
  const fund = caches.fundMap[ticker];
  if (!tech) return { ok: false, trade, shell: null, reason: 'no tech data' };
  if (tech._sectorRegime == null) tech._sectorRegime = sectorRegimeForSymbol(ticker);
  if (tech._earningsTide == null) tech._earningsTide = earningsTideForSymbol(ticker);

  const quantSignal = {
    short: computeQuantSignal(tech, fund, 'short'),
    medium: computeQuantSignal(tech, fund, 'medium'),
    long: computeQuantSignal(tech, fund, 'long')
  };
  const shell = { quantSignal, channelPos: tech.channelPos };
  await applyMarketTierOverlays(ticker, shell, {
    batchMode: true,
    fundPre: fund,
    fmpPre: caches.fmpMap[ticker]
  });
  if (shell.fmpScore) caches.fmpMap[ticker] = shell.fmpScore;
  applySLCooldownGate(ticker, shell);
  const openActPre = String(trade[hz + 'Action'] || trade.action || '').toLowerCase();
  const openStPre = String(trade[hz + 'Status'] || trade.status || 'open').toLowerCase();
  const latchedPre = !!ibkrLiveEntrySide(trade.ticker, hz, trade.entryDate || trade.timestamp);
  const freezeOpen = latchedPre || ((openActPre === 'buy' || openActPre === 'sell')
    && (!openStPre || openStPre === 'open' || openStPre === 'tp1_open'));
  const keepAction = freezeOpen
    ? (openActPre === 'sell' ? 'Sell' : 'Buy')
    : null;

  applyAnalyticsSnapshotToTrade(trade, shell, fund, hz);
  // Open recommendations keep Buy/Sell — single writer refuses Hold demote.
  // Also restore rating so a latched Buy is never displayed as Hold.
  if (keepAction) {
    writeOpenRowAction(trade, hz, keepAction);
    trade._freezeOpenAction = true;
    const score = keepAction === 'Sell'
      ? Number(trade[hz + 'SellScore'] || trade.sellScore || 0)
      : Number(trade[hz + 'Score'] || trade.score || 0);
    const restoredRating = keepAction === 'Sell'
      ? (score >= 74 ? 'Strong Sell' : 'Sell')
      : (score >= 78 ? 'Strong Buy' : 'Buy');
    if (!trade[hz + 'Rating'] || /hold/i.test(String(trade[hz + 'Rating']))) {
      trade[hz + 'Rating'] = restoredRating;
    }
    if (!trade.rating || /hold/i.test(String(trade.rating))) {
      trade.rating = trade[hz + 'Rating'] || restoredRating;
    }
  }
  trade.quantRegime = shell.quantSignal[hz]?.regime || trade.quantRegime || null;

  // CRITICAL: the entry price is the price WHEN THE TRADE WAS SIGNALLED and must be
  // IMMUTABLE. Previously this re-priced levels off tech.currentPrice (today's live
  // price), so every revalidation snapped a 12-Jun trade's entry to today's price
  // (entry == live, PnL == 0 — the recurring "overfitting" bug). We now base levels
  // on the FROZEN entry, so revalidation only refreshes TP/SL geometry & analytics;
  // the entry never moves. Only a brand-new row with no entry yet uses the live price.
  const frozenEntry = parseFloat(trade[hz + 'Entry'] || trade.entry || 0);
  const basePx = (frozenEntry && Number.isFinite(frozenEntry) && frozenEntry > 0)
    ? frozenEntry
    : tech.currentPrice;
  if (basePx && Number.isFinite(basePx)) {
    // Per-horizon action from the trade itself — never invent Hold for an open status.
    const hzAct = (h) => {
      const a = trade[h + 'Action'];
      if (a) return a;
      if (h === hz && trade.action) return trade.action;
      const st = String(trade[h + 'Status'] || (h === hz ? trade.status : '') || '').toLowerCase();
      if (st === 'open' || st === 'tp1_open' || st === 'pending') {
        if (trade.action) return trade.action;
        const side = typeof ibkrLiveEntrySide === 'function'
          ? ibkrLiveEntrySide(trade.ticker, h, trade.entryDate || trade.timestamp)
          : null;
        if (side === 'sell') return 'Sell';
        if (side === 'buy') return 'Buy';
        return a || trade.action || '';
      }
      return a || 'Hold';
    };
    const tempRow = {
      ...trade,
      shortAction: hzAct('short'),
      mediumAction: hzAct('medium'),
      longAction: hzAct('long'),
      // LATCH: open history Buy/Sell or live IBKR entry — Conf/RR demote must not → Hold.
      _freezeOpenAction: freezeOpen
    };
    applyServerPriceLevels(tempRow, basePx, tech, fund);
    ['short', 'medium', 'long'].forEach(hzKey => {
      const nextE = tempRow[hzKey + 'Entry'];
      const nextT1 = tempRow[hzKey + 'Target1'];
      const nextT2 = tempRow[hzKey + 'Target2'];
      const nextSl = tempRow[hzKey + 'StopLoss'];
      if (!(parseFloat(trade[hzKey + 'Entry']) > 0) && parseFloat(nextE) > 0) {
        trade[hzKey + 'Entry'] = nextE;
      }
      // Never blank open-trade levels when recompute fails / wrong hz action.
      if (parseFloat(nextT1) > 0) trade[hzKey + 'Target1'] = nextT1;
      if (parseFloat(nextT2) > 0) trade[hzKey + 'Target2'] = nextT2;
      if (parseFloat(nextSl) > 0) trade[hzKey + 'StopLoss'] = nextSl;
    });
    if (!(parseFloat(trade.entry) > 0) && parseFloat(tempRow[hz + 'Entry'] || tempRow.shortEntry) > 0) {
      trade.entry = tempRow[hz + 'Entry'] || tempRow.shortEntry;
    }
    if (hz === 'short') {
      if (parseFloat(tempRow.shortTarget1) > 0) trade.target1 = tempRow.shortTarget1;
      if (parseFloat(tempRow.shortTarget2) > 0) trade.target2 = tempRow.shortTarget2;
      if (parseFloat(tempRow.shortStopLoss) > 0) trade.stopLoss = tempRow.shortStopLoss;
    } else {
      if (parseFloat(tempRow[hz + 'Target1']) > 0) trade.target1 = tempRow[hz + 'Target1'];
      if (parseFloat(tempRow[hz + 'Target2']) > 0) trade.target2 = tempRow[hz + 'Target2'];
      if (parseFloat(tempRow[hz + 'StopLoss']) > 0) trade.stopLoss = tempRow[hz + 'StopLoss'];
    }
    if (String(trade.action || '').toLowerCase() === 'sell') {
      if (!(parseFloat(trade.sellEntry) > 0)) trade.sellEntry = tempRow.shortEntry;
      if (parseFloat(tempRow.shortTarget1) > 0) trade.sellTarget1 = tempRow.shortTarget1;
      if (parseFloat(tempRow.shortTarget2) > 0) trade.sellTarget2 = tempRow.shortTarget2;
      if (parseFloat(tempRow.shortStopLoss) > 0) trade.sellStopLoss = tempRow.shortStopLoss;
    }
  }

  if (keepAction) {
    writeOpenRowAction(trade, hz, keepAction);
    trade._freezeOpenAction = true;
  }
  fixHistoryRecordMinRR(trade);
  return { ok: true, trade, shell };
}

// POST /api/danelfin/batch — equities only; returns map ticker -> scores (omit if no AI score)
app.post('/api/danelfin/batch', async (req, res) => {
  const apiKey = (process.env.DANELFIN_API_KEY || '').trim();
  if (!apiKey) return res.json({});

  const raw = req.body?.symbols;
  const symbols = Array.isArray(raw) ? raw.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (!symbols.length) return res.json({});

  const equities = symbols.filter(s => !s.includes('=F') && !s.includes('-USD') && !s.includes('-EUR'));

  const out = {};
  await Promise.allSettled(
    equities.map(async sym => {
      const row = await cachedDanelfinRow(apiKey, sym);
      if (row && row.aiscore != null) out[sym] = row;
    })
  );

  console.log(`Danelfin batch: ${Object.keys(out).length}/${equities.length}`);
  res.json(out);
});

// ── Server-side trade history (shared across devices) ──────────────────────
// In-memory store (persists while server is running, resets on redeploy)
// Use a simple JSON file for persistence on Render disk
// Persist history: VPS / Render disk / local ./data / tmp (self-hosted: ./data wins)
// Persistent data directory. Render's default filesystem is EPHEMERAL — it is
// wiped on every deploy/restart. To keep history durable, mount a Render
// Persistent Disk and point DATA_DIR (or RENDER_DISK_MOUNT_PATH) at its mount
// path (e.g. /var/data). Locally this falls back to ./data. The first writable
// candidate wins; we verify writability with a probe file.
const DATA_DIR = (() => {
  const candidates = [
    process.env.DATA_DIR,
    process.env.RENDER_DISK_MOUNT_PATH,
    path.join(__dirname, 'data'),
    '/tmp'
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.writetest');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      return dir;
    } catch (_) {}
  }
  return '/tmp';
})();
const DATA_DIR_PERSISTENT = Boolean(process.env.DATA_DIR || process.env.RENDER_DISK_MOUNT_PATH);
console.log('Data dir:', DATA_DIR, DATA_DIR_PERSISTENT ? '(persistent disk)' : '(EPHEMERAL — set DATA_DIR to a mounted disk)');

const HISTORY_FILE = (() => {
  const p = path.join(DATA_DIR, 'history_data.json');
  try { if (!fs.existsSync(p)) fs.writeFileSync(p, '[]'); } catch (_) {}
  return p;
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

// ── Shared dashboard picks (same scan on phone + desktop) ───────────────────
const DASHBOARD_PICKS_VERSION = 1;
const DASHBOARD_PICKS_FILE = path.join(path.dirname(HISTORY_FILE), 'dashboard_picks.json');

function stripPickForStorage(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  delete out._techSnap;
  return out;
}

function sanitizeDashDataForServer(dashData) {
  const keys = ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell'];
  const out = {};
  for (const k of keys) {
    out[k] = Array.isArray(dashData[k]) ? dashData[k].map(stripPickForStorage) : [];
  }
  return out;
}

function loadDashboardPicksFile() {
  try {
    if (!fs.existsSync(DASHBOARD_PICKS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(DASHBOARD_PICKS_FILE, 'utf8'));
    if (raw && raw.version === DASHBOARD_PICKS_VERSION && raw.dashData) return raw;
  } catch (e) {
    console.warn('Dashboard picks load error:', e.message);
  }
  return null;
}

function saveDashboardPicksFile(payload) {
  try {
    fs.writeFileSync(DASHBOARD_PICKS_FILE, JSON.stringify(payload));
  } catch (e) {
    console.warn('Dashboard picks save error:', e.message);
  }
}

function dashboardPicksSummary(dashData) {
  if (!dashData || typeof dashData !== 'object') return '';
  const keys = ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell'];
  return keys
    .map((k) => {
      const arr = dashData[k] || [];
      if (!arr.length) return '';
      return k + ':' + arr.map((s) => s.ticker).filter(Boolean).join(',');
    })
    .filter(Boolean)
    .join(' | ');
}

let dashboardPicksCache = loadDashboardPicksFile();
if (dashboardPicksCache) {
  console.log('Dashboard picks loaded:', DASHBOARD_PICKS_FILE, 'ts=', dashboardPicksCache.dashTs);
}

app.get('/api/dashboard/picks', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const fromDisk = loadDashboardPicksFile();
  if (fromDisk) dashboardPicksCache = fromDisk;
  if (!dashboardPicksCache || !dashboardPicksCache.dashData) {
    // Still try to surface today's open History buys if cache was wiped.
    const seeded = mergeLiveOpenHistoryIntoDashData(null);
    if (seeded.added > 0) {
      const dashData = filterDashDataBySLCooldown(seeded.dashData);
      dashboardPicksCache = {
        version: DASHBOARD_PICKS_VERSION,
        schemaVersion: 1,
        dashTs: Date.now(),
        filteredAt: Date.now(),
        dashData: sanitizeDashDataForServer(dashData)
      };
      saveDashboardPicksFile(dashboardPicksCache);
      return res.json({
        version: DASHBOARD_PICKS_VERSION,
        schemaVersion: 1,
        dashTs: dashboardPicksCache.dashTs,
        filteredAt: dashboardPicksCache.filteredAt,
        picksAgeHours: 0,
        sgtDay: singaporeDateKey(),
        lastPicksDateKey: typeof _lastPicksDateKey !== 'undefined' ? _lastPicksDateKey : null,
        summary: dashboardPicksSummary(dashData),
        sellPicksDisabled: !SELL_PICKS_ENABLED,
        disabledBrackets: [...DISABLED_BRACKETS],
        restoredFromHistory: seeded.added,
        dashData
      });
    }
    return res.json({ version: DASHBOARD_PICKS_VERSION, dashData: null, dashTs: null, summary: '' });
  }
  let dashData = filterDashDataBySLCooldown(dashboardPicksCache.dashData);
  const before = countDashPicks(dashData);
  const merged = mergeLiveOpenHistoryIntoDashData(dashData);
  dashData = merged.dashData;
  if (merged.added > 0) {
    dashboardPicksCache = {
      version: dashboardPicksCache.version || DASHBOARD_PICKS_VERSION,
      schemaVersion: dashboardPicksCache.schemaVersion || 1,
      dashTs: dashboardPicksCache.dashTs || Date.now(),
      filteredAt: Date.now(),
      dashData: sanitizeDashDataForServer(dashData),
      priorPickTickers: dashboardPicksCache.priorPickTickers,
      priorPickTs: dashboardPicksCache.priorPickTs,
      prevSummary: dashboardPicksCache.prevSummary
    };
    saveDashboardPicksFile(dashboardPicksCache);
    console.log('Restored', merged.added, 'open History pick(s) onto board (was', before, '→', countDashPicks(dashData), ')');
  }
  res.json({
    version: dashboardPicksCache.version,
    schemaVersion: dashboardPicksCache.schemaVersion || 1,
    dashTs: dashboardPicksCache.dashTs,
    filteredAt: dashboardPicksCache.filteredAt || null,
    picksAgeHours: dashboardPicksCache.dashTs
      ? +((Date.now() - Number(dashboardPicksCache.dashTs)) / 3600000).toFixed(2)
      : null,
    sgtDay: singaporeDateKey(),
    lastPicksDateKey: typeof _lastPicksDateKey !== 'undefined' ? _lastPicksDateKey : null,
    summary: dashboardPicksSummary(dashData),
    sellPicksDisabled: !SELL_PICKS_ENABLED, // backtest: sells have no edge — reference-only
    disabledBrackets: [...DISABLED_BRACKETS],
    restoredFromHistory: merged.added || 0,
    dashData
  });
});

app.post('/api/dashboard/picks', express.json({ limit: '3mb' }), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'body required' });
  if (!body.dashData || typeof body.dashData !== 'object') {
    return res.status(400).json({ error: 'dashData required' });
  }
  dashboardPicksCache = {
    version: DASHBOARD_PICKS_VERSION,
    schemaVersion: body.schemaVersion || 1,
    dashTs: body.dashTs || Date.now(),
    dashData: sanitizeDashDataForServer(body.dashData)
  };
  saveDashboardPicksFile(dashboardPicksCache);
  console.log('Dashboard picks saved:', dashboardPicksCache.dashTs);
  res.json({ ok: true, dashTs: dashboardPicksCache.dashTs });
});

app.post('/api/dashboard/picks/revalidate', express.json(), async (req, res) => {
  const cached = loadDashboardPicksFile() || dashboardPicksCache;
  if (!cached?.dashData) {
    return res.json({ ok: false, reason: 'no picks', removed: 0, dashData: null });
  }
  let dashData = filterDashDataBySLCooldown(cached.dashData);
  const paneMap = DASH_PANE_MAP;
  const tickers = [...new Set(
    Object.keys(paneMap).flatMap(k => (dashData[k] || []).map(s => s.ticker).filter(Boolean))
  )];
  const techMap = await getTechnicalsMapForSymbols(tickers, { maxMs: 25000 });
  const filtered = filterDashDataByQuantTechMap(dashData, techMap, paneMap);
  const removed = countDashPickRemovals(dashData, filtered, paneMap);

  dashboardPicksCache = {
    version: DASHBOARD_PICKS_VERSION,
    schemaVersion: cached.schemaVersion || 1,
    dashTs: Date.now(),
    dashData: sanitizeDashDataForServer(filtered)
  };
  saveDashboardPicksFile(dashboardPicksCache);
  res.json({
    ok: true,
    removed,
    dashTs: dashboardPicksCache.dashTs,
    summary: dashboardPicksSummary(filtered),
    dashData: filtered
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FULL-UNIVERSE SCAN — server-side quant ranking over ALL index members.
// Runs the same engine (buildFullTechResult + computeQuantSignal + structural
// caps) over the entire S&P 500 / NASDAQ 100 / Nikkei 225 / Nifty 50 / HSI /
// CAC 40 / FTSE 100 / DAX universe (no Claude), ranks every name, and emits a
// shortlist of the strongest candidates. The client deep-scan then runs its
// full pipeline (Danelfin/news boosts, Claude narrative, TP/SL, top-5) on that
// shortlist — so the *names* are chosen from the whole universe, not a sample.
// ════════════════════════════════════════════════════════════════════════════
const UNIVERSE_SHORTLIST_FILE = path.join(path.dirname(HISTORY_FILE), 'universe_shortlist.json');
const UNIVERSE_SHORTLIST_VERSION = 1;
const UNIVERSE_SHORTLIST_TTL_MS = 20 * 60 * 60 * 1000; // 20h — refreshed daily
const UNIVERSE_PER_HZ_SIDE = Number.parseInt(String(process.env.UNIVERSE_PER_HZ_SIDE || '12'), 10) || 12;

let universeShortlist = null;
let universeScanState = { running: false, startedAt: 0, total: 0, done: 0, ok: 0, lastError: null, lastFinishedAt: 0 };

function loadUniverseShortlistFile() {
  try {
    if (!fs.existsSync(UNIVERSE_SHORTLIST_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(UNIVERSE_SHORTLIST_FILE, 'utf8'));
    if (raw && raw.version === UNIVERSE_SHORTLIST_VERSION && Array.isArray(raw.shortlist)) return raw;
  } catch (e) { console.warn('Universe shortlist load error:', e.message); }
  return null;
}
function saveUniverseShortlistFile(payload) {
  try { fs.writeFileSync(UNIVERSE_SHORTLIST_FILE, JSON.stringify(payload)); }
  catch (e) { console.warn('Universe shortlist save error:', e.message); }
}
universeShortlist = loadUniverseShortlistFile();
if (universeShortlist) console.log('Universe shortlist loaded:', universeShortlist.shortlist.length, 'names, ts=', universeShortlist.ts);

/** Fast per-symbol quant: OHLCV → quantSignal ×3 → structural caps. No network overlays. */
async function scanSymbolQuant(sym) {
  let daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 100) daily = await fetchOHLCV(sym, '1y', '1d').catch(() => null);
  if (!daily || daily.length < 60) return null;
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  const data = buildFullTechResult(sym, daily, weekly);
  const fundEntry = fundCache.get(sym);
  const fund = fundEntry && Date.now() - fundEntry.ts < TECH_TTL * 4 ? fundEntry.data : null;
  data._sectorRegime = sectorRegimeForSymbol(sym); // sector-level momentum tide
  data._earningsTide = earningsTideForSymbol(sym); // peer quarterly-results tide
  const qs = {
    short: computeQuantSignal(data, fund, 'short'),
    medium: computeQuantSignal(data, fund, 'medium'),
    long: computeQuantSignal(data, fund, 'long')
  };
  applyTierScoreCaps(qs);
  return { sym, cp: data.currentPrice, qs };
}

/** Pick top-N buy + top-N sell per horizon, union → shortlist (ranked by best score).
 *  To keep the candidate set geographically diverse (the user wants names from each
 *  index, and the ~550 US names would otherwise crowd out internationals), we take
 *  BOTH a global top-N and a per-market top-M for every horizon/side. */
function buildShortlistFromRows(rows, perSide = UNIVERSE_PER_HZ_SIDE) {
  const byS = new Map(rows.map(r => [r.sym, r]));
  const picked = new Set();
  const perMarketSide = Math.max(2, Number.parseInt(String(process.env.UNIVERSE_PER_MARKET_SIDE || '3'), 10) || 3);
  const markets = [...new Set(rows.map(r => r.market))];
  const topBy = (pool, key, n) => pool
    .filter(r => r.qs[key.hz] && Number.isFinite(r.qs[key.hz][key.field]))
    .sort((a, b) => (b.qs[key.hz][key.field] || 0) - (a.qs[key.hz][key.field] || 0))
    .slice(0, n);
  for (const hz of ['short', 'medium', 'long']) {
    for (const field of ['buyScore', 'sellScore']) {
      const key = { hz, field };
      // Global leaders (pure merit).
      topBy(rows, key, perSide).forEach(r => picked.add(r.sym));
      // Per-market leaders (geographic depth so each index can contribute).
      for (const mkt of markets) {
        topBy(rows.filter(r => r.market === mkt), key, perMarketSide).forEach(r => picked.add(r.sym));
      }
    }
  }
  const entries = [...picked].map(s => {
    const r = byS.get(s);
    const maxBuy = Math.max(r.qs.short.buyScore || 0, r.qs.medium.buyScore || 0, r.qs.long.buyScore || 0);
    const maxSell = Math.max(r.qs.short.sellScore || 0, r.qs.medium.sellScore || 0, r.qs.long.sellScore || 0);
    return { ticker: s, market: r.market, maxBuy, maxSell, score: Math.max(maxBuy, maxSell) };
  });
  // Round-robin interleave by market (each market's names sorted by score) so the
  // client's top-N cap keeps geographic diversity rather than just the US leaders.
  const buckets = new Map();
  for (const e of entries) {
    if (!buckets.has(e.market)) buckets.set(e.market, []);
    buckets.get(e.market).push(e);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => b.score - a.score);
  const ordered = [];
  let added = true;
  while (added) {
    added = false;
    for (const arr of buckets.values()) {
      if (arr.length) { ordered.push(arr.shift()); added = true; }
    }
  }
  return ordered;
}

/** Run the full-universe scan as a background job. Guards against concurrent runs. */
async function runUniverseScan(opts = {}) {
  if (universeScanState.running) return { alreadyRunning: true };
  const reason = opts.reason || 'manual';
  let universe;
  try {
    universe = await buildFullUniverse(fetch, fmpAnyApiKey());
  } catch (e) {
    console.warn('Universe build failed:', e.message);
    return { error: e.message };
  }
  if (!universe || !universe.length) return { error: 'empty universe' };

  universeScanState = { running: true, startedAt: Date.now(), total: universe.length, done: 0, ok: 0, lastError: null, lastFinishedAt: 0 };
  console.log(`Universe scan START (${reason}): ${universe.length} names`);

  const conc = Math.max(2, Math.min(8, Number.parseInt(String(process.env.UNIVERSE_SCAN_CONCURRENCY || '6'), 10) || 6));
  const marketOf = {};
  universe.forEach(u => { marketOf[u.t] = u.market; });
  const rows = [];

  (async () => {
    try {
      for (let off = 0; off < universe.length; off += conc) {
        const slice = universe.slice(off, off + conc);
        const settled = await Promise.allSettled(slice.map(u => scanSymbolQuant(u.t)));
        settled.forEach((s, ix) => {
          universeScanState.done++;
          if (s.status === 'fulfilled' && s.value) {
            s.value.market = marketOf[slice[ix].t] || 'US';
            rows.push(s.value);
            universeScanState.ok++;
          }
        });
        await new Promise(r => setTimeout(r, 120)); // gentle on data vendors
      }
      const shortlist = buildShortlistFromRows(rows);
      const byMarket = {};
      shortlist.forEach(s => { byMarket[s.market] = (byMarket[s.market] || 0) + 1; });
      universeShortlist = {
        version: UNIVERSE_SHORTLIST_VERSION,
        ts: Date.now(),
        reason,
        scannedTotal: universe.length,
        scannedOk: rows.length,
        count: shortlist.length,
        byMarket,
        shortlist
      };
      saveUniverseShortlistFile(universeShortlist);
      console.log(`Universe scan DONE: scored ${rows.length}/${universe.length}, shortlist ${shortlist.length} →`, JSON.stringify(byMarket));
      // Immediately regenerate the final picks server-side so clients read finished
      // picks without needing the page open.
      const picksResult = await generateServerPicksFromShortlist().catch(e => {
        console.warn('post-scan picks:', e.message);
        return { ok: false, error: e.message };
      });
      if (picksResult && picksResult.ok) _lastPicksDateKey = singaporeDateKey();
    } catch (e) {
      universeScanState.lastError = e.message;
      console.warn('Universe scan error:', e.message);
    } finally {
      universeScanState.running = false;
      universeScanState.lastFinishedAt = Date.now();
    }
  })();

  return { started: true, total: universe.length };
}

function universeShortlistTickers() {
  return universeShortlist && Array.isArray(universeShortlist.shortlist)
    ? universeShortlist.shortlist.map(s => s.ticker).filter(Boolean)
    : [];
}

// Same rating/action thresholds the client uses (reconcileActionsRatings) so the
// server-generated picks are labelled identically to the in-browser scan.
function dashRateBuy(sc) { return sc >= 78 ? 'Strong Buy' : sc >= 62 ? 'Buy' : 'Hold'; }
function dashRateSell(sc) { return sc >= 74 ? 'Strong Sell' : sc >= 62 ? 'Sell' : 'Hold'; }
function dashActionRating(buy, sell) {
  const action = buy > sell ? (buy >= 62 ? 'Buy' : 'Hold') : (sell >= 62 ? 'Sell' : 'Hold');
  const rating = buy >= sell ? dashRateBuy(buy) : dashRateSell(sell);
  return { action, rating };
}

/**
 * Generate the final top-5-per-pane picks ENTIRELY on the server (no browser, no
 * Claude) from the universe shortlist: full technicals + tier overlays + structural
 * caps + SL-cooldown, then server-side TP/SL pricing. Writes the picks cache so any
 * device just reads finished picks — the page never needs to stay open.
 */
// Convert the final server-generated picks into history trade records (one per
// ticker/horizon/side) so the autonomous scan records history WITHOUT needing any
// browser open. Mirrors the client's mkRecord shape closely enough for renderHist
// and the path-aware PnL refresh to work.
function serverPicksToHistoryRecords(dashData) {
  const ts = new Date().toISOString();
  const mk = (s, side, hz) => {
    const isSell = side === 'sell';
    const entry = parseFloat(s[hz + 'Entry'] || 0);
    const tp1 = parseFloat(s[hz + 'Target1'] || 0);
    const tp2 = parseFloat(s[hz + 'Target2'] || 0);
    const sl = parseFloat(s[hz + 'StopLoss'] || 0);
    if (!entry || !sl) return null;
    const rating = s[hz + 'Rating'] || (isSell ? 'Sell' : 'Buy');
    return {
      _v: 2,
      ticker: s.ticker, name: s.name || s.ticker, sector: s.sector || '', market: s.market || '',
      hz,
      action: isSell ? 'Sell' : 'Buy',
      rating, conf: s[hz + 'Conf'] || 0,
      entryDate: ts, timestamp: ts,
      entryPending: s.entryPending === true,
      entryFinalized: s.entryFinalized === true,
      entrySource: s.entrySource || null,
      entry, target1: tp1 || null, target2: tp2 || null, stopLoss: sl,
      [hz + 'Entry']: entry, [hz + 'Target1']: tp1 || null, [hz + 'Target2']: tp2 || null, [hz + 'StopLoss']: sl,
      [hz + 'TrailingSL']: true,
      sellEntry: entry, sellTarget1: isSell ? tp1 : null, sellTarget2: isSell ? tp2 : null, sellStopLoss: isSell ? sl : null,
      reason: isSell ? (s.sellReason || s.reason || '') : (s.reason || ''),
      shortScore: s.shortScore, mediumScore: s.mediumScore, longScore: s.longScore,
      shortSellScore: s.shortSellScore, mediumSellScore: s.mediumSellScore, longSellScore: s.longSellScore,
      [hz + 'Status']: 'open', [hz + 'PnlDollar']: null, [hz + 'PnlPct']: null,
      revalidatedAt: ts, analyticsVersion: 2,
      _fromServerScan: true
    };
  };
  const out = [];
  (dashData.short || []).forEach(s => out.push(mk(s, 'buy', 'short')));
  (dashData.medium || []).forEach(s => out.push(mk(s, 'buy', 'medium')));
  (dashData.long || []).forEach(s => out.push(mk(s, 'buy', 'long')));
  (dashData.shortSell || []).forEach(s => out.push(mk(s, 'sell', 'short')));
  (dashData.medSell || []).forEach(s => out.push(mk(s, 'sell', 'medium')));
  (dashData.longSell || []).forEach(s => out.push(mk(s, 'sell', 'long')));
  return out.filter(Boolean);
}

let serverPicksGenerating = false;
async function generateServerPicksFromShortlist(opts = {}) {
  if (serverPicksGenerating) return { ok: false, reason: 'already generating' };
  const list = universeShortlist && Array.isArray(universeShortlist.shortlist) ? universeShortlist.shortlist : [];
  if (!list.length) return { ok: false, reason: 'no shortlist' };
  serverPicksGenerating = true;
  try {
    await refreshMarketRegime().catch(() => {}); // ensure signals below are tide-gated
    await refreshSectorRegimes().catch(() => {}); // sector-level tide per name
    await refreshEarningsTides().catch(() => {}); // peer quarterly-results tide per group
    const marketOf = {};
    list.forEach(x => { marketOf[x.ticker] = x.market; });
    const tickers = list.map(x => x.ticker).slice(0, 120);
    const techMap = await getTechnicalsMapForSymbols(tickers, { maxMs: opts.maxMs || 240000 });

    const rows = [];
    for (const t of tickers) {
      const tech = techMap[t];
      if (!tech || !tech.quantSignal) continue;
      const qs = tech.quantSignal;
      const fundEntry = fundCache.get(t);
      const fund = fundEntry && Date.now() - fundEntry.ts < TECH_TTL * 4 ? fundEntry.data : null;
      const row = {
        ticker: t,
        name: (fund && (fund.companyName || fund.name)) || t,
        market: UNIVERSE_MARKET_LABEL[marketOf[t]] || marketOf[t] || ''
      };
      for (const hz of ['short', 'medium', 'long']) {
        const sig = qs[hz] || {};
        const buy = sig.buyScore || 0;
        const sell = sig.sellScore || 0;
        const cooled = isSLCooldownActive(t, hz)
          || /SL cooldown/i.test(sig.tierLabel || '') || /SL cooldown/i.test(sig.rating || '');
        row[hz + 'Score'] = buy;
        row[hz + 'SellScore'] = sell;
        // sig.action / sig.rating are now canonical (set by applyTierScoreCaps from final score).
        // New picks only — writeOpenRowAction refuses Hold if this row were latched open.
        writeOpenRowAction(row, hz, cooled ? 'Hold' : (sig.action || 'Hold'));
        row[hz + 'Rating'] = cooled ? 'SL cooldown' : (sig.rating || 'Hold');
        row[hz + 'Conf'] = sig.winRateHint || Math.max(buy, sell);
        // Hard floor: never recommend when displayed confidence is below 62%.
        if (!cooled && (row[hz + 'Action'] === 'Buy' || row[hz + 'Action'] === 'Sell')
          && (Number(row[hz + 'Conf']) || 0) < PICKS_MIN_CONF) {
          writeOpenRowAction(row, hz, 'Hold');
          row[hz + 'Rating'] = 'Hold';
        }
        // Prefer Strong on the board (see assignment below). Do NOT demote plain
        // Buy/Sell to Hold here — that emptied every pane and forced clients to
        // rescan the universe on each refresh. History/IBKR still require Strong.
        const condTxt = (sig.conditions || []).slice(0, 4).join('; ');
        row[hz + 'Analysis'] = condTxt;
        row[hz + 'SellAnalysis'] = condTxt;
        if (hz === 'short') row.reason = condTxt;
        if (sell >= buy && sell >= 62) row.sellReason = condTxt;
      }
      row.action = row.shortAction;
      applyServerPriceLevels(row, tech.currentPrice, tech, fund);
      rows.push(row);
    }

    // Cross-timeframe dedup done BEFORE slicing: assign each ticker to its single
    // best horizon (highest score), then take the top 5 per pane from that
    // assignment. This guarantees a name appears in only one timeframe AND keeps
    // every pane as full as the universe allows (slicing-then-deduping left gaps).
    const HZS = ['short', 'medium', 'long'];
    const hasPx = (r, hz) => r[hz + 'Entry'] && r[hz + 'StopLoss'];
    const cooldown = priorBoardCooldownSet(opts);
    const prevSummary = dashboardPicksCache && dashboardPicksCache.dashData
      ? dashboardPicksSummary(dashboardPicksCache.dashData) : '';
    const priorTickers = [...collectDashTickers(dashboardPicksCache && dashboardPicksCache.dashData)];
    const prevDash = dashboardPicksCache && dashboardPicksCache.dashData
      ? JSON.parse(JSON.stringify(dashboardPicksCache.dashData)) : null;
    const prevCount = countDashPicks(prevDash);

    // Candidate pools: NEVER include names already open in the same direction.
    // Re-recommend only on direction change (Buy↔Sell) after the prior open exits /
    // regime flip closes it. Empty pane > repeating AIR / 9988 etc.
    const buyAssign = { short: [], medium: [], long: [] };
    const sellAssign = { short: [], medium: [], long: [] };

    for (const r of rows) {
      let bBuyHz = null, bBuyScore = -1;
      let bSellHz = null, bSellScore = -1;
      const alreadyLong  = hasOpenTradeInDirection(r.ticker, false);
      const alreadyShort = hasOpenTradeInDirection(r.ticker, true);
      for (const hz of HZS) {
        // Prefer Strong Buy/Sell (+1000 sort boost); allow plain Buy/Sell that
        // still meet Conf≥62 / score≥62 so the board is not empty when no Strong
        // names clear the bars (empty cache → client "rescans every refresh").
        const buyBase = bracketEnabled('buy', hz) && r[hz + 'Action'] === 'Buy'
          && (r[hz + 'Score'] || 0) >= 62
          && (Number(r[hz + 'Conf']) || 0) >= PICKS_MIN_CONF
          && !/SL cooldown/i.test(r[hz + 'Rating'] || '') && hasPx(r, hz);
        if (buyBase && !alreadyLong) {
          const buyRank = (r[hz + 'Score'] || 0)
            + (isStrongRecommendableRating(r[hz + 'Rating']) ? 1000 : 0);
          if (buyRank > bBuyScore) { bBuyScore = buyRank; bBuyHz = hz; }
        }
        const sellBase = bracketEnabled('sell', hz) && SELL_PICKS_ENABLED && r[hz + 'Action'] === 'Sell'
          && (r[hz + 'SellScore'] || 0) >= 62
          && (Number(r[hz + 'Conf']) || 0) >= PICKS_MIN_CONF
          && hasPx(r, hz);
        if (sellBase && !alreadyShort) {
          const sellRank = (r[hz + 'SellScore'] || 0)
            + (isStrongRecommendableRating(r[hz + 'Rating']) ? 1000 : 0);
          if (sellRank > bSellScore) { bSellScore = sellRank; bSellHz = hz; }
        }
      }
      // One direction per ticker on the board; prefer the stronger side.
      if (bBuyHz && bSellHz) {
        if (bBuyScore >= bSellScore) bSellHz = null;
        else bBuyHz = null;
      }
      if (bBuyHz) buyAssign[bBuyHz].push(r);
      else if (bSellHz) sellAssign[bSellHz].push(r);
    }

    function pane(primary, key) {
      return topNRotating(primary, key, cooldown, 5);
    }

    let dashData = {
      short: pane(buyAssign.short, 'shortScore'),
      medium: pane(buyAssign.medium, 'mediumScore'),
      long: pane(buyAssign.long, 'longScore'),
      shortSell: pane(sellAssign.short, 'shortSellScore'),
      medSell: pane(sellAssign.medium, 'mediumSellScore'),
      longSell: pane(sellAssign.long, 'longSellScore')
    };

    // Re-price the FINAL picks with LIVE quotes so the recorded entry (and the
    // dashboard card) reflect the real tradeable price, not the last daily close
    // — which lags intraday / pre-market and was making entries show yesterday's
    // close (and history PnL hover near 0).
    try {
      const pickRows = [...dashData.short, ...dashData.medium, ...dashData.long,
                        ...dashData.shortSell, ...dashData.medSell, ...dashData.longSell];
      const pickTickers = [...new Set(pickRows.map(r => r.ticker))];
      if (pickTickers.length) {
        const liveQuotes = await fetchQuotesV7Bulk(pickTickers);
        for (const r of pickRows) {
          const q = liveQuotes[r.ticker];
          // ENTRY SEMANTICS (fix for "random" entry prices):
          //  • Market in REGULAR session → the live price IS the best executable
          //    fill right now. (Using q.open mid-session was hindsight — and worse,
          //    when a market hadn't opened yet Yahoo's regularMarketOpen is the
          //    PREVIOUS session's open, so pre-market picks recorded stale prices.)
          //  • Market PRE/POST/CLOSED → the real fill happens at the NEXT session's
          //    open, which is unknowable now. Record the live/prev-close price as a
          //    PROVISIONAL entry and flag entryPending — the history PnL refresh
          //    finalises it to the actual session open once that bar exists.
          const _inSession = q?.marketState === 'REGULAR';
          const px = _inSession
            ? (q?.price && q.price > 0 ? q.price : null)
            : ((q?.price && q.price > 0) ? q.price : (q?.prevClose > 0 ? q.prevClose : null));
          if (px && px > 0) {
            r.entryPending = !_inSession; // finalise to next session's open later
            r.entryFinalized = _inSession; // live in-session fill IS the entry — lock it
            r.entrySource = _inSession ? 'live @ generation' : 'pending next session open';
            // Sector trend on the PICK itself (buy & sell, every horizon) —
            // entering WITH the sector's tide is part of the entry decision.
            try {
              const _rSec = r._fmpSector || r.sector || (r.fundSnapshot && r.fundSnapshot._fmpSector) || null;
              if (_rSec) { const _rst = await sectorTrendLabel(_rSec); if (_rst) r.sectorTrend = _rst; }
            } catch (_) { /* best-effort */ }
            const tech = techMap[r.ticker];
            const fEntry = fundCache.get(r.ticker);
            const fnd = fEntry && Date.now() - fEntry.ts < TECH_TTL * 4 ? fEntry.data : null;
            applyServerPriceLevels(r, px, tech, fnd);
          }
        }
      }
    } catch (e) { console.warn('Live re-pricing of picks failed:', e.message); }

    // Drop any pane row whose ATR/structure levels fail the minimum R:R gate.
    // Never invent TP to pass — undersized reward setups are simply not recommended.
    dashData = filterDashDataByMinRR(dashData);

    // EARNINGS BLACKOUT: never open a brand-new position within 5 days of the
    // company's own quarterly report — a binary gap event no stop can protect
    // against (this was a repeat SL-hit pattern in the trade history).
    if (EARNINGS_OVERLAY_ENABLED) {
      try {
        for (const pane of ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell']) {
          const arr = dashData[pane];
          if (!Array.isArray(arr) || !arr.length) continue;
          const keep = [];
          for (const row of arr) {
            const imminent = await nextEarningsWithinDays(row.ticker, 5).catch(() => false);
            if (imminent) console.log('Pick dropped (earnings within 5d):', row.ticker, pane);
            else keep.push(row);
          }
          dashData[pane] = keep;
        }
      } catch (e) { console.warn('Earnings blackout filter failed:', e.message); }
    }

    // Stamp each pane pick with a trade-specific reason that includes Entry/TP/SL.
    // Generic/empty reason fields were leaving recommended CSV Reason blanks.
    stampDashDataReasons(dashData);

    // Open History buys/sells are excluded from candidate pools (no re-recommend),
    // but they must still appear on the board — otherwise a deploy wipe leaves
    // empty panes while IR/DLR/RCL remain live opens.
    dashData = mergeLiveOpenHistoryIntoDashData(dashData).dashData;

    // Never clobber a good board with an empty/sparse one (open-trade + rotation
    // race, or a thin shortlist after deploy). A single surviving name used to
    // overwrite a full short/medium board and blank the dashboard.
    const newCount = countDashPicks(dashData);
    const sparseCollapse = prevCount >= 3 && newCount < Math.min(3, Math.ceil(prevCount * 0.4));
    if ((newCount === 0 && prevCount > 0) || sparseCollapse) {
      console.warn(
        'Server picks regen too thin (', newCount, 'vs prior', prevCount,
        ') — keeping previous board'
      );
      return {
        ok: true,
        keptPrevious: true,
        summary: prevSummary,
        prevSummary,
        dashTs: dashboardPicksCache && dashboardPicksCache.dashTs,
        cooldownSize: cooldown.size
      };
    }

    dashboardPicksCache = {
      version: DASHBOARD_PICKS_VERSION,
      schemaVersion: 1,
      dashTs: Date.now(),
      dashData: sanitizeDashDataForServer(dashData),
      // Next regen skips these names for PICKS_ROTATION_HOURS so the board rotates.
      priorPickTickers: priorTickers,
      priorPickTs: Date.now(),
      prevSummary: prevSummary || ''
    };
    saveDashboardPicksFile(dashboardPicksCache);
    const summary = dashboardPicksSummary(dashData);
    const rotatedOff = [...cooldown].filter(t => ![...collectDashTickers(dashData)].includes(t));
    console.log('Server picks generated →', summary,
      cooldown.size ? `(rotated off ${rotatedOff.slice(0, 12).join(',') || (cooldown.size + ' prior')})` : '');

    // Record the picks into history autonomously (no browser needed). The shared
    // writer dedups per ticker/hz/day, so re-running the daily scan just refreshes
    // today's rows rather than duplicating them.
    try {
      const recs = serverPicksToHistoryRecords(dashData);
      if (recs.length) {
        const h = await addTradesToHistory(recs);
        console.log('Server scan recorded history:', h.accepted, 'added,', h.skipped, 'skipped, total', h.total);
      }
    } catch (e) {
      console.warn('Server history record failed:', e.message);
    }
    return {
      ok: true,
      summary,
      prevSummary: prevSummary || '',
      rotatedOff: rotatedOff.slice(0, 40),
      cooldownSize: cooldown.size,
      dashTs: dashboardPicksCache.dashTs
    };
  } catch (e) {
    console.warn('generateServerPicksFromShortlist error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    serverPicksGenerating = false;
  }
}

app.get('/api/dashboard/universe', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const tickers = universeShortlistTickers();
  const fresh = universeShortlist && (Date.now() - universeShortlist.ts) < UNIVERSE_SHORTLIST_TTL_MS;
  // Kick off a refresh if missing/stale and not already running (non-blocking).
  if ((!universeShortlist || !fresh) && !universeScanState.running) {
    runUniverseScan({ reason: 'auto-stale' });
  }
  res.json({
    ok: true,
    ts: universeShortlist ? universeShortlist.ts : null,
    fresh: !!fresh,
    count: tickers.length,
    scannedOk: universeShortlist ? universeShortlist.scannedOk : 0,
    scannedTotal: universeShortlist ? universeShortlist.scannedTotal : 0,
    byMarket: universeShortlist ? universeShortlist.byMarket : {},
    tickers,
    shortlist: universeShortlist ? universeShortlist.shortlist : [],
    scan: { running: universeScanState.running, done: universeScanState.done, total: universeScanState.total }
  });
});

app.post('/api/dashboard/universe/scan', (req, res) => {
  const r = runUniverseScan({ reason: 'manual' });
  Promise.resolve(r).then(out => res.json({ ok: true, ...out, scan: universeScanState }))
    .catch(e => res.status(500).json({ ok: false, error: e.message }));
});

app.get('/api/dashboard/universe/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    running: universeScanState.running,
    done: universeScanState.done,
    total: universeScanState.total,
    ok: universeScanState.ok,
    lastError: universeScanState.lastError,
    lastFinishedAt: universeScanState.lastFinishedAt,
    shortlistTs: universeShortlist ? universeShortlist.ts : null,
    shortlistCount: universeShortlistTickers().length,
    // Per-market breakdown — lets you SEE whether the scan produced international
    // names. If this shows only {US: N} or international counts are 0, the scan
    // is failing to fetch non-US OHLCV (not a downstream display bug).
    shortlistByMarket: universeShortlist ? (universeShortlist.byMarket || {}) : {},
    scannedTotal: universeShortlist ? universeShortlist.scannedTotal : null,
    scannedOk: universeShortlist ? universeShortlist.scannedOk : null
  });
});

// ── Health (after tradeHistory — used in payload) ────────────────────────────
app.get('/api/history/status', (req, res) => {
  const today = singaporeToDateString();
  const todayCnt = tradeHistory.filter(h => historyTradeEntryDay(h) === today).length;
  const byHz = {};
  tradeHistory.forEach(h => { const hz=h.hz||'none'; byHz[hz]=(byHz[hz]||0)+1; });
  res.json({total:tradeHistory.length, todayCount:todayCnt, byHz, file:HISTORY_FILE});
});

/** Per-vendor probe for intl symbol debugging (safe JSON — no API keys). */
app.get('/api/debug/vendors/:symbol', async (req, res) => {
  const sym = String(req.params.symbol || '')
    .trim()
    .toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  res.setHeader('Cache-Control', 'no-store');
  const fk = fmpAnyApiKey();
  try {
    const livePxDbg = await fetchSinglePrice(sym).catch(() => null);
    const [fmpFund, fmpQuote, fmpScores, finnhub, fhFin, fhProf, av, avSearch, yahoo, yahooV7, yahooV8, fmpIncome, merged, fmpScore, fmpExch, fmpEarnStable, avEarnHist] =
      await Promise.all([
        fk ? fetchFundamentalsFMP(sym).catch(() => null) : null,
        fk ? fetchFundamentalsFromFmpQuote(sym).catch(() => null) : null,
        fk ? fetchFmpStableFinancialScores(sym, fk, 12000).catch(() => null) : null,
        fetchFundamentalsFinnhub(sym).catch(() => null),
        fetchFinnhubFinancialsFundamentals(sym).catch(() => null),
        fetchFinnhubProfileFundamentals(sym).catch(() => null),
        fetchFundamentalsAlphaVantage(sym).catch(() => null),
        alphaVantageApiKey() ? alphaVantageSearchSymbolVariants(sym).catch(() => []) : [],
        fetchFundamentalsYahoo(sym).catch(() => null),
        fetchFundamentalsFromYahooV7Quote(sym).catch(() => null),
        fetchFundamentalsFromYahooV8Chart(sym).catch(() => null),
        fk && livePxDbg?.price
          ? fetchFmpIncomeDerivedFundamentals(sym, livePxDbg.price).catch(() => null)
          : null,
        fetchFundamentals(sym).catch(() => null),
        fk ? fetchFmpScore(sym).catch(() => null) : null,
        fk ? fmpExchangeSymbolVariants(sym, fk).catch(() => []) : [],
        fk ? fmpStableEarningsBundle(sym).catch(() => null) : null,
        alphaVantageApiKey() ? alphaVantageEarningsHistory(sym).catch(() => []) : []
      ]);
    res.json({
      build: '20260605-fmp-ultimate-v7.2.4',
      symbol: sym,
      is_intl_symbol: isIntlEquitySymbol(sym),
      fmp_plan: fmpPlanTier(),
      fmp_global_coverage: fmpGlobalCoverageEnabled(),
      live_price: livePxDbg?.price ?? null,
      fmp_exchange_variants: fmpExch,
      alpha_vantage_search: avSearch,
      fmp_fundamentals: fmpFund,
      fmp_quote: fmpQuote,
      fmp_income_derived: fmpIncome,
      fmp_scores: fmpScores,
      finnhub_metric: finnhub,
      finnhub_financials: fhFin,
      finnhub_profile: fhProf,
      alpha_vantage: av,
      yahoo: yahoo,
      yahoo_v7: yahooV7,
      yahoo_v8: yahooV8,
      merged,
      fmp_quality: fmpScore,
      fmp_stable_earnings: fmpEarnStable,
      alpha_vantage_earnings: avEarnHist,
      earnings_cross_list: earningsCrossListVariants(sym),
      merge_policy: 'FMP+Finnhub+AV+Yahoo primary; Bloomberg gap-fill only'
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'debug failed', build: '20260605-fmp-ultimate-v7.2' });
  }
});

app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (fmpGlobalCoverageEnabled() && fmpEnvKeyFund()) {
      const forceProbe = String(req.query?.probe || '') === '1';
      const probeAge = fmpGlobalCoverageProbe.ts ? Date.now() - fmpGlobalCoverageProbe.ts : Infinity;
      if (forceProbe) {
        await probeFmpGlobalCoverage(true).catch(() => null);
      } else if (!fmpGlobalCoverageProbe.ts || probeAge > 6 * 60 * 60 * 1000) {
        probeFmpGlobalCoverage(false).catch(() => null);
      }
    }
    const ak = anthropicApiKey();
    res.json({
    status: 'ok',
    server_build: '20260624-fmp-ultimate-v7.9.5',
    uptime_s: Math.round(process.uptime()),
    rss_mb: Math.round((process.memoryUsage().rss || 0) / 1048576),
    quotes: 'yahoo_finance',
    earnings: {
      finnhub_calendar: !!(process.env.FINNHUB_API_KEY || '').trim(),
      /** Uses same normalization as live FMP fetches (BOM/zero-width trimmed). */
      fmp_calendar: Boolean(fmpAnyApiKey()),
      yahoo_fallback: true
    },
    fmp: (() => {
      const fk = fmpAnyApiKey();
      return {
        key_resolved: Boolean(fk),
        key_chars: fk ? fk.length : 0,
        key_suffix_masked: fk && fk.length >= 4 ? `****${fk.slice(-4)}` : fk ? '(short)' : null,
        plan: fmpPlanTier(),
        global_coverage: fmpGlobalCoverageEnabled(),
        env_plan_var: 'FMP_PLAN (ultimate|starter, default ultimate)',
        global_probe: fmpGlobalCoverageProbe
      };
    })(),
    alpha_vantage: (() => {
      const ak = alphaVantageApiKey();
      return {
        key_resolved: Boolean(ak),
        key_chars: ak ? ak.length : 0,
        key_suffix_masked: ak && ak.length >= 4 ? `****${ak.slice(-4)}` : ak ? '(short)' : null,
        env_names: ['ALPHA_VANTAGE_API_KEY', 'ALPHAVANTAGE_API_KEY', 'ALPHA_VANTAGE_KEY'],
        used_for: 'intl fundamentals gap-fill (OVERVIEW) + earnings history/calendar for .NS/.HK/.T etc.'
      };
    })(),
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
      HK9988: toBloombergEquity('9988.HK'),
      RELIANCE_NS: toBloombergEquity('RELIANCE.NS'),
      ICICIBANK_NS: toBloombergEquity('ICICIBANK.NS')
    },
    danelfin_configured: !!(process.env.DANELFIN_API_KEY || '').trim(),
    /** True only when server env has a non-empty key after trim/BOM cleanup (browser paste does not set this). */
    hasKey: Boolean(ak),
    anthropic: {
      key_resolved: Boolean(ak),
      key_chars: ak ? ak.length : 0,
      key_suffix_masked: ak && ak.length >= 8 ? `****${ak.slice(-4)}` : ak ? '(too_short)' : null,
      hint:
        'Set ANTHROPIC_API_KEY on the Render Web Service that runs Node (same service as this URL), Save, then clear build cache redeploy / restart if the UI still shows no key.'
    },
    bloomberg_bridge_build_expected: BLOOMBERG_BRIDGE_BUILD_EXPECTED,
    bloomberg_bridge_configured: Boolean(bloombergBridgeUrl()),
    bloomberg_bridge_secret_configured_on_server: Boolean((process.env.BLOOMBERG_BRIDGE_SECRET || '').trim()),
    bloomberg_bridge_lan_unreachable_from_cloud:
      bloombergBridgeUrlIsUnreachableFromInternet(),
    bloomberg_bridge_hint:
      bloombergBridgeUrl() && bloombergBridgeUrlIsUnreachableFromInternet()
        ? 'Bridge URL is loopback/LAN-only; hosts like Render cannot reach it — use HTTPS tunnel URL or deploy API on same LAN.'
        : '',
    bloomberg_bridge_manual_test_hint:
      '401 on /snapshot or /earnings via browser: Bloomberg bridge expects HTTP header Authorization: Bearer <BLOOMBERG_BRIDGE_SECRET> when that env var is set on the Terminal PC. Use curl/Postman, or temporarily unset secret for local debugging. AlphaSignal sends this header automatically when Render BLOOMBERG_BRIDGE_SECRET matches.',
    /** false until a real request pulls /snapshot via the bridge — opening /api/health alone does not call Bloomberg. */
    bloomberg_bridge_snapshot_tried_since_boot: Boolean(lastBloombergSnapshotProbe.ts > 0),
    /** false until a real request pulls /earnings via the bridge. */
    bloomberg_bridge_earnings_tried_since_boot: Boolean(lastBloombergEarningsProbe.ts > 0),
    bloomberg_bridge_last_snapshot: lastBloombergSnapshotProbe.ts
      ? {
          ms_ago: Date.now() - lastBloombergSnapshotProbe.ts,
          symbol: lastBloombergSnapshotProbe.symbol,
          ok: lastBloombergSnapshotProbe.ok,
          httpStatus: lastBloombergSnapshotProbe.httpStatus,
          numericFieldsSeen: lastBloombergSnapshotProbe.numericFieldsSeen,
          bbSecurity: lastBloombergSnapshotProbe.bbSecurity,
          bridgeBuild: lastBloombergSnapshotProbe.bridgeBuild,
          elapsedMs: lastBloombergSnapshotProbe.elapsedMs,
          error: lastBloombergSnapshotProbe.err
        }
      : null,
    bloomberg_bridge_last_earnings: lastBloombergEarningsProbe.ts
      ? {
          ms_ago: Date.now() - lastBloombergEarningsProbe.ts,
          symbol: lastBloombergEarningsProbe.symbol,
          ok: lastBloombergEarningsProbe.ok,
          httpStatus: lastBloombergEarningsProbe.httpStatus,
          bbSecurity: lastBloombergEarningsProbe.bbSecurity,
          bridgeBuild: lastBloombergEarningsProbe.bridgeBuild,
          nextDateSeen: lastBloombergEarningsProbe.nextDateSeen,
          elapsedMs: lastBloombergEarningsProbe.elapsedMs,
          error: lastBloombergEarningsProbe.err
        }
      : null,
    bloomberg_enterprise_configured: Boolean(bloombergEnterpriseBase()),
    /** Documents that Desktop API bridge data is not overwritten by vendors for the same field — for ops review. */
    bloomberg_desktop_bridge_merge_policy:
      'fetchFundamentals loads FMP Ultimate stable endpoints first for global .NS/.HK/.T; then Finnhub + Alpha Vantage + Yahoo; Bloomberg Desktop bridge gap-fill only. Piotroski/Altman from FMP /stable/financial-scores only.',
    ts: Date.now(),
    historyVersion: HISTORY_VERSION,
    historyCount: tradeHistory.length,
    dashboard_picks: (() => {
      const d = loadDashboardPicksFile() || dashboardPicksCache;
      const ageH = d?.dashTs ? +((Date.now() - Number(d.dashTs)) / 3600000).toFixed(2) : null;
      return {
        file: DASHBOARD_PICKS_FILE,
        dashTs: d?.dashTs || null,
        filteredAt: d?.filteredAt || null,
        picksAgeHours: ageH,
        sgtDay: typeof singaporeDateKey === 'function' ? singaporeDateKey() : null,
        lastPicksDateKey: typeof _lastPicksDateKey !== 'undefined' ? _lastPicksDateKey : null,
        refreshHourSgt: typeof PICKS_REFRESH_HOUR_SGT !== 'undefined' ? PICKS_REFRESH_HOUR_SGT : 6,
        summary: d?.dashData ? dashboardPicksSummary(d.dashData) : ''
      };
    })()
  });
  } catch (healthErr) {
    console.error('/api/health failed:', healthErr.message);
    res.status(500).json({ status: 'error', message: healthErr.message || String(healthErr) });
  }
});

// GET all history
app.get('/api/history', (req, res) => {
  let migrated = false;
  for (const h of tradeHistory) {
    if (isHistoryBuySellRecord(h) && !h.revalidatedAt) {
      h.revalidatedAt = h.entryDate || h.timestamp || new Date().toISOString();
      h.legacyRecord = true;
      migrated = true;
    }
  }
  if (migrated) saveHistoryFile(tradeHistory);
  res.json(tradeHistory);
});

/** GET /api/history/exit-quality — closed-trade TP1/TP2/TSL/donation summary for model review. */
app.get('/api/history/exit-quality', (req, res) => {
  const FULL = ['tp1_hit', 'tp2_hit', 'sl_hit', 'time_limit', 'signal_exit', 'tp1_then_sl', 'tp1_then_time'];
  const closed = [];
  const byStatus = {};
  let tp1 = 0, tp2 = 0, tsl = 0, donSum = 0, donN = 0, beyond1 = 0, beyond1N = 0, beyond2 = 0, beyond2N = 0;
  let win = 0, pnlSum = 0, avgWin = 0, avgLoss = 0, wN = 0, lN = 0;
  for (const h of tradeHistory) {
    if (!isHistoryBuySellRecord(h)) continue;
    const hz = h.hz || 'short';
    const st = h[hz + 'Status'] || h.status || 'open';
    if (!FULL.includes(st)) continue;
    const isSell = String(h.action || '').toLowerCase() === 'sell';
    const pnl = h[hz + 'PnlDollar'];
    const pn = (pnl != null && Number.isFinite(+pnl)) ? +pnl : null;
    const hit1 = !!(h[hz + 'Tp1Hit'] || String(st).indexOf('tp1') === 0 || st === 'tp2_hit');
    const hit2 = !!h[hz + 'Tp2Hit'];
    const usedTsl = !!(h[hz + 'TslActivated'] || st === 'tp1_then_sl' || st === 'tp1_then_time');
    const don = h[hz + 'DonationPct'];
    const d1 = h[hz + 'Tp1DonationPct'];
    const d2 = h[hz + 'Tp2DonationPct'];
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (hit1) tp1++;
    if (hit2) tp2++;
    if (usedTsl) tsl++;
    if (don != null && Number.isFinite(+don)) { donSum += +don; donN++; }
    if (d1 != null && Number.isFinite(+d1) && +d1 > 0) { beyond1 += +d1; beyond1N++; }
    if (d2 != null && Number.isFinite(+d2) && +d2 > 0) { beyond2 += +d2; beyond2N++; }
    if (pn != null) {
      pnlSum += pn;
      if (pn >= 0) { win++; avgWin += pn; wN++; } else { avgLoss += Math.abs(pn); lN++; }
    }
    closed.push({
      ticker: h.ticker,
      hz,
      action: isSell ? 'Sell' : 'Buy',
      status: st,
      exitReason: h[hz + 'ExitReason'] || '',
      entry: h[hz + 'Entry'] || h.entry,
      tp1: h[hz + 'Target1'] || h.target1,
      tp2: h[hz + 'Target2'] || h.target2,
      sl: h[hz + 'StopLoss'] || h.stopLoss,
      exit: h[hz + 'ExitPrice'],
      sharesTotal: h[hz + 'SharesTotal'],
      sharesSoldTP1: h[hz + 'SharesSoldTP1'],
      sharesRunner: h[hz + 'SharesRunner'],
      tp1Hit: hit1,
      tp2Hit: hit2,
      tslActivated: usedTsl,
      donationPct: don != null ? +don : null,
      donationDollar: don != null && Number.isFinite(+don) ? +((+don / 100) * 10000).toFixed(2) : null,
      beyondTp1Pct: d1 != null ? +d1 : null,
      beyondTp2Pct: d2 != null ? +d2 : null,
      tp2AltPnlPct: h[hz + 'Tp2AltPnlPct'] != null ? +h[hz + 'Tp2AltPnlPct'] : null,
      favExtreme: h[hz + 'FavExtreme'] || null,
      sectorTrend: h[hz + 'SectorTrend'] || h.sector || null,
      pnlDollar: pn,
      pnlPct: h[hz + 'PnlPct'] != null ? +h[hz + 'PnlPct'] : null,
      entryDate: h.entryDate || h.timestamp,
      exitTs: h[hz + 'ExitTs'] || null
    });
  }
  const n = closed.length;
  res.json({
    closed: n,
    byStatus,
    tp1HitRate: n ? +(tp1 / n * 100).toFixed(1) : null,
    tp2HitRate: n ? +(tp2 / n * 100).toFixed(1) : null,
    tslRate: n ? +(tsl / n * 100).toFixed(1) : null,
    avgDonationPct: donN ? +(donSum / donN).toFixed(2) : null,
    avgBeyondTp1Pct: beyond1N ? +(beyond1 / beyond1N).toFixed(2) : null,
    avgBeyondTp2Pct: beyond2N ? +(beyond2 / beyond2N).toFixed(2) : null,
    winRate: n ? Math.round(win / n * 100) : null,
    realisedPnl: +pnlSum.toFixed(2),
    avgWin: wN ? +(avgWin / wN).toFixed(2) : null,
    avgLoss: lN ? +(avgLoss / lN).toFixed(2) : null,
    trades: closed
  });
});

// Shared writer for both the client (/api/history/add) and the autonomous
// server scan. Dedups by ticker|hz|day, enriches, caps, and persists.
async function addTradesToHistory(trades) {
  if (!Array.isArray(trades) || !trades.length) {
    return { accepted: 0, skipped: 0, total: tradeHistory.length };
  }
  // Boundary guard: browsers can re-upload PRE-fold-in localStorage rows after a
  // deploy — sanitize extinct full-TP1/TP2 statuses on ingest so they can never
  // re-enter as closed rows (they reopen and the sim re-decides them).
  const foldedIn = normalizeExtinctStatuses(trades, 'ingest');
  if (foldedIn) console.log('History ingest: folded', foldedIn, 'stale full-TP1/TP2 rows into partial+TSL');
  // One trading-day definition (SGT) for history keys + IBKR event keys.
  const todayStr = singaporeToDateString();
  const keyOf = (t) => {
    const hz = t.hz || 'short';
    const day = historyTradeEntryDay(t) || singaporeToDateString();
    return `${t.ticker}|${hz}|${day}`;
  };
  // Snapshot existing rows by key BEFORE we drop them, so a re-recorded pick keeps
  // its ORIGINAL entry/date/levels/outcome instead of being reset to today's live
  // price on every scan (that reset made entry==live and PnL hover at 0).
  const existingByKey = new Map();
  for (const h of tradeHistory) existingByKey.set(keyOf(h), h);

  const incomingKeys = new Set(trades.map(keyOf));
  tradeHistory = tradeHistory.filter(h => !incomingKeys.has(keyOf(h)));

  const caches = {};
  const accepted = [];
  for (const trade of trades) {
   try {
    const hz = trade.hz || 'short';
    const isSell = String(trade.action || '').toLowerCase() === 'sell';
    // Look up any prior record for this ticker/hz/day up front — the RR gate and
    // the freeze/settled logic below both need it (referencing it before this
    // line threw "Cannot access 'prev' before initialization" on every fresh pick,
    // silently blocking all new recommendations from being recorded).
    const prev = existingByKey.get(keyOf(trade));
    // Only gate FRESH (today's) buy picks on SL cooldown. Historical re-uploads
    // (older entryDate, e.g. localStorage recovery after a deploy) must always be
    // preserved so durable history is never silently dropped.
    const isToday = historyTradeEntryDay(trade) === todayStr;
    if (!isSell && isToday && isSLCooldownActive(trade.ticker, hz)) {
      console.log('History add skipped (SL cooldown):', trade.ticker, hz);
      continue;
    }
    // New recommendations must clear the min R:R gate — never record a pick that
    // risks more than it can make at TP1 (imported CSV / settled recovery exempt).
    if (!prev && isToday && !trade._fromRecommendedCsv && !trade.legacyRecord) {
      const e = parseFloat(trade[hz + 'Entry'] || trade.entry);
      const tp1 = parseFloat(trade[hz + 'Target1'] || trade.target1);
      const sl = parseFloat(trade[hz + 'StopLoss'] || trade.stopLoss);
      if (!levelsMeetMinRR(e, tp1, sl, isSell, PICKS_MIN_RR)) {
        const rr = rewardRiskRatio(e, tp1, sl, isSell);
        console.log('History add skipped (RR <', PICKS_MIN_RR + '):', trade.ticker, hz, 'RR=', rr != null ? rr.toFixed(2) : 'n/a');
        auditLog('entry_blocked_min_rr', { ticker: trade.ticker, hz, rr });
        continue;
      }
      const rating = trade[hz + 'Rating'] || trade.rating || '';
      if (!isStrongRecommendableRating(rating)) {
        console.log('History add skipped (not Strong Buy/Sell):', trade.ticker, hz, 'rating=', rating);
        auditLog('entry_blocked_not_strong', { ticker: trade.ticker, hz, rating });
        continue;
      }
      // No-repeat: same name already open in this direction — only direction/regime
      // change (prior open closed) may re-enter.
      if (hasOpenTradeInDirection(trade.ticker, isSell)) {
        console.log('History add skipped (already open same direction):', trade.ticker, hz, isSell ? 'Sell' : 'Buy');
        auditLog('entry_blocked_already_open', { ticker: trade.ticker, hz, side: isSell ? 'sell' : 'buy' });
        continue;
      }
      // Earnings blackout for brand-new entries: a quarterly report inside the
      // next 5 days is a binary gap no stop protects against.
      if (EARNINGS_OVERLAY_ENABLED && await nextEarningsWithinDays(trade.ticker, 5).catch(() => false)) {
        console.log('History add skipped (earnings within 5d):', trade.ticker, hz);
        auditLog('entry_blocked_earnings', { ticker: trade.ticker, hz });
        continue;
      }
    }
    if (!trade.revalidatedAt || !trade.fmpScore || !trade.fundSnapshot) {
      await enrichHistoryTradeRecord(trade, caches).catch(() => null);
    } else if (!trade.revalidatedAt) {
      trade.revalidatedAt = new Date().toISOString();
      trade.analyticsVersion = 2;
    }

    // FREEZE: if this pick was already recorded earlier (same ticker/hz/day),
    // carry over the first-seen entry, entry date, frozen TP/SL levels and any
    // realised outcome. Entry is the price WHEN FIRST SIGNALLED — it must never
    // drift to the live price. (`prev` is resolved at the top of the loop.)
    // SETTLED ROWS ARE IMMUTABLE: once a trade fully exited, no re-upload (scan
    // re-record, localStorage recovery, stale browser copy) may replace it. The
    // server row is kept VERBATIM — field-merging stale uploads was how settled
    // trades kept getting clobbered, reopened and re-decided, which is what
    // moved already-reported months. This closes that path for good.
    const _SETTLED = ['tp1_then_sl', 'tp1_then_time', 'sl_hit', 'time_limit', 'signal_exit', 'tp1_hit', 'tp2_hit'];
    if (prev && _SETTLED.includes(prev[hz + 'Status'])) {
      accepted.push(prev);
      auditLog('ingest_keep_settled', { ticker: trade.ticker, hz, status: prev[hz + 'Status'] });
      continue;
    }
    // PORTFOLIO RISK-OFF: pause brand-new entries while drawdown ≥15% from peak.
    if (!prev && isToday && riskState.riskOff) {
      console.log('History add skipped (portfolio risk-off):', trade.ticker, hz);
      auditLog('entry_blocked_risk_off', { ticker: trade.ticker, hz });
      continue;
    }
    if (prev) {
      const origEntry = prev.entry != null ? prev.entry : prev[hz + 'Entry'];
      if (origEntry != null) { trade.entry = origEntry; trade[hz + 'Entry'] = origEntry; }
      trade.entryDate = prev.entryDate || trade.entryDate;
      trade.timestamp = prev.timestamp || trade.timestamp;
      for (const f of [
        'target1', 'target2', 'stopLoss', 'sellEntry', 'sellTarget1', 'sellTarget2', 'sellStopLoss',
        hz + 'Target1', hz + 'Target2', hz + 'StopLoss', hz + 'TrailingSL',
        hz + 'Status', hz + 'PnlDollar', hz + 'PnlPct', hz + 'ExitPrice', hz + 'ExitReason',
        hz + 'Tp1Hit', hz + 'ExitTs', hz + 'SettledTs', hz + 'CurrentPrice', 'status', 'pnlDollar', 'pnlPct', 'currentPrice',
        'entryPending', 'entryFinalized' // entry-finalisation state must survive re-records
      ]) {
        if (prev[f] !== undefined) trade[f] = prev[f];
      }
      // FREEZE / LATCH ACTION: open Buy/Sell, or a live emitted IBKR entry with
      // no exit, must not be rewritten to Hold by Conf demote / board refresh.
      const prevAct = String(prev[hz + 'Action'] || prev.action || '').toLowerCase();
      const prevStatus = String(prev[hz + 'Status'] || prev.status || 'open').toLowerCase();
      const stillOpen = !prevStatus || prevStatus === 'open' || prevStatus === 'tp1_open';
      const liveSide = ibkrLiveEntrySide(trade.ticker, hz, trade.entryDate || trade.timestamp || prev.entryDate);
      if (liveSide || (stillOpen && (prevAct === 'buy' || prevAct === 'sell'))) {
        const keep = liveSide === 'sell' ? 'Sell' : (liveSide === 'buy' ? 'Buy' : (prev[hz + 'Action'] || prev.action));
        trade.action = keep;
        trade[hz + 'Action'] = keep;
        if (prev[hz + 'Conf'] != null) trade[hz + 'Conf'] = prev[hz + 'Conf'];
        if (prev[hz + 'Score'] != null) trade[hz + 'Score'] = prev[hz + 'Score'];
        if (prev[hz + 'SellScore'] != null) trade[hz + 'SellScore'] = prev[hz + 'SellScore'];
        if (prev[hz + 'Rating'] != null) trade[hz + 'Rating'] = prev[hz + 'Rating'];
      }
    }
    accepted.push(trade);
    // IBKR feed: brand-new TODAY Buy/Sell with valid RR only.
    // Hold must never emit (tradeEventSnapshot used to default Hold→buy).
    // Re-importing old history must never re-emit 'entry'.
    if (!prev && isToday && shouldEmitIbkrEntry(trade, hz)) {
      try { emitTradeEvent('entry', tradeEventSnapshot(trade, hz)); } catch (_) {}
    }
   } catch (err) {
     // Never let one malformed pick abort the whole batch — a single uncaught
     // exception here (e.g. the old `prev` TDZ) once silently blocked ALL
     // recommendations from being recorded. Skip the bad row, keep the rest.
     console.warn('History add skipped (record error):', (trade && trade.ticker) || '?', '-', err && err.message);
     try { auditLog('entry_record_error', { ticker: trade && trade.ticker, hz: trade && trade.hz, error: err && err.message }); } catch (_) {}
     continue;
   }
  }

  tradeHistory.unshift(...accepted);

  // Cap total rows (multi-horizon scans add many per day; avoid unbounded growth)
  const HISTORY_MAX_SERVER = 3000;
  if (tradeHistory.length > HISTORY_MAX_SERVER) tradeHistory = tradeHistory.slice(0, HISTORY_MAX_SERVER);

  saveHistoryFile(tradeHistory);
  return { accepted: accepted.length, skipped: trades.length - accepted.length, total: tradeHistory.length };
}

/** Parse a CSV line respecting double-quoted fields (Reason often has commas). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseRecommendedCsvText(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  const iTf = idx('timeframe'), iSide = idx('side'), iTk = idx('ticker');
  const iName = idx('name'), iMkt = idx('market'), iRating = idx('rating');
  const iScore = idx('score'), iEntry = idx('entry');
  const iTp1 = idx('target 1'), iTp2 = idx('target 2'), iSl = idx('stop loss');
  const iReason = idx('reason');
  if (iTf < 0 || iSide < 0 || iTk < 0 || iEntry < 0) return [];
  const hzOf = (tf) => {
    const s = String(tf || '').toLowerCase();
    if (s.startsWith('long')) return 'long';
    if (s.startsWith('medium') || s.startsWith('med')) return 'medium';
    return 'short';
  };
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    const ticker = String(cols[iTk] || '').trim().toUpperCase();
    if (!ticker) continue;
    const side = String(cols[iSide] || '').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
    const hz = hzOf(cols[iTf]);
    const entry = parseFloat(cols[iEntry]);
    const tp1 = iTp1 >= 0 ? parseFloat(cols[iTp1]) : NaN;
    const tp2 = iTp2 >= 0 ? parseFloat(cols[iTp2]) : NaN;
    const sl = iSl >= 0 ? parseFloat(cols[iSl]) : NaN;
    if (!Number.isFinite(entry) || entry <= 0) continue;
    rows.push({
      ticker,
      name: (iName >= 0 ? cols[iName] : '') || ticker,
      market: iMkt >= 0 ? (cols[iMkt] || '') : '',
      hz,
      side,
      rating: iRating >= 0 ? (cols[iRating] || (side === 'sell' ? 'Sell' : 'Buy')) : (side === 'sell' ? 'Sell' : 'Buy'),
      score: iScore >= 0 ? parseFloat(cols[iScore]) : null,
      entry,
      tp1: Number.isFinite(tp1) ? tp1 : null,
      tp2: Number.isFinite(tp2) ? tp2 : null,
      sl: Number.isFinite(sl) ? sl : null,
      reason: iReason >= 0 ? (cols[iReason] || '') : ''
    });
  }
  return rows;
}

/** Guess entry day from filename like alphasignal-recommended-2026-07-15.csv */
function entryDateFromRecommendedFilename(name) {
  const m = String(name || '').match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  // Noon UTC ≈ evening SGT / morning US — stable calendar day in most TZs
  return `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`;
}

function recommendedRowsToHistoryRecords(rows, entryDateIso) {
  const ts = entryDateIso || new Date().toISOString();
  return (rows || []).map((r) => {
    if (!r || !r.ticker) return null;
    const hz = r.hz || 'short';
    const isSell = r.side === 'sell' || String(r.action || '').toLowerCase() === 'sell';
    const entry = Number(r.entry);
    if (!Number.isFinite(entry) || entry <= 0) return null;
    const tp1 = r.tp1 != null ? Number(r.tp1) : null;
    const tp2 = r.tp2 != null ? Number(r.tp2) : null;
    const sl = r.sl != null ? Number(r.sl) : null;
    const score = r.score != null && Number.isFinite(Number(r.score)) ? Number(r.score) : null;
    const rec = {
      _v: 2,
      ticker: String(r.ticker).toUpperCase(),
      name: r.name || r.ticker,
      market: r.market || '',
      sector: r.sector || '',
      hz,
      action: isSell ? 'Sell' : 'Buy',
      rating: r.rating || (isSell ? 'Sell' : 'Buy'),
      conf: score || 0,
      entryDate: ts,
      timestamp: ts,
      entry,
      target1: tp1,
      target2: tp2,
      stopLoss: sl,
      [hz + 'Entry']: entry,
      [hz + 'Target1']: tp1,
      [hz + 'Target2']: tp2,
      [hz + 'StopLoss']: sl,
      [hz + 'TrailingSL']: true,
      sellEntry: entry,
      sellTarget1: isSell ? tp1 : null,
      sellTarget2: isSell ? tp2 : null,
      sellStopLoss: isSell ? sl : null,
      reason: r.reason || '',
      shortScore: hz === 'short' && !isSell ? score : null,
      mediumScore: hz === 'medium' && !isSell ? score : null,
      longScore: hz === 'long' && !isSell ? score : null,
      shortSellScore: hz === 'short' && isSell ? score : null,
      mediumSellScore: hz === 'medium' && isSell ? score : null,
      longSellScore: hz === 'long' && isSell ? score : null,
      [hz + 'Status']: 'open',
      [hz + 'PnlDollar']: null,
      [hz + 'PnlPct']: null,
      revalidatedAt: ts,
      analyticsVersion: 2,
      _fromRecommendedCsv: true
    };
    return rec;
  }).filter(Boolean);
}

async function importRecommendedCsvText(csvText, opts = {}) {
  const rows = parseRecommendedCsvText(csvText);
  if (!rows.length) return { ok: false, error: 'no rows parsed', accepted: 0, skipped: 0, total: tradeHistory.length };
  const entryDate = opts.entryDate || null;
  const trades = recommendedRowsToHistoryRecords(rows, entryDate);
  const r = await addTradesToHistory(trades);
  auditLog('import_recommended_csv', {
    rows: rows.length,
    accepted: r.accepted,
    skipped: r.skipped,
    entryDate: entryDate || null,
    source: opts.source || 'api'
  });
  return { ok: true, parsed: rows.length, ...r };
}

/** Drop CSVs into data/pending_history_import/ — imported once on boot, then moved to imported/. */
async function importPendingRecommendedCsvs() {
  const pendingDir = path.join(DATA_DIR, 'pending_history_import');
  const doneDir = path.join(DATA_DIR, 'imported_history_csv');
  try { fs.mkdirSync(pendingDir, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(doneDir, { recursive: true }); } catch (_) {}
  let files = [];
  try { files = fs.readdirSync(pendingDir).filter(f => /\.csv$/i.test(f)); } catch (_) { return; }
  for (const file of files) {
    const src = path.join(pendingDir, file);
    try {
      const csv = fs.readFileSync(src, 'utf8');
      const entryDate = entryDateFromRecommendedFilename(file) || new Date().toISOString();
      const r = await importRecommendedCsvText(csv, { entryDate, source: 'pending:' + file });
      console.log('Pending CSV import', file, '→', r.accepted, 'added,', r.skipped, 'skipped');
      const dest = path.join(doneDir, file);
      try { fs.renameSync(src, dest); }
      catch (_) { try { fs.writeFileSync(dest, csv); fs.unlinkSync(src); } catch (__) {} }
    } catch (e) {
      console.warn('Pending CSV import failed for', file, e.message);
    }
  }
}

/**
 * Seed CSVs shipped with the repo (seed/recommended/). Re-imports a day only
 * when that calendar day is missing from history — recovers after ephemeral disk wipes.
 */
async function importSeedRecommendedCsvsIfMissing() {
  const seedDir = path.join(__dirname, 'seed', 'recommended');
  let files = [];
  try { files = fs.readdirSync(seedDir).filter(f => /\.csv$/i.test(f)); } catch (_) { return; }
  for (const file of files) {
    const entryDate = entryDateFromRecommendedFilename(file);
    if (!entryDate) continue;
    const dayStr = singaporeToDateString(Date.parse(entryDate) || Date.now());
    const have = tradeHistory.some(h => historyTradeEntryDay(h) === dayStr);
    if (have) {
      console.log('Seed CSV skip (day already in history):', file);
      continue;
    }
    try {
      const csv = fs.readFileSync(path.join(seedDir, file), 'utf8');
      const r = await importRecommendedCsvText(csv, { entryDate, source: 'seed:' + file });
      console.log('Seed CSV import', file, '→', r.accepted, 'added');
    } catch (e) {
      console.warn('Seed CSV import failed for', file, e.message);
    }
  }
}

// POST add trades (called when dashboard scan completes)
app.post('/api/history/add', express.json(), async (req, res) => {
  const trades = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Expected array' });
  const r = await addTradesToHistory(trades);
  console.log('History: added', r.accepted, 'trades, total:', r.total);
  res.json({ ok: true, total: r.total, added: r.accepted, skipped: r.skipped });
});

// POST import a dashboard "Export Excel" recommended CSV back into durable history.
// Body: { csv: "...", entryDate?: "2026-07-15T12:00:00.000Z", filename?: "alphasignal-recommended-2026-07-15.csv" }
app.post('/api/history/import-recommended', express.json({ limit: '2mb' }), async (req, res) => {
  const csv = req.body && req.body.csv;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });
  const entryDate = (req.body.entryDate && String(req.body.entryDate))
    || entryDateFromRecommendedFilename(req.body.filename)
    || null;
  try {
    const r = await importRecommendedCsvText(csv, { entryDate, source: 'api' });
    if (!r.ok) return res.status(400).json(r);
    console.log('Recommended CSV import:', r.accepted, 'added, total', r.total);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST update PnL for existing trades
app.post('/api/history/update-pnl', express.json(), (req, res) => {
  const updates = req.body; // array of { ticker, hz, pnl, pct, status, currentPrice }
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  
  updates.forEach(u => {
    const uDay = singaporeToDateString(Date.parse(u.entryDate) || Date.now());
    const idx = tradeHistory.findIndex(h =>
      h.ticker === u.ticker && historyTradeEntryDay(h) === uDay
    );
    if (idx >= 0) {
      const h = tradeHistory[idx];
      // Update all horizon PnL fields
      ['short','medium','long'].forEach(hz => {
        if(u[hz+'PnlDollar'] !== undefined) h[hz+'PnlDollar'] = u[hz+'PnlDollar'];
        if(u[hz+'PnlPct']    !== undefined) h[hz+'PnlPct']    = u[hz+'PnlPct'];
        // Extinct statuses (old full-exit engine) are never accepted from clients.
        if(u[hz+'Status']    !== undefined && u[hz+'Status'] !== 'tp1_hit' && u[hz+'Status'] !== 'tp2_hit') h[hz+'Status'] = u[hz+'Status'];
        if (u[hz + 'Status'] === 'sl_hit') setSLCooldown(h.ticker, hz);
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
  const today = singaporeToDateString();
  const before = tradeHistory.length;
  tradeHistory = tradeHistory.filter(h => {
    const isToday = historyTradeEntryDay(h) === today;
    return !(isToday && tickers.includes(h.ticker));
  });
  saveHistoryFile(tradeHistory);
  console.log('Cleared today entries:', before - tradeHistory.length, 'removed');
  res.json({ok:true, removed: before - tradeHistory.length});
});

// DELETE clear history
app.delete('/api/history', (req, res) => {
  // Destructive: requires explicit confirmation. An automated or accidental call
  // (this endpoint used to be hit by a client-side "fix entries" routine before a
  // full re-upload of whatever the BROWSER happened to hold — a stale copy could
  // silently shrink the durable history) must never wipe the server's record.
  if (req.query.confirm !== 'all') return res.status(400).json({ error: 'Pass ?confirm=all to clear history' });
  auditLog('history_cleared', { rows: tradeHistory.length });
  tradeHistory = [];
  saveHistoryFile(tradeHistory);
  res.json({ ok: true });
});


/** US-listed tickers without intl exchange suffix (no .HK, .NS, etc.). */
function isUsDomesticEquity(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!s || /[=]/.test(s)) return false;
  return !/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|SW|MC|MI|TO|V|MX|NZ|CO|OL|VI)$/i.test(s);
}

function earningsMsToIsoDate(ms, sym) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (isUsDomesticEquity(sym)) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date(ms));
    } catch (_) {}
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function isoDateSpanDays(a, b) {
  const da = String(a || '').slice(0, 10);
  const db = String(b || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(da) || !/^\d{4}-\d{2}-\d{2}$/.test(db)) return 999;
  const t0 = Date.parse(da + 'T12:00:00Z');
  const t1 = Date.parse(db + 'T12:00:00Z');
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 999;
  return Math.round(Math.abs(t1 - t0) / 86400000);
}

/** Yahoo calendarEvents often sends [windowStart, windowEnd] — report day is the later slot. */
function pickUpcomingEarningsTimestampMs(candidates) {
  if (!candidates.length) return null;
  const slack = 86400000 * 14;
  const todayUtc0 =
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 86400000;
  const nextLike = candidates.filter((m) => m >= todayUtc0).sort((a, b) => a - b);
  const now = Date.now();
  const future = candidates.filter((m) => m >= now - slack).sort((a, b) => a - b);
  const pool = nextLike.length ? nextLike : future.length ? future : [...candidates].sort((a, b) => a - b);
  if (!pool.length) return null;
  if (pool.length >= 2 && pool[pool.length - 1] - pool[0] <= slack) return pool[pool.length - 1];
  return pool[0];
}

/** Among upcoming calendar rows, prefer the latest date in the first earnings window (confirmed report day). */
function pickUpcomingEarningsCalendarRow(rows, fromISO) {
  const future = rows
    .map((r) => ({
      ...r,
      date: String(r.date || r.reportDate || '').slice(0, 10),
      epsActual: r.epsActual ?? r.actualEPS ?? r.eps,
      epsEstimated: r.epsEstimated ?? r.estimatedEPS ?? r.estimate ?? r.epsEstimated
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= fromISO)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!future.length) return null;
  const cluster = future.filter((r) => isoDateSpanDays(future[0].date, r.date) <= 7);
  const pending = cluster.filter((r) => r.epsActual == null);
  const pickFrom = pending.length ? pending : cluster;
  return pickFrom[pickFrom.length - 1];
}

function mergeNextEarningsCandidate(state, cand, sourceLabel, upcomingCutoff) {
  if (!cand?.date || cand.date < upcomingCutoff) return state;
  const lowTrust = sourceLabel === 'finnhub';
  if (state.nextDate && lowTrust) return state;
  if (
    state.nextDate &&
    state.nextDate !== cand.date &&
    isoDateSpanDays(state.nextDate, cand.date) <= 7 &&
    cand.date > state.nextDate &&
    ['fmp_confirmed', 'fmp_stable_earnings', 'fmp_symbol_calendar', 'yahoo_quoteSummary', 'yahoo_chart'].includes(
      sourceLabel
    )
  ) {
    // Prefer later date in the same earnings window (e.g. confirmed report day vs window start)
  } else if (state.nextDate && cand.date <= state.nextDate && sourceLabel !== 'bloomberg_bridge') {
    return state;
  }
  return {
    nextDate: cand.date,
    epsEst: cand.epsEst ?? state.epsEst,
    callTime: cand.callTime || state.callTime,
    calendarPrimary: sourceLabel
  };
}

/** Next earnings ISO date + optional EPS avg from Yahoo quoteSummary.calendarEvents. */
function nextEarningsFromCalendar(qs, sym) {
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
    const pickMs = pickUpcomingEarningsTimestampMs(candidates);
    if (pickMs == null) return {};
    const nextDate = earningsMsToIsoDate(pickMs, sym);
    let eps = null;
    if (ce.epsAverage?.fmt != null) eps = String(ce.epsAverage.fmt);
    else if (ce.epsEstimate?.average?.fmt != null) eps = String(ce.epsEstimate.average.fmt);
    out.nextDate = nextDate;
    out.epsEstimate = eps;
  } catch (_) {}
  return out;
}

/** Past quarters (up to `maxRows`) from Yahoo quoteSummary earningsHistory — newest first. */
function earningsHistoryAllFromQuoteSummary(qs, maxRows = 24) {
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
    if (/^\d{8}$/.test(perFmt)) {
      const y = perFmt.slice(0, 4);
      const mo = perFmt.slice(4, 6);
      const d = perFmt.slice(6, 8);
      if (mo >= '01' && mo <= '12' && d >= '01' && d <= '31') return `${y}-${mo}-${d}`;
    }
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
  const nKeep = Math.min(32, Math.max(4, +maxRows || 24));
  const pick = hist.slice(-Math.max(nKeep, 8)).reverse();
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
    .filter(
      (r) =>
        r.date ||
        r.quarter ||
        (r.epsActual != null && r.epsActual !== '') ||
        (r.epsEstimate != null && r.epsEstimate !== '')
    );
}

/** Last 4 quarters for primary UI table. */
function earningsHistoryFromQuoteSummary(qs) {
  return earningsHistoryAllFromQuoteSummary(qs, 4).slice(0, 4);
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
  '9988.HK', '9984.T', '7203.T',
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

async function fetchFinnhubCompanyNewsForSymbol(sym) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token) return [];
  const to = new Date().toISOString().slice(0, 10);
  const dt = new Date(`${to}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 37);
  const from = dt.toISOString().slice(0, 10);
  // Build Finnhub-compatible ticker variants:
  // Finnhub uses: INFY (no suffix for India), 7203 (no suffix for Japan),
  // AAPL (US), AZN (London), but also supports AZN.L sometimes
  const bare2 = sym.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|KS|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i, '');
  const variants = [...new Set([sym, sym.replace(/\./g, '-'), bare2])].filter(Boolean);
  for (const v of variants) {
    try {
      const u = new URL('https://finnhub.io/api/v1/company-news');
      u.searchParams.set('symbol', v);
      u.searchParams.set('from', from);
      u.searchParams.set('to', to);
      u.searchParams.set('token', token);
      const r = await fetch(u.toString(), { signal: AbortSignal.timeout(8000) }); // longer for intl
      if (!r.ok) continue;
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) return arr.slice(0, 15);
    } catch (_) {}
  }
  return [];
}

/**
 * Finnhub valuation / growth snapshot (fills gaps Yahoo/FMP omit from cloud + partial Bloomberg snapshots).
 * https://finnhub.io/docs/api/stock-metrics
 */
async function fetchFundamentalsFinnhub(symbol) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token || !symbol) return null;
  const variants = finnhubSymbolVariants(symbol);
  const num = (v) => {
    const x = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(x) ? x : null;
  };
  /** Growth fields are sometimes fractional (0.12) or already in % (12). */
  const growthPct = (v) => {
    const n = num(v);
    if (n == null) return null;
    if (Math.abs(n) < 4.5 && Math.abs(n) > 1e-8) return +((n * 100).toFixed(2));
    return +n.toFixed(2);
  };
  for (const v of variants) {
    try {
      const url = new URL('https://finnhub.io/api/v1/stock/metric');
      url.searchParams.set('symbol', v);
      url.searchParams.set('metric', 'all');
      url.searchParams.set('token', token);
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(14000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || typeof j !== 'object' || typeof j.error === 'string') continue;
      const met = typeof j.metric === 'object' && j.metric ? j.metric : {};
      const pegRatio = num(
        met.pegRatioTTM ??
          met.trailingPegRatio ??
          met.pegRatioAnnual ??
          met.pegRatio ??
          met.peToEpsGrowthTTM
      );
      const earningsGrowth = growthPct(
        met.epsGrowth3Y ??
          met.epsGrowth5Y ??
          met.epsAnnualGrowth5Y ??
          met.netIncomeGrowthAnnual ??
          met.epsGrowthAnnual ??
          met.epsBvAnnualGrowth5Y
      );
      const revenueGrowth = growthPct(
        met.revenueGrowth3Y ??
          met.revenueGrowth5Y ??
          met.revenueGrowthAnnual ??
          met.revenueAnnualGrowth5Y ??
          met.revenuePerShareAnnualGrowth5Y
      );
      const forwardPE = num(met.forwardPE ?? met.forwardPeRatio ?? met.peTTMForward);
      const trailingPE = num(met.peTTM ?? met.peBasicExclExtraTTM ?? met.peNormalizedAnnual);
      if (
        pegRatio == null &&
        earningsGrowth == null &&
        revenueGrowth == null &&
        forwardPE == null &&
        trailingPE == null
      )
        continue;
      const out = {
        _source: 'finnhub_metric',
        pegRatio,
        earningsGrowth,
        revenueGrowth,
        forwardPE,
        trailingPE
      };
      const hasAny = Object.keys(out).some(
        (k) => !k.startsWith('_') && out[k] != null && out[k] !== ''
      );
      if (hasAny) return out;
    } catch (e) {
      console.warn('fetchFundamentalsFinnhub', v, e.message);
    }
  }
  return null;
}

function finnhubPeriodToHistIso(period) {
  const s = String(period ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString().slice(0, 10);
  if (Number.isFinite(n) && n > 30000 && n < 65000) {
    try {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      epoch.setUTCDate(epoch.getUTCDate() + Math.round(n));
      return epoch.toISOString().slice(0, 10);
    } catch (_) {
      return '';
    }
  }
  const t = Date.parse(s.replace(',', ''));
  return !Number.isNaN(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

/** Rows shaped like Yahoo earningsHistory for enrichEarningsHistFromYahooRows */
async function finnhubHistoricalEpsSurprisesPool(sym, maxRows = 16) {
  const token = (process.env.FINNHUB_API_KEY || '').trim();
  if (!token || !sym) return [];
  const variants = finnhubSymbolVariants(sym);
  const pickNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  for (const v of variants) {
    try {
      const tryUrls = [
        () => {
          const u = new URL('https://finnhub.io/api/v1/stock/earnings');
          u.searchParams.set('symbol', v);
          u.searchParams.set('token', token);
          return u.toString();
        },
        () => {
          const u = new URL('https://finnhub.io/api/v1/stock/historical_eps_surprises');
          u.searchParams.set('symbol', v);
          u.searchParams.set('token', token);
          return u.toString();
        }
      ];
      let j = null;
      let raw = [];
      for (const makeUrl of tryUrls) {
        const r = await fetch(makeUrl(), { signal: AbortSignal.timeout(14000) });
        j = await r.json().catch(() => null);
        if (!r.ok || !j || typeof j !== 'object') continue;
        raw =
          (Array.isArray(j.data) && j.data) ||
          (Array.isArray(j.earnings) && j.earnings) ||
          (Array.isArray(j.earningCalendar) && j.earningCalendar) ||
          (Array.isArray(j.surprises) && j.surprises) ||
          (Array.isArray(j.results) && j.results) ||
          (Array.isArray(j) ? j : []);
        if (raw.length) break;
      }
      if (!raw.length) continue;
      const sorted = [...raw].sort((a, b) => {
        const da = finnhubPeriodToHistIso(a.period ?? a.date ?? a.actualTime);
        const db = finnhubPeriodToHistIso(b.period ?? b.date ?? b.actualTime);
        return db.localeCompare(da);
      });
      return sorted.slice(0, maxRows)
        .map((row) => {
          const ds = finnhubPeriodToHistIso(row.period ?? row.date ?? row.actualTime);
          const ea = pickNum(row.actual ?? row.actualEps ?? row.epsActual);
          const ee = pickNum(row.estimate ?? row.estimatedEps ?? row.epsEstimate ?? row.epsEst);
          let surp = pickNum(
            row.surprise ??
              row.surprisePercent ??
              row.epsSurprisePercent ??
              row.epsSurprise
          );
          if (
            (surp == null || Number.isNaN(surp)) &&
            ea != null &&
            ee != null &&
            Math.abs(ee) > 1e-9
          ) {
            surp = ((ea - ee) / Math.abs(ee)) * 100;
          }
          if (surp != null && Number.isFinite(surp) && Math.abs(surp) <= 1.0001 && Math.abs(surp) > 1e-12) {
            surp *= 100;
          }
          const surpLabel =
            surp != null && Number.isFinite(surp)
              ? (surp >= 0 ? '+' : '') + surp.toFixed(1) + '%'
              : null;
          const quarter = ds
            ? new Date(ds + 'T12:00:00Z').toLocaleDateString('en-GB', {
                month: 'short',
                year: 'numeric'
              })
            : '';
          return {
            quarter,
            date: /^\d{4}-\d{2}-\d{2}$/.test(ds) ? ds : '',
            epsActual: ea != null ? String(ea) : null,
            epsEstimate: ee != null ? String(ee) : null,
            epsSurprise: surpLabel,
            beat: surp != null ? surp >= 0 : null,
            revenueActual: null,
            stockReaction: null
          };
        })
        .filter((r) => r.date || r.quarter);
    } catch (e) {
      console.warn('finnhubHistoricalEpsSurprisesPool', v, e.message);
    }
  }
  return [];
}

function finnhubNewsToImpactPack(articles) {
  if (!Array.isArray(articles) || !articles.length) return null;
  const posRe =
    /\b(beats?\b|beat estimates|raised guidance|strong growth|surge|rally|upgrade|profit rose|revenue rose|approval|positive|buyback|dividend hike|record revenue|expansion)\b/i;
  const negRe =
    /\b(miss(es)?|lawsuit|probe|fine|bearish|downgrade|investigation|warned|warnings?|warns?|weak demand|charges|strike|halt|crash|sell-?off|layoffs?)\b/i;
  const heads = articles.slice(0, 6).map(a => String(a.headline || '').trim()).filter(Boolean);
  let score = 0;
  for (const h of heads) {
    if (negRe.test(h)) score--;
    else if (posRe.test(h)) score++;
  }
  const tone = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  const label =
    score > 1
      ? 'Likely supportive for sentiment'
      : score < -1
        ? 'Likely adverse for sentiment'
        : tone === 'neutral'
          ? 'Mixed / headline-neutral tone'
          : score > 0
            ? 'Mild positive skew vs recent headlines'
            : 'Mild negative skew vs recent headlines';
  const recap = heads.slice(0, 4).join(' · ');
  const text = `${label} — recent headlines (${heads.length || articles.length} sampled): ${recap}`.slice(
    0,
    520
  );
  return { tone, text };
}

async function augmentNewsImpactFromFinnhub(sym, row) {
  if (!row || !sym) return;
  let arts = await fetchFinnhubCompanyNewsForSymbol(sym);
  let pack = finnhubNewsToImpactPack(arts);
  if (!pack?.text) {
    try {
      const yNews = await fetchNews(sym, 8);
      if (Array.isArray(yNews) && yNews.length) {
        pack = finnhubNewsToImpactPack(
          yNews.map((n) => ({ headline: n.title || '', source: n.publisher || 'Yahoo' }))
        );
      }
    } catch (_) {}
  }
  if (pack?.text) {
    row.newsImpact = pack.text;
    row.newsTone = pack.tone;
  }
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
      const cal = nextEarningsFromCalendar(qs, t);
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
  const displayEndISO = addUTCISODays(toISO, 135);
  const vendorEndISO  = addUTCISODays(toISO, 90);

  // ── STEP 1: Bloomberg Bridge (skip when URL is LAN/loopback on a public host — saves long TCP stalls)
  let bloombergTrackedHits = 0;
  const skipBbCal =
    !bloombergBridgeUrl() ||
    (typeof bloombergBridgeUrlIsUnreachableFromInternet === 'function' &&
      bloombergBridgeUrlIsUnreachableFromInternet());
  if (skipBbCal && bloombergBridgeUrl()) {
    console.log(
      'Earnings calendar: skipping Bloomberg bridge (URL not reachable from this server, e.g. 127.0.0.1 on Render)'
    );
  }
  if (!skipBbCal) {
  const BB_CHUNK = 15; // bigger chunk = faster (bridge handles parallel fine)
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
          byTicker.set(k, row); // Bloomberg always wins — no prev check
          bloombergTrackedHits++;
        } catch (_) {}
      })
    );
    if (i + BB_CHUNK < EARNINGS_CAL_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, 25)); // minimal delay, bridge is local
    }
  }
  console.log(`Earnings calendar: Bloomberg bridge ${bloombergTrackedHits}/${EARNINGS_CAL_SYMBOLS.length} hits`);
  }

  // ── STEP 2: Finnhub bulk calendar — fills tickers Bloomberg didn't return ──
  // Finnhub is a bulk API (one call for date range), very fast
  let yahooSeedHits = 0; // kept for diag compat

  let fhRaw = await finnhubEarningsCalendar(fromISO, vendorEndISO);
  let finnhubPath = fhRaw.length ? 'global' : 'none';
  if (!fhRaw.length && (process.env.FINNHUB_API_KEY || '').trim()) {
    finnhubPath = 'symbol_fallback';
    const acc = [];
    const FH_SYM_CHUNK = 14;
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
        await new Promise((r) => setTimeout(r, 90));
      }
    }
    fhRaw = acc;
  }

  const fmpRows = await fmpEarningCalendarByRange(fromISO, vendorEndISO);

  // Full-window merge (not limited to ~55 watchlist names) so the widget reflects the real market.
  // ── STEP 3: Finnhub + FMP — bulk merge, Bloomberg always wins ─────────────
  fhRaw
    .filter((x) => x && x.symbol && isUpcomingCalRow(x, fromISO, displayEndISO))
    .forEach((e) => {
      const row = mapFinnhubCalRow(e);
      const k = normalizeTickerMatch(row.ticker);
      if (!k) return;
      const prev = byTicker.get(k);
      if (prev && prev.source === 'bloomberg_bridge') return; // Bloomberg always wins
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

  // ── STEP 4: Yahoo gap-fill — ONLY for tickers Bloomberg + Finnhub + FMP missed ──
  // Skip tickers already covered by Bloomberg (Bloomberg wins always)
  const missingTickers = EARNINGS_CAL_SYMBOLS.filter(t => !byTicker.has(normalizeTickerMatch(t)));
  if (missingTickers.length > 0) {
    console.log(`Earnings calendar: Yahoo gap-fill for ${missingTickers.length} tickers Bloomberg/Finnhub/FMP missed`);
    const GAP_CHUNK = 8;
    for (let i = 0; i < missingTickers.length; i += GAP_CHUNK) {
      const chunk = missingTickers.slice(i, i + GAP_CHUNK);
      await Promise.all(
        chunk.map(async (tick) => {
          try {
            const nk = normalizeTickerMatch(tick);
            if (byTicker.has(nk)) return; // double-check
            // Short timeout so slow Yahoo doesn't block the response
            const gap = await Promise.race([
              yahooEarningsGapRow(tick, fromISO, displayEndISO),
              new Promise(r => setTimeout(() => r(null), 4000))
            ]);
            if (gap && gap.date && gap.date >= fromISO && gap.date <= displayEndISO) {
              byTicker.set(nk, gap);
              yahooSeedHits++;
            }
          } catch (_) {}
        })
      );
      if (i + GAP_CHUNK < missingTickers.length) {
        await new Promise((r) => setTimeout(r, 40));
      }
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
function fmpNormalizeEarningsHistRows(arr) {
  function pickNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const sorted = [...arr].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return sorted
    .slice(0, 4)
    .map((row) => {
      const dateStr = String(row.date || row.reportDate || '').slice(0, 10);
      const ea = pickNum(
        row.epsActual ?? row.actualEPS ?? row.actual ?? row.actualEarningResult ?? row.eps
      );
      const ee = pickNum(
        row.epsEstimated ??
          row.estimatedEPS ??
          row.estimate ??
          row.estimatesAvg ??
          row.estimatedEarning
      );
      let surp = pickNum(row.surprisePercent ?? row.surprise);
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
        revenueActual: row.revenueActual != null ? String(row.revenueActual) : null,
        stockReaction: null
      };
    })
    .filter((r) => r.date || r.quarter);
}

/** US/other listings that share earnings with HK/NSE primary tickers (FMP often indexes under ADR). */
function earningsCrossListVariants(sym) {
  const u = String(sym || '').trim().toUpperCase();
  const map = {
    '9988.HK': ['BABA', 'BABAF', '09988.HK'],
    '0700.HK': ['TCEHY', '700.HK', '00700.HK'],
    '9618.HK': ['JD', '9618.HK'],
    '9888.HK': ['BIDU', '9888.HK'],
    '3690.HK': ['MPNGY', '3690.HK']
  };
  return map[u] ? [...map[u]] : [];
}

async function fmpStableEarningsBundle(sym, fromISO) {
  const k = fmpAnyApiKey();
  if (!k || !sym) return null;
  const cutoff = fromISO || new Date().toISOString().slice(0, 10);
  const staticV = intlVendorSymbolVariants(sym);
  const exchV = await fmpAllSymbolVariants(sym, k).catch(() => []);
  const variants = [
    ...new Set([...earningsCrossListVariants(sym), ...exchV, ...staticV, sym.replace(/\./g, '-'), sym])
  ].filter(Boolean);
  for (const v of variants.slice(0, 16)) {
    try {
      const enc = encodeURIComponent(v);
      const url = `https://financialmodelingprep.com/stable/earnings?symbol=${enc}&apikey=${encodeURIComponent(k)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(14000), headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      let arr = await r.json().catch(() => []);
      if (!Array.isArray(arr) && arr && typeof arr === 'object') {
        arr = Array.isArray(arr.data) ? arr.data : [];
      }
      if (!Array.isArray(arr) || !arr.length) continue;
      const mapped = arr
        .map((row) => ({
          date: String(row.date || row.reportDate || '').slice(0, 10),
          epsActual: row.epsActual ?? row.actualEPS ?? row.eps,
          epsEstimated: row.epsEstimated ?? row.estimatedEPS ?? row.estimate,
          revenueActual: row.revenueActual,
          time: row.time || row.hour
        }))
        .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
      if (!mapped.length) continue;
      const past = mapped
        .filter((row) => row.date < cutoff && (row.epsActual != null || row.epsEstimated != null))
        .sort((a, b) => b.date.localeCompare(a.date));
      const future = mapped.filter((row) => row.date >= cutoff);
      const nextRow = pickUpcomingEarningsCalendarRow(future, cutoff);
      const history = fmpNormalizeEarningsHistRows(past.length ? past : mapped);
      let callTime = null;
      const tl = String(nextRow?.time || '').toLowerCase();
      if (tl.includes('bmo') || tl.includes('before')) callTime = 'pre-market';
      else if (tl.includes('amc') || tl.includes('after')) callTime = 'post-market';
      return {
        history,
        next: nextRow
          ? {
              date: nextRow.date,
              epsEst:
                nextRow.epsEstimated != null
                  ? String(nextRow.epsEstimated)
                  : nextRow.epsActual != null
                    ? String(nextRow.epsActual)
                    : null,
              callTime
            }
          : null,
        source: 'fmp_stable_earnings'
      };
    } catch (e) {
      console.warn('fmpStableEarningsBundle', v, e.message);
    }
  }
  return null;
}

async function fmpEarningsSurprisesHistory(sym) {
  const k = fmpAnyApiKey();
  if (!k) return [];
  const staticV = intlVendorSymbolVariants(sym);
  const exchV = await fmpAllSymbolVariants(sym, k).catch(() => []);
  const variants = [...new Set([...exchV, ...staticV, sym.replace(/\./g, '-'), sym])].filter(Boolean);
  for (const v of variants.slice(0, 16)) {
    try {
      const enc = encodeURIComponent(v);
      const urls = [
        `https://financialmodelingprep.com/stable/earnings-surprises?symbol=${enc}&apikey=${encodeURIComponent(k)}`,
        `https://financialmodelingprep.com/api/v3/earnings-surprises/${enc}?apikey=${encodeURIComponent(k)}`
      ];
      for (const url of urls) {
        const r = await fetch(url, { signal: AbortSignal.timeout(14000), headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        let arr = await r.json().catch(() => []);
        if (!Array.isArray(arr) && arr && typeof arr === 'object') {
          arr = Array.isArray(arr.data) ? arr.data : [];
        }
        if (!Array.isArray(arr) || !arr.length) continue;
        const out = fmpNormalizeEarningsHistRows(arr);
        if (out.length) return out;
      }
    } catch (e) {
      console.warn('fmpEarningsSurprisesHistory', v, e.message);
    }
  }
  return [];
}

/** FMP Ultimate — next earnings date for one symbol (confirmed calendar first). */
async function fmpNextEarningsForSymbol(sym, fromISO, toISO) {
  const k = fmpAnyApiKey();
  if (!k || !sym) return null;
  const variants = [
    ...new Set([
      ...earningsCrossListVariants(sym),
      ...(await fmpAllSymbolVariants(sym, k).catch(() => [])),
      ...intlVendorSymbolVariants(sym),
      sym,
      sym.replace(/\./g, '-')
    ])
  ].filter(Boolean);
  const qAmp = `&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&apikey=${encodeURIComponent(k)}`;
  let best = null;
  for (const v of variants.slice(0, 14)) {
    const enc = encodeURIComponent(v);
    const confirmedUrl = `https://financialmodelingprep.com/stable/earning-calendar-confirmed?symbol=${enc}${qAmp}`;
    try {
      const r = await fetch(confirmedUrl, { signal: AbortSignal.timeout(14000), headers: { Accept: 'application/json' } });
      if (r.ok) {
        let rows = await r.json().catch(() => []);
        if (!Array.isArray(rows) && rows && typeof rows === 'object') {
          rows = Array.isArray(rows.data) ? rows.data : rows.earningsCalendar || [];
        }
        if (Array.isArray(rows) && rows.length) {
          const hit = pickUpcomingEarningsCalendarRow(rows, fromISO);
          if (hit?.date && (!best || hit.date >= best.date)) {
            best = {
              date: hit.date,
              epsEst:
                hit.epsEstimated != null
                  ? String(hit.epsEstimated)
                  : hit.epsActual != null
                    ? String(hit.epsActual)
                    : null,
              source: 'fmp_confirmed'
            };
          }
        }
      }
    } catch (e) {
      console.warn('fmpNextEarningsForSymbol confirmed', v, e.message);
    }
  }
  const stable = await fmpStableEarningsBundle(sym, fromISO);
  if (stable?.next?.date && (!best || stable.next.date >= best.date)) {
    best = { ...stable.next, source: 'fmp_stable_earnings' };
  }
  if (best) return best;
  for (const v of variants.slice(0, 14)) {
    const enc = encodeURIComponent(v);
    const urls = [
      `https://financialmodelingprep.com/stable/earning-calendar?symbol=${enc}${qAmp}`,
      `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${enc}?${qAmp.slice(1)}`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(14000), headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        let rows = await r.json().catch(() => []);
        if (!Array.isArray(rows) && rows && typeof rows === 'object') {
          rows = Array.isArray(rows.data) ? rows.data : rows.earningsCalendar || [];
        }
        if (!Array.isArray(rows) || !rows.length) continue;
        const hit = pickUpcomingEarningsCalendarRow(rows, fromISO);
        if (hit?.date) {
          return {
            date: hit.date,
            epsEst:
              hit.epsEstimated != null
                ? String(hit.epsEstimated)
                : hit.epsActual != null
                  ? String(hit.epsActual)
                  : null,
            source: 'fmp_symbol_calendar'
          };
        }
      } catch (e) {
        console.warn('fmpNextEarningsForSymbol', v, e.message);
      }
    }
  }
  return null;
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
  const prefersFmpIntlHist = /\.(NS|BO|HK|T|L|DE|PA|AS|TW|SI|KS|KQ|AX|NZ|BK|ST|SW|MC|MI|TO|V)$/i.test(
    sym
  );
  const todayISO = new Date().toISOString().slice(0, 10);
  const toFar = new Date();
  toFar.setUTCDate(toFar.getUTCDate() + 120);
  const toISOsym = toFar.toISOString().slice(0, 10);
  /** One-day grace: avoid dropping "today" rows on timezone / feed lag vs strict UTC midnight */
  const upcomingCutoff = addUTCISODays(todayISO, -1);
  /** FMP stable/confirmed earnings for all symbols (Yahoo often blocked from Render). */
  const fmpStableEarlyP = fmpAnyApiKey() ? fmpStableEarningsBundle(sym, upcomingCutoff) : null;
  const fmpNextEarlyP = fmpAnyApiKey() ? fmpNextEarningsForSymbol(sym, upcomingCutoff, toISOsym) : null;
  const fmpHistEarlyP =
    prefersFmpIntlHist && fmpAnyApiKey() ? fmpEarningsSurprisesHistory(sym) : null;
  const avHistEarlyP =
    prefersFmpIntlHist && alphaVantageApiKey() ? alphaVantageEarningsHistory(sym) : null;
  const fhHistEarlyP =
    prefersFmpIntlHist && (process.env.FINNHUB_API_KEY || '').trim()
      ? finnhubHistoricalEpsSurprisesPool(sym, 4)
      : null;
  // Bloomberg bridge is always running — fetch unconditionally, no URL check needed
  const bbEarnPromise = fetchBloombergBridgeEarnings(sym);
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
    }

    const toFar = new Date();
    toFar.setUTCDate(toFar.getUTCDate() + 120);

    let qs = await quoteSummary(sym, 'calendarEvents,earnings,earningsHistory');
    let fromCal = nextEarningsFromCalendar(qs, sym);
    if ((!fromCal.nextDate || fromCal.nextDate < todayISO) && (sym === 'GOOGL' || sym === 'GOOG')) {
      const altQs = await quoteSummary(
        sym === 'GOOGL' ? 'GOOG' : 'GOOGL',
        'calendarEvents,earnings,earningsHistory'
      );
      const altCal = nextEarningsFromCalendar(altQs, sym);
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

    /** FMP stable/confirmed — primary for US when Yahoo is unavailable; also fills intl gaps. */
    if (fmpStableEarlyP || fmpNextEarlyP) {
      try {
        const [stable, fmpNext] = await Promise.all([
          fmpStableEarlyP || Promise.resolve(null),
          fmpNextEarlyP || Promise.resolve(null)
        ]);
        if (stable?.history?.length) {
          if (prefersFmpIntlHist || !epsHistory.length || isUsDomesticEquity(sym)) {
            epsHistory = stable.history;
            historySource = stable.source || 'fmp_stable_earnings';
          }
        }
        const fmpCand = fmpNext?.date
          ? fmpNext
          : stable?.next?.date
            ? { ...stable.next, source: stable.source || 'fmp_stable_earnings' }
            : null;
        if (fmpCand?.date) {
          const mergedNext = mergeNextEarningsCandidate(
            { nextDate, epsEst, callTime, calendarPrimary },
            fmpCand,
            fmpCand.source || 'fmp_stable_earnings',
            upcomingCutoff
          );
          nextDate = mergedNext.nextDate;
          epsEst = mergedNext.epsEst;
          callTime = mergedNext.callTime;
          calendarPrimary = mergedNext.calendarPrimary || calendarPrimary;
        }
      } catch (_) {}
    }

    if (!epsHistory.length && fmpHistEarlyP) {
      try {
        const fmpHist = await fmpHistEarlyP;
        if (fmpHist.length) {
          epsHistory = fmpHist;
          historySource = 'fmp_earnings_surprises';
        }
      } catch (_) {}
    }
    if (!epsHistory.length && avHistEarlyP) {
      try {
        const avHist = await avHistEarlyP;
        if (avHist.length) {
          epsHistory = avHist;
          historySource = 'alpha_vantage_earnings';
        }
      } catch (_) {}
    }
    if (!nextDate && alphaVantageApiKey() && prefersFmpIntlHist) {
      try {
        const avCal = await alphaVantageNextEarningsDate(sym, upcomingCutoff, toISOsym);
        if (avCal?.date) {
          nextDate = avCal.date;
          epsEst = epsEst || avCal.epsEst || null;
          calendarPrimary = calendarPrimary || 'alpha_vantage';
        }
      } catch (_) {}
    }
    if (!epsHistory.length && fhHistEarlyP) {
      try {
        const fhHist = await fhHistEarlyP;
        if (fhHist.length) {
          epsHistory = fhHist;
          historySource = 'finnhub_historical_eps_surprises';
        }
      } catch (_) {}
    }

    const intlFmpSkipYahoo =
      prefersFmpIntlHist && epsHistory.length >= 1 && historySource === 'fmp_earnings_surprises';

    if (!intlFmpSkipYahoo) {
    const symbolsForChart =
      sym === 'GOOGL' || sym === 'GOOG'
        ? ['GOOGL', 'GOOG']
        : sym.includes('.')
          ? [
              ...new Set([
                sym,
                sym.replace(/\./g, '-'),
                sym.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|KS|KQ|TW|SI|AX|ST|SW|MC|MI)$/i, '')
              ])
            ].filter(Boolean)
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
    if (!epsHistory.length && fmpAnyApiKey() && !prefersFmpIntlHist) {
      const fmpH = await fmpEarningsSurprisesHistory(sym);
      if (fmpH.length) {
        epsHistory = fmpH;
        historySource = 'fmp_earnings_surprises';
      }
    }
    if (!epsHistory.length && alphaVantageApiKey() && !prefersFmpIntlHist) {
      const avH = await alphaVantageEarningsHistory(sym);
      if (avH.length) {
        epsHistory = avH;
        historySource = 'alpha_vantage_earnings';
      }
    }
    } /* end !intlFmpFastPath */

    if (!nextDate && fmpAnyApiKey()) {
      if (prefersFmpIntlHist) {
        const fmpNext = await fmpNextEarningsForSymbol(sym, todayISO, toISOsym);
        if (fmpNext?.date && fmpNext.date >= upcomingCutoff) {
          nextDate = fmpNext.date;
          epsEst = epsEst || fmpNext.epsEst || null;
          calendarPrimary = calendarPrimary || 'fmp';
        }
      } else {
      const fmpArr = await fmpEarningCalendarByRange(todayISO, toISOsym);
      const symVariants = [
        ...new Set(
          [sym, ...fmpSymbolVariantsForApi(sym)].map(s =>
            normalizeTickerMatch(String(s || '').trim().toUpperCase())
          )
        )
      ].filter(Boolean);
      const symCompactSet = new Set(symVariants.map(s => s.replace(/\./g, '').toUpperCase()));
      let fmpHits = fmpArr.filter(r => {
        const fs = fmpSymbol(r);
        if (!fs) return false;
        const n = normalizeTickerMatch(String(fs).trim().toUpperCase());
        return n && symVariants.includes(n);
      });
      if (!fmpHits.length) {
        fmpHits = fmpArr.filter(r => {
          const fs = fmpSymbol(r);
          if (!fs) return false;
          const compact = normalizeTickerMatch(String(fs).trim().toUpperCase()).replace(/\./g, '');
          return compact && symCompactSet.has(compact);
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
    }

    if (!nextDate && alphaVantageApiKey()) {
      try {
        const avCal = await alphaVantageNextEarningsDate(sym, upcomingCutoff, toISOsym);
        if (avCal?.date) {
          const mergedNext = mergeNextEarningsCandidate(
            { nextDate, epsEst, callTime, calendarPrimary },
            avCal,
            'alpha_vantage',
            upcomingCutoff
          );
          nextDate = mergedNext.nextDate;
          epsEst = mergedNext.epsEst;
          callTime = mergedNext.callTime;
          calendarPrimary = mergedNext.calendarPrimary || calendarPrimary;
        }
      } catch (_) {}
    }

    /** Finnhub last — often 1–2 days early vs FMP/Yahoo for US report dates. */
    if (!nextDate && (process.env.FINNHUB_API_KEY || '').trim()) {
      const fhVariants =
        sym === 'GOOGL' || sym === 'GOOG'
          ? ['GOOGL', 'GOOG']
          : [...new Set(intlVendorSymbolVariants(sym))].slice(0, 10);
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

    const sourcesUsed = {};
    if (process.env.FINNHUB_API_KEY) sourcesUsed.finnhub = true;
    if (fmpAnyApiKey()) sourcesUsed.fmp = true;
    if (alphaVantageApiKey()) sourcesUsed.alpha_vantage = true;
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

    let yahooHistEnrichPool = earningsHistoryAllFromQuoteSummary(qs, 28);
    if (!yahooHistEnrichPool.length) {
      const qh = await quoteSummary(sym, 'earningsHistory').catch(() => null);
      if (qh) yahooHistEnrichPool = earningsHistoryAllFromQuoteSummary(qh, 28);
    }
    if (sym.includes('.') && sym !== 'GOOGL' && sym !== 'GOOG') {
      const altQsDot = await quoteSummary(sym.replace(/\./g, '-'), 'earningsHistory').catch(() => null);
      if (altQsDot) {
        const extraPool = earningsHistoryAllFromQuoteSummary(altQsDot, 28);
        const uniq = new Map();
        for (const row of yahooHistEnrichPool.concat(extraPool)) {
          const k = String(row.date || '').slice(0, 10);
          if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
          if (!uniq.has(k)) uniq.set(k, row);
        }
        yahooHistEnrichPool = sortEarningsHistDesc([...uniq.values()]);
      }
    }

    try {
      const fhHistPool = await finnhubHistoricalEpsSurprisesPool(sym);
      if (fhHistPool.length)
        yahooHistEnrichPool = sortEarningsHistDesc(yahooHistEnrichPool.concat(fhHistPool));
    } catch (_) {}

    let histSend = Array.isArray(merged.epsHistory) ? merged.epsHistory.map((r) => ({ ...r })) : [];
    let histSourceOut = merged.historySource;
    histSend = enrichEarningsHistFromYahooRows(histSend, yahooHistEnrichPool);
    const needFmp =
      histSend.length &&
      histSend.some(
        (r) => isEmptyHistEps(r.epsActual) || isEmptyHistEps(r.epsEstimate) || isEmptyHistEps(r.epsSurprise)
      );
    if (needFmp && fmpAnyApiKey()) {
      const fmpH = await fmpEarningsSurprisesHistory(sym);
      if (fmpH.length) histSend = enrichEarningsHistFromYahooRows(histSend, fmpH);
    }
    if (
      histSend.length &&
      histSend.some(
        (r) => isEmptyHistEps(r.epsActual) || isEmptyHistEps(r.epsEstimate) || isEmptyHistEps(r.epsSurprise)
      ) &&
      alphaVantageApiKey()
    ) {
      const avH = await alphaVantageEarningsHistory(sym, 8);
      if (avH.length) histSend = enrichEarningsHistFromYahooRows(histSend, avH);
    }
    if (
      (process.env.FINNHUB_API_KEY || '').trim() &&
      histSend.length &&
      histSend.some(
        (r) => isEmptyHistEps(r.epsActual) || isEmptyHistEps(r.epsEstimate) || isEmptyHistEps(r.epsSurprise)
      )
    ) {
      const fhAgain = await finnhubHistoricalEpsSurprisesPool(sym);
      if (fhAgain.length) histSend = enrichEarningsHistFromYahooRows(histSend, fhAgain);
    }
    histSend = sortEarningsHistDesc(histSend).slice(0, 4);

    if (!histSend.length && yahooHistEnrichPool.length) {
      histSend = sortEarningsHistDesc(yahooHistEnrichPool).slice(0, 4).map((r) => ({ ...r }));
      histSourceOut = 'yahoo_quoteSummary_earningsHistory';
    }
    if (!histSend.length && fmpAnyApiKey()) {
      const fmpFall = await fmpEarningsSurprisesHistory(sym);
      if (fmpFall.length) {
        histSend = sortEarningsHistDesc(fmpFall).slice(0, 4).map((r) => ({ ...r }));
        histSourceOut = 'fmp_earnings_surprises';
      }
    }
    if (!histSend.length && alphaVantageApiKey()) {
      const avFall = await alphaVantageEarningsHistory(sym);
      if (avFall.length) {
        histSend = sortEarningsHistDesc(avFall).slice(0, 4).map((r) => ({ ...r }));
        histSourceOut = 'alpha_vantage_earnings';
      }
    }
    if (!histSend.length && (process.env.FINNHUB_API_KEY || '').trim()) {
      const fhFall = await finnhubHistoricalEpsSurprisesPool(sym);
      if (fhFall.length) {
        histSend = sortEarningsHistDesc(fhFall).slice(0, 4).map((r) => ({ ...r }));
        histSourceOut = 'finnhub_historical_eps_surprises';
      }
    }

    let bloombergBridgeExtras = null;
    if (bbEarn && !bbEarn.error) {
      const extras = {
        consensusEstimatesHint: bbEarn.consensusEstimatesHint ?? null,
        postEventPriceHintNext: bbEarn.postEventPriceHintNext ?? null,
        primaryStockReactionInterpretationHint:
          bbEarn.primaryStockReactionInterpretationHint ?? null,
        expectedReportTyp: bbEarn.expectedReportTyp ?? null,
        expectedReportPeriod: bbEarn.expectedReportPeriod ?? null,
        expectedReportTime: bbEarn.expectedReportTime ?? null,
        sourcesNote: bbEarn.sourcesNote ?? null
      };
      if (Object.values(extras).some((x) => x != null)) bloombergBridgeExtras = extras;
    }

    let nextOut = merged.nextDate;
    if (nextOut && String(nextOut).slice(0, 10) < todayISO) nextOut = null;

    res.json({
      symbol: sym,
      nextEarningsDate: nextOut,
      nextEarningsDateEnd: nextDateEnd,
      epsEstimate: merged.epsEst,
      earningsTime: merged.callTime || null,
      quarter: merged.quarter,
      calendarPrimarySource: merged.calendarPrimary || null,
      expectedReportTyp: merged.expectedReportTyp ?? null,
      expectedReportPeriod: merged.expectedReportPeriod ?? null,
      expectedReportTime: merged.expectedReportTime ?? null,
      calendarSourcesConsulted: sourcesUsed,
      history: histSend,
      historySource: histSourceOut,
      bloombergBridgeExtras
    });
  } catch (e) {
    console.error('Earnings err:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function pickDailyWeeklyForAnalyze(sym) {
  /** Prefer 5y first so Analyze walk-forward matches the model's 5–6y backtest
   *  window (BACKTEST_WINDOW_BARS = 1260). One primary round trip for most listings;
   *  only if thin, probe remaining ranges IN PARALLEL (avoids the old serial 6-hop). */
  const MIN = 15;
  const NEED = Math.min(BACKTEST_WINDOW_BARS, 1000); // enough for ~5y walk-forward
  const primary = await fetchOHLCV(sym, '5y', '1d').catch(() => null);
  if (primary && primary.length >= NEED) {
    return { daily: primary, weekly: dailyToWeeklyBars(primary) };
  }
  let bestDaily = (primary && primary.length >= MIN) ? primary : null;
  const rest = await Promise.all(
    ['max', '2y', '12mo', '6mo', '3mo'].map(r => fetchOHLCV(sym, r, '1d').catch(() => null))
  );
  for (const d of rest) {
    if (d && d.length >= MIN && (!bestDaily || d.length > bestDaily.length)) bestDaily = d;
  }
  if (!bestDaily || bestDaily.length < MIN) return null;
  return { daily: bestDaily, weekly: dailyToWeeklyBars(bestDaily) };
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
 * Claude JSON sometimes uses the wrong ticker (esp. HK/NS names). Merge must use the *requested*
 * symbols or fundamentals, Bloomberg lines, and /api/earnings on the client will bind to the wrong name.
 */
function alignAiStockRowsToRequestedTickers(stocks, requested) {
  if (!Array.isArray(stocks) || !Array.isArray(requested) || !requested.length) return stocks || [];
  const out = stocks.map((row) => (row && typeof row === 'object' ? { ...row } : {}));
  if (requested.length === 1) {
    if (out.length >= 1) out[0].ticker = requested[0];
    return out.slice(0, 1);
  }
  if (out.length === requested.length) {
    for (let i = 0; i < out.length; i++) out[i].ticker = requested[i];
    return out;
  }
  const used = new Set();
  const norm = (t) => String(t || '').trim().toUpperCase();
  const picked = [];
  for (const row of out) {
    const u = norm(row.ticker);
    if (requested.includes(u) && !used.has(u)) {
      used.add(u);
      picked.push({ ...row, ticker: u });
    }
  }
  if (picked.length) return picked;
  const n = Math.min(out.length, requested.length);
  for (let i = 0; i < n; i++) out[i].ticker = requested[i];
  return out.slice(0, n);
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

/** Minimum distance floors — medium always wider than short, long wider than medium. */
// Stop/target floors SCALE WITH THE HOLDING PERIOD: a 1-day trade can use a tight
// 3% stop, but a 4–12 month position must tolerate normal multi-month swings — a
// 5% stop on a long-term hold just guarantees a noise stop-out. Targets scale with
// Stop floors scale with horizon so longer holds tolerate normal swings.
// Targets are ATR+momentum (minRR 1:1 only) — not fixed %-of-price or stop multiples.
// ── SELL PICKS: redesigned two-path architecture ─────────────────────────────
// Backtest history (30 liquid US names, 252d): the old single-path strict gate
// demanded trend-short structure (below MA200 + bear regime) from EVERY sell —
// which strangled short-term fades to ZERO trades and left medium/long shorts
// break-even/negative in a rising tape. Redesign:
//   • SHORT horizon  = MEAN-REVERSION FADE — shorts overbought extensions back
//     to the mean (works in ANY regime; the two-sided edge in bull markets).
//   • MEDIUM/LONG    = BREAKDOWN shorts — strict structural confluence, which
//     by design fire rarely outside bear regimes (that rarity is correct).
// Re-run /api/backtest/medium-sell?hz=short&side=sell after deploy to verify
// the fade path; acceptance = WR ≥55% or avg ≥+0.30%/trade with PF ≥1.5.
// Default OFF — bracket acceptance (all windows) shows sell:short/medium/long with
// negative or sub-1.5-PF expectancy across every horizon. Running them was the main
// drag on live PnL. Reference-only unless explicitly re-enabled with SELL_PICKS_ENABLED=1.
const SELL_PICKS_ENABLED = process.env.SELL_PICKS_ENABLED === '1';

// Bracket acceptance gates (v143). Opt-in via env — default OFF so the dashboard
// never goes blank. Set e.g. DISABLED_BRACKETS=sell:medium,sell:long,buy:short
// after you've reviewed acceptance results and still want those panes suppressed.
const DISABLED_BRACKETS = new Set(
  String(process.env.DISABLED_BRACKETS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
function bracketEnabled(side, hz) {
  return !DISABLED_BRACKETS.has(`${String(side).toLowerCase()}:${String(hz).toLowerCase()}`);
}

const HORIZON_MIN_PCT = {
  // SL: noise floors only (ATR / structure still drive the actual stop).
  // TP stays ATR/structure — never invented to pass RR. Below PICKS_MIN_RR → not recommended.
  short:  { sl: 0.025, tp1: 0, tp2: 0, minRR: 1.1 },
  medium: { sl: 0.050, tp1: 0, tp2: 0, minRR: 1.1 },
  long:   { sl: 0.080, tp1: 0, tp2: 0, minRR: 1.1 }
};

/** Hard floor: TP1 reward / SL risk must be ≥ 1.1 or the setup is not recommended. */
const PICKS_MIN_RR = Math.max(1.1, parseFloat(process.env.PICKS_MIN_RR || '1.1') || 1.1);
/** UI "confidence %" (= winRateHint). Below this → never Buy/Sell / never IBKR. */
const PICKS_MIN_CONF = Math.max(62, parseInt(process.env.PICKS_MIN_CONF || '62', 10) || 62);

/** Strong Buy / Strong Sell — preferred on the board; required for history emit & IBKR. */
function isStrongRecommendableRating(rating) {
  const r = String(rating || '').trim().toLowerCase();
  return r === 'strong buy' || r === 'strong sell';
}

function rewardRiskRatio(entry, tp1, sl, isSell) {
  const e = parseFloat(entry), t = parseFloat(tp1), s = parseFloat(sl);
  if (!(e > 0) || !(t > 0) || !(s > 0)) return null;
  const risk = isSell ? (s - e) : (e - s);
  const reward = isSell ? (e - t) : (t - e);
  if (!(risk > 0) || !(reward > 0)) return null;
  return reward / risk;
}

function levelsMeetMinRR(entry, tp1, sl, isSell, minRR = PICKS_MIN_RR) {
  const rr = rewardRiskRatio(entry, tp1, sl, isSell);
  return rr != null && rr >= minRR;
}

// ── Sector trend (hold/exit context) ─────────────────────────────────────────
// Maps a stock's sector to its SPDR sector ETF as a trend proxy (used globally —
// for non-US names the US sector ETF still captures the sector's world cycle).
// Trend = ETF close vs its MA20/MA50. Cached 6h; one OHLCV fetch per sector max.
const SECTOR_ETF = {
  'technology': 'XLK', 'information technology': 'XLK', 'tech': 'XLK',
  'financial services': 'XLF', 'financials': 'XLF', 'financial': 'XLF', 'banks': 'XLF',
  'energy': 'XLE', 'oil & gas': 'XLE',
  'healthcare': 'XLV', 'health care': 'XLV', 'pharmaceuticals': 'XLV',
  'industrials': 'XLI', 'industrial': 'XLI',
  'consumer cyclical': 'XLY', 'consumer discretionary': 'XLY', 'retail': 'XLY', 'automobiles': 'XLY',
  'consumer defensive': 'XLP', 'consumer staples': 'XLP',
  'basic materials': 'XLB', 'materials': 'XLB', 'metals & mining': 'XLB', 'chemicals': 'XLB',
  'real estate': 'XLRE',
  'utilities': 'XLU',
  'communication services': 'XLC', 'communication': 'XLC', 'telecom': 'XLC', 'media': 'XLC'
};
const _sectorTrendCache = new Map(); // etf → { ts, label }
const SECTOR_TREND_TTL = 6 * 60 * 60 * 1000;
async function sectorTrendLabel(sectorRaw) {
  const sector = String(sectorRaw || '').trim();
  if (!sector) return null;
  const key = sector.toLowerCase();
  let etf = SECTOR_ETF[key] || null;
  if (!etf) { for (const [k, v] of Object.entries(SECTOR_ETF)) { if (key.includes(k)) { etf = v; break; } } }
  if (!etf) return null;
  const hit = _sectorTrendCache.get(etf);
  if (hit && Date.now() - hit.ts < SECTOR_TREND_TTL) return hit.label ? `${sector} ${hit.label}` : null;
  let label = null;
  try {
    const bars = await fetchOHLCV(etf, '6mo', '1d').catch(() => null);
    if (bars && bars.length >= 50) {
      const closes = bars.map(b => b.c).filter(v => v != null);
      const ma20 = calcSMA(closes, 20), ma50 = calcSMA(closes, 50);
      const last = closes[closes.length - 1];
      if (last > ma20 && ma20 > ma50) label = '↑ uptrend';
      else if (last < ma20 && ma20 < ma50) label = '↓ downtrend';
      else label = '→ sideways';
    }
  } catch (_) { /* leave null */ }
  _sectorTrendCache.set(etf, { ts: Date.now(), label });
  return label ? `${sector} ${label}` : null;
}


// ── Danelfin call discipline ─────────────────────────────────────────────────
// Danelfin's plan allows ~2500 calls/MONTH. Without a cache, every page load /
// boot / pick-gen re-fetched every US name and burnt the whole month in a day.
// Scores update once daily, so: disk cache with a 20h TTL + a hard daily budget.
// When the budget is spent (or the API errors), callers get null and the FMP
// quality fallback takes over — the model keeps working.
const DANELFIN_CACHE_FILE = path.join(DATA_DIR, 'danelfin_cache.json'); // DATA_DIR → Render persistent disk when mounted
const DANELFIN_TTL_MS = 20 * 60 * 60 * 1000; // 20h — scores are daily
const DANELFIN_DAILY_BUDGET = Math.max(5, parseInt(process.env.DANELFIN_DAILY_BUDGET || '12', 10) || 12); // 10-12/day: ~360/mo, safely inside the 2500/mo plan
let danelfinCache = {};
let danelfinBudget = { day: '', used: 0 };
function loadDanelfinCache() {
  try {
    if (fs.existsSync(DANELFIN_CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(DANELFIN_CACHE_FILE, 'utf8'));
      danelfinCache = j.cache || {};
      danelfinBudget = j.budget || { day: '', used: 0 };
    }
  } catch (e) { console.warn('Danelfin cache load:', e.message); }
}
function saveDanelfinCache() {
  try {
    fs.mkdirSync(path.dirname(DANELFIN_CACHE_FILE), { recursive: true });
    fs.writeFileSync(DANELFIN_CACHE_FILE, JSON.stringify({ cache: danelfinCache, budget: danelfinBudget }));
  } catch (e) { console.warn('Danelfin cache save:', e.message); }
}
function danelfinBudgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (danelfinBudget.day !== today) danelfinBudget = { day: today, used: 0 };
  return DANELFIN_DAILY_BUDGET - danelfinBudget.used;
}
/** Cached, budget-guarded Danelfin fetch. Returns the cached row (even stale, as
 *  a last resort) rather than burning calls; null only when nothing is known. */
async function cachedDanelfinRow(apiKey, sym) {
  const k = String(sym || '').toUpperCase();
  const hit = danelfinCache[k];
  if (hit && Date.now() - hit.ts < DANELFIN_TTL_MS) return hit.row; // fresh (row may be null = known-missing)
  if (danelfinBudgetLeft() <= 0) {
    if (hit) return hit.row; // stale beats nothing when out of budget
    return null;
  }
  danelfinBudget.used++;
  const row = await fetchDanelfinRow(apiKey, sym).catch(() => null);
  danelfinCache[k] = { ts: Date.now(), row };
  saveDanelfinCache();
  return row;
}


const SL_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
const SL_COOLDOWN_FILE = path.join(DATA_DIR, 'sl_cooldowns.json');
let slCooldowns = {};

function loadSLCooldowns() {
  try {
    if (fs.existsSync(SL_COOLDOWN_FILE)) {
      slCooldowns = JSON.parse(fs.readFileSync(SL_COOLDOWN_FILE, 'utf8')) || {};
    }
  } catch (_) {
    slCooldowns = {};
  }
}

function saveSLCooldowns() {
  try {
    fs.mkdirSync(path.dirname(SL_COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(SL_COOLDOWN_FILE, JSON.stringify(slCooldowns));
  } catch (e) {
    console.warn('SL cooldown save failed:', e.message);
  }
}

function setSLCooldown(ticker, hz) {
  if (!ticker || !hz) return;
  slCooldowns[`${ticker}|${hz}`] = { hitAt: Date.now(), until: Date.now() + SL_COOLDOWN_MS };
  saveSLCooldowns();
}

function isSLCooldownActive(ticker, hz) {
  const k = `${ticker}|${hz}`;
  const c = slCooldowns[k];
  if (!c) return false;
  if (Date.now() > (c.until || 0)) {
    delete slCooldowns[k];
    saveSLCooldowns();
    return false;
  }
  return true;
}

function maybeClearSLCooldown(ticker, hz, tech) {
  if (!isSLCooldownActive(ticker, hz)) return false;
  const aboveMa20 = tech?.aboveMa20 === true;
  const rsi = tech?.rsi ?? 50;
  const macdBull = tech?.macd?.trend === 'bullish';
  if (aboveMa20 && rsi > 42 && macdBull) {
    delete slCooldowns[`${ticker}|${hz}`];
    saveSLCooldowns();
    return true;
  }
  return false;
}

function applySLCooldownGate(sym, data) {
  if (!data?.quantSignal) return;
  ['short', 'medium', 'long'].forEach(hz => {
    maybeClearSLCooldown(sym, hz, data);
    if (!isSLCooldownActive(sym, hz)) return;
    const q = data.quantSignal[hz];
    if (!q) return;
    if (q.action === 'Buy' || (q.buyScore || 0) >= 62) {
      q.action = 'Hold';
      q.rating = 'Hold';
      q.buyScore = Math.min(q.buyScore || 0, 38);
      q.tierLabel = '⚠ SL cooldown — reversal not confirmed';
      q.conditions = q.conditions || [];
      if (!q.conditions.some(c => /SL cooldown/i.test(c))) {
        q.conditions.push('SL cooldown active (3d after stop hit)');
      }
    }
  });
}

const DASH_PANE_MAP = {
  short: { hz: 'short', side: 'buy' },
  medium: { hz: 'medium', side: 'buy' },
  long: { hz: 'long', side: 'buy' },
  shortSell: { hz: 'short', side: 'sell' },
  medSell: { hz: 'medium', side: 'sell' },
  longSell: { hz: 'long', side: 'sell' }
};

function filterDashDataBySLCooldown(dashData) {
  if (!dashData || typeof dashData !== 'object') return dashData;
  const out = {};
  for (const [pane, { hz, side }] of Object.entries(DASH_PANE_MAP)) {
    out[pane] = (dashData[pane] || []).filter(pick => {
      const action = pick[hz + 'Action'] || pick.action || 'Hold';
      const rating = String(pick[hz + 'Rating'] || '');
      if (/^hold$/i.test(String(rating).trim()) || /SL cooldown/i.test(rating)) return false;
      if (side === 'buy') {
        if (isSLCooldownActive(pick.ticker, hz)) return false;
        // Serve cached board: Buy + Conf/score floor. Strong-only is enforced at
        // generation — re-applying it on every GET emptied the board and forced
        // a full client universe rescan on each page refresh.
        if (!(action === 'Buy'
          && (pick[hz + 'Score'] || 0) >= 62
          && (Number(pick[hz + 'Conf']) || 0) >= PICKS_MIN_CONF)) return false;
      } else if (!(action === 'Sell'
        && (pick[hz + 'SellScore'] || 0) >= 62
        && (Number(pick[hz + 'Conf']) || 0) >= PICKS_MIN_CONF)) {
        return false;
      }
      const isSell = side === 'sell';
      const entry = parseFloat(pick[hz + 'Entry'] || pick.entry);
      const tp1 = parseFloat(pick[hz + 'Target1'] || pick.target1);
      const sl = parseFloat(pick[hz + 'StopLoss'] || pick.stopLoss);
      return levelsMeetMinRR(entry, tp1, sl, isSell, PICKS_MIN_RR);
    });
  }
  return out;
}

function filterDashDataByMinRR(dashData, minRR = PICKS_MIN_RR) {
  if (!dashData || typeof dashData !== 'object') return dashData;
  const out = {};
  let dropped = 0;
  for (const [pane, { hz, side }] of Object.entries(DASH_PANE_MAP)) {
    const isSell = side === 'sell';
    out[pane] = (dashData[pane] || []).filter(pick => {
      const entry = parseFloat(pick[hz + 'Entry'] || pick.entry);
      const tp1 = parseFloat(pick[hz + 'Target1'] || (isSell ? pick.sellTarget1 : pick.target1));
      const sl = parseFloat(pick[hz + 'StopLoss'] || (isSell ? pick.sellStopLoss : pick.stopLoss));
      const conf = Number(pick[hz + 'Conf'] || pick.conf || 0);
      if (!(conf >= PICKS_MIN_CONF)) {
        dropped++;
        console.log('Pick dropped (Conf <', PICKS_MIN_CONF + '%):', pick.ticker, hz, side, 'conf=', conf);
        return false;
      }
      const ok = levelsMeetMinRR(entry, tp1, sl, isSell, minRR);
      if (!ok) {
        dropped++;
        const rr = rewardRiskRatio(entry, tp1, sl, isSell);
        console.log('Pick dropped (RR <', minRR + '):', pick.ticker, hz, side, 'RR=', rr != null ? rr.toFixed(2) : 'n/a');
      }
      return ok;
    });
  }
  if (dropped) console.log('filterDashDataByMinRR dropped', dropped, 'rows (minRR', minRR + ', minConf', PICKS_MIN_CONF + '%)');
  return out;
}

function filterDashDataByQuantTechMap(dashData, techMap, paneMap = DASH_PANE_MAP) {
  const out = {};
  for (const [pane, { hz, side }] of Object.entries(paneMap)) {
    out[pane] = (dashData[pane] || []).filter(pick => {
      const tech = techMap[pick.ticker];
      const sig = tech?.quantSignal?.[hz];
      // CRITICAL: if we have NO fresh signal (OHLCV fetch failed or the re-scan
      // timed out before reaching this name — common for slower international
      // symbols like .NS/.HK/.T), KEEP the already-validated pick rather than
      // silently dropping it. Dropping-on-missing-data was erasing every non-US
      // name whenever the boot re-validation ran out of its time budget, leaving
      // a US-only dashboard. A pick is only removed when fresh data ACTIVELY
      // contradicts it (action flipped or score fell below threshold).
      if (!sig) return true; // no fresh data → trust the existing pick
      pick[hz + 'Score'] = sig.buyScore ?? pick[hz + 'Score'];
      pick[hz + 'SellScore'] = sig.sellScore ?? pick[hz + 'SellScore'];
      pick[hz + 'Rating'] = sig.rating ?? pick[hz + 'Rating'];
      pick[hz + 'Action'] = sig.action ?? pick[hz + 'Action'];
      if (side === 'buy') {
        return sig.action === 'Buy' && (sig.buyScore || 0) >= 62 && !/SL cooldown/i.test(sig.tierLabel || '');
      }
      return sig.action === 'Sell' && (sig.sellScore || 0) >= 62;
    });
  }
  return out;
}

function countDashPickRemovals(before, after, paneMap = DASH_PANE_MAP) {
  let n = 0;
  for (const pane of Object.keys(paneMap)) {
    n += (before[pane] || []).length - (after[pane] || []).length;
  }
  return n;
}

/** Fast technicals map for pick filtering — uses techCache, no fundamentals fetch. */
async function getTechnicalsMapForSymbols(symbols, opts = {}) {
  const maxMs = opts.maxMs || 25000;
  const started = Date.now();
  const results = {};
  const uniq = [...new Set((symbols || []).filter(Boolean))];
  const chunkSize = 4;
  for (let off = 0; off < uniq.length; off += chunkSize) {
    if (Date.now() - started > maxMs) break;
    const slice = uniq.slice(off, off + chunkSize);
    await Promise.allSettled(slice.map(async sym => {
      try {
        const cached = techCache.get(sym);
        if (cached && Date.now() - cached.ts < TECH_TTL && cached.data?.quantSignal) {
          results[sym] = cached.data;
          return;
        }
        let daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
        if (!daily || daily.length < 100) daily = await fetchOHLCV(sym, '1y', '1d').catch(() => null);
        if (!daily || daily.length < 20) return;
        const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
        const data = buildFullTechResult(sym, daily, weekly);
        const fundEntry = fundCache.get(sym);
        const fund = fundEntry && Date.now() - fundEntry.ts < TECH_TTL * 4 ? fundEntry.data : null;
        data._sectorRegime = sectorRegimeForSymbol(sym); // sector-level momentum tide
        data._earningsTide = earningsTideForSymbol(sym); // peer quarterly-results tide
        data.quantSignal = {
          short: computeQuantSignal(data, fund, 'short'),
          medium: computeQuantSignal(data, fund, 'medium'),
          long: computeQuantSignal(data, fund, 'long')
        };
        await applyMarketTierOverlays(sym, data, { batchMode: true, fundPre: fund });
        applySLCooldownGate(sym, data);
        techCache.set(sym, { ts: Date.now(), data });
        results[sym] = data;
      } catch (e) {
        console.warn('getTechnicalsMapForSymbols', sym, e.message);
      }
    }));
  }
  return results;
}

/**
 * One-time legacy fix: trades created before horizon SL floors existed have stops only
 * ~0.5–1% from entry, so they "hit SL" on noise. Re-floor levels for every record and,
 * for closed sl_hit rows whose stop was clearly too tight, reopen them for honest re-evaluation.
 */
function migrateLegacyTightStops() {
  let refloored = 0;
  let reopened = 0;
  for (const h of tradeHistory) {
    if (!isHistoryBuySellRecord(h)) continue;
    const hz = h.hz || 'short';
    const floor = HORIZON_MIN_PCT[hz] || HORIZON_MIN_PCT.short;
    const isSell = String(h.action || '').toLowerCase() === 'sell';
    const entry = parseFloat(h[hz + 'Entry'] || h.entry || 0);
    if (!entry || !Number.isFinite(entry)) continue;
    const sl = parseFloat(h[hz + 'StopLoss'] || h.stopLoss || 0);
    if (!sl || !Number.isFinite(sl)) continue;
    const slDistPct = Math.abs(sl - entry) / entry;
    // "Too tight" = stop sits well inside the horizon minimum (allow 10% tolerance).
    if (slDistPct >= floor.sl * 0.9) continue;

    const tp1 = parseFloat(h[hz + 'Target1'] || h.target1 || 0) || null;
    const tp2 = parseFloat(h[hz + 'Target2'] || h.target2 || 0) || null;
    const fixed = applyHorizonMinPctFloors(entry, tp1, tp2, sl, isSell, hz);
    h[hz + 'Target1'] = fixed.tp1;
    h[hz + 'Target2'] = fixed.tp2; // TP2 = REFERENCE level only (exit-quality analysis) — never an exit
    h[hz + 'StopLoss'] = fixed.sl;
    if (h.hz === hz || !h.hz) {
      h.target1 = fixed.tp1;
      h.target2 = fixed.tp2;
      h.stopLoss = fixed.sl;
    }
    if (isSell) { h.sellTarget1 = fixed.tp1; h.sellTarget2 = fixed.tp2; h.sellStopLoss = fixed.sl; }
    refloored++;

    // Reopen trades that were stopped out on the bogus tight stop so refresh-pnl re-evaluates them.
    if ((h[hz + 'Status'] || '') === 'sl_hit') {
      h[hz + 'Status'] = 'open';
      h[hz + 'ExitPrice'] = '';
      h[hz + 'PnlDollar'] = null;
      h[hz + 'PnlPct'] = null;
      if (h.hz === hz || !h.hz) { h.status = 'open'; h.pnlDollar = null; h.pnlPct = null; }
      reopened++;
    }
  }
  if (refloored > 0) {
    saveHistoryFile(tradeHistory);
    console.log('Legacy tight-stop migration: re-floored', refloored, 'rows, reopened', reopened, 'mis-stopped trades');
  }
  return { refloored, reopened };
}

function purgeOpenCooldownBuysFromHistory() {
  const today = singaporeToDateString();
  const before = tradeHistory.length;
  tradeHistory = tradeHistory.filter(h => {
    if (!isHistoryBuySellRecord(h)) return true;
    const hz = h.hz || 'short';
    const isToday = historyTradeEntryDay(h) === today;
    const st = h[hz + 'Status'] || h.status || 'open';
    const isOpen = st === 'open';
    const isBuy = String(h.action || '').toLowerCase() !== 'sell';
    if (isToday && isOpen && isBuy && isSLCooldownActive(h.ticker, hz)) return false;
    return true;
  });
  const removed = before - tradeHistory.length;
  if (removed > 0) {
    saveHistoryFile(tradeHistory);
    console.log('Purged', removed, 'open SL-cooldown buy(s) from today history');
  }
  return removed;
}

/**
 * History Live clutter: close open Buy/Sell rows that are neither
 *  • still held in the latest IB paper snapshot, nor
 *  • on today's dashboard board, nor
 *  • still open on the IBKR fill ledger, nor
 *  • entered today (SGT) — grace for OPG / not-yet-filled board picks.
 */
function pruneStaleOpenHistoryRows() {
  const OPEN_ST = new Set(['open', 'tp1_open', 'pending', '']);
  const todayLong = singaporeToDateString();

  const keep = new Set();
  const addKeep = (t) => {
    for (const a of ibkrYahooAliases(t)) keep.add(String(a).toUpperCase());
  };

  try {
    const recon = loadIbkrReconReport();
    for (const p of (recon && recon.positions) || []) {
      if (p && p.ticker && Number(p.qty)) addKeep(p.ticker);
    }
  } catch (_) { /* recon optional on first boot */ }

  try {
    const cached = loadDashboardPicksFile() || dashboardPicksCache;
    for (const t of collectDashTickers(cached && cached.dashData)) addKeep(t);
  } catch (_) { /* board optional */ }

  try {
    for (const o of aggregateIbkrOpenFromFills(readIbkrFillRows())) {
      if (o && o.ticker && o.openQty > 0) addKeep(o.ticker);
    }
  } catch (_) { /* fills optional */ }

  // If we have no keep anchors yet (no recon + empty board), do not mass-close.
  if (keep.size === 0) return 0;

  let closed = 0;
  for (const h of tradeHistory) {
    if (!h || !h.ticker) continue;
    const entryDay = historyTradeEntryDay(h);
    if (entryDay === todayLong) continue;

    for (const hz of ['short', 'medium', 'long']) {
      const act = String(h[hz + 'Action'] || (hz === (h.hz || 'short') ? h.action : '') || '').toLowerCase();
      if (act !== 'buy' && act !== 'sell') continue;
      const st = String(h[hz + 'Status'] || (hz === (h.hz || 'short') ? h.status : '') || 'open').toLowerCase();
      if (!OPEN_ST.has(st)) continue;

      const y = String(h.ticker || '').toUpperCase();
      if ([...ibkrYahooAliases(y)].some(a => keep.has(String(a).toUpperCase()))) continue;

      h[hz + 'Status'] = 'signal_exit';
      h[hz + 'ExitReason'] = 'Stale open — not in IB paper and not on today\'s board';
      if (h[hz + 'ExitPrice'] == null && h[hz + 'Entry'] != null) {
        // No invented PnL — mark flat at entry so Realised view is honest.
        h[hz + 'ExitPrice'] = Number(h[hz + 'Entry']) || null;
        h[hz + 'PnlDollar'] = 0;
        h[hz + 'PnlPct'] = 0;
      }
      if (!h[hz + 'ExitTs']) h[hz + 'ExitTs'] = Date.now();
      if (!h[hz + 'SettledTs']) {
        h[hz + 'SettledTs'] = Date.now();
        try {
          emitTradeEvent('exit', tradeEventSnapshot(h, hz, { exitReason: h[hz + 'ExitReason'] }));
        } catch (_) { /* best-effort */ }
      }
      if (hz === (h.hz || 'short')) h.status = 'signal_exit';
      closed++;
    }
  }
  if (closed > 0) {
    saveHistoryFile(tradeHistory);
    console.log('Pruned', closed, 'stale History open row(s) (not IB / not today\'s board)');
  }
  return closed;
}

function scanHistoryForSLCooldowns() {
  for (const h of tradeHistory) {
    if (!h?.ticker) continue;
    ['short', 'medium', 'long'].forEach(hz => {
      if ((h[hz + 'Status'] || '') === 'sl_hit') setSLCooldown(h.ticker, hz);
    });
  }
}

loadSLCooldowns();
loadDanelfinCache();
scanHistoryForSLCooldowns();
purgeOpenCooldownBuysFromHistory();

setTimeout(async function bootDashHistorySync() {
  try {
    migrateLegacyTightStops();
    const cached = loadDashboardPicksFile() || dashboardPicksCache;
    if (cached?.dashData) {
      let dd = filterDashDataBySLCooldown(cached.dashData);
      const beforeCount = countDashPicks(dd);
      const tickers = [...new Set(Object.keys(DASH_PANE_MAP).flatMap(k => (dd[k] || []).map(s => s.ticker).filter(Boolean)))];
      if (tickers.length) {
        const techMap = await getTechnicalsMapForSymbols(tickers, { maxMs: 45000 });
        const filtered = filterDashDataByQuantTechMap(dd, techMap);
        const afterCount = countDashPicks(filtered);
        // Deploy/restart must not gut the board when Yahoo/FMP flips many names
        // to Hold under a short time budget (looked like "no recommendations").
        const collapsed = beforeCount >= 3 && afterCount < Math.min(3, Math.ceil(beforeCount * 0.4));
        if (collapsed) {
          console.warn(
            'Boot: pick revalidation too destructive (', afterCount, 'vs', beforeCount,
            ') — keeping pre-filter board'
          );
        } else {
          dd = filtered;
        }
      }
      // CRITICAL: do NOT stamp dashTs=Date.now() here. That made yesterday's
      // tickers look "fresh" after every deploy/restart and tricked operators
      // (and previously the scheduler) into thinking the morning regen had run.
      dashboardPicksCache = {
        version: DASHBOARD_PICKS_VERSION,
        schemaVersion: cached.schemaVersion || 1,
        dashTs: cached.dashTs || null,
        filteredAt: Date.now(),
        dashData: sanitizeDashDataForServer(dd)
      };
      saveDashboardPicksFile(dashboardPicksCache);
      console.log('Boot: dashboard picks filtered (dashTs preserved', dashboardPicksCache.dashTs, ') →', dashboardPicksSummary(dd));
    }
    purgeOpenCooldownBuysFromHistory();
    try { pruneStaleOpenHistoryRows(); } catch (e2) {
      console.warn('Boot history prune:', e2.message);
    }
  } catch (e) {
    console.warn('Boot dash/history sync:', e.message);
  }
}, 4000);

// ── Pick / universe scan scheduler ───────────────────────────────────────────
// Cadence (Asia/Singapore — user local morning):
//   • 04:45 SGT — universe rescan kicks off (fresh candidates for the day).
//   • ≥05:00 SGT — regenerate picks so Japan names (Tokyo opens 08:00 SGT) are
//     on the board and at IBKR well before the open.
//   • Also force-regen if picks are >20h old (catches missed ticks / failed runs).
//   • SHORTLIST — rebuild when older than UNIVERSE_SHORTLIST_TTL (20h).
// Singapore is always UTC+8 (no DST).
// NOTE: this only fires while the server process is awake. On Render free tier
// the service spins down without inbound traffic — the ibkr-bridge polling
// every 15s doubles as the keep-alive, so keep the bridge running overnight.
const PICKS_REFRESH_HOUR_SGT = Math.max(0, Math.min(23, parseInt(process.env.PICKS_REFRESH_HOUR_SGT || '5', 10) || 5));
const SCAN_PRE_MINUTES_SGT = 4 * 60 + 45; // 04:45 SGT universe rescan
const PICKS_MAX_AGE_MS = Math.max(6, parseInt(process.env.PICKS_MAX_AGE_HOURS || '20', 10) || 20) * 60 * 60 * 1000;
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
function singaporeParts(ms = Date.now()) {
  const sgt = new Date(ms + SGT_OFFSET_MS);
  return {
    key: sgt.toISOString().slice(0, 10), // YYYY-MM-DD in SGT
    hour: sgt.getUTCHours(),
    minute: sgt.getUTCMinutes()
  };
}
function singaporeDateKey(ms = Date.now()) { return singaporeParts(ms).key; }

/** Same shape as Date#toDateString(), but always in Asia/Singapore (UTC+8).
 *  IBKR trade keys and history day matching must not depend on the host TZ
 *  (Render=UTC vs bridge PC=SGT was splitting "today" across two calendar days). */
function singaporeToDateString(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('weekday')} ${get('month')} ${get('day')} ${get('year')}`;
}

// Seed from last REAL generation time (not boot filter stamps).
let _lastPicksDateKey = (dashboardPicksCache && dashboardPicksCache.dashTs)
  ? singaporeDateKey(dashboardPicksCache.dashTs) : null;

async function scanSchedulerTick(boot = false) {
  try {
    if (universeScanState.running || serverPicksGenerating) return;
    const now = Date.now();
    const { key: todayKey, hour, minute } = singaporeParts(now);
    const sgtMinutes = hour * 60 + minute;
    const picksTs = dashboardPicksCache && dashboardPicksCache.dashTs ? Number(dashboardPicksCache.dashTs) : 0;
    const picksAge = picksTs > 0 ? (now - picksTs) : Infinity;
    const shortlistStale = !universeShortlist
      || (now - (universeShortlist.ts || 0)) > UNIVERSE_SHORTLIST_TTL_MS;

    // Refresh the candidate universe ~daily (was 7d — left shortlist stale for a week).
    if (shortlistStale) {
      console.log('Scheduler: universe shortlist stale → rescan (reason=', boot ? 'boot' : 'daily-shortlist', ')');
      runUniverseScan({ reason: boot ? 'boot' : 'daily-shortlist' });
      // Fall through: still regen picks from the current shortlist so the morning
      // board updates even while the heavy universe scan is running.
    }

    const pastRefreshHour = sgtMinutes >= PICKS_REFRESH_HOUR_SGT * 60;
    const pastScanTime = sgtMinutes >= SCAN_PRE_MINUTES_SGT;
    const newSgtDay = _lastPicksDateKey !== todayKey;
    const overdue = picksAge > PICKS_MAX_AGE_MS;

    // 04:45 SGT (or overdue): refresh the universe pool on a new SGT day so
    // we are not re-ranking yesterday's shortlist into the same top-5 forever.
    // Runs BEFORE the 05:00 picks regen so the board is built from fresh candidates.
    if (pastScanTime && newSgtDay && !shortlistStale && !universeScanState.running) {
      console.log('Scheduler: new SGT morning (04:45+) → universe rescan for fresh candidates');
      runUniverseScan({ reason: 'morning' });
    }

    // Morning (or overdue) picks regeneration — only mark the day done on SUCCESS.
    if ((pastRefreshHour && newSgtDay) || overdue) {
      console.log(
        'Scheduler: regenerating picks',
        JSON.stringify({
          sgtDay: todayKey,
          sgtHour: hour,
          lastKey: _lastPicksDateKey,
          picksAgeH: Number.isFinite(picksAge) ? +(picksAge / 3600000).toFixed(1) : null,
          overdue,
          boot,
          rotationH: PICKS_ROTATION_HOURS
        })
      );
      const r = await generateServerPicksFromShortlist().catch(e => ({ ok: false, error: e.message }));
      if (r && r.ok) {
        _lastPicksDateKey = todayKey;
        console.log('Scheduler: picks regenerated OK →', r.summary, r.prevSummary ? `| was: ${r.prevSummary}` : '');
      } else {
        console.warn('Scheduler: picks regen failed — will retry next tick:', r && (r.error || r.reason));
      }
    }
  } catch (e) { console.warn('scanSchedulerTick:', e.message); }
}

// Initial kick once the heavier boot sync has settled, then poll every 5 min
// so the 05:00 SGT board lands by ~05:05 and failed attempts retry quickly
// before the Tokyo open (08:00 SGT).
setTimeout(() => scanSchedulerTick(true), 30000);
setInterval(() => scanSchedulerTick(false), 5 * 60 * 1000);

// Manual / client-triggered picks regeneration (does not wait for the clock).
app.post('/api/dashboard/picks/regen', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    if (serverPicksGenerating) {
      return res.json({ ok: false, reason: 'already generating', dashTs: dashboardPicksCache && dashboardPicksCache.dashTs });
    }
    const body = req.body || {};
    const forceUniverse = body.forceUniverse === true || req.query.forceUniverse === '1';
    if (forceUniverse && !universeScanState.running) {
      runUniverseScan({ reason: 'manual-regen' });
    }
    if (!universeShortlistTickers().length && !universeScanState.running) {
      runUniverseScan({ reason: 'regen-no-shortlist' });
      return res.json({ ok: false, reason: 'no shortlist — universe scan started', scan: universeScanState });
    }
    const r = await generateServerPicksFromShortlist({
      maxMs: 240000,
      allowRepeat: body.allowRepeat === true
    });
    if (r && r.ok) _lastPicksDateKey = singaporeDateKey();
    const d = dashboardPicksCache;
    res.json({
      ok: !!(r && r.ok),
      reason: r && (r.reason || r.error) || null,
      summary: r && r.summary || null,
      prevSummary: r && r.prevSummary || null,
      rotatedOff: r && r.rotatedOff || [],
      cooldownSize: r && r.cooldownSize || 0,
      dashTs: (r && r.dashTs) || (d && d.dashTs) || null,
      sgtDay: singaporeDateKey(),
      lastPicksDateKey: _lastPicksDateKey,
      universeScanStarted: forceUniverse || false
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function countConsecutiveLowerCloses(daily) {
  if (!daily || daily.length < 2) return 0;
  let count = 0;
  for (let i = daily.length - 1; i >= 1; i--) {
    const c = daily[i].c ?? daily[i].close;
    const p = daily[i - 1].c ?? daily[i - 1].close;
    if (c == null || p == null) break;
    if (c < p) count++;
    else break;
  }
  return count;
}

/** Mirror of the above for the SELL side: how many days in a row the stock has
 *  CLOSED HIGHER. 3+ = an active rally — a terrible moment to open a new short. */
function countConsecutiveHigherCloses(daily) {
  if (!daily || daily.length < 2) return 0;
  let count = 0;
  for (let i = daily.length - 1; i >= 1; i--) {
    const c = daily[i].c ?? daily[i].close;
    const p = daily[i - 1].c ?? daily[i - 1].close;
    if (c == null || p == null) break;
    if (c > p) count++;
    else break;
  }
  return count;
}

function applyHorizonMinPctFloors(e, tp1, tp2, sl, isSell, hz) {
  const f = HORIZON_MIN_PCT[hz] || HORIZON_MIN_PCT.short;
  if (!e || !Number.isFinite(+e)) return { tp1, tp2, sl };
  e = +e;
  tp1 = tp1 != null ? +tp1 : null;
  tp2 = tp2 != null ? +tp2 : null;
  sl = sl != null ? +sl : null;

  if (isSell) {
    const minSl = e * (1 + f.sl);
    if (!Number.isFinite(sl) || sl < minSl) sl = roundPrice(minSl);
    // TP %-floors removed (f.tp1/tp2 = 0) — ATR/momentum set the targets.
    if (f.tp1 > 0) {
      const maxTp1 = e * (1 - f.tp1);
      if (!Number.isFinite(tp1) || tp1 > maxTp1) tp1 = roundPrice(maxTp1);
    }
    if (f.tp2 > 0) {
      const maxTp2 = e * (1 - f.tp2);
      if (!Number.isFinite(tp2) || tp2 > maxTp2) tp2 = roundPrice(maxTp2);
    }
  } else {
    const maxSl = e * (1 - f.sl);
    if (!Number.isFinite(sl) || sl > maxSl) sl = roundPrice(maxSl);
    if (f.tp1 > 0) {
      const minTp1 = e * (1 + f.tp1);
      if (!Number.isFinite(tp1) || tp1 < minTp1) tp1 = roundPrice(minTp1);
    }
    if (f.tp2 > 0) {
      const minTp2 = e * (1 + f.tp2);
      if (!Number.isFinite(tp2) || tp2 < minTp2) tp2 = roundPrice(minTp2);
    }
  }
  return enforceMinRiskReward(e, tp1, tp2, sl, isSell, f.minRR != null ? f.minRR : PICKS_MIN_RR);
}

function roundPrice(x) {
  if (x == null || Number.isNaN(x)) return x;
  const a = Math.abs(x);
  const d = a >= 100 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return +x.toFixed(d);
}

/** Concrete Entry / TP1 / TP2 / SL clause for recommended-trade reasons. */
function formatLevelsReasonClause(side, entry, tp1, tp2, sl) {
  const e = parseFloat(entry), t1 = parseFloat(tp1), t2 = parseFloat(tp2), s = parseFloat(sl);
  if (!(e > 0)) return '';
  const pct = (from, to) => {
    if (!(to > 0)) return '';
    const p = ((to - from) / from) * 100;
    const sign = p >= 0 ? '+' : '−';
    return ` (${sign}${Math.abs(p).toFixed(1)}%)`;
  };
  const isSell = String(side || '').toLowerCase() === 'sell';
  const parts = [`${isSell ? 'Sell' : 'Buy'} @ ${roundPrice(e)}`];
  if (t1 > 0) parts.push(`TP1 ${roundPrice(t1)}${pct(e, t1)}`);
  if (t2 > 0) parts.push(`TP2 ${roundPrice(t2)}${pct(e, t2)}`);
  if (s > 0) {
    parts.push(`SL ${roundPrice(s)}${pct(e, s)}`);
    const risk = Math.abs(e - s);
    const reward = t1 > 0 ? Math.abs(t1 - e) : 0;
    if (risk > 0 && reward > 0) parts.push(`R:R ${(reward / risk).toFixed(1)}x`);
  }
  return parts.join(' · ');
}

function buildTradeSpecificReason(row, hz, isSell) {
  const entry = isSell
    ? (row.sellEntry || row[hz + 'Entry'] || row.entry)
    : (row[hz + 'Entry'] || row.entry);
  const tp1 = isSell
    ? (row.sellTarget1 || row[hz + 'Target1'] || row.target1)
    : (row[hz + 'Target1'] || row.target1);
  const tp2 = isSell
    ? (row.sellTarget2 || row[hz + 'Target2'] || row.target2)
    : (row[hz + 'Target2'] || row.target2);
  const sl = isSell
    ? (row.sellStopLoss || row[hz + 'StopLoss'] || row.stopLoss)
    : (row[hz + 'StopLoss'] || row.stopLoss);
  const levels = formatLevelsReasonClause(isSell ? 'Sell' : 'Buy', entry, tp1, tp2, sl);
  const whyRaw = isSell
    ? (row[hz + 'SellAnalysis'] || row.sellReason || row[hz + 'Analysis'] || row.reason || '')
    : (row[hz + 'Analysis'] || row.reason || row.shortAnalysis || row.mediumAnalysis || row.longAnalysis || '');
  // Drop generic placeholders; keep concrete condition text.
  let why = String(whyRaw || '').trim();
  if (/^quant signal$/i.test(why) || /^setup note$/i.test(why)) why = '';
  // Avoid duplicating the levels line if a prior stamp already embedded it.
  if (levels && why && why.indexOf(levels) === 0) return why;
  if (levels && why && why.indexOf('TP1 ') >= 0 && why.indexOf('SL ') >= 0) {
    // Already levels-specific from a previous pass — keep as-is.
    return why;
  }
  if (levels && why) return levels + ' | ' + why;
  if (levels) {
    const rating = row[hz + 'Rating'] || row.rating || (isSell ? 'Sell' : 'Buy');
    const score = isSell ? (row[hz + 'SellScore'] || row.sellScore) : (row[hz + 'Score'] || row.buyScore);
    return levels + ' | ' + rating + (score != null ? ` (${score}/100)` : '') + ' — levels locked at signal.';
  }
  return why || '';
}

function stampDashDataReasons(dashData) {
  if (!dashData) return;
  const panes = [
    { key: 'short', hz: 'short', sell: false },
    { key: 'medium', hz: 'medium', sell: false },
    { key: 'long', hz: 'long', sell: false },
    { key: 'shortSell', hz: 'short', sell: true },
    { key: 'medSell', hz: 'medium', sell: true },
    { key: 'longSell', hz: 'long', sell: true }
  ];
  for (const p of panes) {
    for (const r of dashData[p.key] || []) {
      const text = buildTradeSpecificReason(r, p.hz, p.sell);
      if (!text) continue;
      if (p.sell) {
        r.sellReason = text;
        r[p.hz + 'SellAnalysis'] = text;
      } else {
        r.reason = text;
        r[p.hz + 'Analysis'] = text;
      }
    }
  }
}

/** Keep TP2 beyond TP1 only. Never invent TP1 to pass RR — filterDashDataByMinRR
 *  / levelsMeetMinRR drop setups below PICKS_MIN_RR (1.1:1 on TP1 vs SL). */
function enforceMinRiskReward(e, tp1, tp2, sl, isSell, _minRR = PICKS_MIN_RR) {
  if (!e || !Number.isFinite(+e)) return { tp1, tp2, sl };
  e = +e;
  tp1 = tp1 != null ? +tp1 : null;
  tp2 = tp2 != null ? +tp2 : null;
  sl = sl != null ? +sl : null;
  if (!Number.isFinite(tp1)) return { tp1, tp2, sl };
  if (isSell) {
    if (!Number.isFinite(tp2) || tp2 >= tp1) {
      tp2 = roundPrice(tp1 - Math.max(e * 0.004, Math.abs(e - tp1) * 0.35));
    }
  } else {
    if (!Number.isFinite(tp2) || tp2 <= tp1) {
      tp2 = roundPrice(tp1 + Math.max(e * 0.004, Math.abs(tp1 - e) * 0.35));
    }
  }
  return { tp1, tp2, sl };
}

function fixHistoryRecordMinRR(trade) {
  if (!trade || !trade.ticker) return trade;
  const hz = trade.hz || 'short';
  const isSell = String(trade.action || '').toLowerCase() === 'sell';
  const e = parseFloat(trade[hz + 'Entry'] || trade.entry);
  let tp1 = parseFloat(trade[hz + 'Target1'] || trade.target1);
  let tp2 = parseFloat(trade[hz + 'Target2'] || trade.target2);
  let sl = parseFloat(trade[hz + 'StopLoss'] || trade.stopLoss);
  if (!e || !Number.isFinite(e)) return trade;
  const fixed = applyHorizonMinPctFloors(e, tp1, tp2, sl, isSell, hz);
  trade[hz + 'Target1'] = String(roundPrice(fixed.tp1));
  trade[hz + 'Target2'] = String(roundPrice(fixed.tp2));
  trade[hz + 'StopLoss'] = String(roundPrice(fixed.sl));
  if (hz === 'short' || trade.target1 == null || trade.target1 === '') {
    trade.target1 = trade[hz + 'Target1'];
    trade.target2 = trade[hz + 'Target2'];
    trade.stopLoss = trade[hz + 'StopLoss'];
  }
  if (isSell) {
    trade.sellTarget1 = trade[hz + 'Target1'];
    trade.sellTarget2 = trade[hz + 'Target2'];
    trade.sellStopLoss = trade[hz + 'StopLoss'];
  }
  return trade;
}

/**
 * Professional entry/exit levels using real S/R levels as TP and SL anchors.
 * ATR used as minimum buffer and fallback. Analyst target used for long-term TP.
 *
 * SHORT  (1-3d):  SL = just below support1; TP1 = resistance1; TP2 = resistance2
 * MEDIUM (1-3wk): SL = below support2 or MA50; TP1 = resistance1-2; TP2 = prior high
 * LONG   (1-6mo): SL = below MA200; TP1 = analyst target (or resistance); TP2 = extended
 */
/**
 * Populate analysis-card technical fields from server-computed OHLC indicators.
 * Claude often omits RSI/MACD/volume/Bollinger even when prompts show them → UI showed "—".
 */
function injectAnalyzeRowFromServerTech(row, tech) {
  if (!row || !tech) return row;
  if (tech.rsi != null && Number.isFinite(+tech.rsi)) row.rsi = (+tech.rsi).toFixed(1);
  if (tech.macd?.trend) {
    const h =
      tech.macd.histogram != null && tech.macd.histogram !== ''
        ? ` (${+tech.macd.histogram})`
        : '';
    row.macd = `${String(tech.macd.trend).charAt(0).toUpperCase()}${String(tech.macd.trend).slice(1)}${h}`;
  }
  if (tech.trend20) row.trend = `${String(tech.trend20).charAt(0).toUpperCase()}${String(tech.trend20).slice(1)}`;
  if (tech.volume?.lastVolume != null && tech.volume.avgVolume) {
    const lv = tech.volume.lastVolume;
    const dayV =
      lv >= 1e9 ? `${(lv / 1e9).toFixed(2)}B` : lv >= 1e6 ? `${(lv / 1e6).toFixed(2)}M` : `${lv}`;
    const rel =
      tech.volume.relativeVolume != null ? `${tech.volume.relativeVolume}× avg` : 'rvol';
    const conf =
      tech.volume.confirmation && tech.volume.confirmation !== 'neutral'
        ? tech.volume.confirmation.replace(/_/g, ' ')
        : '';
    row.volume = conf ? `${dayV} (${rel}; ${conf})` : `${dayV} (${rel})`;
  }
  const fPrice = x => (x != null && Number.isFinite(+x) ? `$${(+x).toFixed(2)}` : '');
  row.support = fPrice(tech.support1) || row.support || '—';
  row.resistance = fPrice(tech.resistance1) || row.resistance || '—';
  const ma = ab =>
    ab === true ? 'above' : ab === false ? 'below' : ab == null ? '—' : 'at';
  row.ma20 = ma(tech.aboveMa20);
  row.ma50 = ma(tech.aboveMa50);
  row.ma200 = ma(tech.aboveMa200);
  if (tech.bb != null && tech.bbSignal != null) {
    const sig = String(tech.bbSignal).replace(/_/g, ' ');
    row.bollingerPos = `%B ${tech.bb.pct}% (${sig}); width ${tech.bb.width}% · mid $${tech.bb.middle}`;
    if (tech.bbSignal === 'near_lower_band') row.bollingerTone = 'bullish';
    else if (tech.bbSignal === 'near_upper_band') row.bollingerTone = 'bearish';
    else row.bollingerTone = 'neutral';
  }
  if (tech.candlePattern && isPlaceholderUiSlot(row.pattern)) row.pattern = tech.candlePattern;
  if (tech.fmpScore && typeof tech.fmpScore === 'object') row.fmpScore = tech.fmpScore;
  const pToneSrc = String(tech.candlePattern || row.pattern || '').toLowerCase();
  if (/bearish/.test(pToneSrc)) row.patternTone = 'bearish';
  else if (/bullish/.test(pToneSrc)) row.patternTone = 'bullish';
  else row.patternTone = 'neutral';
  return row;
}

/** SD channel + volume S/R entry / TP / SL (aligned with dashboard client math). */
/**
 * SINGLE WRITER for an open row's Buy/Sell action. Refuses Hold/blank when the
 * row is latched (open history Buy/Sell OR live emitted entry). New non-open
 * picks may still demote to Hold via Conf/RR gates.
 * @returns {boolean} true if the desired action was applied; false if refused.
 */
function isOpenRowLatched(row, hz) {
  if (!row || !hz) return false;
  if (row._freezeOpenAction) return true;
  if (row.ticker && typeof ibkrLiveEntrySide === 'function'
    && ibkrLiveEntrySide(row.ticker, hz, row.entryDate || row.timestamp)) {
    return true;
  }
  const openAct = String(row[hz + 'Action'] || ((row.hz || 'short') === hz ? row.action : '') || '').toLowerCase();
  // Explicit open status only — empty status = new board pick (may demote to Hold).
  const openSt = String(row[hz + 'Status'] || ((row.hz || 'short') === hz ? row.status : '') || '').toLowerCase();
  if ((openAct === 'buy' || openAct === 'sell')
    && (openSt === 'open' || openSt === 'tp1_open' || openSt === 'pending')) {
    return true;
  }
  return false;
}

function writeOpenRowAction(row, hz, desired) {
  if (!row || !hz) return false;
  const wantRaw = desired == null ? '' : String(desired);
  const want = wantRaw.toLowerCase();
  const isHoldOrBlank = !want || want === 'hold';
  const latched = isOpenRowLatched(row, hz);
  if (latched && isHoldOrBlank) {
    let keep = String(row[hz + 'Action'] || row.action || '');
    if (!/^buy$/i.test(keep) && !/^sell$/i.test(keep) && row.ticker
      && typeof ibkrLiveEntrySide === 'function') {
      const side = ibkrLiveEntrySide(row.ticker, hz, row.entryDate || row.timestamp);
      if (side === 'buy' || side === 'sell') keep = side === 'sell' ? 'Sell' : 'Buy';
    }
    if (/^buy$/i.test(keep) || /^sell$/i.test(keep)) {
      const keepAction = /^sell$/i.test(keep) ? 'Sell' : 'Buy';
      row[hz + 'Action'] = keepAction;
      if (String(row.hz || 'short') === hz) row.action = keepAction;
      row._freezeOpenAction = true;
    }
    return false;
  }
  const next = want === 'sell' ? 'Sell' : want === 'buy' ? 'Buy' : 'Hold';
  row[hz + 'Action'] = next;
  if (String(row.hz || 'short') === hz || (!row.hz && hz === 'short')) {
    row.action = next;
  }
  if (next === 'Buy' || next === 'Sell') {
    if (isOpenRowLatched(row, hz)) row._freezeOpenAction = true;
  }
  return true;
}

function applyServerPriceLevels(row, livePrice, tech = null, fund = null) {
  if (!row || !livePrice || livePrice <= 0) return row;
  const e = livePrice;
  const atr = tech?.atr || tech?.atr14 || null;
  const chan = tech?.channels || null;
  const d20 = chan?.daily20 || null;
  const d50 = chan?.daily50 || null;
  const w20 = chan?.weekly20 || null;
  const w50 = chan?.weekly50 || null;
  const s1 = tech?.support1 || null;
  const s2 = tech?.support2 || null;
  const r1 = tech?.resistance1 || null;
  const r2 = tech?.resistance2 || null;
  const s1conf = tech?.s1Confluence || false;
  const ma50 = tech?.ma50 || null;
  const ma200 = tech?.ma200 || null;
  const analystTarget = fund?.targetMeanPrice || fund?.targetMean || null;


  const actionKeys = { short: 'shortAction', medium: 'mediumAction', long: 'longAction' };

  for (const hz of ['short', 'medium', 'long']) {
    const act = String(row[actionKeys[hz]] || row.action || '').toLowerCase();
    if (act !== 'buy' && act !== 'sell') {
      // Never blank levels on a latched open horizon (even if action momentarily empty).
      if (isOpenRowLatched(row, hz)) continue;
      row[hz + 'Entry'] = row[hz + 'Target1'] = row[hz + 'Target2'] = row[hz + 'StopLoss'] = '';
      continue;
    }
    const isSell = act === 'sell';
    // All horizons: TP1/TP2 from ATR + momentum + structure; SL from trail/structure.
    // If TP1/SL cannot clear PICKS_MIN_RR (1.1:1), or confidence < 62%, do not recommend.
    // Demote only via writeOpenRowAction (refuses Hold on latched open rows).
    const clearHz = () => {
      if (!writeOpenRowAction(row, hz, 'Hold')) {
        row[hz + 'Entry'] = row[hz + 'Entry'] || '';
        return;
      }
      row[hz + 'Entry'] = row[hz + 'Target1'] = row[hz + 'Target2'] = row[hz + 'StopLoss'] = '';
    };
    const conf = Number(row[hz + 'Conf'] || row.conf || 0);
    if (conf > 0 && conf < PICKS_MIN_CONF) { clearHz(); continue; }
    const sl = hz === 'short'
      ? (computeMeanReversionLevels(tech, e, isSell) || {}).stop
      : computeTrailingStopFromTech(tech, e, hz, isSell, fund);
    const targets = computeAtrMomentumTargets(tech, e, hz, isSell);
    if (!sl || !targets.tp1) {
      // Short fallback: full mean-reversion package if ATR path missing tech
      if (hz === 'short') {
        const lv = computeMeanReversionLevels(tech, e, isSell);
        if (!lv) { clearHz(); continue; }
        const fl0 = applyHorizonMinPctFloors(e, lv.target, null, lv.stop, isSell, hz);
        const tp2s = computeSecondTargetFromTech(tech, e, hz, isSell, fl0.tp1);
        const fl = applyHorizonMinPctFloors(e, fl0.tp1, tp2s, fl0.sl, isSell, hz);
        if (!levelsMeetMinRR(e, fl.tp1, fl.sl, isSell, PICKS_MIN_RR)) { clearHz(); continue; }
        row[hz + 'Entry'] = String(roundPrice(e));
        row[hz + 'Target1'] = fl.tp1 != null ? String(fl.tp1) : '';
        row[hz + 'Target2'] = fl.tp2 != null ? String(fl.tp2) : '';
        row[hz + 'StopLoss'] = fl.sl != null ? String(fl.sl) : '';
        row[hz + 'TrailingSL'] = false;
        continue;
      }
      clearHz();
      continue;
    }
    const fl = applyHorizonMinPctFloors(e, targets.tp1, targets.tp2, sl, isSell, hz);
    if (!levelsMeetMinRR(e, fl.tp1, fl.sl, isSell, PICKS_MIN_RR)) { clearHz(); continue; }
    row[hz + 'Entry'] = String(roundPrice(e));
    row[hz + 'Target1'] = fl.tp1 != null ? String(fl.tp1) : '';
    row[hz + 'Target2'] = fl.tp2 != null ? String(fl.tp2) : '';
    row[hz + 'StopLoss'] = fl.sl != null ? String(fl.sl) : '';
    row[hz + 'TrailingSL'] = hz !== 'short';
  }

  row.entry = row.shortEntry;
  row.target1 = row.shortTarget1;
  row.target2 = row.shortTarget2;
  row.stopLoss = row.shortStopLoss;

  const mainSell = String(row.shortAction || row.action || '').toLowerCase() === 'sell';
  if (mainSell) {
    row.sellEntry = row.shortEntry;
    row.sellTarget1 = row.shortTarget1;
    row.sellTarget2 = row.shortTarget2;
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
  const apiKey = anthropicApiKey();
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
  const techBySym = {}, ohlcvBySym = {}, weeklyBySym = {};
  await Promise.all(
    clean.filter(s => priceBySym[s]).map(async sym => {
      try {
        const got = await pickDailyWeeklyForAnalyze(sym);
        if (got?.daily) {
          techBySym[sym]  = buildFullTechResult(sym, got.daily, got.weekly);
          ohlcvBySym[sym] = got.daily;
          weeklyBySym[sym] = got.weekly;
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
    // Fast path: one short-horizon walk-forward on the ~5y window
    // (BACKTEST_WINDOW_BARS). One short-horizon pass with a modest entryStep
    // keeps Analyze responsive; full 3-horizon stays on the dashboard path.
    let btShort = null, btMedium = null, btLong = null;
    try {
      const btOpts = { windowBars: BACKTEST_WINDOW_BARS, entryStep: 3 };
      btShort = ohlcv ? await backtestSignal(ohlcv, 'short', weeklyBySym[sym], fund, btOpts) : null;
      // Medium/long reuse short stats as a hint when history is thin; full
      // multi-horizon backtest stays on the dashboard / dedicated endpoint.
      btMedium = btShort;
      btLong = btShort;
    } catch (e) {
      console.warn('backtest failed for', sym, '-', e.message);
    }
    if (tech) {
      tech._supertrendBacktestWR = btShort?.supertrendWinRate ?? null;
    }
    const sigShort  = computeQuantSignal(tech, fund, 'short');
    const sigMedium = computeQuantSignal(tech, fund, 'medium');
    const sigLong   = computeQuantSignal(tech, fund, 'long');
    signalBySym[sym] = {
      short:  { ...sigShort,  backtest: btShort  },
      medium: { ...sigMedium, backtest: btMedium },
      long:   { ...sigLong,   backtest: btLong   },
    };
    console.log(`${sym}: short ${sigShort.action}(${sigShort.buyScore}/${sigShort.sellScore}) bt=${btShort?.winRate??'N/A'}% ${btShort?.trades??0}trades`);
  }

  await Promise.all(
    clean.map(async sym => {
      const tech = techBySym[sym];
      const fund = fundBySym[sym] || null;
      const sig = signalBySym[sym];
      if (!tech || !sig) return;
      const shell = {
        quantSignal: {
          short: sig.short,
          medium: sig.medium,
          long: sig.long
        },
        channelPos: tech.channelPos
      };
      await applyMarketTierOverlays(sym, shell, { batchMode: true, fundPre: fund });
      if (shell.fmpScore) sig.fmpScore = shell.fmpScore;
      if (shell.danelfin) sig.danelfin = shell.danelfin;
    })
  );

  // Fast default: skip Claude prose and build the card from quant signals.
  // Pass { skipAi: false } to keep the old Haiku narrative path.
  const skipAi = req.body?.skipAi !== false;
  if (skipAi) {
    const stocks = await Promise.all(requestedWithPrice.filter(s => signalBySym[s]).map(async sym => {
      const pq = priceBySym[sym];
      const tech = techBySym[sym];
      const fund = fundBySym[sym] || null;
      const sig = signalBySym[sym];
      const cond = (sig.short.conditions || []).slice(0, 4).join('; ') || 'Quant signal';
      let row = {
        ticker: sym,
        name: fund?.longName || fund?.shortName || sym,
        sector: fund?.sector || fund?._fmpSector || '',
        action: sig.short.action,
        shortAnalysis: cond,
        mediumAnalysis: (sig.medium.conditions || []).slice(0, 3).join('; ') || cond,
        longAnalysis: (sig.long.conditions || []).slice(0, 3).join('; ') || cond,
        sellReason: sig.short.action === 'Sell' || sig.short.action === 'Strong Sell' ? cond : '',
        risks: [],
        catalyst: '',
        momentum: tech?.macd?.trend === 'bullish' ? 'Bullish' : tech?.macd?.trend === 'bearish' ? 'Bearish' : 'Neutral',
        price: String(pq.price),
        change: pq.change != null ? String(pq.change) : ''
      };
      row.shortScore = sig.short.buyScore;
      row.mediumScore = sig.medium.buyScore;
      row.longScore = sig.long.buyScore;
      row.shortSellScore = sig.short.sellScore;
      row.mediumSellScore = sig.medium.sellScore;
      row.longSellScore = sig.long.sellScore;
      row.shortRating = sig.short.rating;
      row.mediumRating = sig.medium.rating;
      row.longRating = sig.long.rating;
      row.shortAction = sig.short.action;
      row.mediumAction = sig.medium.action;
      row.longAction = sig.long.action;
      const btS = sig.short.backtest;
      row.backtestedWinRate = btS ? btS.winRate : sig.short.winRateHint;
      row.backtestTrades = btS?.trades ?? null;
      row.backtestAvgReturn = btS?.avgReturnPct ?? null;
      row.quantConditions = sig.short.conditions;
      if (sig.fmpScore) row.fmpScore = sig.fmpScore;
      if (sig.danelfin) {
        row.danelfinAiScore = sig.danelfin.aiscore;
        row.danelfinTechnical = sig.danelfin.technical;
        row.danelfinFundamental = sig.danelfin.fundamental;
        row.danelfinSentiment = sig.danelfin.sentiment;
      }
      row = applyServerPriceLevels(row, +pq.price, tech || null, fund || null);
      mergeFundamentalsForUi(row, fund || null);
      injectAnalyzeRowFromServerTech(row, tech || null);
      // Always attach a levels-specific reason so recommended/export views never blank.
      const act = String(row.shortAction || row.action || '').toLowerCase();
      const isSellRow = act === 'sell' || act === 'strong sell';
      const stamped = buildTradeSpecificReason(row, 'short', isSellRow);
      if (stamped) {
        row.reason = stamped;
        if (isSellRow) row.sellReason = stamped;
        row.shortAnalysis = stamped;
        if (row.mediumAnalysis) row.mediumAnalysis = buildTradeSpecificReason(row, 'medium', String(row.mediumAction || '').toLowerCase().includes('sell')) || row.mediumAnalysis;
        if (row.longAnalysis) row.longAnalysis = buildTradeSpecificReason(row, 'long', String(row.longAction || '').toLowerCase().includes('sell')) || row.longAnalysis;
      }
      return row;
    }));
    console.log(`Analyze FAST: ${stocks.length} tickers (skipAi)`);
    return res.json({ stocks, fast: true });
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

BACKTEST / HISTORICAL PERFORMANCE (read carefully — reference in prose when helpful):
• "Real backtest" lines are causal walk-forward: at each simulated day only past OHLC/volume exists; support/resistance are recomputed from that slice only; only one hypothetical position runs at a time until exit then the next eligible signal day.
• Results are illustrative, out-of-sample style, not guarantees. With fewer than ~15 closed trades they are statistically noisy — if trades are low or avg return sharply negative despite a bullish rating, say so plainly (range-bound regime / whipsaw) instead of implying strong historical edge.

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
          + 'The server provides backtest win rates from a causal walk-forward simulation (no lookahead). '
          + 'Treat very low trade counts or negative average trade return as a warning about regime mismatch, not silent endorsement. '
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

    stocks = alignAiStockRowsToRequestedTickers(stocks, requestedWithPrice);
    if (!stocks.length) {
      return res.status(500).json({
        error: 'Analysis JSON tickers did not match requested symbols',
        preview: aiText.slice(0, 200)
      });
    }

    // ── Merge server signals + prices — override Claude's scores ────────────────
    stocks = await Promise.all(stocks.map(async row => {
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
        const btS=sig.short.backtest, btM=sig.medium.backtest, btL=sig.long.backtest;
        row.backtestShortWinRate  = btS ? btS.winRate : sig.short.winRateHint;
        row.backtestMediumWinRate = btM ? btM.winRate : sig.medium.winRateHint;
        row.backtestLongWinRate   = btL ? btL.winRate : sig.long.winRateHint;
        row.backtestShortTrades   = btS?.trades ?? null;
        row.backtestMediumTrades  = btM?.trades ?? null;
        row.backtestLongTrades    = btL?.trades ?? null;
        const bt = btS;
        row.backtestedWinRate = row.backtestShortWinRate;
        row.backtestTrades    = btS?.trades ?? null;
        row.backtestAvgReturn = btS?.avgReturnPct ?? null;
        row.backtestMedium    = row.backtestMediumWinRate;
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
      injectAnalyzeRowFromServerTech(mergedRow, tech || null);

      if (sig?.fmpScore) mergedRow.fmpScore = sig.fmpScore;
      else {
        const _mktAn = classifyMarket(sym);
        if (_mktAn.tier === 'fmp_quality' || (_mktAn.tier === 'danelfin_eu' && _mktAn.fmp)) {
          try {
            const _fmpR = await fetchFmpScore(sym);
            if (_fmpR && typeof _fmpR === 'object') mergedRow.fmpScore = _fmpR;
          } catch (_) {
            /* optional */
          }
        }
      }

      const dk = (process.env.DANELFIN_API_KEY || '').trim();
      if (sig?.danelfin) {
        mergedRow.danelfinAiScore = sig.danelfin.aiscore;
        mergedRow.danelfinTechnical = sig.danelfin.technical;
        mergedRow.danelfinFundamental = sig.danelfin.fundamental;
        mergedRow.danelfinSentiment = sig.danelfin.sentiment;
        mergedRow.danelfinLowRisk = sig.danelfin.low_risk;
        mergedRow.danelfinBuyTrack = sig.danelfin.buy_track_record;
      } else if (dk && !sym.includes('=F') && !sym.includes('-USD') && !sym.includes('-EUR')) {
        const df = await cachedDanelfinRow(dk, sym);
        if (df && df.aiscore != null) {
          mergedRow.danelfinAiScore = df.aiscore;
          mergedRow.danelfinTechnical = df.technical;
          mergedRow.danelfinFundamental = df.fundamental;
          mergedRow.danelfinSentiment = df.sentiment;
          mergedRow.danelfinLowRisk = df.low_risk;
          mergedRow.danelfinBuyTrack = df.buy_track_record;
        }
      }

      await augmentNewsImpactFromFinnhub(sym, mergedRow);
      return mergedRow;
    }));

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
let calCacheKey = '';

app.get('/api/earnings-calendar', async (req, res) => {
  const { fromISO, endISO, windowSource } = resolveEarningsCalendarWindow(req);
  const rangeKey = `${fromISO}|${endISO}`;
  const mcapMinB = (() => {
    const n = parseFloat(String(req.query.mcapMin ?? '').trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, 2000);
  })();
  const topPerDay = (() => {
    const n = parseInt(String(req.query.topPerDay ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) return 0;
    return n;
  })();
  const cacheKey = `${rangeKey}|mcap:${mcapMinB}|top:${topPerDay}`;

  if (
    !req.query.force &&
    calCache &&
    calCacheKey === cacheKey &&
    Date.now() - calTs < 21600000
  ) {
    return res.json(calCache);
  }

  try {
    let merged = await mergedEarningsCalendarWidget(fromISO, endISO);
    const uniqTickers = [...new Set(merged.map((r) => r.ticker).filter(Boolean))];
    const needCaps = (mcapMinB > 0 || topPerDay > 0) && uniqTickers.length > 0;
    const capMap = needCaps ? await fetchYahooMarketCapsBulk(uniqTickers) : {};
    if (mcapMinB > 0 && merged.length) {
      const floorUsd = mcapMinB * 1e9;
      merged = merged.filter((r) => {
        const c = marketCapUsdForTicker(r.ticker, capMap);
        return c != null && c >= floorUsd;
      });
    }
    if (topPerDay > 0 && merged.length) {
      merged = sliceEarningsCalendarTopMcapPerDay(merged, capMap, topPerDay);
    }
    if (merged.length) {
      calCache = merged;
      calTs = Date.now();
      calCacheKey = cacheKey;
    } else {
      calCache = null;
      calTs = 0;
      calCacheKey = '';
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
  const apiKey = anthropicApiKey();
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
  const fromHeader = typeof raw === 'string' ? normalizeApiKeyString(raw) : '';
  if (fromHeader.startsWith('sk-ant-') && fromHeader.length > 24) return fromHeader;
  return anthropicApiKey();
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

// Recalibrate open trades using SD channel + volume S/R (replaces legacy ATR-only method)
app.post('/api/history/recalibrate-levels', async (req, res) => {
  const updated = [];
  const failed = [];
  const sinceMs = req.body?.since ? new Date(req.body.since).getTime() : 0;

  const openTickers = [...new Set(
    tradeHistory
      .filter(h => {
        const hz = h.hz || 'short';
        if ((h[hz + 'Status'] || h.status || 'open') !== 'open') return false;
        if (sinceMs && new Date(h.entryDate || h.timestamp || 0).getTime() < sinceMs) return false;
        return true;
      })
      .map(h => h.ticker)
      .filter(Boolean)
  )];

  console.log('Recalibrate channels: fetching tech for', openTickers.length, 'tickers');

  const techMap = {};
  await Promise.all(openTickers.map(async ticker => {
    try {
      let daily = await fetchOHLCV(ticker, '2y', '1d').catch(() => null);
      if (!daily || daily.length < 30) daily = await fetchOHLCV(ticker, '1y', '1d').catch(() => null);
      const weekly = await fetchOHLCV(ticker, '2y', '1wk').catch(() => null);
      if (daily && daily.length >= 30) techMap[ticker] = buildFullTechResult(ticker, daily, weekly);
    } catch (e) {
      console.warn('Recalibrate tech', ticker, e.message);
    }
  }));

  const fundMap = {};
  const equityTickers = openTickers.filter(t => !t.includes('=F') && !t.includes('-USD') && !t.includes('-EUR'));
  await Promise.all(equityTickers.map(async ticker => {
    try {
      const f = await fetchFundamentals(ticker);
      if (f) fundMap[ticker] = f;
    } catch (_) {}
  }));

  tradeHistory = tradeHistory.map(h => {
    const hz = h.hz || 'short';
    const status = h[hz + 'Status'] || h.status || 'open';
    if (status !== 'open') return h;
    if (sinceMs && new Date(h.entryDate || h.timestamp || 0).getTime() < sinceMs) return h;

    const ticker = h.ticker;
    const tech = techMap[ticker];
    const fund = fundMap[ticker] || null;
    if (!tech) {
      failed.push(ticker);
      return h;
    }

    const entryPrice = parseFloat(h[hz + 'Entry'] || h.entry || 0);
    if (!entryPrice) {
      failed.push(ticker);
      return h;
    }

    const tempRow = {
      ...h,
      shortRating: h.shortRating || (h.action === 'Sell' ? 'Sell' : 'Buy'),
      mediumRating: h.mediumRating || (h.action === 'Sell' ? 'Sell' : 'Buy'),
      longRating: h.longRating || (h.action === 'Sell' ? 'Sell' : 'Buy')
    };

    const recalibrated = applyServerPriceLevels(tempRow, entryPrice, tech, fund);
    updated.push(ticker);
    return recalibrated;
  });

  saveHistoryFile(tradeHistory);
  console.log('Recalibrate: updated', updated.length, 'open trades with channel-based levels');
  res.json({
    updated: updated.length,
    failed: failed.length,
    failedTickers: [...new Set(failed)],
    message: `Updated ${updated.length} open trade(s) with SD channel-based TP/SL and volume S/R levels.`
  });
});

// One-time cleanup: fix impossible entries in server history (must be before SPA GET *)
app.post('/api/history/cleanup-entries', async (req, res) => {
  let fixed = 0;
  // ── DEDUP STACKED OPENS ────────────────────────────────────────────────────
  // Before the no-repeat filter existed, the daily regen re-recommended the same
  // name day after day, stacking many concurrent $10k "positions" in one ticker/
  // direction. Those phantom duplicates multiply unrealised PnL and active-trade
  // counts. Keep the EARLIEST open per ticker|hz|direction (the real position);
  // REMOVE the rest entirely so they never pollute realised PnL or win rate.
  let deduped = 0;
  {
    const keepIdx = new Map(); // key → index of earliest open
    tradeHistory.forEach((t, i) => {
      if (!t || !t.ticker) return;
      const hz = t.hz || 'short';
      const status = t[hz + 'Status'] || t.status || 'open';
      if (status !== 'open') return;
      const key = String(t.ticker).toUpperCase() + '|' + hz + '|' + ((t.action || '').toLowerCase() === 'sell' ? 'S' : 'B');
      const ts = new Date(t.entryDate || t.timestamp || 0).getTime() || 0;
      const prev = keepIdx.get(key);
      if (!prev || ts < prev.ts) keepIdx.set(key, { i, ts });
    });
    const keep = new Set([...keepIdx.values()].map(v => v.i));
    const before = tradeHistory.length;
    tradeHistory = tradeHistory.filter((t, i) => {
      if (!t || !t.ticker) return true;
      const hz = t.hz || 'short';
      const status = t[hz + 'Status'] || t.status || 'open';
      if (status !== 'open') return true; // closed rows are untouched history
      const key = String(t.ticker).toUpperCase() + '|' + hz + '|' + ((t.action || '').toLowerCase() === 'sell' ? 'S' : 'B');
      return keep.has(i) || !keepIdx.has(key);
    });
    deduped = before - tradeHistory.length;
    if (deduped > 0) console.log('cleanup: removed ' + deduped + ' stacked duplicate open trades');
  }
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
  if (deduped > 0 || fixed > 0) saveHistoryFile(tradeHistory);
  res.json({ fixed, deduped, total: tradeHistory.length });
});


// POST /api/history/revalidate — refresh FMP/fundamentals analytics on history rows;
// removes only today's open trades that contradict current regime/signal. Runs on page load.
app.post('/api/history/revalidate', express.json(), async (req, res) => {
  const dryRun = req.body?.dryRun === true;
  const sinceMs = req.body?.since ? new Date(req.body.since).getTime() : 0;
  const caches = {};
  const removed = [];
  const errors = [];
  const toRemoveKeys = new Set();
  let enriched = 0;
  let skipped = 0;

  for (const trade of tradeHistory) {
    if (!isHistoryBuySellRecord(trade)) continue;
    const hz = trade.hz || 'short';
    const key = `${trade.ticker}|${hz}|${trade.entryDate || trade.timestamp || ''}`;
    if (sinceMs && new Date(trade.entryDate || trade.timestamp || 0).getTime() < sinceMs) {
      skipped++;
      continue;
    }

    const result = await enrichHistoryTradeRecord(trade, caches).catch(e => ({
      ok: false,
      trade,
      shell: null,
      reason: e.message
    }));

    if (!result.ok) {
      trade.revalidatedAt =
        trade.revalidatedAt || trade.entryDate || trade.timestamp || new Date().toISOString();
      trade.analyticsPartial = true;
      trade.analyticsError = result.reason || 'enrich failed';
      fixHistoryRecordMinRR(trade);
      errors.push({ ticker: trade.ticker, hz, reason: result.reason || 'enrich failed' });
      enriched++;
      continue;
    }
    enriched++;

    const isOpen = (trade[hz + 'Status'] || trade.status || 'open') === 'open';
    if (!isOpen) continue;

    if (shouldRemoveOpenHistoryTrade(trade, result.shell, hz)) {
      toRemoveKeys.add(key);
      const sig = result.shell.quantSignal[hz];
      removed.push({
        ticker: trade.ticker,
        hz,
        regime: sig?.regime || trade.quantRegime || 'neutral',
        action: trade.action,
        signal: sig?.action,
        buyScore: sig?.buyScore,
        sellScore: sig?.sellScore,
        reason:
          String(trade.action || '').toLowerCase() !== 'sell' && sig?.regime === 'bear'
            ? 'Long trade in BEAR regime'
            : String(trade.action || '').toLowerCase() === 'sell' && sig?.regime === 'bull'
              ? 'Short trade in BULL regime'
              : `Signal flipped: ${sig?.action}`
      });
    }
  }

  if (!dryRun) {
    const before = tradeHistory.length;
    tradeHistory = tradeHistory.filter(h => {
      if (!isHistoryBuySellRecord(h)) return true;
      const hz = h.hz || 'short';
      if ((h[hz + 'Status'] || h.status || 'open') !== 'open') return true;
      if (!isHistoryTradeFromToday(h)) return true;
      return !toRemoveKeys.has(`${h.ticker}|${hz}|${h.entryDate || h.timestamp || ''}`);
    });
    saveHistoryFile(tradeHistory);
    console.log(
      `Revalidate: enriched ${enriched}, removed ${removed.length}, kept ${tradeHistory.length} (was ${before})`
    );
  }

  res.json({
    dryRun,
    enriched,
    skipped,
    since: req.body?.since || null,
    removed,
    kept: dryRun
      ? tradeHistory.filter(h => isHistoryBuySellRecord(h)).length
      : tradeHistory.length,
    errors: errors.slice(0, 50),
    errorsTruncated: errors.length > 50,
    totalRemoved: removed.length
  });
});


function tradingDaysElapsedSinceEntryServer(entryDateOrIso) {
  const d0 = new Date(entryDateOrIso);
  if (Number.isNaN(d0.getTime())) return 0;
  const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
  const end = new Date();
  const endD = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let n = 0;
  for (let d = new Date(start); d <= endD; d.setDate(d.getDate() + 1)) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function horizonTimeLimitExceededServer(hz, entryDateOrIso) {
  if (hz === 'long') {
    const daysOld = (Date.now() - new Date(entryDateOrIso).getTime()) / 86400000;
    return daysOld >= 180;
  }
  const td = tradingDaysElapsedSinceEntryServer(entryDateOrIso);
  if (hz === 'short') return td >= 20;
  if (hz === 'medium') return td >= 63;
  return false;
}

/**
 * History P&L via the SHARED hybrid exit (TP1 partial + trailing remainder +
 * hysteresis signal-flip), so live trade outcomes match the backtest exactly.
 * Returns canonical status + blended return + representative exit price.
 */
async function simulateTradeExitTrailing(bars, entryMs, entry, hz, isSell, markPrice = null, liveMark = false, partialFrac = 0.5) {
  if (!Array.isArray(bars) || !bars.length || !entry) return null;
  const weeklyAll = dailyToWeeklyBars(bars);
  let startIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if ((bars[i].t || 0) * 1000 >= entryMs) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  const res = await simulateHybridExit(bars, startIdx, entry, hz, isSell, weeklyAll, null, markPrice, liveMark, partialFrac);
  if (!res) return null;
  // Preserve the hybrid engine's native status. The UI needs to distinguish
  // TP1 runner-live, TP1-then-TSL, TP1-then-time, signal exits, and SL exits.
  const status = res.status || 'open';
  const open = status === 'open' || status === 'tp1_open';
  return {
    status,
    ret: res.ret,
    exit: res.exitPrice,
    stopLoss: res.stopLoss,
    tp1Hit: !!res.tp1Hit,
    tp2AltRet: res.tp2AltRet,
    exitIdx: res.exitIdx,
    open
  };
}

function computeTpDonationAnalytics(bars, entryMs, hz, trade, isSell) {
  if (!Array.isArray(bars) || !bars.length || !trade) return null;
  const tp1 = parseFloat(trade[hz + 'Target1'] || trade.target1 || 0);
  const tp2 = parseFloat(trade[hz + 'Target2'] || trade.target2 || 0);
  const out = {
    tp1Hit: false,
    tp2Hit: false,
    tp1DonationPct: null,
    tp2DonationPct: null,
    tp1BestPrice: null,
    tp2BestPrice: null
  };
  if (!tp1 && !tp2) return out;
  let afterTp1Best = null;
  let afterTp2Best = null;
  for (const b of bars) {
    const bt = (b.t || 0) * 1000;
    if (bt < entryMs) continue;
    if (!isSell) {
      if (tp1 && b.h >= tp1) {
        out.tp1Hit = true;
        if (afterTp1Best == null || b.h > afterTp1Best) afterTp1Best = b.h;
      }
      if (tp2 && b.h >= tp2) {
        out.tp2Hit = true;
        if (afterTp2Best == null || b.h > afterTp2Best) afterTp2Best = b.h;
      }
    } else {
      if (tp1 && b.l <= tp1) {
        out.tp1Hit = true;
        if (afterTp1Best == null || b.l < afterTp1Best) afterTp1Best = b.l;
      }
      if (tp2 && b.l <= tp2) {
        out.tp2Hit = true;
        if (afterTp2Best == null || b.l < afterTp2Best) afterTp2Best = b.l;
      }
    }
  }
  if (out.tp1Hit && tp1 && afterTp1Best > 0) {
    out.tp1BestPrice = roundPrice(afterTp1Best);
    out.tp1DonationPct = !isSell
      ? +(((afterTp1Best - tp1) / tp1) * 100).toFixed(2)
      : +(((tp1 - afterTp1Best) / tp1) * 100).toFixed(2);
  }
  if (out.tp2Hit && tp2 && afterTp2Best > 0) {
    out.tp2BestPrice = roundPrice(afterTp2Best);
    out.tp2DonationPct = !isSell
      ? +(((afterTp2Best - tp2) / tp2) * 100).toFixed(2)
      : +(((tp2 - afterTp2Best) / tp2) * 100).toFixed(2);
  }
  return out;
}

/** Close an open position only on a TRUE reversal to the opposite side — a Buy
 *  whose live signal now reads an entry-grade Sell (or vice-versa). Softening to
 *  Hold is NOT an exit: we hold the position so normal conviction wobble never
 *  churns a good trade out near breakeven. (Reversal-only flip policy.) */
function liveSignalFlipExit(ticker, hz, isSell, techMap) {
  const tech = techMap?.[ticker];
  if (!tech?.quantSignal?.[hz]) return null;
  const sig = tech.quantSignal[hz];
  // REVERSAL-ONLY policy: close a position only when the OPPOSITE side becomes a
  // genuine, entry-grade signal (score >= 62, i.e. an actual Buy→Sell or Sell→Buy
  // reversal). We deliberately HOLD through any mere softening to Hold so a normal
  // wobble in conviction never churns a good position out at ~breakeven.
  const VALID = 62; // opposite side this strong → true reversal
  if (!isSell) {
    if ((sig.sellScore || 0) >= VALID) return { flipped: true, reason: 'Sell' };
  } else {
    if ((sig.buyScore || 0) >= VALID) return { flipped: true, reason: 'Buy' };
  }
  return null;
}

// Soft-close remediation must run AT MOST ONCE across deploys. An in-memory flag
// reset on every boot and reopened settled signal_exit / time_limit rows — which
// flipped closed months (e.g. 2026-06) from realised PnL back to open/unrealised
// and made Performance go negative. Persist the "already done" marker on disk.
const SOFT_CLOSE_FLAG = path.join(path.dirname(HISTORY_FILE), 'soft_close_remediated.flag');
let _softCloseRemediated = false;
try { _softCloseRemediated = fs.existsSync(SOFT_CLOSE_FLAG); } catch (_) {}
// (entry repair is now always-on per-trade via h.entryFinalized — no boot flag)
// One-time re-floor of still-OPEN trades to the v7.9.6 reward:risk model
// (TP1 ≥ minRR × stop distance). PERSISTED on the data disk like the soft-close
// flag — the old per-boot boolean re-ran on every deploy and kept rewriting
// live-row levels (and, before v144, kept re-blanking the TP2 reference).
const RR_REFLOOR_FLAG = path.join(path.dirname(HISTORY_FILE), 'rr_refloor_v2.flag');
let _rrRefloored = false;
try { _rrRefloored = fs.existsSync(RR_REFLOOR_FLAG); } catch (_) {}

// ── APPEND-ONLY HISTORY AUDIT LOG ────────────────────────────────────────────
// Every event that can change a trade's status or the history's composition is
// journalled to the data disk, so "why did this number move?" always has a
// concrete answer. Read back via GET /api/history/audit?limit=200.
const AUDIT_LOG_FILE = path.join(path.dirname(HISTORY_FILE), 'history_audit.log');
function auditLog(event, details) {
  try {
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify({ t: new Date().toISOString(), event, ...(details || {}) }) + '\n');
  } catch (_) {}
}

// ── IBKR PAPER BRIDGE: TRADE EVENT FEED ──────────────────────────────────────
// AlphaSignal stays the signal engine. A small bridge next to IB Gateway / TWS
// polls GET /api/ibkr/events and places native bracket orders. Events are
// append-only on the data disk so deploys don't lose the cursor.
const TRADE_EVENTS_FILE = path.join(path.dirname(HISTORY_FILE), 'trade_events.jsonl');
let _tradeEventSeq = 0;
try {
  if (fs.existsSync(TRADE_EVENTS_FILE)) {
    const lines = fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) {
      try { _tradeEventSeq = Number(JSON.parse(lines[lines.length - 1]).seq) || lines.length; }
      catch (_) { _tradeEventSeq = lines.length; }
    }
  }
} catch (_) {}

/** Dual-listed names that must not open two IBKR brackets for the same thesis.
 *  Resolved once via aliases + IB conId — not per-endpoint name collapses. */
const IBKR_LISTING_ALIASES = {
  'AIR.DE': ['AIR.PA'],
  'AIR.PA': ['AIR.DE']
};

function ibkrYahooAliases(ticker) {
  const y = String(ticker || '').toUpperCase();
  const out = new Set([y]);
  for (const a of (IBKR_LISTING_ALIASES[y] || [])) out.add(String(a).toUpperCase());
  return out;
}

/** Resolve IB position for a yahoo ticker via exact match, listing alias, or conId. */
function resolveIbPosForYahoo(yahoo, ibByY, ibByConId) {
  const y = String(yahoo || '').toUpperCase();
  if (ibByY && ibByY.has(y)) return ibByY.get(y);
  for (const a of ibkrYahooAliases(y)) {
    if (a !== y && ibByY && ibByY.has(a)) return ibByY.get(a);
  }
  if (ibByConId && ibByConId.size) {
    for (const [cid, canonY] of ibByConId) {
      if (!ibkrYahooAliases(y).has(String(canonY || '').toUpperCase())) continue;
      if (ibByY && ibByY.has(canonY)) return ibByY.get(canonY);
      // conId map may store yahoo string; look up any alias row with that conId
      for (const [ty, row] of ibByY || []) {
        if (Number(row && row.conId) === Number(cid)) return row;
        if (ibkrYahooAliases(ty).has(String(canonY || '').toUpperCase())) return row;
      }
    }
  }
  return null;
}

/**
 * AUTHORIZATION BY PROVENANCE: a position is authorized iff it maps to an open
 * emitted `entry` key (no `exit`) in trade_events — never by ticker identity lists.
 */
function hasOpenEmittedEntryForTicker(ticker) {
  const aliases = ibkrYahooAliases(ticker);
  try {
    if (!fs.existsSync(TRADE_EVENTS_FILE)) return false;
    const open = new Set();
    for (const line of fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || !e.key) continue;
      const t = String(e.key.split('|')[0] || '').toUpperCase();
      if (!aliases.has(t)) continue;
      if (e.type === 'entry') open.add(e.key);
      else if (e.type === 'exit') open.delete(e.key);
    }
    return open.size > 0;
  } catch (_) { return false; }
}

function isPositionAuthorizedByProvenance(ticker, hz, entryDate) {
  if (hz != null) {
    if (ibkrLiveEntrySide(ticker, hz, entryDate)) return true;
  }
  return hasOpenEmittedEntryForTicker(ticker);
}

function ibkrHzAction(h, hz) {
  const z = hz || h.hz || 'short';
  const a = String(h[z + 'Action'] || h.action || '').toLowerCase();
  if (a === 'buy' || a === 'sell') return a;
  return null;
}

function tradeEventSnapshot(h, hz, extra) {
  const z = hz || h.hz || 'short';
  const entryMs = Date.parse(h.entryDate || h.timestamp || Date.now());
  const keyDay = singaporeToDateString(Number.isFinite(entryMs) ? entryMs : Date.now());
  const act = ibkrHzAction(h, z);
  return {
    ticker: h.ticker,
    name: h.name || h.ticker,
    hz: z,
    // NEVER default Hold/unknown → buy (that mis-fired FSLR/BMY/CVX/MPC/HSBA/AIR).
    side: act === 'sell' ? 'sell' : (act === 'buy' ? 'buy' : null),
    entry: parseFloat(h[z + 'Entry'] || h.entry) || null,
    tp1: parseFloat(h[z + 'Target1'] || h.target1) || null,
    tp2: parseFloat(h[z + 'Target2'] || h.target2) || null,
    sl: parseFloat(h[z + 'StopLoss'] || h.stopLoss) || null,
    trailSl: h[z + 'LiveTrailSL'] != null
      ? parseFloat(h[z + 'LiveTrailSL']) : null,
    sharesTotal: h[z + 'SharesTotal'] ?? null,
    sharesSoldTp1: h[z + 'SharesSoldTP1'] ?? null,
    sharesRunner: h[z + 'SharesRunner'] ?? null,
    status: h[z + 'Status'] || h.status || null,
    exitPrice: h[z + 'ExitPrice'] != null
      ? parseFloat(h[z + 'ExitPrice']) : null,
    pnlDollar: h[z + 'PnlDollar'] ?? null,
    entryDate: h.entryDate || h.timestamp || null,
    key: `${h.ticker}|${z}|${keyDay}`,
    ...(extra || {})
  };
}

/** True if an open IBKR entry already exists for this key or a dual-list alias. */
function ibkrHasOpenEntryFor(ticker, hz, entryDate) {
  return !!ibkrLiveEntrySide(ticker, hz, entryDate);
}

/**
 * Emitted-entry LATCH: if an `entry` event exists with no `exit` for this
 * ticker|hz|SGT-day (or alias), return the side ('buy'|'sell'). Conf demote
 * must not rewrite these to Hold while the trade is live.
 */
function ibkrLiveEntrySide(ticker, hz, entryDate) {
  const entryMs = Date.parse(entryDate || Date.now());
  const keyDay = singaporeToDateString(Number.isFinite(entryMs) ? entryMs : Date.now());
  const aliases = new Set([String(ticker || '').toUpperCase()]);
  for (const a of (IBKR_LISTING_ALIASES[String(ticker || '').toUpperCase()] || [])) {
    aliases.add(String(a).toUpperCase());
  }
  const open = new Map(); // key -> side
  try {
    if (!fs.existsSync(TRADE_EVENTS_FILE)) return null;
    const lines = fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!e || !e.key) continue;
        const [t, ehz, day] = String(e.key).split('|');
        if (!aliases.has(String(t || '').toUpperCase())) continue;
        if (String(ehz) !== String(hz || 'short')) continue;
        if (day && day !== keyDay) continue;
        if (e.type === 'entry') open.set(e.key, e.side === 'sell' ? 'sell' : 'buy');
        else if (e.type === 'exit') open.delete(e.key);
      } catch (_) { /* skip */ }
    }
  } catch (_) { return null; }
  if (!open.size) return null;
  return open.values().next().value;
}

function shouldEmitIbkrEntry(trade, hz) {
  if (!trade || !isHistoryBuySellRecord(trade)) return false;
  if (isForceIbkrErrorTicker(trade.ticker)) {
    console.log('IBKR entry skipped (error-trade blocklist):', trade.ticker);
    return false;
  }
  const snap = tradeEventSnapshot(trade, hz);
  if (snap.side !== 'buy' && snap.side !== 'sell') return false;
  if (!(snap.entry > 0) || !(snap.sl > 0)) return false;
  const z = hz || trade.hz || 'short';
  const rating = trade[z + 'Rating'] || trade.rating || '';
  if (!isStrongRecommendableRating(rating)) {
    console.log('IBKR entry skipped (not Strong Buy/Sell):', snap.key, 'rating=', rating);
    return false;
  }
  const conf = Number(trade[z + 'Conf'] || trade.conf || 0);
  if (!(conf >= PICKS_MIN_CONF)) {
    console.log('IBKR entry skipped (Conf <', PICKS_MIN_CONF + '%):', snap.key, 'conf=', conf);
    return false;
  }
  // Require min RR when TP1 exists; reject null-TP1 entries (not recommendable).
  if (!(snap.tp1 > 0) || !levelsMeetMinRR(snap.entry, snap.tp1, snap.sl, snap.side === 'sell', PICKS_MIN_RR)) {
    return false;
  }
  if (ibkrHasOpenEntryFor(snap.ticker, snap.hz, snap.entryDate)) {
    console.log('IBKR entry skipped (open alias/duplicate):', snap.key);
    auditLog('ibkr_entry_blocked_alias', { key: snap.key, ticker: snap.ticker, hz: snap.hz });
    return false;
  }
  return true;
}

function emitTradeEvent(type, payload) {
  if (process.env.IBKR_EVENTS_ENABLED === '0') return null;
  if (type === 'entry') {
    if (!payload || (payload.side !== 'buy' && payload.side !== 'sell')) {
      console.log('IBKR entry skipped (not Buy/Sell):', payload && payload.key);
      return null;
    }
    if (!(payload.entry > 0) || !(payload.sl > 0)) {
      console.log('IBKR entry skipped (missing levels):', payload && payload.key);
      return null;
    }
  }
  _tradeEventSeq += 1;
  const evt = { seq: _tradeEventSeq, t: new Date().toISOString(), type, ...(payload || {}) };
  try {
    fs.appendFileSync(TRADE_EVENTS_FILE, JSON.stringify(evt) + '\n');
  } catch (e) {
    console.warn('trade event write failed:', e.message);
  }
  auditLog('trade_event', { type, seq: evt.seq, ticker: payload && payload.ticker, hz: payload && payload.hz });
  return evt;
}

/** Restore Buy/Sell on open history rows that were wrongly demoted to Hold after
 *  an IBKR entry event was already emitted (Conf gate / board refresh). */
function repairOpenHistoryActionsFromIbkrEvents() {
  const openSideByKey = new Map();
  try {
    if (!fs.existsSync(TRADE_EVENTS_FILE)) return 0;
    for (const line of fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n')) {
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || !e.key) continue;
      if (e.type === 'entry' && (e.side === 'buy' || e.side === 'sell')) openSideByKey.set(e.key, e.side);
      else if (e.type === 'exit') openSideByKey.delete(e.key);
    }
  } catch (_) { return 0; }
  let n = 0;
  for (const h of tradeHistory) {
    if (!h || !h.ticker) continue;
    const hz = h.hz || 'short';
    const st = String(h[hz + 'Status'] || h.status || 'open').toLowerCase();
    if (st && st !== 'open' && st !== 'tp1_open') continue;
    const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
    if (act === 'buy' || act === 'sell') continue;
    const day = historyTradeEntryDay(h);
    const key = `${h.ticker}|${hz}|${day}`;
    let side = openSideByKey.get(key);
    if (!side) {
      for (const [k, s] of openSideByKey) {
        const [t, ehz] = String(k).split('|');
        if (t === h.ticker && ehz === hz) { side = s; break; }
      }
    }
    if (!side) continue;
    const labeled = side === 'sell' ? 'Sell' : 'Buy';
    h.action = labeled;
    h[hz + 'Action'] = labeled;
    n++;
    auditLog('history_action_repaired_from_ibkr', { ticker: h.ticker, hz, side: labeled, key });
  }
  if (n) {
    saveHistoryFile(tradeHistory);
    console.log('Repaired', n, 'open history row(s) Hold→Buy/Sell from IBKR entry events');
  }
  return n;
}

try { repairOpenHistoryActionsFromIbkrEvents(); } catch (e) {
  console.warn('history action repair failed:', e.message);
}

/**
 * Restore open history rows wrongly demoted to Hold (levels wiped) when the
 * reason string still encodes the original Buy/Sell geometry
 * (e.g. "Buy @ 302.25 · TP1 367.01 · … · SL 247.58").
 */
function repairDemotedOpenHistoryFromReason() {
  let n = 0;
  for (const h of tradeHistory) {
    if (!h || !h.ticker) continue;
    const hz = h.hz || 'short';
    const st = String(h[hz + 'Status'] || h.status || '').toLowerCase();
    if (st !== 'open' && st !== 'tp1_open') continue;
    const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
    if (act === 'buy' || act === 'sell') continue;
    const reason = String(h.reason || '');
    const m = reason.match(/\b(Buy|Sell)\s*@\s*([0-9]+(?:\.[0-9]+)?)\s*[·|].*?TP1\s*([0-9]+(?:\.[0-9]+)?).*?TP2\s*([0-9]+(?:\.[0-9]+)?).*?SL\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!m) continue;
    const side = /^sell$/i.test(m[1]) ? 'Sell' : 'Buy';
    const entry = m[2], tp1 = m[3], tp2 = m[4], sl = m[5];
    h.action = side;
    h[hz + 'Action'] = side;
    h.rating = side;
    h.entry = entry;
    h[hz + 'Entry'] = entry;
    h.target1 = tp1; h[hz + 'Target1'] = tp1;
    h.target2 = tp2; h[hz + 'Target2'] = tp2;
    h.stopLoss = sl; h[hz + 'StopLoss'] = sl;
    if (side === 'Sell') {
      h.sellEntry = entry; h.sellTarget1 = tp1; h.sellTarget2 = tp2; h.sellStopLoss = sl;
    }
    n++;
    auditLog('history_action_repaired_from_reason', { ticker: h.ticker, hz, side, entry, tp1, sl });
  }
  if (n) {
    saveHistoryFile(tradeHistory);
    console.log('Repaired', n, 'demoted open history row(s) Hold→Buy/Sell from reason levels');
  }
  return n;
}
try { repairDemotedOpenHistoryFromReason(); } catch (e) {
  console.warn('history reason repair failed:', e.message);
}

function readTradeEvents(sinceSeq, limit, tail) {
  const since = Math.max(0, Number(sinceSeq) || 0);
  const lim = Math.min(Math.max(1, Number(limit) || 200), 2000);
  try {
    const lines = fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if ((e.seq || 0) > since) out.push(e);
      } catch (_) { /* skip */ }
    }
    // Poller paging wants the OLDEST lim (forward cursor); the bridge's
    // reconciliation sweep wants the NEWEST lim (tail=1) — with oldest-first
    // truncation it stopped seeing recent trades once the log passed lim.
    return tail ? out.slice(-lim) : out.slice(0, lim);
  } catch (_) {
    return [];
  }
}

function ibkrEventsAuthorized(req) {
  const want = process.env.IBKR_EVENTS_TOKEN || '';
  if (!want) return true; // open when no token configured (paper/dev)
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.query.token || '');
  return got && got === want;
}

app.get('/api/ibkr/events', (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const since = parseInt(req.query.since, 10) || 0;
  const limit = parseInt(req.query.limit, 10) || 200;
  const events = readTradeEvents(since, limit, req.query.tail === '1');
  res.json({
    ok: true,
    latestSeq: _tradeEventSeq,
    since,
    count: events.length,
    events,
    note: 'Poll with since=<last seq>. Types: entry, entry_finalized, tp1_partial, tsl_update, exit'
  });
});

app.get('/api/ibkr/status', (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    ok: true,
    latestSeq: _tradeEventSeq,
    eventsEnabled: process.env.IBKR_EVENTS_ENABLED !== '0',
    tokenRequired: !!process.env.IBKR_EVENTS_TOKEN,
    paperPorts: { tws: 7497, gateway: 4002 }
  });
});

// ── IBKR EXECUTION REPORTS ───────────────────────────────────────────────────
// The local bridge posts real TWS executions here so the site can show actual
// paper-account PnL (fills, not theoretical marks). Append-only JSONL on the
// data disk, deduped by IB execId.
const IBKR_FILLS_FILE = path.join(path.dirname(HISTORY_FILE), 'ibkr_fills.jsonl');
/** Optional kill-switch only (default EMPTY). Authorization is by provenance /
 *  fill.errorTrade stamps — not a permanent ticker ban (Claude audit Fix 1). */
const IBKR_ERROR_TRADE_TICKERS = new Set(
  String(process.env.IBKR_ERROR_TICKERS || '')
    .split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase())
);
/**
 * Forced error trades — dual-list / Hold→Buy episodes. These win over provenance
 * so AIR.DE and AIR.PA both show under Error trades (user request).
 */
const IBKR_FORCE_ERROR_TICKERS = new Set([
  'AIR.DE', 'AIR.PA', 'FSLR', 'BMY', 'CVX', 'MPC', 'HSBA.L', 'VTR', 'FANG', '8002.T'
]);
const IBKR_LEGACY_ERROR_TICKERS = IBKR_FORCE_ERROR_TICKERS;
/** Keys that must stay error even if ticker-level rules change. */
const IBKR_LEGACY_ERROR_KEYS = new Set([
  'AIR.DE|medium|Thu Aug 06 2026',
  'AIR.PA|medium|Thu Aug 06 2026',
  'FSLR|medium|Thu Aug 06 2026',
  'BMY|long|Thu Aug 06 2026',
  'CVX|short|Thu Aug 06 2026',
  'MPC|short|Thu Aug 06 2026',
  'HSBA.L|short|Thu Aug 06 2026',
  'VTR|short|Wed Aug 05 2026',
  'FANG|short|Wed Aug 05 2026',
  '8002.T|short|Mon Aug 03 2026'
]);
/** No longer unstamp AIR.DE — both Airbus listings are error trades. */
const IBKR_UNSTAMP_ERROR_TICKERS = new Set();
const IBKR_ERROR_TRADES_FILE = path.join(path.dirname(HISTORY_FILE), 'ibkr_error_trades.json');
function loadIbkrErrorTradeExtra() {
  try {
    const j = JSON.parse(fs.readFileSync(IBKR_ERROR_TRADES_FILE, 'utf8'));
    return {
      tickers: new Set((j.tickers || []).map(t => String(t).toUpperCase())),
      keys: new Set([...(j.keys || []), ...IBKR_LEGACY_ERROR_KEYS])
    };
  } catch (_) {
    return { tickers: new Set(), keys: new Set(IBKR_LEGACY_ERROR_KEYS) };
  }
}
function isForceIbkrErrorTicker(ticker) {
  const tk = String(ticker || '').toUpperCase();
  if (IBKR_FORCE_ERROR_TICKERS.has(tk) || IBKR_ERROR_TRADE_TICKERS.has(tk)) return true;
  for (const a of ibkrYahooAliases(tk)) {
    if (IBKR_FORCE_ERROR_TICKERS.has(a) || IBKR_ERROR_TRADE_TICKERS.has(a)) return true;
  }
  return false;
}
function isIbkrErrorTrade(t, extra) {
  if (!t) return false;
  const tk = String(t.ticker || '').toUpperCase();
  // Force-error list / keys win over provenance (AIR.DE + AIR.PA → Error box).
  if (isForceIbkrErrorTicker(tk)) return true;
  if (extra && extra.keys.has(t.key)) return true;
  if (IBKR_LEGACY_ERROR_KEYS.has(t.key)) return true;
  if (t.errorTrade === true) return true;
  if ((t.fills || []).some(f => f.errorTrade)) return true;
  // Provenance wins for everything else: open emitted entry ⇒ not an error.
  if (isPositionAuthorizedByProvenance(tk)) return false;
  if (extra && extra.tickers && extra.tickers.has(tk)) return true;
  return false;
}
/** Stamp historical unauthorized fills by KEY and force-error tickers (AIR.*). */
function stampLegacyIbkrErrorFills() {
  try {
    if (!fs.existsSync(IBKR_FILLS_FILE)) return 0;
    let n = 0;
    const next = readIbkrFillRows().map(r => {
      if (!r || r.errorTrade) return r;
      const forceKey = IBKR_LEGACY_ERROR_KEYS.has(String(r.key || ''));
      const forceTk = isForceIbkrErrorTicker(r.ticker);
      if (!forceKey && !forceTk) return r;
      n++;
      return Object.assign({}, r, { errorTrade: true });
    });
    if (!n) return 0;
    mutateFillLedger('stamp_legacy_error_keys', () => next);
    console.log('Stamped', n, 'IBKR fill(s) as errorTrade (AIR dual-list / legacy)');
    return n;
  } catch (e) {
    console.warn('legacy error-trade stamp failed:', e.message);
    return 0;
  }
}
/** Clear errorTrade on fills that are still provenance-authorized (model open).
 *  Never unstamps force-error tickers (AIR.DE / AIR.PA). */
function unstampModelIbkrFills() {
  try {
    if (!fs.existsSync(IBKR_FILLS_FILE)) return 0;
    let n = 0;
    const next = readIbkrFillRows().map(r => {
      if (!r || !r.errorTrade) return r;
      if (isForceIbkrErrorTicker(r.ticker)) return r;
      if (IBKR_LEGACY_ERROR_KEYS.has(String(r.key || ''))) return r;
      if (!isPositionAuthorizedByProvenance(r.ticker)
        && !IBKR_UNSTAMP_ERROR_TICKERS.has(String(r.ticker || '').toUpperCase())) {
        return r;
      }
      n++;
      return Object.assign({}, r, { errorTrade: false });
    });
    if (!n) return 0;
    mutateFillLedger('unstamp_authorized_model_fills', () => next);
    console.log('Unstamped', n, 'fill(s) → model trades (provenance-authorized)');
    auditLog('ibkr_unstamp_model_fills', { count: n });
    return n;
  } catch (e) {
    console.warn('model fill unstamp failed:', e.message);
    return 0;
  }
}
/**
 * Close unauthorized / dual-list entry events (including AIR.DE + AIR.PA) so
 * orphan flatten and Error-trades UI stay aligned.
 */
function emitExitsForLegacyUnauthorizedKeys() {
  if (process.env.IBKR_EVENTS_ENABLED === '0') return 0;
  const open = new Set();
  try {
    if (!fs.existsSync(TRADE_EVENTS_FILE)) return 0;
    for (const line of fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || !e.key) continue;
      if (e.type === 'entry') open.add(e.key);
      else if (e.type === 'exit') open.delete(e.key);
    }
  } catch (_) { return 0; }
  let n = 0;
  for (const key of IBKR_LEGACY_ERROR_KEYS) {
    if (!open.has(key)) continue;
    const [ticker, hz] = key.split('|');
    emitTradeEvent('exit', {
      key, ticker, hz: hz || 'short', side: 'buy',
      reason: 'unauthorized-non-recommendation', errorTrade: true
    });
    n++;
  }
  if (n) console.log('Emitted', n, 'exit event(s) for legacy unauthorized IBKR keys');
  return n;
}
let _ibkrExecIds = new Set();
try {
  if (fs.existsSync(IBKR_FILLS_FILE)) {
    for (const line of fs.readFileSync(IBKR_FILLS_FILE, 'utf8').trim().split('\n')) {
      try { const r = JSON.parse(line); if (r.execId) _ibkrExecIds.add(r.execId); } catch (_) {}
    }
  }
} catch (_) {}

/** Listing market for Yahoo/IBKR tickers — mirrors bridge.js windows. */
function ibkrMarketFromTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (t.endsWith('.HK')) return 'HK';
  if (t.endsWith('.T')) return 'JP';
  if (t.endsWith('.L')) return 'LSE';
  if (t.endsWith('.DE') || t.endsWith('.F')) return 'XETRA';
  if (t.endsWith('.PA') || t.endsWith('.AS') || t.endsWith('.MI') || t.endsWith('.BR')) return 'EURONEXT';
  if (t.includes('.')) return 'OTHER';
  return 'US';
}

/**
 * Session at fill time. Returns 'pre' | 'rth' | 'post' | 'lunch' | 'closed'.
 * Same UTC windows as ibkr-bridge/bridge.js (summer EU/US DST).
 */
function ibkrSessionPhase(ticker, timeIso) {
  const ms = Date.parse(timeIso || '') || Date.now();
  const d = new Date(ms);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return 'closed';
  const m = ibkrMarketFromTicker(ticker);
  const windows = {
    US: { open: 13 * 60 + 30, close: 20 * 60, preOpen: 8 * 60, postClose: 24 * 60 },
    JP: { open: 0, close: 6 * 60 },
    HK: { open: 1 * 60 + 30, close: 8 * 60, lunchStart: 4 * 60, lunchEnd: 5 * 60 },
    XETRA: { open: 7 * 60, close: 15 * 60 + 30 },
    EURONEXT: { open: 7 * 60, close: 15 * 60 + 30 },
    LSE: { open: 7 * 60, close: 15 * 60 + 30 }
  };
  const w = windows[m] || windows.XETRA;
  if (m === 'US') {
    if (utcMin >= w.open && utcMin < w.close) return 'rth';
    if (utcMin >= (w.preOpen || 0) && utcMin < w.open) return 'pre';
    if (utcMin >= w.close && utcMin < (w.postClose || 24 * 60)) return 'post';
    return 'closed';
  }
  if (m === 'HK' && w.lunchStart != null
    && utcMin >= w.lunchStart && utcMin < w.lunchEnd) return 'lunch';
  if (utcMin >= w.open && utcMin < w.close) return 'rth';
  if (utcMin < w.open) return 'pre';
  return 'closed';
}

function ibkrSessionLabel(phase) {
  return ({
    rth: 'Market', pre: 'Pre-market', post: 'Post-market',
    lunch: 'Lunch', closed: 'After hours'
  })[phase] || phase || '—';
}

app.post('/api/ibkr/report', (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const reports = Array.isArray(req.body && req.body.reports) ? req.body.reports : [];
  let stored = 0, skipped = 0;
  const toAdd = [];
  for (const r of reports) {
    if (!r || !r.execId || !r.key || !(Number(r.qty) > 0) || !(Number(r.price) > 0)) { skipped++; continue; }
    if (_ibkrExecIds.has(r.execId) || toAdd.some(x => x.execId === r.execId)) { skipped++; continue; }
    // Reject fills for recommendations whose entry day is ancient vs the fill
    // time (stale history re-emit → phantom paper trade).
    if (isPhantomIbkrKey(r.key, r.time || new Date().toISOString(), r)) {
      skipped++;
      auditLog('ibkr_fill_rejected_stale_key', { key: r.key, execId: r.execId });
      continue;
    }
    const fillTime = r.time || new Date().toISOString();
    const ticker = String(r.ticker || '');
    const phase = ['pre', 'rth', 'post', 'lunch', 'closed'].includes(r.session)
      ? r.session
      : ibkrSessionPhase(ticker, fillTime);
    toAdd.push({
      execId: String(r.execId), key: String(r.key),
      ticker, hz: String(r.hz || 'short'),
      side: r.side === 'sell' ? 'sell' : 'buy',
      role: ['entry', 'tp1', 'stop', 'flatten'].includes(r.role) ? r.role : 'other',
      qty: Number(r.qty), price: Number(r.price),
      currency: String(r.currency || 'USD'), ccyScale: Number(r.ccyScale) || 1,
      orderId: r.orderId ?? null,
      time: fillTime,
      session: phase,
      sessionLabel: r.sessionLabel || ibkrSessionLabel(phase),
      // Bridge stamp, env kill-switch, or force-error list (AIR.DE / AIR.PA).
      errorTrade: r.errorTrade === true || isForceIbkrErrorTicker(r.ticker),
      synthetic: r.synthetic === true || undefined,
      recon: r.recon ? String(r.recon) : undefined,
      markSrc: r.markSrc ? String(r.markSrc) : undefined
    });
  }
  if (toAdd.length) {
    try {
      mutateFillLedger('bridge_report', (rows) => {
        const have = new Set(rows.map(r => r.execId).filter(Boolean));
        for (const row of toAdd) {
          if (have.has(row.execId)) { skipped++; continue; }
          rows.push(row);
          have.add(row.execId);
          stored++;
        }
        return rows;
      });
    } catch (e) {
      skipped += toAdd.length;
      stored = 0;
    }
  }
  if (stored) auditLog('ibkr_fills', { stored, skipped });
  res.json({ ok: true, stored, skipped, totalExecs: _ibkrExecIds.size });
});

/**
 * True when the recommendation day in `key` is >3d before the fill — not a real
 * AlphaSignal→IBKR trade. Synthetic / recon sync fills are exempt (they close or
 * pad older keys to match the live paper account).
 */
function isPhantomIbkrKey(key, fillTime, row) {
  const eid = String((row && row.execId) || '');
  if (row && (row.synthetic || row.recon
    || eid.startsWith('recon-') || eid.startsWith('ibhist-'))) {
    return false;
  }
  const dayPart = String(key || '').split('|')[2];
  const keyTs = Date.parse(dayPart || 0);
  const fillTs = Date.parse(fillTime || 0) || Date.now();
  if (!Number.isFinite(keyTs)) return false;
  return (fillTs - keyTs) > 3 * 24 * 3600 * 1000;
}

function readIbkrFillRows() {
  try {
    return fs.readFileSync(IBKR_FILLS_FILE, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function writeIbkrFillRows(rows) {
  fs.writeFileSync(IBKR_FILLS_FILE, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  _ibkrExecIds = new Set(rows.map(r => r.execId).filter(Boolean));
}

/** Synthetic / recon rows are never deleted by purge/phantom filters. */
function isProtectedIbkrFillRow(r) {
  return !!(r && (r.synthetic || r.recon || String(r.execId || '').startsWith('recon-')));
}

function ibkrFillRowId(r) {
  return String(r && r.execId || '') + '|' + String(r && r.key || '') + '|' + String(r && r.time || '') + '|' + String(r && r.role || '');
}

/**
 * SINGLE WRITER for the IBKR fill ledger. All mutators (recon, purge, correct-avg)
 * must go through this. GET /api/ibkr/trades is read-only and must never call it.
 * Protected synthetic/recon rows cannot be dropped by a mutation — unless
 * opts.mayDropProtected(row, beforeRows) returns true (void bad ghost-flats).
 */
function mutateFillLedger(reason, fn, opts) {
  opts = opts || {};
  const before = readIbkrFillRows();
  let next = fn(before.map(r => Object.assign({}, r)));
  if (!Array.isArray(next)) throw new Error('mutateFillLedger fn must return an array');
  const nextIds = new Set(next.map(ibkrFillRowId));
  for (const r of before) {
    if (!isProtectedIbkrFillRow(r)) continue;
    if (typeof opts.mayDropProtected === 'function' && opts.mayDropProtected(r, before)) continue;
    const id = ibkrFillRowId(r);
    if (!nextIds.has(id)) {
      next.push(r);
      nextIds.add(id);
    }
  }
  writeIbkrFillRows(next);
  auditLog('ibkr_fill_ledger_mutate', {
    reason: String(reason || 'unspecified'),
    before: before.length,
    after: next.length
  });
  return { before: before.length, after: next.length, rows: next };
}

/** Fake $0 closes: synthetic ghost-flat with no external mark whose exit ≈ avg entry.
 *  Quote-backed closes (yahoo-recon / ib-bridge) are kept even if PnL is near zero. */
function isZeroEdgeGhostFlatFill(row, allRows) {
  if (!row || row.role !== 'flatten' || row.recon !== 'ghost-flat') return false;
  const src = String(row.markSrc || '');
  if (src === 'yahoo-recon' || src.startsWith('ib-bridge') || src === 'fmp' || src === 'ibkr') {
    return false;
  }
  const px = Number(row.price);
  if (!(px > 0)) return true;
  const key = String(row.key || '');
  const entries = (allRows || []).filter(r => r && r.key === key && r.role === 'entry' && Number(r.price) > 0);
  if (!entries.length) return Math.abs(px) < 1e-9;
  const qtySum = entries.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const avg = qtySum > 0
    ? entries.reduce((s, r) => s + Number(r.price) * (Number(r.qty) || 0), 0) / qtySum
    : Number(entries[0].price);
  if (!(avg > 0)) return false;
  return Math.abs(px - avg) / avg < 0.0005; // < 5 bps with no quote src → invented
}

// Boot ledger repairs — must run after mutateFillLedger / _ibkrExecIds exist.
stampLegacyIbkrErrorFills();
unstampModelIbkrFills();
emitExitsForLegacyUnauthorizedKeys();

/** Drop phantom/stale fills (and optional explicit keys) from the durable log. */
app.post('/api/ibkr/purge', express.json({ limit: '32kb' }), (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const keys = new Set((req.body && req.body.keys) || []);
  const dropStale = req.body && req.body.stale !== false; // default: purge phantoms
  const beforeLen = readIbkrFillRows().length;
  const { after } = mutateFillLedger('purge', (rows) => rows.filter(r => {
    if (isProtectedIbkrFillRow(r)) return true; // never delete synthetic/recon
    if (keys.has(r.key)) return false;
    if (dropStale && isPhantomIbkrKey(r.key, r.time, r)) return false;
    return true;
  }));
  res.json({ ok: true, before: beforeLen, after, removed: beforeLen - after });
});

/**
 * Rewrite entry-fill prices for a key to match IB averageCost / avgFillPrice
 * (fixes coarse integer exec.price e.g. 9988 @124 → 123.8).
 * Body: { corrections: [{ key, avgEntry }] }
 */
app.post('/api/ibkr/correct-avg', express.json({ limit: '64kb' }), (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const corrections = Array.isArray(req.body && req.body.corrections) ? req.body.corrections : [];
  if (!corrections.length) return res.json({ ok: true, corrected: 0 });
  const byKey = new Map();
  for (const c of corrections) {
    if (!c || !c.key || !(Number(c.avgEntry) > 0)) continue;
    byKey.set(String(c.key), Number(c.avgEntry));
  }
  if (!byKey.size) return res.json({ ok: true, corrected: 0 });
  let n = 0;
  mutateFillLedger('correct-avg', (rows) => rows.map(r => {
    if (!r || r.role !== 'entry') return r;
    const avg = byKey.get(r.key);
    if (!(avg > 0)) return r;
    const prev = Number(r.price);
    if (!(prev > 0) || Math.abs(prev - avg) < 1e-9) return r;
    n++;
    return { ...r, price: avg, priceCorrectedFrom: prev, priceCorrectedAt: new Date().toISOString() };
  }));
  if (n) {
    console.log('IBKR fill avg corrected:', n, 'fill(s) across', byKey.size, 'key(s)');
  }
  res.json({ ok: true, corrected: n, keys: byKey.size });
});

// ── IBKR ↔ AlphaSignal reconciliation ────────────────────────────────────────
// Bridge posts the paper-account position snapshot. Server is source of truth
// for the IBKR tab fills; IB is source of truth for open qty + avg cost.
// Syncs: ghost opens (site open / IB flat), missing entry qty, entry avgCost.
const IBKR_RECON_FILE = path.join(path.dirname(HISTORY_FILE), 'ibkr_recon.json');
const IBKR_RECON_PENDING_FILE = path.join(path.dirname(HISTORY_FILE), 'ibkr_recon_pending.json');
function normalizeIbkrYahooTicker(t) {
  const s = String(t || '').toUpperCase();
  const m = s.match(/^(\d+)\.HK$/);
  if (m) return m[1].padStart(4, '0') + '.HK';
  return s;
}
function loadIbkrReconPending() {
  try { return JSON.parse(fs.readFileSync(IBKR_RECON_PENDING_FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function saveIbkrReconPending(p) {
  try { fs.writeFileSync(IBKR_RECON_PENDING_FILE, JSON.stringify(p)); } catch (_) {}
}
function loadIbkrReconReport() {
  try { return JSON.parse(fs.readFileSync(IBKR_RECON_FILE, 'utf8')); }
  catch (_) { return null; }
}
function saveIbkrReconReport(r) {
  try { fs.writeFileSync(IBKR_RECON_FILE, JSON.stringify(r, null, 2)); } catch (_) {}
}
function ibkrAvgToFillUnit(avgCost, ccyScale, sampleEntryPx) {
  let avg = Number(avgCost);
  if (!(avg > 0)) return null;
  // LSE: IB often reports pounds while fills are pence (ccyScale=100).
  if ((Number(ccyScale) || 1) === 100 && sampleEntryPx > 50 && avg * 10 < sampleEntryPx) avg *= 100;
  return avg;
}
/** Aggregate open lots from fill rows (same math as /api/ibkr/trades). */
function aggregateIbkrOpenFromFills(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r || !r.key) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const opens = [];
  for (const [key, fills] of byKey) {
    const f0 = fills[0];
    const entries = fills.filter(f => f.role === 'entry');
    const exits = fills.filter(f => f.role !== 'entry');
    const entryQty = entries.reduce((s, f) => s + Number(f.qty || 0), 0);
    const exitQty = exits.reduce((s, f) => s + Number(f.qty || 0), 0);
    if (!(entryQty > 0)) continue;
    const openQty = Math.max(0, entryQty - exitQty);
    if (!(openQty > 0)) continue;
    const avgEntry = entries.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / entryQty;
    opens.push({
      key, ticker: normalizeIbkrYahooTicker(f0.ticker),
      rawTicker: f0.ticker,
      hz: f0.hz, side: f0.side === 'sell' ? 'sell' : 'buy',
      currency: f0.currency || 'USD',
      ccyScale: Number(f0.ccyScale) || 1,
      openQty, avgEntry,
      errorTrade: !!(f0.errorTrade || fills.some(f => f.errorTrade)),
      mark: null
    });
  }
  return opens;
}

/** Mark for site-open / IB-flat closes — Yahoo v7 often blocked from Render. */
async function resolveGhostFlatMark(ticker) {
  const syms = [...new Set([String(ticker || '').toUpperCase(), ...ibkrYahooAliases(ticker)])].filter(Boolean);
  try {
    const qmap = await fetchQuotesV7Bulk(syms);
    for (const s of syms) {
      const q = qmap[s];
      const px = Number(q && (q.price || q.regularMarketPrice || q.regularMarketPreviousClose));
      if (px > 0) return { price: px, src: 'yahoo-v7' };
    }
  } catch (_) { /* next */ }
  for (const s of syms) {
    try {
      const f = await fetchFmpQuotePrice(s);
      if (f && f.price > 0) return { price: f.price, src: 'fmp' };
    } catch (_) { /* next */ }
  }
  for (const s of syms) {
    try {
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`;
      const r = await fetch(chartUrl, {
        headers: typeof YF_HEADERS !== 'undefined' ? YF_HEADERS : { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const d = await r.json().catch(() => null);
      const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const px = Number(meta && (meta.regularMarketPrice || meta.chartPreviousClose || meta.previousClose));
      if (px > 0) return { price: px, src: 'yahoo-chart' };
      const closes = (d && d.chart && d.chart.result && d.chart.result[0]
        && d.chart.result[0].indicators && d.chart.result[0].indicators.quote
        && d.chart.result[0].indicators.quote[0] && d.chart.result[0].indicators.quote[0].close) || [];
      for (let i = closes.length - 1; i >= 0; i--) {
        if (Number(closes[i]) > 0) return { price: Number(closes[i]), src: 'yahoo-chart-close' };
      }
    } catch (_) { /* next */ }
  }
  return null;
}

/**
 * POST /api/ibkr/recon
 * Body: { positions: [{ ticker, qty, avgCost, currency?, conId? }], marks?: {TICKER: price} }
 * Aligns AlphaSignal fill ledger to IB paper open qty + averageCost for tracked names.
 */
app.post('/api/ibkr/recon', express.json({ limit: '256kb' }), async (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    // Refresh dedupe set from disk (purge/other instance may have changed file).
    try {
      _ibkrExecIds.clear();
      for (const r of readIbkrFillRows()) {
        if (r && r.execId) _ibkrExecIds.add(String(r.execId));
      }
    } catch (_) {}
    const positions = Array.isArray(req.body && req.body.positions) ? req.body.positions : [];
    const marksIn = (req.body && req.body.marks && typeof req.body.marks === 'object') ? req.body.marks : {};
    const ibByY = new Map();
    const ibByConId = new Map(); // conId → canonical yahoo (dual-list identity)
    for (const p of positions) {
      if (!p) continue;
      const y = normalizeIbkrYahooTicker(p.ticker || '');
      if (!y) continue;
      const qty = Number(p.qty) || 0;
      if (!qty) continue;
      const prev = ibByY.get(y) || { qty: 0, avgCost: null, currency: p.currency, conId: p.conId };
      prev.qty = qty;
      if (Number(p.avgCost) > 0) prev.avgCost = Number(p.avgCost);
      if (p.currency) prev.currency = p.currency;
      if (p.conId) prev.conId = p.conId;
      ibByY.set(y, prev);
      const cid = Number(p.conId);
      if (cid > 0) {
        const existing = ibByConId.get(cid);
        // Prefer the listing that already has an AlphaSignal open lot / emitted entry.
        if (!existing) ibByConId.set(cid, y);
      }
    }

    // SINGLE reconcile writer: drop stale phantoms here (never on GET /trades).
    {
      const beforePurge = readIbkrFillRows();
      const afterPurge = beforePurge.filter(r => !isPhantomIbkrKey(r.key, r.time, r));
      if (afterPurge.length !== beforePurge.length) {
        mutateFillLedger('recon_phantom_purge', () => afterPurge);
      }
    }

    // Void invented $0 ghost-flats (e.g. AIR.PA/AIR.DE closed at exact entry).
    {
      const beforeVoid = readIbkrFillRows();
      const dropIds = new Set(
        beforeVoid.filter(r => isZeroEdgeGhostFlatFill(r, beforeVoid)).map(ibkrFillRowId)
      );
      if (dropIds.size) {
        mutateFillLedger(
          'void_zero_ghost_flat',
          (rows) => rows.filter(r => !dropIds.has(ibkrFillRowId(r))),
          { mayDropProtected: (r) => dropIds.has(ibkrFillRowId(r)) }
        );
        console.log('IBKR recon: voided', dropIds.size, 'zero-edge ghost-flat fill(s)');
      }
    }

    const rows = readIbkrFillRows();
    const opens = aggregateIbkrOpenFromFills(rows);
    const pending = loadIbkrReconPending();
    const matched = [];
    const adjusted = [];
    const issues = [];
    const untrackedIb = [];
    const newFills = [];
    const avgCorrections = new Map(); // key -> avgEntry
    const touchedPending = new Set();
    const dualListHandled = new Set(); // yahoo tickers already closed via alias group

    const asByTicker = new Map();
    for (const o of opens) {
      if (!asByTicker.has(o.ticker)) asByTicker.set(o.ticker, []);
      asByTicker.get(o.ticker).push(o);
      const mk = Number(marksIn[o.ticker] || marksIn[o.rawTicker]);
      if (mk > 0) { o.mark = mk; o.markSrc = o.markSrc || 'ib-bridge'; }
      // Dual-list marks: AIR.PA can use AIR.DE mark and vice versa
      if (!(o.mark > 0)) {
        for (const a of ibkrYahooAliases(o.ticker)) {
          const am = Number(marksIn[a]);
          if (am > 0) { o.mark = am; o.markSrc = 'ib-bridge-alias'; break; }
        }
      }
    }

    // When IB is flat, the bridge portfolio has no mark for that name — so site
    // ghosts (FANG/VTR/AIR) stayed open forever. Pull Yahoo for those tickers
    // and close the ledger at a real market price (never invent exit = entry).
    {
      const needQuote = new Set();
      for (const [y, group] of asByTicker) {
        const ib = resolveIbPosForYahoo(y, ibByY, ibByConId);
        const ibAbs = Math.abs(ib ? Number(ib.qty) || 0 : 0);
        if (ibAbs !== 0) continue;
        for (const o of group) {
          if (!(o.openQty > 0)) continue;
          if (!(o.mark > 0)) needQuote.add(o.rawTicker || o.ticker || y);
        }
      }
      if (needQuote.size) {
        const got = [];
        for (const t of needQuote) {
          try {
            const m = await resolveGhostFlatMark(t);
            if (!(m && m.price > 0)) continue;
            for (const o of opens) {
              if (o.mark > 0) continue;
              const aliases = ibkrYahooAliases(o.ticker || o.rawTicker);
              if (!aliases.has(String(t).toUpperCase())
                && String(o.ticker).toUpperCase() !== String(t).toUpperCase()
                && String(o.rawTicker || '').toUpperCase() !== String(t).toUpperCase()) continue;
              o.mark = m.price;
              o.markSrc = m.src || 'ghost-mark';
            }
            got.push(t + '@' + m.price + '(' + m.src + ')');
          } catch (e) {
            console.warn('IBKR recon ghost mark failed', t, e.message || e);
          }
        }
        if (got.length) console.log('IBKR recon: marks for IB-flat site opens:', got.join(', '));
        else console.warn('IBKR recon: no marks for IB-flat opens:', [...needQuote].join(','));
      }
    }

    // Prefer conId→listing that already has an AS open lot (canonical dual-list).
    for (const [cid, y0] of [...ibByConId.entries()]) {
      const aliases = ibkrYahooAliases(y0);
      let preferred = null;
      for (const a of aliases) {
        if (asByTicker.has(a)) { preferred = a; break; }
      }
      if (!preferred) {
        for (const a of aliases) {
          if (hasOpenEmittedEntryForTicker(a)) { preferred = a; break; }
        }
      }
      if (preferred) ibByConId.set(cid, preferred);
    }

    const trackedYahoo = new Set(asByTicker.keys());
    const seenUntrackedCon = new Set();
    for (const [y, ib] of ibByY) {
      const cid = Number(ib.conId) || 0;
      if (cid > 0 && seenUntrackedCon.has(cid)) continue;
      // Dual-list: if any alias is tracked, this IB lot is accounted for.
      const aliases = ibkrYahooAliases(y);
      if ([...aliases].some(a => trackedYahoo.has(a))) {
        if (cid > 0) seenUntrackedCon.add(cid);
        continue;
      }
      if (cid > 0) seenUntrackedCon.add(cid);
      untrackedIb.push({
        ticker: y, qty: ib.qty, avgCost: ib.avgCost, conId: cid || null,
        note: isPositionAuthorizedByProvenance(y)
          ? 'IB position missing site fill lot (model entry exists — import/fill lag)'
          : 'IB-only orphan — not a model recommendation (bridge flattens MKT/OPG)',
        authorized: isPositionAuthorizedByProvenance(y)
      });
    }

    for (const [y, group] of asByTicker) {
      if (dualListHandled.has(y)) continue;
      const ib = resolveIbPosForYahoo(y, ibByY, ibByConId);
      const ibQty = ib ? Number(ib.qty) || 0 : 0;
      const ibAbs = Math.abs(ibQty);
      // Net AlphaSignal open (buys positive, sells negative)
      let asSigned = 0;
      for (const o of group) asSigned += (o.side === 'sell' ? -1 : 1) * o.openQty;
      const asAbs = Math.abs(asSigned);
      const primary = group.slice().sort((a, b) => b.openQty - a.openQty)[0];
      const ibSideOk = !ibQty || (asSigned === 0) || (Math.sign(ibQty) === Math.sign(asSigned));

      if (!ibSideOk) {
        issues.push({
          ticker: y, severity: 'error',
          detail: `Side mismatch: AlphaSignal net ${asSigned}, IB ${ibQty}`
        });
        continue;
      }

      const wantKey = y + '|qty';
      touchedPending.add(wantKey);
      const avgKey = y + '|avg';

      // Qty sync — IB paper snapshot is authoritative for open size.
      // Apply immediately (bridge only posts after positionsReady).
      if (ibAbs !== asAbs) {
        delete pending[wantKey];
        if (ibAbs === 0 && asAbs > 0) {
          // Ghost open on site while IB is flat. Never invent an exit at avg
          // entry ($0 "flatten") — that produced fake AIR.PA/AIR.DE closes.
          // Dual-list: merge alias lots once (one IB book, not two $0 closes).
          const aliasYs = [...ibkrYahooAliases(y)];
          for (const a of aliasYs) dualListHandled.add(a);
          const mergedOpens = [];
          for (const a of aliasYs) {
            for (const o of (asByTicker.get(a) || [])) mergedOpens.push(o);
          }
          let anyFlat = false;
          let siteOpenSum = 0;
          for (const o of mergedOpens) {
            if (!(o.openQty > 0)) continue;
            siteOpenSum += o.openQty;
            const px = o.mark > 0 ? o.mark : 0;
            if (!(px > 0)) {
              issues.push({
                ticker: o.rawTicker || o.ticker || y, severity: 'pending',
                detail: `Site open ${o.openQty} but IB flat — no market quote yet; retry next recon`
              });
              continue;
            }
            // Yahoo/IB mark is a real price even if near entry — that is not the
            // old bug (inventing exit === avgEntry with no quote).
            const fillAt = new Date().toISOString();
            const phase = ibkrSessionPhase(o.rawTicker || y, fillAt);
            const execId = `recon-flat-${o.key}-q${o.openQty}`;
            if (_ibkrExecIds.has(execId)) continue;
            newFills.push({
              execId, key: o.key, ticker: o.rawTicker || y, hz: o.hz || 'short',
              side: o.side, role: 'flatten', qty: o.openQty, price: px,
              currency: o.currency, ccyScale: o.ccyScale, orderId: null,
              time: fillAt, session: phase, sessionLabel: ibkrSessionLabel(phase),
              errorTrade: !!(o.errorTrade || isForceIbkrErrorTicker(o.rawTicker || y)),
              synthetic: true,
              recon: 'ghost-flat', markSrc: o.markSrc || 'unknown'
            });
            adjusted.push({
              ticker: o.rawTicker || y, key: o.key, action: 'ghost-flatten',
              qty: o.openQty, price: px, markSrc: o.markSrc || 'unknown'
            });
            anyFlat = true;
          }
          if (!anyFlat && siteOpenSum > 0) {
            issues.push({
              ticker: y, severity: 'pending',
              detail: `Difference: site open ${siteOpenSum} on ${aliasYs.join('/')} but IB flat — waiting for market quote`
            });
          }
        } else if (ibAbs > asAbs && primary) {
          const delta = ibAbs - asAbs;
          const avg = ibkrAvgToFillUnit(ib && ib.avgCost, primary.ccyScale, primary.avgEntry)
            || primary.avgEntry;
          if (!(avg > 0) || !(delta > 0)) continue;
          const fillAt = new Date().toISOString();
          const phase = ibkrSessionPhase(primary.rawTicker || y, fillAt);
          const execId = `recon-entry-${primary.key}-pad${delta}`;
          if (!_ibkrExecIds.has(execId)) {
            newFills.push({
              execId, key: primary.key, ticker: primary.rawTicker || y, hz: primary.hz || 'short',
              side: primary.side, role: 'entry', qty: delta, price: avg,
              currency: primary.currency, ccyScale: primary.ccyScale, orderId: null,
              time: fillAt, session: phase, sessionLabel: ibkrSessionLabel(phase),
              errorTrade: !!primary.errorTrade, synthetic: true, recon: 'qty-pad'
            });
            adjusted.push({ ticker: y, key: primary.key, action: 'qty-pad', qty: delta, price: avg });
          }
          avgCorrections.set(primary.key, avg);
        } else if (ibAbs < asAbs && ibAbs > 0 && primary) {
          const delta = asAbs - ibAbs;
          const px = primary.mark > 0 ? primary.mark : 0;
          if (!(delta > 0)) continue;
          if (!(px > 0) || (primary.avgEntry > 0 && Math.abs(px - primary.avgEntry) / primary.avgEntry < 0.0005)) {
            issues.push({
              ticker: y, severity: 'pending',
              detail: `Qty drift AS=${asAbs} IB=${ibAbs} — no real mark to trim (won't invent exit @ entry)`
            });
            continue;
          }
          const fillAt = new Date().toISOString();
          const phase = ibkrSessionPhase(primary.rawTicker || y, fillAt);
          const execId = `recon-trim-${primary.key}-q${delta}`;
          if (!_ibkrExecIds.has(execId)) {
            newFills.push({
              execId, key: primary.key, ticker: primary.rawTicker || y, hz: primary.hz || 'short',
              side: primary.side, role: 'flatten', qty: Math.min(delta, primary.openQty), price: px,
              currency: primary.currency, ccyScale: primary.ccyScale, orderId: null,
              time: fillAt, session: phase, sessionLabel: ibkrSessionLabel(phase),
              errorTrade: !!primary.errorTrade, synthetic: true, recon: 'qty-trim'
            });
            adjusted.push({
              ticker: y, key: primary.key, action: 'qty-trim',
              qty: Math.min(delta, primary.openQty), price: px
            });
          }
        } else {
          issues.push({
            ticker: y, severity: 'pending',
            detail: `Qty drift AS=${asAbs} IB=${ibAbs} (unresolved)`
          });
        }
      } else {
        delete pending[wantKey];
        // Qty matches — check avg
        if (ib && Number(ib.avgCost) > 0 && primary) {
          const avg = ibkrAvgToFillUnit(ib.avgCost, primary.ccyScale, primary.avgEntry);
          if (avg > 0) {
            const tick = primary.ccyScale === 100 ? 0.1
              : (avg >= 1000 ? 1 : avg >= 100 ? 0.05 : 0.01);
            if (Math.abs(primary.avgEntry - avg) > tick) {
              for (const o of group) avgCorrections.set(o.key, avg);
              adjusted.push({
                ticker: y, key: primary.key, action: 'avg-correct',
                from: +primary.avgEntry.toFixed(6), to: avg
              });
            } else {
              matched.push({
                ticker: y, openQty: asAbs, avgEntry: +primary.avgEntry.toFixed(6),
                ibQty: ibQty, ibAvg: avg
              });
            }
          } else {
            matched.push({ ticker: y, openQty: asAbs, ibQty });
          }
        } else if (asAbs === 0 && ibAbs === 0) {
          /* nothing */
        } else {
          matched.push({ ticker: y, openQty: asAbs, ibQty });
        }
      }
    }

    // Drop stale pending keys
    for (const k of Object.keys(pending)) {
      if (!touchedPending.has(k) && k.endsWith('|qty')) delete pending[k];
    }
    saveIbkrReconPending(pending);

    // Persist new fills + avg corrections through the single ledger writer.
    let stored = 0;
    let avgFixed = 0;
    if (newFills.length || avgCorrections.size) {
      mutateFillLedger('recon_sync', (all) => {
        let out = all.slice();
        for (const row of newFills) {
          if (!row || !row.execId) continue;
          if (out.some(r => r.execId === row.execId)) continue;
          out.push(row);
          stored++;
        }
        if (avgCorrections.size) {
          out = out.map(r => {
            if (!r || r.role !== 'entry') return r;
            const avg = avgCorrections.get(r.key);
            if (!(avg > 0)) return r;
            const prev = Number(r.price);
            if (!(prev > 0) || Math.abs(prev - avg) < 1e-9) return r;
            avgFixed++;
            return {
              ...r, price: avg, priceCorrectedFrom: prev,
              priceCorrectedAt: new Date().toISOString(), recon: 'avg-correct'
            };
          });
        }
        return out;
      });
      console.log('IBKR recon sync:', stored, 'fill(s),', avgFixed, 'avg fix(es)');
    }

    // Fully matched = no errors, no pending drifts, no synthetic fixes, no IB-only lots.
    const inSync = issues.filter(i => i.severity === 'error').length === 0
      && issues.filter(i => i.severity === 'pending').length === 0
      && adjusted.length === 0
      && untrackedIb.length === 0;
    const report = {
      inSync,
      ok: inSync, // UI /trades reconcile.ok
      at: new Date().toISOString(),
      matched: matched.length,
      adjusted: adjusted.length,
      pendingIssues: issues.filter(i => i.severity === 'pending').length,
      errors: issues.filter(i => i.severity === 'error').length,
      untrackedIb: untrackedIb.length,
      matchedRows: matched,
      adjustedRows: adjusted,
      issues,
      untrackedIbRows: untrackedIb,
      storedFills: stored,
      avgFixed,
      // Snapshot used by /api/ibkr/trades to overlay live IB qty/avg on the tab
      positions: [...ibByY.entries()].map(([ticker, v]) => ({
        ticker, qty: v.qty, avgCost: v.avgCost, currency: v.currency || null, conId: v.conId || null
      }))
    };
    saveIbkrReconReport(report);
    // After IB snapshot lands, drop History Live ghosts not held / not on board.
    try { pruneStaleOpenHistoryRows(); } catch (ePrune) {
      console.warn('History prune after recon:', ePrune.message);
    }
    res.json({
      ok: true,
      inSync,
      matched: report.matched,
      adjusted: report.adjusted,
      pendingIssues: report.pendingIssues,
      errors: report.errors,
      untrackedIb: report.untrackedIb,
      matchedRows: matched,
      adjustedRows: adjusted,
      issues,
      untrackedIbRows: untrackedIb,
      storedFills: stored,
      avgFixed,
      at: report.at
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/ibkr/recon', (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const report = loadIbkrReconReport();
  res.json({ ok: true, report: report || null });
});

// Live marks from the local IBKR bridge (TWS/Gateway market data) — preferred for MTM.
const IBKR_MARKS_FILE = path.join(path.dirname(HISTORY_FILE), 'ibkr_marks.json');
let _ibkrLiveMarks = {}; // ticker -> { price, bid, ask, last, at, src }
try {
  if (fs.existsSync(IBKR_MARKS_FILE)) {
    const j = JSON.parse(fs.readFileSync(IBKR_MARKS_FILE, 'utf8'));
    if (j && typeof j === 'object') _ibkrLiveMarks = j;
  }
} catch (_) {}

app.post('/api/ibkr/marks', express.json({ limit: '256kb' }), (req, res) => {
  if (!ibkrEventsAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const marks = Array.isArray(req.body && req.body.marks) ? req.body.marks : [];
  let n = 0;
  const now = Date.now();
  for (const m of marks) {
    const ticker = String(m && m.ticker || '').trim();
    const price = Number(m && m.price);
    if (!ticker || !(price > 0)) continue;
    const prev = _ibkrLiveMarks[ticker];
    const prevPx = prev ? Number(prev.price) : NaN;
    const priceChanged = !(prevPx > 0) || Math.abs(prevPx - price) / prevPx > 1e-9;
    // Only advance lastTickAt when the IB print actually moves. Re-posting the
    // same portfolio mark every 15s must not look "fresh" and block FMP.
    let lastTickAt = m.lastTickAt != null ? Number(m.lastTickAt) : NaN;
    if (!(lastTickAt > 0)) {
      lastTickAt = priceChanged ? now : Number(prev && prev.lastTickAt) || now;
    } else if (!priceChanged && prev && prev.lastTickAt > 0) {
      lastTickAt = Math.min(lastTickAt, Number(prev.lastTickAt));
    }
    _ibkrLiveMarks[ticker] = {
      price,
      bid: m.bid != null ? Number(m.bid) : null,
      ask: m.ask != null ? Number(m.ask) : null,
      last: m.last != null ? Number(m.last) : null,
      lastTickAt,
      src: 'ibkr',
      at: now
    };
    n++;
  }
  try { fs.writeFileSync(IBKR_MARKS_FILE, JSON.stringify(_ibkrLiveMarks)); } catch (_) {}
  res.json({ ok: true, updated: n, tickers: Object.keys(_ibkrLiveMarks).length });
});

// Fallback mark cache (FMP / Yahoo) — only when bridge IB marks are missing/stale.
const _ibkrMarkCache = new Map(); // sym -> { px, at, src }
const _ibkrFx = { at: 0, rates: {} };

/** FMP last price — primary live MTM for the IBKR tab (Ultimate quote feed).
 *  Keep this FAST. Do NOT call fmpAllSymbolVariants (exchange search). */
async function fetchFmpQuotePrice(symbol) {
  const k = fmpEnvKeyFund();
  if (!k || !symbol) return null;
  const cached = _ibkrMarkCache.get('fmp:' + symbol);
  // Short cache so the 5s IBKR tab poll can show tape movement.
  if (cached && Date.now() - cached.at < 4000 && cached.px > 0) {
    return { price: cached.px, src: 'fmp' };
  }
  // Short static list only (Yahoo-style + bare). Try batch v3 first (fastest).
  const list = [...new Set(fmpSymbolVariantsForApi(symbol))].filter(Boolean).slice(0, 3);
  const batch = list.join(',');
  const urls = [
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(batch)}?apikey=${encodeURIComponent(k)}`,
    ...list.map(raw => `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(raw)}&apikey=${encodeURIComponent(k)}`)
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(3500),
        headers: { Accept: 'application/json' }
      });
      if (!r.ok) continue;
      let arr = await r.json().catch(() => []);
      if (!Array.isArray(arr) && arr && typeof arr === 'object') {
        arr = Array.isArray(arr.data) ? arr.data : [arr];
      }
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        const price = Number(row && (row.price ?? row.close ?? row.last));
        if (price > 0) {
          _ibkrMarkCache.set('fmp:' + symbol, { px: price, at: Date.now(), src: 'fmp' });
          return { price, src: 'fmp' };
        }
      }
    } catch (_) { /* next */ }
  }
  return null;
}

/** Session-aware Yahoo last trade (pre/post included) — last-resort MTM only. */
async function fetchSessionAwareMark(symbol) {
  const variants = [symbol, String(symbol).replace(/\./g, '-')].filter((v, i, a) => a.indexOf(v) === i);
  for (const sym of variants) {
    for (const host of ['query1', 'query2']) {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`;
      try {
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const d = await r.json();
        const res = d?.chart?.result?.[0];
        if (!res) continue;
        const meta = res.meta || {};
        const q = res.indicators?.quote?.[0] || {};
        const closes = (q.close || []).filter(c => c != null && Number(c) > 0);
        const lastBar = closes.length ? Number(closes[closes.length - 1]) : null;
        const pre = Number(meta.preMarketPrice);
        const post = Number(meta.postMarketPrice);
        const reg = Number(meta.regularMarketPrice);
        // Prefer the most recent extended-hours print, then regular.
        let price = null, src = null;
        if (lastBar > 0) { price = lastBar; src = 'yahoo:1m'; }
        else if (pre > 0) { price = pre; src = 'yahoo:pre'; }
        else if (post > 0) { price = post; src = 'yahoo:post'; }
        else if (reg > 0) { price = reg; src = 'yahoo:reg'; }
        if (price > 0) return { price, src, pre: pre || null, post: post || null, regular: reg || null };
      } catch (_) { /* next */ }
    }
  }
  return null;
}

/** Live last-trade for IBKR MTM. Prefers 1m/5m chart bars (update during the
 *  session); daily close is last resort. No 15-bar floor — even 1 bar is enough. */
async function fetchIbkrLastTrade(symbol) {
  const live = await fetchSessionAwareMark(symbol);
  if (live) return live;
  const variants = [symbol, String(symbol).replace(/\./g, '-')].filter((v, i, a) => a.indexOf(v) === i);
  const attempts = [
    { range: '5d', interval: '5m' },
    { range: '5d', interval: '1d' }
  ];
  for (const { range, interval } of attempts) {
    for (const sym of variants) {
      for (const host of ['query1', 'query2']) {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=true`;
        try {
          const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const d = await r.json();
          const res = d?.chart?.result?.[0];
          const metaPx = Number(res?.meta?.regularMarketPrice || res?.meta?.postMarketPrice || res?.meta?.preMarketPrice);
          if (metaPx > 0) return { price: metaPx, src: `meta:${interval}` };
          const q = res?.indicators?.quote?.[0] || {};
          const closes = (q.close || []).filter(c => c != null && Number(c) > 0);
          if (closes.length) return { price: Number(closes[closes.length - 1]), src: `chart:${interval}` };
        } catch (_) { /* try next */ }
      }
    }
  }
  return null;
}
async function ibkrUsdPerCcy(ccy) {
  if (!ccy || ccy === 'USD') return 1;
  if (Date.now() - _ibkrFx.at > 3600 * 1000) {
    try {
      const m = await fetchQuotesV7Bulk(['USDJPY=X', 'USDHKD=X', 'USDINR=X', 'EURUSD=X', 'GBPUSD=X']);
      const px = {};
      for (const [k, v] of Object.entries(m || {})) px[k] = Number(v && v.price) || null;
      _ibkrFx.rates = px; _ibkrFx.at = Date.now();
    } catch (_) {}
  }
  const r = _ibkrFx.rates || {};
  switch (ccy) {
    case 'JPY': return r['USDJPY=X'] ? 1 / r['USDJPY=X'] : 1 / 150;
    case 'HKD': return r['USDHKD=X'] ? 1 / r['USDHKD=X'] : 1 / 7.8;
    case 'INR': return r['USDINR=X'] ? 1 / r['USDINR=X'] : 1 / 84;
    case 'EUR': return r['EURUSD=X'] || 1.08;
    case 'GBP': return r['GBPUSD=X'] || 1.28;
    default: return 1;
  }
}

// Aggregated per-trade view of the paper account, built purely from real fills.
// READ-ONLY: never mutate ibkr_fills.jsonl here (phantom drop runs inside recon).
app.get('/api/ibkr/trades', async (req, res) => {
  try {
    const allRows = readIbkrFillRows();
    // In-memory view only — do not writeIbkrFillRows / mutateFillLedger.
    const rows = allRows.filter(r => !isPhantomIbkrKey(r.key, r.time, r));
    const errExtra = loadIbkrErrorTradeExtra();
    const byKey = new Map();
    for (const r of rows) {
      if (!byKey.has(r.key)) byKey.set(r.key, []);
      byKey.get(r.key).push(r);
    }

    // Marks for open positions (Yahoo quote is in the same unit as IB fills:
    // pence for LSE, JPY for Tokyo, etc., so scales cancel out).
    const trades = [];
    const needMarks = [];
    for (const [key, fills] of byKey) {
      const f0 = fills[0];
      const dir = f0.side === 'sell' ? -1 : 1;
      const entries = fills.filter(f => f.role === 'entry');
      const exits = fills.filter(f => f.role !== 'entry');
      const entryQty = entries.reduce((s, f) => s + f.qty, 0);
      const exitQty = exits.reduce((s, f) => s + f.qty, 0);
      if (!entryQty) continue;
      const scale = f0.ccyScale || 1;
      const avgEntry = entries.reduce((s, f) => s + f.price * f.qty, 0) / entryQty;
      const avgExit = exitQty > 0
        ? exits.reduce((s, f) => s + f.price * f.qty, 0) / exitQty
        : null;
      const lastExit = exitQty > 0 ? exits[exits.length - 1] : null;
      const realizedLocal = exits.reduce((s, f) => s + (f.price - avgEntry) * f.qty * dir, 0) / scale;
      const openQty = Math.max(0, entryQty - exitQty);
      const enrichFill = (f) => {
        const session = f.session || ibkrSessionPhase(f.ticker || f0.ticker, f.time);
        return {
          role: f.role, qty: f.qty, price: f.price, time: f.time,
          errorTrade: !!f.errorTrade,
          session,
          sessionLabel: f.sessionLabel || ibkrSessionLabel(session)
        };
      };
      const fillViews = fills.map(enrichFill);
      const entrySessions = [...new Set(fillViews.filter(f => f.role === 'entry').map(f => f.sessionLabel))];
      const exitSessions = [...new Set(fillViews.filter(f => f.role !== 'entry').map(f => f.sessionLabel))];
      let sessionSummary = entrySessions[0] || '—';
      if (exitSessions.length) {
        const ex = exitSessions[exitSessions.length - 1];
        sessionSummary = entrySessions[0] && entrySessions[0] !== ex
          ? (entrySessions[0] + ' → ' + ex)
          : ex;
      } else if (entrySessions.length > 1) {
        sessionSummary = entrySessions.join(' · ');
      }
      const t = {
        key, ticker: f0.ticker, hz: f0.hz, side: f0.side,
        currency: f0.currency, ccyScale: scale,
        entryQty, exitQty, openQty, avgEntry,
        avgExit,
        lastExitPrice: lastExit ? lastExit.price : null,
        lastExitTime: lastExit ? lastExit.time : null,
        entrySession: entrySessions[0] || null,
        exitSession: exitSessions.length ? exitSessions[exitSessions.length - 1] : null,
        sessionSummary,
        realizedLocal,
        fills: fillViews,
        entryTime: entries[0] ? entries[0].time : f0.time,
        lastTime: fills[fills.length - 1].time,
        status: openQty > 0 ? (exitQty > 0 ? 'partial' : 'open') : 'closed',
        errorTrade: !!(f0.errorTrade || fills.some(f => f.errorTrade))
      };
      t.errorTrade = isIbkrErrorTrade(t, errExtra);
      trades.push(t);
      if (openQty > 0 && f0.ticker) needMarks.push(f0.ticker);
    }

    let markMap = {};
    if (needMarks.length) {
      const uniq = [...new Set(needMarks)];
      // Live MTM: FMP quote first (updates during the session), then IB only if
      // the bridge print actually moved recently, then Yahoo. This stops the
      // FMP↔IB tag flip caused by sticky IB portfolio marks re-posted every 15s.
      const IB_MOVED_MS = 30 * 1000;
      await Promise.all(uniq.map(async (sym) => {
        let picked = null;
        try {
          const fmp = await fetchFmpQuotePrice(sym);
          if (fmp && fmp.price > 0) picked = { price: fmp.price, src: 'fmp' };
        } catch (_) {}
        if (!picked) {
          const ibm = _ibkrLiveMarks[sym];
          const tickAt = Number(ibm && ibm.lastTickAt || 0);
          const ibMoved = ibm && Number(ibm.price) > 0 && tickAt > 0 && (Date.now() - tickAt) < IB_MOVED_MS;
          if (ibMoved) picked = { price: Number(ibm.price), src: 'ibkr' };
        }
        if (!picked) {
          try {
            const bulk = await fetchQuotesV7Bulk([sym]);
            const px = bulk[sym] && Number(bulk[sym].price);
            if (px > 0) picked = { price: px, src: 'yahoo:v7' };
          } catch (_) {}
        }
        if (!picked) {
          try {
            const yahoo = await fetchSessionAwareMark(sym);
            if (yahoo && yahoo.price > 0) picked = { price: yahoo.price, src: yahoo.src || 'yahoo' };
          } catch (_) {}
        }
        if (picked) markMap[sym] = picked;
      }));
    }

    // Join AlphaSignal's own lifecycle events so each IBKR trade carries the
    // recommendation levels and the model's exit reasoning.
    const recByKey = new Map();
    try {
      for (const line of fs.readFileSync(TRADE_EVENTS_FILE, 'utf8').trim().split('\n')) {
        let e; try { e = JSON.parse(line); } catch (_) { continue; }
        if (!e || !e.key) continue;
        const rec = recByKey.get(e.key) || {};
        if (e.type === 'entry') {
          rec.entry = e.entry; rec.tp1 = e.tp1; rec.tp2 = e.tp2; rec.sl = e.sl; rec.name = e.name;
        }
        if (e.type === 'exit') {
          rec.exitReason = e.exitReason || e.status || null;
          rec.exitStatus = e.status || null;
          rec.modelExitPrice = e.exitPrice ?? null;
          rec.modelPnlDollar = e.pnlDollar ?? null;
        }
        if (e.type === 'tsl_update') rec.lastTrailSl = e.trailSl ?? rec.lastTrailSl;
        recByKey.set(e.key, rec);
      }
    } catch (_) {}

    /** Backfill null tp1/sl from history when the emit stored incomplete levels. */
    function historyLevelsForIbkrTrade(key, ticker, hz) {
      const day = String(key || '').split('|')[2] || '';
      const tk = normalizeHistoryTicker(ticker);
      const z = hz || 'short';
      let best = null;
      for (const h of tradeHistory || []) {
        if (!h || normalizeHistoryTicker(h.ticker) !== tk) continue;
        if (String(h.hz || 'short') !== String(z)) continue;
        const entry = parseFloat(h[z + 'Entry'] || h.entry);
        const tp1 = parseFloat(h[z + 'Target1'] || h.target1);
        const tp2 = parseFloat(h[z + 'Target2'] || h.target2);
        const sl = parseFloat(h[z + 'StopLoss'] || h.stopLoss);
        if (!(tp1 > 0) && !(sl > 0)) continue;
        const row = { entry: entry > 0 ? entry : null, tp1: tp1 > 0 ? tp1 : null, tp2: tp2 > 0 ? tp2 : null, sl: sl > 0 ? sl : null, name: h.name || ticker };
        if (day && historyTradeEntryDay(h) === day) return row;
        if (!best) best = row;
      }
      return best;
    }
    function synthesizeTp1FromEntry(avgEntry, hz, isSell) {
      const e = Number(avgEntry);
      if (!(e > 0)) return null;
      const pct = ({ short: 0.035, medium: 0.07, long: 0.12 })[hz || 'short'] || 0.035;
      return +(isSell ? e * (1 - pct) : e * (1 + pct)).toFixed(4);
    }
    // Overlay last IB paper snapshot so the tab matches account qty/avg even if
    // recon fill rows were delayed or purged. IB is source of truth for opens.
    const reconSnap = loadIbkrReconReport();
    const ibPosByY = new Map();
    const ibPosByConId = new Map();
    if (reconSnap && Array.isArray(reconSnap.positions)) {
      for (const p of reconSnap.positions) {
        if (!p || !p.ticker) continue;
        const yt = normalizeIbkrYahooTicker(p.ticker);
        ibPosByY.set(yt, p);
        const cid = Number(p.conId);
        if (cid > 0) ibPosByConId.set(cid, yt);
      }
    }

    for (const t of trades) {
      const rec = Object.assign({}, recByKey.get(t.key) || {});
      // Older emits sometimes stored tp1:null — fill from history, then synthesize.
      if (!(Number(rec.tp1) > 0) || !(Number(rec.sl) > 0) || !(Number(rec.entry) > 0)) {
        const histLv = historyLevelsForIbkrTrade(t.key, t.ticker, t.hz);
        if (histLv) {
          if (!(Number(rec.tp1) > 0) && histLv.tp1 > 0) rec.tp1 = histLv.tp1;
          if (!(Number(rec.tp2) > 0) && histLv.tp2 > 0) rec.tp2 = histLv.tp2;
          if (!(Number(rec.sl) > 0) && histLv.sl > 0) rec.sl = histLv.sl;
          if (!(Number(rec.entry) > 0) && histLv.entry > 0) rec.entry = histLv.entry;
          if (!rec.name && histLv.name) rec.name = histLv.name;
        }
      }
      if (!(Number(rec.tp1) > 0) && Number(t.avgEntry) > 0) {
        rec.tp1 = synthesizeTp1FromEntry(t.avgEntry, t.hz, t.side === 'sell');
        rec.tp1Synthesized = true;
      }
      if (!(Number(rec.sl) > 0) && Number(t.avgEntry) > 0) {
        const e = Number(t.avgEntry);
        const pct = ({ short: 0.025, medium: 0.05, long: 0.08 })[t.hz || 'short'] || 0.025;
        rec.sl = +((t.side === 'sell' ? e * (1 + pct) : e * (1 - pct)).toFixed(4));
        rec.slSynthesized = true;
      }
      t.rec = rec;
      // Exit type from the actual fills (what really closed the trade at IB).
      const hasTp1 = t.fills.some(f => f.role === 'tp1');
      const hasStop = t.fills.some(f => f.role === 'stop');
      const hasFlat = t.fills.some(f => f.role === 'flatten');
      t.hasFlatten = hasFlat;
      // Prefer the AlphaSignal exit reason when present; only fall back to
      // fill-role heuristics. Flatten fills used to be mislabeled "signal/time
      // exit" even when the bridge force-closed on a Hold rewrite.
      const modelReason = (rec.exitReason || rec.exitStatus) || null;
      if (t.errorTrade && (t.status === 'closed' || hasFlat)) {
        t.exitType = 'error flatten';
      } else {
        t.exitType = t.status !== 'closed' ? (hasTp1 ? 'tp1 banked — runner live' : null)
          : modelReason ? String(modelReason)
          : hasFlat ? 'flatten exit'
          : hasStop && hasTp1 ? 'trailing stop (post-TP1)'
          : hasStop ? 'stop-loss (full)'
          : 'tp exit';
      }

      const y = normalizeIbkrYahooTicker(t.ticker);
      const ibp = resolveIbPosForYahoo(y, ibPosByY, ibPosByConId);
      if (!ibp || reconSnap && reconSnap.at && (Date.now() - Date.parse(reconSnap.at)) > 15 * 60 * 1000) {
        continue; // snapshot missing/stale — keep fill-ledger view
      }
      const ibQty = Number(ibp.qty) || 0;
      const ibAbs = Math.abs(ibQty);
      const asSign = t.side === 'sell' ? -1 : 1;
      if (ibAbs === 0 && t.openQty > 0) {
        // Ghost open vs paper — present as closed at IB
        t.openQty = 0;
        t.status = 'closed';
        t.ibReconciled = 'ghost-closed';
        if (t.errorTrade) t.exitType = 'error flatten';
        else if (!t.exitType) t.exitType = 'flatten exit';
        t.unrealizedUsd = 0;
        t.mark = null;
      } else if (ibAbs > 0 && Math.sign(ibQty) === asSign) {
        if (t.openQty !== ibAbs) {
          t.openQty = ibAbs;
          t.ibReconciled = 'qty';
          t.status = t.exitQty > 0 ? 'partial' : 'open';
        }
        const avg = ibkrAvgToFillUnit(ibp.avgCost, t.ccyScale, t.avgEntry);
        if (avg > 0) {
          const tick = t.ccyScale === 100 ? 0.1 : (avg >= 1000 ? 1 : avg >= 100 ? 0.05 : 0.01);
          if (Math.abs(t.avgEntry - avg) > tick) {
            t.avgEntry = avg;
            t.ibReconciled = (t.ibReconciled ? t.ibReconciled + '+avg' : 'avg');
          }
        }
      }
    }

    const daily = new Map();
    const dailyError = new Map();
    let totRealUsd = 0, totUnrealUsd = 0, wins = 0, losses = 0, openCount = 0, closedCount = 0;
    let errRealUsd = 0, errUnrealUsd = 0, errOpen = 0, errClosed = 0;
    for (const t of trades) {
      const fx = await ibkrUsdPerCcy(t.currency);
      t.realizedUsd = +(t.realizedLocal * fx).toFixed(2);
      const dir = t.side === 'sell' ? -1 : 1;
      let mark = markMap[t.ticker] && Number(markMap[t.ticker].price) > 0 ? Number(markMap[t.ticker].price) : null;
      // LSE fills are in pence (ccyScale=100); IB sometimes ticks in pounds.
      if (mark != null && t.ccyScale === 100 && t.avgEntry > 0 && mark * 10 < t.avgEntry) mark *= 100;
      t.mark = mark;
      t.markSrc = mark != null ? (markMap[t.ticker] && markMap[t.ticker].src) || null : null;
      t.unrealizedUsd = (t.openQty > 0 && mark != null)
        ? +(((mark - t.avgEntry) * t.openQty * dir / (t.ccyScale || 1)) * fx).toFixed(2)
        : (t.openQty > 0 ? null : 0);

      if (t.errorTrade) {
        errRealUsd += t.realizedUsd;
        if (t.unrealizedUsd != null) errUnrealUsd += t.unrealizedUsd;
        if (t.status === 'closed') errClosed++; else errOpen++;
      } else {
        totRealUsd += t.realizedUsd;
        if (t.unrealizedUsd != null) totUnrealUsd += t.unrealizedUsd;
        if (t.status === 'closed') {
          closedCount++;
          if (t.realizedUsd > 0) wins++; else if (t.realizedUsd < 0) losses++;
        } else openCount++;
      }
      // Daily realized: attribute each exit fill's PnL (vs avg entry) to its day.
      for (const f of t.fills) {
        if (f.role === 'entry') continue;
        const day = String(f.time).slice(0, 10);
        const pnlUsd = ((f.price - t.avgEntry) * f.qty * dir / (t.ccyScale || 1)) * fx;
        if (t.errorTrade) dailyError.set(day, (dailyError.get(day) || 0) + pnlUsd);
        else daily.set(day, (daily.get(day) || 0) + pnlUsd);
      }
    }

    // Flatten / exit reporting: include ALL realised on the same ticker that
    // shares a flatten (closed + partial). Example: 2914 short +14 and long
    // flatten −9 → tickerGroupRealized = +5 (not +14 alone).
    const byTicker = new Map();
    for (const t of trades) {
      if (t.errorTrade) continue;
      const k = String(t.ticker || '').toUpperCase();
      if (!byTicker.has(k)) byTicker.set(k, []);
      byTicker.get(k).push(t);
    }
    for (const [, group] of byTicker) {
      const anyFlat = group.some(t => t.hasFlatten);
      if (!anyFlat) continue;
      const groupReal = +group.reduce((s, t) => s + (t.realizedUsd || 0), 0).toFixed(2);
      for (const t of group) {
        if (t.hasFlatten || t.status === 'closed') t.tickerGroupRealizedUsd = groupReal;
      }
    }

    const dailyArr = [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([date, pnl]) => ({ date, realizedUsd: +pnl.toFixed(2) }));
    let cum = 0;
    for (const d of dailyArr) { cum += d.realizedUsd; d.cumUsd = +cum.toFixed(2); }
    const dailyErrorArr = [...dailyError.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([date, pnl]) => ({ date, realizedUsd: +pnl.toFixed(2) }));
    trades.sort((a, b) => (a.entryTime < b.entryTime ? 1 : -1));

    const reconReport = loadIbkrReconReport();
    res.json({
      ok: true,
      trades,
      daily: dailyArr,
      dailyError: dailyErrorArr,
      totals: {
        realizedUsd: +totRealUsd.toFixed(2),
        unrealizedUsd: +totUnrealUsd.toFixed(2),
        openCount, closedCount, wins, losses,
        winRate: (wins + losses) ? Math.round(wins / (wins + losses) * 100) : null,
        errorRealizedUsd: +errRealUsd.toFixed(2),
        errorUnrealizedUsd: +errUnrealUsd.toFixed(2),
        errorOpenCount: errOpen,
        errorClosedCount: errClosed
      },
      fillCount: rows.length,
      errorTickers: [...new Set([...IBKR_ERROR_TRADE_TICKERS, ...IBKR_FORCE_ERROR_TICKERS])],
      reconcile: reconReport ? {
        ok: !!reconReport.ok,
        at: reconReport.at,
        matched: reconReport.matched || 0,
        adjusted: reconReport.adjusted || 0,
        pendingIssues: reconReport.pendingIssues || 0,
        errors: reconReport.errors || 0,
        untrackedIb: reconReport.untrackedIb || 0,
        issues: (reconReport.issues || []).slice(0, 20),
        untrackedIbRows: (reconReport.untrackedIbRows || []).slice(0, 20),
        adjustedRows: (reconReport.adjustedRows || []).slice(0, 20)
      } : null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/history/audit', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').trim().split('\n');
    res.json(lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } }));
  } catch (_) { res.json([]); }
});

// ── PORTFOLIO RISK-OFF SWITCH ────────────────────────────────────────────────
// Fund-style guardrail: if portfolio equity draws down ≥15% from its persisted
// peak (on the $700k notional pool), NEW entries pause. Existing positions keep
// managing their exits normally — this throttles fresh risk, it never touches
// open trades. State survives deploys on /var/data.
const RISK_STATE_FILE = path.join(path.dirname(HISTORY_FILE), 'risk_state.json');
const RISK_POOL = 700000;
const RISK_MAX_DD = 0.15;
let riskState = { peakEquity: RISK_POOL, equity: RISK_POOL, drawdownPct: 0, riskOff: false, updated: null };
try {
  const loaded = JSON.parse(fs.readFileSync(RISK_STATE_FILE, 'utf8'));
  riskState = { ...riskState, ...loaded };
} catch (_) {}

/** Marked PnL once per trade (primary horizon only — never sum short+medium+long).
 *  Hardened against corrupt history: de-dupes by trade key and clamps each trade's
 *  contribution to ±NOTIONAL (a $10k-notional position cannot realistically lose or
 *  gain more than its notional), so duplicated/garbage rows can no longer drive the
 *  risk-guard equity to an impossible value (the 27,400,159% drawdown bug). */
const RISK_NOTIONAL = 10000;
function portfolioMarkedPnl() {
  let pnl = 0;
  const seen = new Set();
  for (const h of tradeHistory) {
    if (!(h.action === 'Buy' || h.action === 'Sell')) continue;
    const hz = h.hz || 'short';
    const key = [h.ticker || h.symbol || '', h.entryDate || h.date || h.ts || '', hz, h.action]
      .join('|');
    if (seen.has(key)) continue;       // ignore duplicate rows
    seen.add(key);
    let v = Number(h[hz + 'PnlDollar']);
    if (!Number.isFinite(v)) v = Number(h.pnlDollar);
    if (!Number.isFinite(v)) continue;
    // A single $10k-notional trade cannot move the pool by more than its notional.
    if (v > RISK_NOTIONAL) v = RISK_NOTIONAL;
    else if (v < -RISK_NOTIONAL) v = -RISK_NOTIONAL;
    pnl += v;
  }
  return pnl;
}

function persistRiskState() {
  try { fs.writeFileSync(RISK_STATE_FILE, JSON.stringify(riskState)); } catch (_) {}
}

function updateRiskState() {
  const pnl = portfolioMarkedPnl();
  const equity = RISK_POOL + pnl;
  riskState.equity = Math.round(equity);
  riskState.pnl = Math.round(pnl);
  // Bootstrap / repair peak. A peak that has collapsed far below the pool is the
  // fingerprint of the old peak=1 corruption — rebuild it. A legitimately rebased
  // peak (e.g. after a manual reset to current equity) is left intact.
  if (!(Number(riskState.peakEquity) > RISK_POOL * 0.5)) {
    riskState.peakEquity = Math.max(RISK_POOL, Math.round(equity));
  }
  if (equity > riskState.peakEquity) riskState.peakEquity = Math.round(equity);
  const peak = Number(riskState.peakEquity) || RISK_POOL;
  // Clamp to [0,1] so a data glitch can never render an absurd drawdown %.
  const dd = peak > 0 ? Math.min(1, Math.max(0, (peak - equity) / peak)) : 0;
  const wasOff = !!riskState.riskOff;
  riskState.riskOff = dd >= RISK_MAX_DD;
  riskState.drawdownPct = +(dd * 100).toFixed(2);
  riskState.updated = new Date().toISOString();
  if (riskState.riskOff !== wasOff) {
    auditLog(riskState.riskOff ? 'risk_off_engaged' : 'risk_off_cleared', {
      equity: riskState.equity, peak: riskState.peakEquity, ddPct: riskState.drawdownPct, pnl
    });
  }
  persistRiskState();
  return riskState;
}

/** Rebase peak to current equity → drawdown 0, risk-off cleared. */
function resetRiskGuard(reason) {
  const pnl = portfolioMarkedPnl();
  const equity = RISK_POOL + pnl;
  // Peak = current equity so DD is exactly 0 after reset (user intent). Only fall
  // back to the pool if equity is non-positive (corrupt), so reset can never
  // re-collapse peak to 1 and instantly re-trip risk-off — it always clears.
  const peak = equity > 0 ? Math.round(equity) : RISK_POOL;
  riskState = {
    peakEquity: peak,
    equity: Math.round(equity),
    pnl: Math.round(pnl),
    drawdownPct: 0,
    riskOff: false,
    updated: new Date().toISOString(),
    resetAt: new Date().toISOString(),
    resetReason: reason || 'manual'
  };
  persistRiskState();
  auditLog('risk_state_reset', { equity: riskState.equity, peak: riskState.peakEquity, pnl, reason: riskState.resetReason });
  return riskState;
}

// Heal a corrupt risk_state left by the old "peak=0 + equity=pnl" formula.
(function healRiskStateOnBoot() {
  try {
    const peak = Number(riskState.peakEquity) || 0;
    const eq = Number(riskState.equity) || 0;
    const dd = Number(riskState.drawdownPct) || 0;
    const bogus = peak <= 0 || dd > 100 || eq < 0 || (riskState.riskOff && dd > 50);
    if (bogus) {
      console.warn('Risk state heal: rebasing peak (was peak=', peak, 'equity=', eq, 'dd=', dd, ')');
      resetRiskGuard('boot_heal');
    } else {
      updateRiskState();
    }
  } catch (_) {}
})();

app.get('/api/risk-status', (req, res) => {
  try { updateRiskState(); } catch (_) {}
  res.json(riskState);
});

app.post('/api/risk-status/reset', express.json(), (req, res) => {
  try {
    const state = resetRiskGuard('manual_ui');
    // Do NOT call updateRiskState() here — it used to re-raise peak / re-trip risk-off.
    res.json({ ok: true, ...state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** tp1_hit / tp2_hit are EXTINCT statuses — the engine can no longer produce
 *  them (ALL trades live under the partial+TSL regime). Any appearance means
 *  STALE data: typically a browser re-uploading pre-fold-in localStorage rows
 *  via /api/history/add after a deploy. A one-time disk flag CANNOT hold this
 *  invariant (the stale rows arrive AFTER the flag burns and then stick — they
 *  showed in Realised with a live runner missing from Live, and were wrongly
 *  counted as closed wins). So the fold-in is enforced at EVERY boundary:
 *  ingest, update-pnl and each refresh pass. Legitimate closed rows are never
 *  touched — the sim simply cannot emit these two statuses anymore. */
function normalizeExtinctStatuses(rows, source) {
  let n = 0;
  for (const h of rows || []) {
    if (!h || !(h.action === 'Buy' || h.action === 'Sell')) continue;
    const hzL = h.hz ? [h.hz] : ['short', 'medium', 'long'];
    for (const hz of hzL) {
      const s = h[hz + 'Status'];
      if (s !== 'tp1_hit' && s !== 'tp2_hit') continue;
      auditLog('foldin_reopen', { ticker: h.ticker, hz, from: s, source: source || 'refresh' });
      h[hz + 'Status'] = 'open';
      h[hz + 'ExitPrice'] = undefined;
      h[hz + 'ExitTs'] = undefined;
      h[hz + 'ExitReason'] = '';
      h[hz + 'TslActivated'] = false;
      h[hz + 'DonationV'] = undefined; // donation re-stamps after re-decision
      if ((h.hz || 'short') === hz) h.status = 'open';
      n++;
    }
  }
  return n;
}

// POST /api/history/refresh-pnl — server-side trailing SL + signal-flip exit + PnL
app.post('/api/history/refresh-pnl', express.json(), async (req, res) => {
  // Render's disk is ephemeral; on each deploy the client re-uploads its localStorage history
  // (which can still contain pre-floor tight stops). Re-run the migration here so the fix
  // applies to whatever was just uploaded, not only to boot-time data.
  const legacyFix = migrateLegacyTightStops();

  // One-time backfill: older closed rows stored $0 PnL because position sizing
  // floored to 0 shares for high-priced names. Recompute $ from the stored % on
  // a fixed $10k notional so the history display is correct without re-simulating.
  let dollarFixed = 0;
  for (const h of tradeHistory) {
    for (const hz of ['short', 'medium', 'long']) {
      const pct = h[hz + 'PnlPct'];
      const dol = h[hz + 'PnlDollar'];
      if (pct != null && Number.isFinite(+pct) && +pct !== 0 && (dol == null || +dol === 0)) {
        h[hz + 'PnlDollar'] = +((+pct / 100) * 10000).toFixed(2);
        if ((h.hz || 'short') === hz) h.pnlDollar = h[hz + 'PnlDollar'];
        dollarFixed++;
      }
    }
  }
  if (dollarFixed) saveHistoryFile(tradeHistory);

  // One-time remediation: the previous build retroactively closed live trades as
  // signal_exit by replaying fund-less historical signals (and mislabeled recent
  // opens as time_limit). Reopen those soft-closed rows once so the corrected
  // logic re-evaluates them; genuine flips / expiries will simply re-close.
  if (!_softCloseRemediated) {
    let reopened = 0;
    for (const h of tradeHistory) {
      for (const hz of ['short', 'medium', 'long']) {
        const s = h[hz + 'Status'];
        // Only reopen soft-closes that look like the OLD bug: no ExitTs (never
        // stamped by the hybrid path sim) and near-zero / missing PnL. Genuine
        // settled exits keep their status so closed months stay frozen.
        if (s !== 'signal_exit' && s !== 'time_limit') continue;
        const hasExitTs = !!h[hz + 'ExitTs'];
        const pnl = h[hz + 'PnlDollar'];
        const nearZero = pnl == null || !Number.isFinite(+pnl) || Math.abs(+pnl) < 1;
        if (hasExitTs && !nearZero) continue;
        h[hz + 'Status'] = 'open';
        h[hz + 'ExitPrice'] = undefined;
        h[hz + 'ExitReason'] = '';
        if ((h.hz || 'short') === hz) h.status = 'open';
        reopened++;
      }
    }
    _softCloseRemediated = true;
    try { fs.writeFileSync(SOFT_CLOSE_FLAG, new Date().toISOString()); } catch (_) {}
    if (reopened) saveHistoryFile(tradeHistory);
  }

  // ALWAYS-ON: fold any extinct tp1_hit/tp2_hit rows back into partial+TSL so
  // the sim re-decides them this pass. Idempotent — legitimate rows can never
  // carry these statuses, so a clean history is a no-op here.
  {
    const foldN = normalizeExtinctStatuses(tradeHistory, 'refresh');
    if (foldN) { saveHistoryFile(tradeHistory); console.log('Partial+TSL fold-in: reopened', foldN, 'stale full-TP1/TP2 rows'); }
  }

  // GRANDFATHER: rows settled before settlement-date accounting existed keep the
  // period they were already reported in (their exit-bar session). Stamped once.
  {
    const _SET = ['tp1_then_sl', 'tp1_then_time', 'sl_hit', 'time_limit', 'signal_exit'];
    let gf = 0;
    for (const h of tradeHistory) {
      if (!(h.action === 'Buy' || h.action === 'Sell')) continue;
      const hzL = h.hz ? [h.hz] : ['short', 'medium', 'long'];
      for (const hz of hzL) {
        if (!_SET.includes(h[hz + 'Status']) || h[hz + 'SettledTs']) continue;
        h[hz + 'SettledTs'] = Number(h[hz + 'ExitTs']) || new Date(h.entryDate || h.timestamp || 0).getTime() || Date.now();
        gf++;
      }
    }
    if (gf) saveHistoryFile(tradeHistory);
  }

  // One-time R:R re-floor (v7.9.6): widen TP1/SL on still-OPEN trades to the new
  // reward:risk discipline. Entry is NEVER changed (frozen); closed/settled rows
  // keep their historical levels. Fixes legacy picks whose stop met the floor but
  // whose TP1 was the old 0.62× (too-tight) target.
  if (!_rrRefloored) {
    let rrFixed = 0;
    for (const h of tradeHistory) {
      if (!isHistoryBuySellRecord(h)) continue;
      const isSell = String(h.action || '').toLowerCase() === 'sell';
      for (const hz of ['short', 'medium', 'long']) {
        const isPrimary = (h.hz || 'short') === hz;
        const hasHzEntry = h[hz + 'Entry'] != null && h[hz + 'Entry'] !== '';
        if (!hasHzEntry && !isPrimary) continue; // don't fabricate levels for unused horizons
        const status = (h[hz + 'Status'] != null && h[hz + 'Status'] !== '')
          ? h[hz + 'Status'] : (isPrimary ? (h.status || 'open') : 'open');
        if (status !== 'open') continue; // only adjust live positions
        const entry = parseFloat(hasHzEntry ? h[hz + 'Entry'] : (h.entry || 0));
        if (!entry || !Number.isFinite(entry)) continue;
        const tp1 = parseFloat(h[hz + 'Target1'] || h.target1 || 0) || null;
        const sl  = parseFloat(h[hz + 'StopLoss'] || h.stopLoss || 0) || null;
        if (!tp1 && !sl) continue;
        const tp2Cur = parseFloat(h[hz + 'Target2'] || h.target2 || 0) || null;
        const fixed = applyHorizonMinPctFloors(entry, tp1, tp2Cur, sl, isSell, hz);
        h[hz + 'Target1'] = fixed.tp1;
        h[hz + 'Target2'] = fixed.tp2; // TP2 = REFERENCE level for exit-quality analysis — NEVER an exit, never blanked
        h[hz + 'StopLoss'] = fixed.sl;
        if (isPrimary) { h.target1 = fixed.tp1; h.target2 = fixed.tp2; h.stopLoss = fixed.sl; }
        if (isSell) { h.sellTarget1 = fixed.tp1; h.sellTarget2 = fixed.tp2; h.sellStopLoss = fixed.sl; }
        rrFixed++;
      }
    }
    _rrRefloored = true;
    try { fs.writeFileSync(RR_REFLOOR_FLAG, new Date().toISOString()); } catch (_) {}
    if (rrFixed) { saveHistoryFile(tradeHistory); console.log('R:R re-floor (v7.9.6): adjusted', rrFixed, 'open rows'); }
  }

  const sinceMs = req.body?.since ? new Date(req.body.since).getTime() : 0;

  // Fetch OHLCV for open rows AND for closed rows that still need analytics
  // backfill (donation / TP2 hit / sector / shares). Skipping closed tickers
  // left Donation % and TP2 blank forever on settled trades.
  const needsClosedBackfill = (h) => {
    const hz = h.hz || 'short';
    const s = h[hz + 'Status'] || h.status;
    if (!['tp1_hit', 'tp2_hit', 'sl_hit', 'signal_exit', 'time_limit', 'tp1_then_sl', 'tp1_then_time'].includes(s)) return false;
    return h[hz + 'DonationV'] !== 2 // v145 TP1-clock donation not yet stamped
      || h[hz + 'Tp2Hit'] == null
      || h[hz + 'SharesTotal'] == null
      || !h[hz + 'SectorTrend'];
  };
  const isOpenRow = (h) => {
    const hz = h.hz || 'short';
    const s = h[hz + 'Status'] || h.status;
    return !s || s === 'open' || s === 'tp1_open' || s === 'n/a';
  };
  const tickers = [...new Set(
    tradeHistory
      .filter(h => (h.action === 'Buy' || h.action === 'Sell')
        && (isOpenRow(h) || needsClosedBackfill(h))
        && (!sinceMs || new Date(h.entryDate || h.timestamp || 0).getTime() >= sinceMs))
      .map(h => h.ticker)
      .filter(Boolean)
  )];
  const DEADLINE = Date.now() + 230000; // return before Render's request ceiling
  const priceMap = {};
  for (let off = 0; off < tickers.length; off += 12) {
    if (Date.now() > DEADLINE) break;
    await Promise.all(tickers.slice(off, off + 12).map(async sym => {
      try {
        const q = await fetchSinglePrice(sym);
        if (q?.price) priceMap[sym] = parseFloat(q.price);
      } catch (_) {}
    }));
  }

  const ohlcvMap = {};
  const techLiveMap = {};
  for (let off = 0; off < tickers.length; off += 8) {
    if (Date.now() > DEADLINE) break;
    const slice = tickers.slice(off, off + 8);
    await Promise.all(slice.map(async sym => {
      try {
        // 2y daily is ample for live signals and the (recent-entry) path sim;
        // derive weekly locally to avoid a second network round-trip per symbol.
        const bars = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
        if (bars && bars.length >= 60) {
          ohlcvMap[sym] = bars;
          const weekly = dailyToWeeklyBars(bars);
          const tech = buildFullTechResult(sym, bars, weekly);
          // Use the SAME cached fundamentals the dashboard scored with, so the live
          // signal here matches the displayed rating. Recomputing with fund=null made
          // a fund-boosted "Strong Buy" look like a Hold and falsely flipped it out.
          let fund = fundCache.get(sym)?.data || null;
          if (!fund && Date.now() < DEADLINE) {
            // Cold cache (e.g. just after a deploy) — fetch once and cache for reuse.
            fund = await fetchFundamentals(sym).catch(() => null);
            if (fund) fundCache.set(sym, { ts: Date.now(), data: fund });
          }
          if (tech._sectorRegime == null) tech._sectorRegime = sectorRegimeForSymbol(sym);
          if (tech._earningsTide == null) tech._earningsTide = earningsTideForSymbol(sym);
          tech.quantSignal = {
            short: computeQuantSignal(tech, fund, 'short'),
            medium: computeQuantSignal(tech, fund, 'medium'),
            long: computeQuantSignal(tech, fund, 'long')
          };
          techLiveMap[sym] = tech;
        }
      } catch (_) {}
    }));
  }

  let updated = 0;
  let signalExits = 0;
  for (const h of tradeHistory) {
    if (sinceMs && new Date(h.entryDate || h.timestamp || 0).getTime() < sinceMs) continue;
    const curr = priceMap[h.ticker];
    const isSell = String(h.action || '').toLowerCase() === 'sell';
    const dir = isSell ? -1 : 1;
    const hzList = h.hz ? [h.hz] : ['short', 'medium', 'long'];
    let rowChanged = false;
    const hzPrimary = h.hz || 'short';
    const stPrimary = h[hzPrimary + 'Status'] || h.status;
    const isClosedPrimary = ['tp1_hit', 'tp2_hit', 'sl_hit', 'signal_exit', 'time_limit', 'tp1_then_sl', 'tp1_then_time'].includes(stPrimary);
    // Open rows need a live quote. Closed rows can still backfill donation/TP2/shares
    // from OHLCV alone — don't skip them when Yahoo price is missing.
    if ((!curr || !Number.isFinite(curr)) && !isClosedPrimary) continue;

    for (const hz of hzList) {
      const st = h[hz + 'Status'];
      const entryMs = new Date(h.entryDate || h.timestamp || 0).getTime();
      const bars = ohlcvMap[h.ticker];
      if (['tp1_hit', 'tp2_hit', 'sl_hit', 'signal_exit', 'time_limit', 'tp1_then_sl', 'tp1_then_time'].includes(st)) {
        // CLOSED rows: backfill analytics only — never rewrite PnL / status / exit.
        // Exception: legacy `tp1_hit` from the old full-exit-at-TP1 engine is
        // remapped to `tp1_then_sl` semantics in the UI; here we stamp Tp1Hit and
        // compute whether price later reached TP2 (reference) + giveback donation.
        const entryC = parseFloat(h[hz + 'Entry'] || h.entry || 0);
        if (entryC && (h[hz + 'SharesTotal'] === undefined || h[hz + 'SharesTotal'] === null)) {
          const spl = computeShareSplit(entryC);
          h[hz + 'SharesTotal'] = spl.total;
          h[hz + 'SharesSoldTP1'] = spl.sold;
          h[hz + 'SharesRunner'] = spl.runner;
          rowChanged = true;
        }
        // Ensure TP2 reference exists — ATR extension beyond TP1, not 2× invent.
        const tp1C = parseFloat(h[hz + 'Target1'] || h.target1 || 0);
        let tp2C = parseFloat(h[hz + 'Target2'] || h.target2 || 0);
        if (entryC && tp1C && (!tp2C || !Number.isFinite(tp2C))) {
          let atrEst = null;
          if (bars && bars.length >= 15) {
            let sum = 0, n = 0;
            for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
              const b = bars[i], p = bars[i - 1];
              if (!b || !p) continue;
              const tr = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
              if (Number.isFinite(tr)) { sum += tr; n++; }
            }
            if (n) atrEst = sum / n;
          }
          const mult = hz === 'short' ? 2.8 : hz === 'medium' ? 5.0 : 8.0;
          if (atrEst > 0) {
            tp2C = isSell ? entryC - mult * atrEst : entryC + mult * atrEst;
          } else {
            const d1 = Math.abs(tp1C - entryC);
            tp2C = isSell ? tp1C - 0.75 * d1 : tp1C + 0.75 * d1;
          }
          if (!isSell && !(tp2C > tp1C)) tp2C = tp1C * 1.04;
          if (isSell && !(tp2C < tp1C)) tp2C = tp1C * 0.96;
          h[hz + 'Target2'] = roundPrice(tp2C);
          if ((h.hz || 'short') === hz) h.target2 = h[hz + 'Target2'];
          rowChanged = true;
        }
        if (st === 'tp1_hit' || st === 'tp1_then_sl' || st === 'tp1_then_time' || st === 'tp2_hit') {
          if (!h[hz + 'Tp1Hit']) { h[hz + 'Tp1Hit'] = true; rowChanged = true; }
        }
        if (bars && bars.length && entryC) {
          const tpDonation = computeTpDonationAnalytics(bars, entryMs, hz, h, isSell);
          if (tpDonation) {
            const pairs = [
              ['Tp1Hit', tpDonation.tp1Hit || !!h[hz + 'Tp1Hit']],
              ['Tp2Hit', tpDonation.tp2Hit],
              ['Tp1DonationPct', tpDonation.tp1DonationPct],
              ['Tp2DonationPct', tpDonation.tp2DonationPct],
              ['Tp1BestPrice', tpDonation.tp1BestPrice],
              ['Tp2BestPrice', tpDonation.tp2BestPrice]
            ];
            for (const [suffix, val] of pairs) {
              if (h[hz + suffix] !== val) {
                h[hz + suffix] = val;
                rowChanged = true;
              }
            }
          }
          if (h[hz + 'DonationV'] !== 2) {
            // v145: donation clock starts at the TP1 PRINT (user spec). This also
            // RE-stamps rows the v144 build measured from entry — the version
            // marker forces exactly one recompute, then the value is frozen.
            const exitPxC = parseFloat(h[hz + 'ExitPrice'] || 0) || null;
            const tp1LvC = parseFloat(h[hz + 'Target1'] || h.target1 || 0) || null;
            const tp1MsC = tp1LvC ? findTp1PrintMs(bars, entryMs, tp1LvC, isSell) : null;
            const gvC = (exitPxC && tp1MsC) ? computeGivebackDonation(bars, tp1MsC, exitPxC, isSell, h[hz + 'ExitTs'] || null) : null;
            h[hz + 'DonationPct'] = gvC ? gvC.pct : null; // null = TP1 never printed → no donation concept
            h[hz + 'FavExtreme'] = gvC ? gvC.fav : null;
            h[hz + 'DonationV'] = 2;
            rowChanged = true;
          }
        }
        // Sector trend for closed rows (was only computed on open path).
        try {
          const _secC = h.fundSnapshot?._fmpSector || h.sector || null;
          if (_secC && !h[hz + 'SectorTrend']) {
            const _stLabelC = await sectorTrendLabel(_secC);
            if (_stLabelC) {
              h[hz + 'SectorTrend'] = _stLabelC;
              rowChanged = true;
            }
          }
        } catch (_) {}
        continue;
      }
      // A trade entered today keeps its scan-time entry (that IS the correct entry);
      // only older rows need the historical-close repair / are eligible to flip.
      const enteredToday = singaporeToDateString(entryMs) === singaporeToDateString();

      // ENTRY FINALISATION (always-on, once per trade): the recorded entry must be
      // the MARKET OPEN of the session the fill actually happens in — the FIRST
      // daily bar ON OR AFTER the signal date. (The old repair picked the bar
      // on-or-BEFORE the date, so weekend/pre-market picks froze the PREVIOUS
      // session's open — a price the trade could never have got. It was also
      // one-time and skipped today's trades, so fresh picks kept provisional
      // prices forever.) Runs until the target bar exists, then locks.
      // Rows finalised under the old UTC-date rule carry no entrySource — clear
      // the flag once so the corrected epoch rule re-derives their entry.
      if (h.entryFinalized && !h.entrySource) h.entryFinalized = false;
      if (!h.entryFinalized && bars && bars.length) {
        // Fill = the first session whose OPEN happens AFTER the signal existed.
        // (Bar timestamps are session starts.) The old UTC-date match backdated
        // any after-close signal to that same morning's open — a price the trade
        // could never have executed at, which made entries look arbitrary.
        let entryBar = null;
        for (const b of bars) {
          const bT = (b.t || 0) * 1000;
          if (bT > entryMs) { entryBar = b; break; } // first session starting after signal
        }
        // If the signal landed DURING a session (bar started before the signal but
        // that session's date matches the signal date), a same-day live fill is
        // legitimate — but those rows are entryFinalized at generation and never
        // reach here. Anything else waits for the next bar to print.
        const op = entryBar ? ((entryBar.o != null && entryBar.o > 0) ? entryBar.o : entryBar.c) : null;
        if (op && op > 0) {
          const fixed = roundPrice(op);
          const prevEntry = parseFloat(h[hz + 'Entry'] || h.entry || 0) || null;
          h[hz + 'Entry'] = fixed;
          if ((h.hz || 'short') === hz) h.entry = fixed;
          h.entryFinalized = true;
          h.entryPending = false;
          h.entrySource = 'session open ' + new Date((entryBar.t || 0) * 1000).toISOString().slice(0, 10);
          // Keep TP/SL consistent with the corrected entry: scale the stored
          // levels by the entry ratio (full re-derivation happens on the next
          // recalibrate-levels pass; this keeps RR sane in the meantime).
          if (prevEntry && Math.abs(fixed - prevEntry) / prevEntry > 0.0005) {
            const k = fixed / prevEntry;
            // Target2 included: it is reference-only (exit-quality analytics),
            // but leaving it unscaled corrupted TP2-reached stats (audit F2).
            for (const lf of [hz + 'Target1', hz + 'Target2', hz + 'StopLoss']) {
              const v = parseFloat(h[lf] || 0);
              if (v > 0) h[lf] = roundPrice(v * k);
            }
          }
          rowChanged = true;
        }
      }

      const entry = parseFloat(h[hz + 'Entry'] || h.entry || 0);
      if (!entry) continue;

      const tpDonation = bars && bars.length
        ? computeTpDonationAnalytics(bars, entryMs, hz, h, isSell)
        : null;
      if (tpDonation) {
        const pairs = [
          ['Tp1Hit', tpDonation.tp1Hit],
          ['Tp2Hit', tpDonation.tp2Hit],
          ['Tp1DonationPct', tpDonation.tp1DonationPct],
          ['Tp2DonationPct', tpDonation.tp2DonationPct],
          ['Tp1BestPrice', tpDonation.tp1BestPrice],
          ['Tp2BestPrice', tpDonation.tp2BestPrice]
        ];
        for (const [suffix, val] of pairs) {
          if (h[hz + suffix] !== val) {
            h[hz + suffix] = val;
            rowChanged = true;
          }
        }
      }

      // TRADE GIVEBACK ("drawdown"): the move from the trade's favorable extreme
      // since entry to the current price. Longs: peak high → CMP. Shorts: trough
      // low → CMP (the adverse retrace). Recorded on every refresh so History can
      // show how much of the best excursion each open trade has donated back.
      if (bars && bars.length && curr > 0) {
        const _dd0 = new Date(entryMs).toISOString().slice(0, 10);
        let _pk = null, _tr = null;
        for (const b of bars) {
          const _bs = new Date((b.t || 0) * 1000).toISOString().slice(0, 10);
          if (_bs < _dd0) continue;
          if (b.h != null && (_pk == null || b.h > _pk)) _pk = b.h;
          if (b.l != null && (_tr == null || b.l < _tr)) _tr = b.l;
        }
        let _peakP = null, _givePct = null;
        if (!isSell && _pk > 0) { _peakP = roundPrice(_pk); _givePct = +(((_pk - curr) / _pk) * 100).toFixed(2); }
        else if (isSell && _tr > 0) { _peakP = roundPrice(_tr); _givePct = +(((curr - _tr) / _tr) * 100).toFixed(2); }
        if (_peakP != null && (h[hz + 'PeakPrice'] !== _peakP || h[hz + 'DrawdownFromPeakPct'] !== _givePct)) {
          h[hz + 'PeakPrice'] = _peakP;
          h[hz + 'DrawdownFromPeakPct'] = _givePct;
          rowChanged = true;
        }
      }

      // SECTOR TREND context — is the stock's sector trending with or against
      // the position? Cached per-ETF, so this costs at most one fetch per sector
      // per 6h regardless of how many trades share it.
      try {
        const _sec = h.fundSnapshot?._fmpSector || h.sector || null;
        if (_sec) {
          const _stLabel = await sectorTrendLabel(_sec);
          if (_stLabel && h[hz + 'SectorTrend'] !== _stLabel) {
            h[hz + 'SectorTrend'] = _stLabel;
            rowChanged = true;
          }
        }
      } catch (_) { /* sector context is best-effort */ }

      // EXHAUSTION analysis — how stretched is the move powering this trade?
      // High exhaustion = the favorable move is statistically tired (RSI extreme,
      // price far from MA20, long run of one-way closes) → tighten the trail /
      // consider banking. This is the exit-quality input the TP/TSL tuning uses.
      try {
        if (bars && bars.length >= 25 && curr > 0) {
          const _cl = bars.map(b => b.c).filter(v => v != null);
          const _rsiX = calcRSI(_cl, 14);
          const _ma20X = calcSMA(_cl, 20);
          const _stretch = _ma20X ? ((curr - _ma20X) / _ma20X) * 100 : 0;
          let _run = 0;
          for (let _i = _cl.length - 1; _i >= 1; _i--) {
            const up = _cl[_i] > _cl[_i - 1];
            if ((!isSell && up) || (isSell && !up)) _run++; else break;
          }
          // Favorable-direction extremes: overbought+stretched for longs,
          // oversold+overshot for shorts.
          let _score = 0; const _why = [];
          if (!isSell) {
            if (_rsiX >= 78) { _score += 2; _why.push('RSI ' + Math.round(_rsiX)); }
            else if (_rsiX >= 70) { _score += 1; _why.push('RSI ' + Math.round(_rsiX)); }
            if (_stretch >= 12) { _score += 2; _why.push('+' + _stretch.toFixed(0) + '% vs MA20'); }
            else if (_stretch >= 8) { _score += 1; _why.push('+' + _stretch.toFixed(0) + '% vs MA20'); }
            if (_run >= 4) { _score += 1; _why.push(_run + '↑'); }
          } else {
            if (_rsiX <= 22) { _score += 2; _why.push('RSI ' + Math.round(_rsiX)); }
            else if (_rsiX <= 30) { _score += 1; _why.push('RSI ' + Math.round(_rsiX)); }
            if (_stretch <= -12) { _score += 2; _why.push(_stretch.toFixed(0) + '% vs MA20'); }
            else if (_stretch <= -8) { _score += 1; _why.push(_stretch.toFixed(0) + '% vs MA20'); }
            if (_run >= 4) { _score += 1; _why.push(_run + '↓'); }
          }
          const _exLabel = _score >= 3 ? 'Exhaustion HIGH' : _score >= 1 ? 'Exhaustion building' : null;
          const _exStr = _exLabel ? (_exLabel + (_why.length ? ' (' + _why.join(' · ') + ')' : '')) : null;
          if (h[hz + 'Exhaustion'] !== _exStr) { h[hz + 'Exhaustion'] = _exStr; rowChanged = true; }
        }
      } catch (_) { /* exhaustion is best-effort */ }

      // Immediate exit if live signal has flipped against the open position.
      // Never flip on the SAME DAY as entry (enteredToday): a pick and its instant
      // same-price "Signal exit" ($0) is pure churn. Give every trade at least one
      // full session before the flip rule can close it.
      const flip = (!enteredToday && (st === 'open' || !st || st === 'n/a'))
        ? liveSignalFlipExit(h.ticker, hz, isSell, techLiveMap) : null;
      if (flip) {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * 10000).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'signal_exit';
        h[hz + 'ExitPrice'] = curr;
        h[hz + 'ExitReason'] = 'Signal → ' + flip.reason;
        h[hz + 'TslActivated'] = false;
        if (!h[hz + 'ExitTs']) h[hz + 'ExitTs'] = Date.now();
        if (!h[hz + 'SettledTs']) {
          h[hz + 'SettledTs'] = Date.now();
          auditLog('trade_settled', { ticker: h.ticker, hz, status: 'signal_exit', pnl: h[hz + 'PnlDollar'], exit: curr });
          try { emitTradeEvent('exit', tradeEventSnapshot(h, hz, { exitReason: h[hz + 'ExitReason'] })); } catch (_) {}
        }
        rowChanged = true;
        signalExits++;
        continue;
      }

      // liveMark=true → path sim only detects PRICE exits (TP1/SL/trailing). Signal-
      // flip closing for a live OPEN trade is decided above by liveSignalFlipExit on
      // the CURRENT signal, never by replaying noisy fund-less historical signals
      // (which was retroactively closing trades that are still rated Buy today).
      // Whole-share TP1 split — drives BOTH the History display and the exact
      // partial fraction the exit sim books at TP1 (floor(total/2) sold at TP1,
      // the larger half rides the ratchet — user rule for odd counts).
      const shareSplit = computeShareSplit(entry);
      if (h[hz + 'SharesTotal'] !== shareSplit.total || h[hz + 'SharesSoldTP1'] !== shareSplit.sold) {
        h[hz + 'SharesTotal'] = shareSplit.total;
        h[hz + 'SharesSoldTP1'] = shareSplit.sold;
        h[hz + 'SharesRunner'] = shareSplit.runner;
        rowChanged = true;
      }
      const pathExit = (bars && entry) ? await simulateTradeExitTrailing(bars, entryMs, entry, hz, isSell, curr, true, shareSplit.frac) : null;

      // Fixed $10k notional for the $ figure. Sizing by floor(10000/entry) shares
      // collapses to 0 shares for high-priced names (e.g. ¥-denominated stocks),
      // which made the $ PnL show $0 even when the % was non-zero.
      const NOTIONAL = 10000;
      if (pathExit) {
        const prevTp1 = !!h[hz + 'Tp1Hit'];
        const prevTsl = h[hz + 'LiveTrailSL'];
        const prevSettled = !!h[hz + 'SettledTs'];
        // res.ret is already directional (profit>0 for both long & short) and
        // already blends the TP1 partial — use it directly, don't re-apply `dir`.
        h[hz + 'PnlPct'] = +(pathExit.ret * 100).toFixed(2);
        h[hz + 'PnlDollar'] = +(pathExit.ret * NOTIONAL).toFixed(2);
        // EXIT-QUALITY ANALYSIS: the hypothetical "closed the runner at TP2"
        // outcome vs what the ratchet actually produced. Null = TP2 never printed.
        h[hz + 'Tp2AltPnlPct'] = pathExit.tp2AltRet != null ? +(pathExit.tp2AltRet * 100).toFixed(2) : null;
        h[hz + 'Tp2AltPnlDollar'] = pathExit.tp2AltRet != null ? +(pathExit.tp2AltRet * NOTIONAL).toFixed(2) : null;
        // Surface the LIVE trailing stop — post-TP1 this ratchets daily on
        // favorable moves (never loosens), so History shows today's actual level.
        h[hz + 'LiveTrailSL'] = (pathExit.tp1Hit && pathExit.stopLoss > 0) ? roundPrice(pathExit.stopLoss) : null;
        h[hz + 'Status'] = pathExit.status;
        h[hz + 'Tp1Hit'] = !!pathExit.tp1Hit;
        h[hz + 'Tp2Hit'] = !!(tpDonation && tpDonation.tp2Hit);
        h[hz + 'TslActivated'] = !!(pathExit.tp1Hit && pathExit.stopLoss > 0);
        const exitReasonMap = {
          open: pathExit.tp1Hit ? 'TP1 banked; runner open on trailing stop' : '',
          tp1_open: 'TP1 banked; runner open on trailing stop',
          tp1_hit: 'TP1 target hit',
          tp1_then_sl: 'TP1 banked; trailing stop closed runner',
          tp1_then_time: 'TP1 banked; horizon time exit closed runner',
          sl_hit: 'Stop loss / trailing stop hit',
          signal_exit: 'Signal reversal exit',
          time_limit: 'Horizon time limit exit'
        };
        h[hz + 'ExitReason'] = exitReasonMap[pathExit.status] || pathExit.status || '';
        if (!pathExit.open && pathExit.exit != null) h[hz + 'ExitPrice'] = roundPrice(pathExit.exit);
        // Exit timestamp = the exit BAR's session (drives weekly/monthly performance)
        const _fullExit = ['tp1_then_sl','tp1_then_time','sl_hit','time_limit','signal_exit','tp2_hit','tp1_hit'].includes(pathExit.status);
        if (_fullExit && !h[hz + 'ExitTs']) {
          const _xb = bars && pathExit.exitIdx != null ? bars[pathExit.exitIdx] : null;
          h[hz + 'ExitTs'] = _xb && _xb.t ? _xb.t * 1000 : Date.now();
        }
        // SETTLEMENT-DATE ACCOUNTING: a trade reports in the period it FIRST
        // settled — stamped once, never rewritten. ExitTs stays the truthful
        // exit-bar session, but monthly/weekly performance buckets by SettledTs,
        // so a late re-decision exiting on a historical bar lands in the CURRENT
        // period instead of mutating an already-reported month.
        if (_fullExit && !h[hz + 'SettledTs']) {
          h[hz + 'SettledTs'] = Date.now();
          auditLog('trade_settled', { ticker: h.ticker, hz, status: pathExit.status, pnl: h[hz + 'PnlDollar'], exit: h[hz + 'ExitPrice'] || null });
        }
        if (pathExit.stopLoss) h[hz + 'StopLoss'] = pathExit.stopLoss;
        if (pathExit.status === 'sl_hit') setSLCooldown(h.ticker, hz);
        // IBKR lifecycle edges (once each)
        try {
          if (!prevTp1 && pathExit.tp1Hit) {
            emitTradeEvent('tp1_partial', tradeEventSnapshot(h, hz));
          }
          if (h[hz + 'LiveTrailSL'] != null && h[hz + 'LiveTrailSL'] !== prevTsl) {
            emitTradeEvent('tsl_update', tradeEventSnapshot(h, hz, { prevTrailSl: prevTsl }));
          }
          if (_fullExit && !prevSettled) {
            emitTradeEvent('exit', tradeEventSnapshot(h, hz, { exitReason: h[hz + 'ExitReason'] }));
          }
        } catch (_) {}
        rowChanged = true;
      } else if (horizonTimeLimitExceededServer(hz, h.entryDate || h.timestamp)) {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * NOTIONAL).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'time_limit';
        h[hz + 'ExitPrice'] = curr;
        h[hz + 'ExitReason'] = 'Horizon time limit exit';
        h[hz + 'TslActivated'] = false;
        if (!h[hz + 'ExitTs']) h[hz + 'ExitTs'] = Date.now();
        if (!h[hz + 'SettledTs']) {
          h[hz + 'SettledTs'] = Date.now();
          auditLog('trade_settled', { ticker: h.ticker, hz, status: 'time_limit', pnl: h[hz + 'PnlDollar'], exit: curr });
          try { emitTradeEvent('exit', tradeEventSnapshot(h, hz, { exitReason: 'Horizon time limit exit' })); } catch (_) {}
        }
        rowChanged = true;
      } else if (st !== 'time_limit' && st !== 'sl_hit') {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * NOTIONAL).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'open';
        h[hz + 'TslActivated'] = false;
        rowChanged = true;
      }
      // GIVEBACK DONATION — v145 spec: the clock starts at the TP1 PRINT.
      // Favorable extreme AFTER TP1 printed → exit price (if this pass closed it)
      // or CMP (still open). Rows where TP1 never printed carry null (UI: —).
      if (bars && bars.length && entry) {
        const _tp1Lv = parseFloat(h[hz + 'Target1'] || h.target1 || 0) || null;
        const _tp1Ms = _tp1Lv ? findTp1PrintMs(bars, entryMs, _tp1Lv, isSell) : null;
        const _closedNow = pathExit && !pathExit.open && pathExit.exit != null;
        const _refPx = _closedNow ? pathExit.exit : curr;
        const _gv = _tp1Ms ? computeGivebackDonation(bars, _tp1Ms, _refPx, isSell, _closedNow ? (h[hz + 'ExitTs'] || null) : null) : null;
        const _pct = _gv ? _gv.pct : null;
        const _fav = _gv ? _gv.fav : null;
        if (h[hz + 'DonationPct'] !== _pct || h[hz + 'FavExtreme'] !== _fav || h[hz + 'DonationV'] !== 2) {
          h[hz + 'DonationPct'] = _pct;
          h[hz + 'FavExtreme'] = _fav;
          h[hz + 'DonationV'] = 2;
          rowChanged = true;
        }
      }
      h[hz + 'CurrentPrice'] = curr;
      // A row that is still genuinely open must not carry a stale exit note.
      if (h[hz + 'Status'] === 'open' && h[hz + 'ExitReason']) h[hz + 'ExitReason'] = '';
      if (h.hz === hz || !h.hz) {
        h.pnlDollar = h[hz + 'PnlDollar'];
        h.pnlPct = h[hz + 'PnlPct'];
        h.status = h[hz + 'Status'];
      }
    }
    if (curr && Number.isFinite(curr)) h.currentPrice = curr;
    if (rowChanged) updated++;
  }

  // Mark the one-time entry repair done once we've made a real pass over the data.
  // entry finalisation is per-trade (h.entryFinalized) — no global flag to set
  saveHistoryFile(tradeHistory);
  const _risk = updateRiskState();
  res.json({
    ok: true,
    updated,
    legacyReflored: legacyFix.refloored,
    legacyReopened: legacyFix.reopened,
    pricesFetched: Object.keys(priceMap).length,
    risk: { riskOff: _risk.riskOff, drawdownPct: _risk.drawdownPct, equity: _risk.equity, peakEquity: _risk.peakEquity },
    since: req.body?.since || null
  });
});


// ── Institutional holder flow (FMP /api/v3/institutional-holder) ──────────────
const _instCache = new Map();
const INST_TTL = 6 * 60 * 60 * 1000;

async function fetchInstitutionalFlow(symbol) {
  const now = Date.now();
  const cached = _instCache.get(symbol);
  if (cached && now - cached.ts < INST_TTL) return cached.data;
  const key = fmpEnvKeyFund ? fmpEnvKeyFund() : null;
  if (!key) return null;
  try {
    const enc = encodeURIComponent(symbol.toUpperCase().trim());
    const url = `https://financialmodelingprep.com/api/v3/institutional-holder/${enc}?apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) { _instCache.set(symbol, { ts: now, data: null }); return null; }
    const raw = await r.json().catch(() => null);
    if (!Array.isArray(raw) || !raw.length) { _instCache.set(symbol, { ts: now, data: null }); return null; }
    let netShares = 0;
    const buyers = [], sellers = [];
    for (const h of raw.slice(0, 25)) {
      const chg = Number(h.change || h.sharesChange || 0);
      netShares += chg;
      const holder = { name: h.holder || h.shareholder || 'Unknown', shares: Number(h.shares || 0), change: chg };
      if (chg > 0) buyers.push(holder);
      else if (chg < 0) sellers.push(holder);
    }
    buyers.sort((a, b) => b.change - a.change);
    sellers.sort((a, b) => a.change - b.change);
    const data = {
      symbol,
      netShares,
      netFlowLabel: netShares > 0 ? 'Net buying' : netShares < 0 ? 'Net selling' : 'Neutral',
      topBuyers: buyers.slice(0, 5).map(h => h.name + ' (+' + (h.change / 1e6).toFixed(1) + 'M)'),
      topSellers: sellers.slice(0, 5).map(h => h.name + ' (' + (h.change / 1e6).toFixed(1) + 'M)'),
      buyerCount: buyers.length,
      sellerCount: sellers.length
    };
    _instCache.set(symbol, { ts: now, data });
    return data;
  } catch (e) {
    _instCache.set(symbol, { ts: now, data: null });
    return null;
  }
}

app.get('/api/institutional-flow/:symbol', async (req, res) => {
  const sym = (req.params.symbol || '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  const data = await fetchInstitutionalFlow(sym);
  res.json(data || { symbol: sym, netShares: 0, netFlowLabel: 'No data', topBuyers: [], topSellers: [] });
});


// GET /api/backtest/medium-sell?tickers=A,B,C&window=252&side=sell&hz=medium
// Replays CURRENT signal + hybrid exit. Acceptance (v143):
//   WR ≥55% OR avg ≥+0.30%/trade, AND PF ≥1.5. Failing brackets should be gated.
const ACCEPTANCE_DEFAULT_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'MA',
  'JNJ', 'UNH', 'PG', 'HD', 'AVGO', 'LLY', 'XOM', 'CVX', 'KO', 'PEP',
  'COST', 'WMT', 'NFLX', 'AMD', 'CRM', 'ORCL', 'IBM', 'GS', 'BAC', 'MCD',
  'INTC', 'QCOM', 'TXN', 'AMAT', 'CAT', 'BA', 'GE', 'DIS', 'NKE', 'SBUX'
];

function evaluateAcceptance(agg) {
  const wr = agg && agg.winRate != null ? Number(agg.winRate) : null;
  const avg = agg && agg.avgReturnPct != null ? Number(agg.avgReturnPct) : null;
  const pf = agg && agg.meanProfitFactor != null ? Number(agg.meanProfitFactor) : null;
  const wrOk = wr != null && wr >= 55;
  const avgOk = avg != null && avg >= 0.30;
  const pfOk = pf != null && pf >= 1.5;
  const pass = (wrOk || avgOk) && pfOk;
  return {
    pass,
    criteria: 'WR≥55% OR avg≥+0.30%/trade, AND PF≥1.5',
    checks: { wrOk, avgOk, pfOk, wr, avgReturnPct: avg, meanProfitFactor: pf }
  };
}

async function runBracketAcceptance(opts = {}) {
  const hz = ['short', 'medium', 'long'].includes(opts.hz) ? opts.hz : 'medium';
  const side = ['buy', 'sell'].includes(opts.side) ? opts.side : 'sell';
  const windowBars = Math.min(1260, Math.max(60, parseInt(opts.window, 10) || 252));
  let tickers = Array.isArray(opts.tickers) ? opts.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean) : [];
  if (!tickers.length) tickers = universeShortlistTickers().slice(0, 40);
  if (!tickers.length) tickers = ACCEPTANCE_DEFAULT_TICKERS.slice();
  tickers = tickers.slice(0, Math.min(60, opts.maxTickers || 40));

  // Always pull enough history for BACKTEST_WARMUP (~220) + windowBars.
  // window=252 means "last year of walk-forward", NOT "fetch only 1y".
  const range = windowBars >= 1000 ? '5y' : '2y';
  // Build the market-momentum regime once from the benchmark index (SPY) so every
  // ticker's replay is gated by the same tide the live overlay uses.
  let spySeries = null;
  try {
    const spy = await fetchOHLCV(MARKET_BENCHMARK, range, '1d').catch(() => null);
    if (spy && spy.length >= 60) spySeries = buildMarketRegime(spy);
  } catch (_) {}
  const useSector = MARKET_OVERLAY_ENABLED && SECTOR_OVERLAY_ENABLED && opts.sector !== false;
  const perTicker = [];
  let tTrades = 0, tWins = 0, tRet = 0, gW = 0, gL = 0;
  for (const sym of tickers) {
    try {
      const daily = await fetchOHLCV(sym, range, '1d').catch(() => null);
      if (!daily || daily.length < 150) { perTicker.push({ ticker: sym, skipped: 'insufficient data' }); continue; }
      const weekly = dailyToWeeklyBars(daily);
      const fe = fundCache.get(sym);
      const fund = fe && Date.now() - fe.ts < TECH_TTL * 4 ? fe.data : null;
      // Gate each ticker by its SECTOR ETF's historical momentum (SPY fallback).
      let marketSeries = spySeries;
      if (useSector) {
        const etf = sectorEtfForSymbol(sym);
        if (etf) marketSeries = (await getEtfRegimeSeries(etf, range)) || spySeries;
      }
      // Historical peer-earnings events for this ticker's sub-industry group.
      let earningsEvents = null;
      if (EARNINGS_OVERLAY_ENABLED && opts.earnings !== false) {
        const gk = earningsGroupKeyForSymbol(sym);
        if (gk) earningsEvents = ((await getGroupEarnings(gk).catch(() => null)) || {}).events || null;
      }
      const bt = await backtestSignal(daily, hz, weekly, fund, { windowBars, side, entryStep: opts.entryStep || 2, marketSeries, earningsEvents });
      if (!bt || !bt.trades) { perTicker.push({ ticker: sym, trades: 0 }); continue; }
      perTicker.push({ ticker: sym, trades: bt.trades, winRate: bt.winRate, avgReturnPct: bt.avgReturnPct, profitFactor: bt.profitFactor });
      tTrades += bt.trades;
      tWins += Math.round(bt.winRate / 100 * bt.trades);
      tRet += bt.avgReturnPct * bt.trades;
      if (bt.profitFactor && bt.profitFactor < 99) { gW += bt.profitFactor; gL += 1; }
    } catch (e) { perTicker.push({ ticker: sym, error: e.message }); }
  }
  const aggregate = {
    totalTrades: tTrades,
    winRate: tTrades ? Math.round(tWins / tTrades * 100) : null,
    avgReturnPct: tTrades ? +(tRet / tTrades).toFixed(2) : null,
    meanProfitFactor: gL ? +(gW / gL).toFixed(2) : null
  };
  const acceptance = evaluateAcceptance(aggregate);
  return {
    hz, side, windowBars, range, tickersTested: tickers.length,
    aggregate, acceptance,
    note: 'Replays CURRENT signal + hybrid exit. Entry = next-bar open.',
    perTicker: perTicker.sort((a, b) => (b.trades || 0) - (a.trades || 0))
  };
}

app.get('/api/backtest/medium-sell', async (req, res) => {
  try {
    let tickers = String(req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    const out = await runBracketAcceptance({
      hz: req.query.hz,
      side: req.query.side,
      window: req.query.window,
      tickers,
      maxTickers: 60,
      entryStep: parseInt(req.query.entryStep, 10) || 2
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backtest/acceptance', async (req, res) => {
  try {
    const windowBars = parseInt(req.query.window, 10) || 252;
    const sides = String(req.query.sides || 'sell,buy').split(',').map(s => s.trim()).filter(s => s === 'buy' || s === 'sell');
    const horizons = String(req.query.hz || 'short,medium,long').split(',').map(s => s.trim()).filter(s => ['short', 'medium', 'long'].includes(s));
    let tickers = String(req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    const brackets = [];
    for (const side of sides) {
      for (const hz of horizons) {
        console.log(`Acceptance bracket: ${side}/${hz} window=${windowBars}…`);
        const r = await runBracketAcceptance({ hz, side, window: windowBars, tickers, maxTickers: 40, entryStep: 3 });
        brackets.push({
          key: `${side}:${hz}`,
          hz: r.hz,
          side: r.side,
          windowBars: r.windowBars,
          aggregate: r.aggregate,
          acceptance: r.acceptance,
          tickersTested: r.tickersTested
        });
      }
    }
    res.json({
      windowBars,
      criteria: 'WR≥55% OR avg≥+0.30%/trade, AND PF≥1.5',
      disabledBrackets: [...DISABLED_BRACKETS],
      passed: brackets.filter(b => b.acceptance.pass).map(b => b.key),
      failed: brackets.filter(b => !b.acceptance.pass).map(b => b.key),
      brackets
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static files AFTER /api routes so `/api/*` never gets swallowed by filesystem lookup
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('AlphaSignal on port', PORT);
    console.log('Anthropic API key set:', !!anthropicApiKey());
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
    // Restore any recommended CSVs dropped into data/pending_history_import/
    importPendingRecommendedCsvs()
      .then(() => importSeedRecommendedCsvsIfMissing())
      .catch(e => console.warn('CSV history restore:', e.message));
    // Prime the market + sector momentum overlays and keep them fresh.
    refreshMarketRegime(true).then(() => refreshSectorRegimes(true)).then(() => refreshEarningsTides(true)).catch(() => {});
    setInterval(() => refreshMarketRegime().then(() => refreshSectorRegimes()).catch(() => {}), MARKET_REGIME_TTL);
    setInterval(() => refreshEarningsTides().catch(() => {}), EARNINGS_TTL_MS);
  });
}

module.exports = {
  backtestSignal,
  computeQuantSignal,
  computeTrailingStopFromTech,
  signalFlipped,
  horizonHoldDaysServer,
  fetchOHLCV,
  fetchFundamentals,
  fetchFmpScore,
  fundCache,
  simulateHybridExit,
  TECH_TTL,
  techAtBoundedIndex,
  evaluateAcceptance,
  ACCEPTANCE_DEFAULT_TICKERS,
  runBracketAcceptance,
  emitTradeEvent,
  tradeEventSnapshot,
  writeOpenRowAction,
  isOpenRowLatched,
  isStrongRecommendableRating,
  deriveActionRating,
  applyServerPriceLevels,
  mutateFillLedger,
  isPhantomIbkrKey,
  readIbkrFillRows,
  writeIbkrFillRows,
  isProtectedIbkrFillRow,
  hasOpenEmittedEntryForTicker,
  isPositionAuthorizedByProvenance,
  ibkrLiveEntrySide,
  aggregateIbkrOpenFromFills,
  IBKR_FILLS_FILE,
  TRADE_EVENTS_FILE,
  sectorEtfForSymbol,
  countryOfSymbol,
  sectorKeyForSymbol,
  earningsGroupKeyForSymbol,
  earningsLeadersForGroup,
  getGroupEarnings,
  earningsTideFromEvents,
  refreshEarningsTides,
  nextEarningsWithinDays,
  _earnGroupCache,
  app
};
