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
  // Minimum stop distance from CURRENT price — prevents noise stop-outs (a 0.75%
  // stop on a 12-month trade was a major PnL killer). Wider room for longer holds.
  const minGap = hz === 'short' ? 0.025 : hz === 'medium' ? 0.05 : 0.085;
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

/** First profit target (TP1) — deliberately set CLOSER than the stop so it is hit
 *  more often than not; once hit we book a partial AND move the remainder's stop to
 *  breakeven, so a TP1 trade can no longer become a loss. This (plus entry quality)
 *  is what lifts the win rate while the trailed remainder still rides big moves.
 *  TP1 distance = ratio × stop distance (ratio<1 ⇒ P(TP1 first) > P(stop first)). */
function computeFirstTargetFromTech(tech, entry, hz, isSell, stopLevel = null) {
  if (!tech || !entry || entry <= 0) return null;
  const atr = tech.atr || entry * 0.02;
  const ratio = 0.62; // TP1 ≈ 62% of the stop distance → ~60%+ raw hit rate
  const floorPct = hz === 'short' ? 0.015 : hz === 'medium' ? 0.03 : 0.05;
  const capPct   = hz === 'short' ? 0.08 : hz === 'medium' ? 0.16 : 0.32;
  if (!isSell) {
    const stopDist = stopLevel && stopLevel < entry ? (entry - stopLevel) : (hz === 'short' ? 2.0 : hz === 'medium' ? 3.0 : 5.0) * atr;
    let tp = entry + ratio * stopDist;
    const r1 = tech.resistance1;
    if (r1 && r1 > entry * (1 + floorPct) && r1 < tp) tp = r1; // nearer resistance = even easier hit
    tp = Math.min(Math.max(tp, entry * (1 + floorPct)), entry * (1 + capPct));
    return roundPrice(tp);
  } else {
    const stopDist = stopLevel && stopLevel > entry ? (stopLevel - entry) : (hz === 'short' ? 2.0 : hz === 'medium' ? 3.0 : 5.0) * atr;
    let tp = entry - ratio * stopDist;
    const s1 = tech.support1;
    if (s1 && s1 < entry * (1 - floorPct) && s1 > tp) tp = s1;
    tp = Math.max(Math.min(tp, entry * (1 - floorPct)), entry * (1 - capPct));
    return roundPrice(tp);
  }
}

/** Hysteresis signal-flip test — only exit when the picture TRULY reverses, not on
 *  a 1-point dip below the 62 entry threshold (that churn was destroying win rate). */
function signalFlipped(sig, isSell) {
  if (!sig) return false;
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
    target = Math.max(Math.min(target, entry * 1.10), entry * 1.02);
    const lower2 = tech.channels?.daily20?.lower2;
    let stop = Math.min(entry - 1.5 * atr, lower2 || entry * 0.97);
    stop = Math.max(Math.min(stop, entry * 0.985), entry * 0.93);
    return { target: roundPrice(target), stop: roundPrice(stop) };
  } else {
    const cands = [mean, tech.support1].filter(v => v && v < entry * 0.995);
    let target = cands.length ? Math.max(...cands) : entry - 1.5 * atr;
    target = Math.min(Math.max(target, entry * 0.90), entry * 0.98);
    const upper2 = tech.channels?.daily20?.upper2;
    let stop = Math.max(entry + 1.5 * atr, upper2 || entry * 1.03);
    stop = Math.min(Math.max(stop, entry * 1.015), entry * 1.07);
    return { target: roundPrice(target), stop: roundPrice(stop) };
  }
}

/** Short-horizon MEAN-REVERSION exit: bank the bounce at the channel mean/resistance
 *  (or when the fast oscillator normalises), with a fixed stop beyond the band. No
 *  trend trailing — this is a range/swing exit suited to choppy markets. */
async function simulateMeanReversionExit(data, entryIdx, entry, isSell, weeklyAll, fund = null, markPrice = null) {
  const holdDays = Math.min(15, horizonHoldDaysServer('short')); // banks quickly
  const maxJ = Math.min(entryIdx + holdDays, data.length - 1);
  const lastIdx = data.length - 1;
  // Mark an unrealised position at the LIVE price (when we've simply run out of
  // historical bars) rather than the last daily close — otherwise a trade entered
  // at yesterday's close shows ~0 PnL until the next daily bar prints.
  const markAt = (idx, fallback) => (markPrice && idx >= lastIdx) ? markPrice : fallback;
  const eTech = techAtBoundedIndex(data, weeklyAll, entryIdx);
  const lv = computeMeanReversionLevels(eTech, entry, isSell) || {};
  const target = lv.target, stop = lv.stop;
  const ret = px => (isSell ? (entry - px) : (px - entry)) / entry;
  const finish = (status, exitIdx, px) => ({ ret: ret(px), status, exitIdx, tp1Hit: status === 'tp1_hit', stopLoss: stop, exitPrice: px });
  let _yc = 0;
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    if ((++_yc & 15) === 0) await new Promise(r => setImmediate(r));
    const bar = data[j];
    if (!isSell) {
      if (stop && bar.l <= stop) return finish('sl_hit', j, stop);
      if (target && bar.h >= target) return finish('tp1_hit', j, target); // reverted to mean — banked
    } else {
      if (stop && bar.h >= stop) return finish('sl_hit', j, stop);
      if (target && bar.l <= target) return finish('tp1_hit', j, target);
    }
    // Oscillator-normalised exit: reversion complete, bank at close if in profit
    const bt = techAtBoundedIndex(data, weeklyAll, j);
    const r2 = bt.rsi2, rr = bt.rsi;
    if (!isSell && bar.c > entry && ((r2 != null && r2 > 70) || rr >= 58)) return finish('signal_exit', j, bar.c);
    if (isSell && bar.c < entry && ((r2 != null && r2 < 30) || rr <= 42)) return finish('signal_exit', j, bar.c);
    if (j === maxJ) return finish('time_limit', j, markAt(j, bar.c));
  }
  return finish('open', maxJ, markAt(maxJ, data[maxJ].c));
}

/** Unified HYBRID exit simulator used by BOTH the backtest and the history P&L
 *  refresh, so reported win rates match what the live rules would have done.
 *  SHORT horizon delegates to the mean-reversion exit; medium/long book a partial
 *  at TP1 (locks a win) and ride the remainder with a wide chandelier trail. */
async function simulateHybridExit(data, entryIdx, entry, hz, isSell, weeklyAll, fund = null, markPrice = null) {
  if (!data || entryIdx == null || !(entry > 0)) return null;
  if (hz === 'short') return simulateMeanReversionExit(data, entryIdx, entry, isSell, weeklyAll, fund, markPrice);
  const holdDays = horizonHoldDaysServer(hz);
  const maxJ = Math.min(entryIdx + holdDays, data.length - 1);
  const lastIdx = data.length - 1;
  const markAt = (idx, fallback) => (markPrice && idx >= lastIdx) ? markPrice : fallback;
  const entryTech = techAtBoundedIndex(data, weeklyAll, entryIdx);
  const atrEntry = entryTech.atr || entry * 0.02;
  let trailingSl = computeTrailingStopFromTech(entryTech, entry, hz, isSell, fund);
  const tp1 = computeFirstTargetFromTech(entryTech, entry, hz, isSell, trailingSl);
  const PARTIAL = 0.5;
  // Chandelier multiple for the post-TP1 runner — wide so winners can actually run.
  const runK = hz === 'short' ? 3.0 : hz === 'medium' ? 4.0 : 5.5;
  let tp1Hit = false, realized = 0, remaining = 1.0, _yc = 0;
  let peak = isSell ? entry : entry; // best favorable price since entry

  const longRet  = px => (px - entry) / entry;
  const shortRet = px => (entry - px) / entry;
  const ret = px => isSell ? shortRet(px) : longRet(px);
  const finish = (status, exitIdx, px) => ({ ret: realized + remaining * ret(px), status, exitIdx, tp1Hit, stopLoss: trailingSl, exitPrice: px });

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
      // ── PRE-TP1: tight, technicals-driven stop + hysteresis signal-flip exit ──
      const barTech = techAtBoundedIndex(data, weeklyAll, j);
      const barSig = computeQuantSignal(barTech, fund, hz);
      const eodSl = computeTrailingStopFromTech(barTech, entry, hz, isSell, fund);
      if (eodSl && Number.isFinite(eodSl)) {
        trailingSl = trailingSl == null ? eodSl : (isSell ? Math.min(trailingSl, eodSl) : Math.max(trailingSl, eodSl));
      }
      if (!isSell && trailingSl && bar.l <= trailingSl) return finish('sl_hit', j, trailingSl);
      if (isSell && trailingSl && bar.h >= trailingSl)  return finish('sl_hit', j, trailingSl);
      if (signalFlipped(barSig, isSell)) return finish('signal_exit', j, bar.c);
    } else {
      // ── POST-TP1: let the runner RUN. Wide chandelier trail off the favorable
      //    extreme, floored at breakeven; no signal-flip exit (breakeven protects). ──
      if (!isSell) {
        peak = Math.max(peak, bar.h);
        const chand = Math.max(entry, peak - runK * atrEntry);
        trailingSl = trailingSl == null ? chand : Math.max(trailingSl, chand);
        if (bar.l <= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      } else {
        peak = Math.min(peak, bar.l);
        const chand = Math.min(entry, peak + runK * atrEntry);
        trailingSl = trailingSl == null ? chand : Math.min(trailingSl, chand);
        if (bar.h >= trailingSl) return finish('tp1_then_sl', j, trailingSl);
      }
    }
    // horizon time cap
    if (j === maxJ) return finish(tp1Hit ? 'tp1_then_time' : 'time_limit', j, markAt(j, bar.c));
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

/**
 * Compute buy/sell scores deterministically from pre-computed indicators.
 * Returns { buyScore, sellScore, action, rating, conditions, winRateHint }
 * Scores 0-100. Mutual exclusivity enforced: both cannot exceed 55.
 */
function computeQuantSignal(tech, fund, hz) {
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
    if (!aboveMa200&&deathCross&&weeklyTrend==='downtrend') { sellGates+=4; condSell.push('BEAR BREAKDOWN: MA200+DC+weekly down'); }
    else if (!aboveMa200&&deathCross)         { sellGates+=3; condSell.push('Bear regime: below MA200 + Death Cross'); }
    else if (!aboveMa200)                { sellGates+=2; condSell.push('Below MA200 — bear regime'); }
    else if (deathCross)                 { sellGates+=2; condSell.push('Death Cross — trend reversal'); }
    if (weeklyTrend==='downtrend')       { sellGates++;  condSell.push('Weekly downtrend'); }
    if (!macdBull&&!aboveMa200)          { sellGates++;  condSell.push('MACD bearish in bear regime'); }
    if (inSDSellZone&&bearStruct)        { sellGates++;  condSell.push('SD top + distribution'); }
    else if (bearStruct||obvBullish===false) sellGates+=0.5;
    if (rsi<30) sellGates=Math.round(sellGates*0.4);
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

    if(!aboveMa200&&deathCross){sellGates+=3;condSell.push('Bear regime: below MA200+Death Cross');}
    else if(!aboveMa200){sellGates+=2;condSell.push('Below MA200');}
    if(weeklyTrend==='downtrend'){sellGates++;condSell.push('Weekly downtrend');}
    if(!macdBull&&!aboveMa200) sellGates++;
    if(bearStruct&&obvBullish===false){sellGates++;condSell.push('Distribution pattern');}
    if(rsi<28) sellGates=Math.round(sellGates*0.50);
    // Regime-scaled long sell — BEAR makes structural shorts primary
    sellGates *= _sellMult; sellGates = Math.max(0, sellGates);
    sell=sellGates>=5.5?86:sellGates>=4.5?73:sellGates>=3.5?60:sellGates>=2.5?48:Math.min(22,Math.round(sellGates*10));
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
      if (!stHz.flippedBull) { buy = Math.min(buy, 58); condBuy.push(`Below ${hz} Supertrend — buy capped`); }
    }
    if (stHz.direction === 'bear') {
      if (stHz.flippedBear && sell >= 50) { sell = Math.min(92, sell + 12); condSell.unshift(`Supertrend ${hz} Strong Sell (fresh bear flip)`); }
      else if (sell >= 55)                { sell = Math.min(90, sell + 6);  condSell.push(`Supertrend ${hz} bearish`); }
    } else if (stHz.direction === 'bull') {
      if (!stHz.flippedBear) { sell = Math.min(sell, 58); condSell.push(`Above ${hz} Supertrend — sell capped`); }
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

    const shortValid = aboveMa200 === false
      && regime !== 'bull'
      && stBearHz
      && realDistribution
      && !fundamentallyStrong
      && !earningsSoon;

    if (!shortValid) {
      sell = Math.min(sell, 55); // demote to Hold — not a high-conviction short
    } else {
      condSell.unshift('Strict short: below MA200 + ST bear + distribution');
      if (epsG != null && epsG < 0) condSell.push(`Earnings declining ${epsG}%`);
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

  let wins = 0, losses = 0, trades = 0, totalReturn = 0, grossWin = 0, grossLoss = 0;
  let stWins = 0, stTrades = 0;
  let nextAllowed = windowStart;
  let _yc = 0;

  for (let i = windowStart; i < data.length - 2; i += entryStep) {
    if (i < nextAllowed) continue;
    if ((++_yc & 15) === 0) await new Promise(r => setImmediate(r));
    const tech = techAtBoundedIndex(data, weeklyAll, i);
    const sig = computeQuantSignal(tech, fund, hz);
    const stHz = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend;

    // Entry only on a real, dominant signal (same 62 threshold as live picks).
    const buyOk = sig.buyScore >= 62 && sig.buyScore > sig.sellScore;
    const sellOk = sig.sellScore >= 62 && sig.sellScore > sig.buyScore;
    if (!buyOk && !sellOk) continue;
    const isBuy = buyOk && (!sellOk || sig.buyScore >= sig.sellScore);
    const isSell = !isBuy;

    const entry = data[i + 1]?.o ?? data[i].c;
    if (!entry || entry <= 0) continue;

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
    try {
      const _dkey = (process.env.DANELFIN_API_KEY || '').trim();
      if (_dkey) {
        const _ds = opts.danelfinPre || (await fetchDanelfinRow(_dkey, sym));
        if (_ds && _ds.aiscore != null) applyDanelfinTierOverlay(dataShell, _ds);
      }
    } catch (e) {
      console.warn('Danelfin overlay', sym, e.message);
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
  return new Date(trade.entryDate || trade.timestamp || 0).toDateString();
}

function isHistoryTradeFromToday(trade) {
  return historyTradeEntryDay(trade) === new Date().toDateString();
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
  applyAnalyticsSnapshotToTrade(trade, shell, fund, hz);
  trade.quantRegime = shell.quantSignal[hz]?.regime || trade.quantRegime || null;

  const livePx = tech.currentPrice || parseFloat(trade[hz + 'Entry'] || trade.entry);
  if (livePx && Number.isFinite(livePx)) {
    const tempRow = {
      ...trade,
      shortAction: trade.shortAction || (String(trade.action || '').toLowerCase() === 'sell' ? 'Sell' : 'Buy'),
      mediumAction: trade.mediumAction || trade.shortAction || 'Hold',
      longAction: trade.longAction || trade.shortAction || 'Hold'
    };
    applyServerPriceLevels(tempRow, livePx, tech, fund);
    ['short', 'medium', 'long'].forEach(hzKey => {
      trade[hzKey + 'Entry'] = tempRow[hzKey + 'Entry'];
      trade[hzKey + 'Target1'] = tempRow[hzKey + 'Target1'];
      trade[hzKey + 'Target2'] = tempRow[hzKey + 'Target2'];
      trade[hzKey + 'StopLoss'] = tempRow[hzKey + 'StopLoss'];
    });
    trade.entry = tempRow.shortEntry;
    trade.target1 = tempRow.shortTarget1;
    trade.target2 = tempRow.shortTarget2;
    trade.stopLoss = tempRow.shortStopLoss;
    if (String(trade.action || '').toLowerCase() === 'sell') {
      trade.sellEntry = tempRow.shortEntry;
      trade.sellTarget1 = tempRow.shortTarget1;
      trade.sellTarget2 = tempRow.shortTarget2;
      trade.sellStopLoss = tempRow.shortStopLoss;
    }
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
      const row = await fetchDanelfinRow(apiKey, sym);
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
    return res.json({ version: DASHBOARD_PICKS_VERSION, dashData: null, dashTs: null, summary: '' });
  }
  const dashData = filterDashDataBySLCooldown(dashboardPicksCache.dashData);
  res.json({
    version: dashboardPicksCache.version,
    schemaVersion: dashboardPicksCache.schemaVersion || 1,
    dashTs: dashboardPicksCache.dashTs,
    summary: dashboardPicksSummary(dashData),
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
      await generateServerPicksFromShortlist().catch(e => console.warn('post-scan picks:', e.message));
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
      let worstSellConds = [];
      for (const hz of ['short', 'medium', 'long']) {
        const sig = qs[hz] || {};
        const buy = sig.buyScore || 0;
        const sell = sig.sellScore || 0;
        const cooled = isSLCooldownActive(t, hz)
          || /SL cooldown/i.test(sig.tierLabel || '') || /SL cooldown/i.test(sig.rating || '');
        row[hz + 'Score'] = buy;
        row[hz + 'SellScore'] = sell;
        // sig.action / sig.rating are now canonical (set by applyTierScoreCaps from final score).
        row[hz + 'Action'] = cooled ? 'Hold' : (sig.action || 'Hold');
        row[hz + 'Rating'] = cooled ? 'SL cooldown' : (sig.rating || 'Hold');
        row[hz + 'Conf'] = sig.winRateHint || Math.max(buy, sell);
        if (hz === 'short') row.reason = (sig.conditions || []).slice(0, 3).join('; ');
        if (sell >= 62 && (sig.conditions || []).length) worstSellConds = sig.conditions;
      }
      row.action = row.shortAction;
      row.sellReason = worstSellConds.slice(0, 3).join('; ');
      applyServerPriceLevels(row, tech.currentPrice, tech, fund);
      rows.push(row);
    }

    // Cross-timeframe dedup done BEFORE slicing: assign each ticker to its single
    // best horizon (highest score), then take the top 5 per pane from that
    // assignment. This guarantees a name appears in only one timeframe AND keeps
    // every pane as full as the universe allows (slicing-then-deduping left gaps).
    const HZS = ['short', 'medium', 'long'];
    const hasPx = (r, hz) => r[hz + 'Entry'] && r[hz + 'StopLoss'];
    const buyAssign = { short: [], medium: [], long: [] };
    const sellAssign = { short: [], medium: [], long: [] };

    for (const r of rows) {
      let bBuyHz = null, bBuyScore = -1;
      let bSellHz = null, bSellScore = -1;
      for (const hz of HZS) {
        const buyOk = r[hz + 'Action'] === 'Buy' && (r[hz + 'Score'] || 0) >= 62
          && !/SL cooldown/i.test(r[hz + 'Rating'] || '') && hasPx(r, hz);
        if (buyOk && (r[hz + 'Score'] || 0) > bBuyScore) { bBuyScore = r[hz + 'Score'] || 0; bBuyHz = hz; }
        const sellOk = r[hz + 'Action'] === 'Sell' && (r[hz + 'SellScore'] || 0) >= 62 && hasPx(r, hz);
        if (sellOk && (r[hz + 'SellScore'] || 0) > bSellScore) { bSellScore = r[hz + 'SellScore'] || 0; bSellHz = hz; }
      }
      if (bBuyHz) buyAssign[bBuyHz].push(r);
      else if (bSellHz) sellAssign[bSellHz].push(r); // a name is buy XOR sell, never both
    }

    const topN = (arr, key) => arr.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 5).map(r => ({ ...r }));
    const dashData = {
      short: topN(buyAssign.short, 'shortScore'),
      medium: topN(buyAssign.medium, 'mediumScore'),
      long: topN(buyAssign.long, 'longScore'),
      shortSell: topN(sellAssign.short, 'shortSellScore'),
      medSell: topN(sellAssign.medium, 'mediumSellScore'),
      longSell: topN(sellAssign.long, 'longSellScore')
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
          const px = liveQuotes[r.ticker]?.price;
          if (px && px > 0) {
            const tech = techMap[r.ticker];
            const fEntry = fundCache.get(r.ticker);
            const fnd = fEntry && Date.now() - fEntry.ts < TECH_TTL * 4 ? fEntry.data : null;
            applyServerPriceLevels(r, px, tech, fnd);
          }
        }
      }
    } catch (e) { console.warn('Live re-pricing of picks failed:', e.message); }

    dashboardPicksCache = {
      version: DASHBOARD_PICKS_VERSION,
      schemaVersion: 1,
      dashTs: Date.now(),
      dashData: sanitizeDashDataForServer(dashData)
    };
    saveDashboardPicksFile(dashboardPicksCache);
    console.log('Server picks generated →', dashboardPicksSummary(dashData));

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
    return { ok: true, summary: dashboardPicksSummary(dashData) };
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
    shortlistCount: universeShortlistTickers().length
  });
});

// ── Health (after tradeHistory — used in payload) ────────────────────────────
app.get('/api/history/status', (req, res) => {
  const today = new Date().toDateString();
  const todayCnt = tradeHistory.filter(h => new Date(h.entryDate||h.timestamp).toDateString()===today).length;
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
    server_build: '20260618-fmp-ultimate-v7.8.3',
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
      return {
        file: DASHBOARD_PICKS_FILE,
        dashTs: d?.dashTs || null,
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

// Shared writer for both the client (/api/history/add) and the autonomous
// server scan. Dedups by ticker|hz|day, enriches, caps, and persists.
async function addTradesToHistory(trades) {
  if (!Array.isArray(trades) || !trades.length) {
    return { accepted: 0, skipped: 0, total: tradeHistory.length };
  }
  const todayStr = new Date().toDateString();
  const keyOf = (t) => {
    const hz = t.hz || 'short';
    const day = new Date(t.entryDate || t.timestamp || Date.now()).toDateString();
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
    const hz = trade.hz || 'short';
    const isSell = String(trade.action || '').toLowerCase() === 'sell';
    // Only gate FRESH (today's) buy picks on SL cooldown. Historical re-uploads
    // (older entryDate, e.g. localStorage recovery after a deploy) must always be
    // preserved so durable history is never silently dropped.
    const isToday = new Date(trade.entryDate || trade.timestamp || Date.now()).toDateString() === todayStr;
    if (!isSell && isToday && isSLCooldownActive(trade.ticker, hz)) {
      console.log('History add skipped (SL cooldown):', trade.ticker, hz);
      continue;
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
    // drift to the live price.
    const prev = existingByKey.get(keyOf(trade));
    if (prev) {
      const origEntry = prev.entry != null ? prev.entry : prev[hz + 'Entry'];
      if (origEntry != null) { trade.entry = origEntry; trade[hz + 'Entry'] = origEntry; }
      trade.entryDate = prev.entryDate || trade.entryDate;
      trade.timestamp = prev.timestamp || trade.timestamp;
      for (const f of [
        'target1', 'target2', 'stopLoss', 'sellEntry', 'sellTarget1', 'sellTarget2', 'sellStopLoss',
        hz + 'Target1', hz + 'Target2', hz + 'StopLoss', hz + 'TrailingSL',
        hz + 'Status', hz + 'PnlDollar', hz + 'PnlPct', hz + 'ExitPrice', hz + 'ExitReason',
        hz + 'Tp1Hit', hz + 'CurrentPrice', 'status', 'pnlDollar', 'pnlPct', 'currentPrice'
      ]) {
        if (prev[f] !== undefined) trade[f] = prev[f];
      }
    }
    accepted.push(trade);
  }

  tradeHistory.unshift(...accepted);

  // Cap total rows (multi-horizon scans add many per day; avoid unbounded growth)
  const HISTORY_MAX_SERVER = 3000;
  if (tradeHistory.length > HISTORY_MAX_SERVER) tradeHistory = tradeHistory.slice(0, HISTORY_MAX_SERVER);

  saveHistoryFile(tradeHistory);
  return { accepted: accepted.length, skipped: trades.length - accepted.length, total: tradeHistory.length };
}

// POST add trades (called when dashboard scan completes)
app.post('/api/history/add', express.json(), async (req, res) => {
  const trades = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Expected array' });
  const r = await addTradesToHistory(trades);
  console.log('History: added', r.accepted, 'trades, total:', r.total);
  res.json({ ok: true, total: r.total, added: r.accepted, skipped: r.skipped });
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
  /** Aligned with fetchOHLCV (≥15 bars); thin listings need longer ranges first */
  const MIN = 15;
  const ranges = ['5y', '2y', '12mo', 'max', '6mo', '3mo'];
  let bestDaily = null;
  for (const range of ranges) {
    const daily = await fetchOHLCV(sym, range, '1d');
    if (daily && daily.length >= MIN && (!bestDaily || daily.length > bestDaily.length)) {
      bestDaily = daily;
      if (daily.length >= 1000) break;
    }
  }
  if (!bestDaily || bestDaily.length < MIN) return null;
  const weekly = await fetchOHLCV(sym, '5y', '1wk').catch(() => dailyToWeeklyBars(bestDaily));
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
const HORIZON_MIN_PCT = {
  short:  { sl: 0.025, tp1: 0.045, tp2: 0.075, minRR: 1.8 },
  medium: { sl: 0.050, tp1: 0.090, tp2: 0.140, minRR: 1.75 },
  long:   { sl: 0.080, tp1: 0.150, tp2: 0.250, minRR: 1.9 }
};

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
      if (side === 'buy') {
        if (isSLCooldownActive(pick.ticker, hz)) return false;
        if (/SL cooldown/i.test(rating)) return false;
        // Only genuine Buy setups with a passing score belong in a buy pane.
        return action === 'Buy' && (pick[hz + 'Score'] || 0) >= 62;
      }
      return action === 'Sell' && (pick[hz + 'SellScore'] || 0) >= 62;
    });
  }
  return out;
}

function filterDashDataByQuantTechMap(dashData, techMap, paneMap = DASH_PANE_MAP) {
  const out = {};
  for (const [pane, { hz, side }] of Object.entries(paneMap)) {
    out[pane] = (dashData[pane] || []).filter(pick => {
      const tech = techMap[pick.ticker];
      const sig = tech?.quantSignal?.[hz];
      if (!sig) return false;
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
    h[hz + 'Target2'] = fixed.tp2;
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
  const today = new Date().toDateString();
  const before = tradeHistory.length;
  tradeHistory = tradeHistory.filter(h => {
    if (!isHistoryBuySellRecord(h)) return true;
    const hz = h.hz || 'short';
    const isToday = new Date(h.entryDate || h.timestamp).toDateString() === today;
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

function scanHistoryForSLCooldowns() {
  for (const h of tradeHistory) {
    if (!h?.ticker) continue;
    ['short', 'medium', 'long'].forEach(hz => {
      if ((h[hz + 'Status'] || '') === 'sl_hit') setSLCooldown(h.ticker, hz);
    });
  }
}

loadSLCooldowns();
scanHistoryForSLCooldowns();
purgeOpenCooldownBuysFromHistory();

setTimeout(async function bootDashHistorySync() {
  try {
    migrateLegacyTightStops();
    const cached = loadDashboardPicksFile() || dashboardPicksCache;
    if (cached?.dashData) {
      let dd = filterDashDataBySLCooldown(cached.dashData);
      const tickers = [...new Set(Object.keys(DASH_PANE_MAP).flatMap(k => (dd[k] || []).map(s => s.ticker).filter(Boolean)))];
      if (tickers.length) {
        const techMap = await getTechnicalsMapForSymbols(tickers, { maxMs: 45000 });
        dd = filterDashDataByQuantTechMap(dd, techMap);
      }
      dashboardPicksCache = {
        version: DASHBOARD_PICKS_VERSION,
        schemaVersion: cached.schemaVersion || 1,
        dashTs: Date.now(),
        dashData: sanitizeDashDataForServer(dd)
      };
      saveDashboardPicksFile(dashboardPicksCache);
      console.log('Boot: dashboard picks filtered →', dashboardPicksSummary(dd));
    }
    purgeOpenCooldownBuysFromHistory();
  } catch (e) {
    console.warn('Boot dash/history sync:', e.message);
  }
}, 4000);

// ── Full-universe scan scheduler ─────────────────────────────────────────────
// Boot: if the shortlist is missing or stale, run an initial scan (after the
// heavier boot sync settles). Then refresh once per day.
setTimeout(() => {
  try {
    const stale = !universeShortlist || (Date.now() - universeShortlist.ts) > UNIVERSE_SHORTLIST_TTL_MS;
    if (stale && !universeScanState.running) runUniverseScan({ reason: 'boot' });
  } catch (e) { console.warn('Boot universe scan:', e.message); }
}, 30000);

setInterval(() => {
  try {
    if (!universeScanState.running) runUniverseScan({ reason: 'daily' });
  } catch (e) { console.warn('Scheduled universe scan:', e.message); }
}, 24 * 60 * 60 * 1000);

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
    const maxTp1 = e * (1 - f.tp1);
    if (!Number.isFinite(tp1) || tp1 > maxTp1) tp1 = roundPrice(maxTp1);
    const maxTp2 = e * (1 - f.tp2);
    if (!Number.isFinite(tp2) || tp2 > maxTp2) tp2 = roundPrice(maxTp2);
  } else {
    const maxSl = e * (1 - f.sl);
    if (!Number.isFinite(sl) || sl > maxSl) sl = roundPrice(maxSl);
    const minTp1 = e * (1 + f.tp1);
    if (!Number.isFinite(tp1) || tp1 < minTp1) tp1 = roundPrice(minTp1);
    const minTp2 = e * (1 + f.tp2);
    if (!Number.isFinite(tp2) || tp2 < minTp2) tp2 = roundPrice(minTp2);
  }
  return enforceMinRiskReward(e, tp1, tp2, sl, isSell, f.minRR);
}

function roundPrice(x) {
  if (x == null || Number.isNaN(x)) return x;
  const a = Math.abs(x);
  const d = a >= 100 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return +x.toFixed(d);
}

/** Ensure reward >= risk — widens TP when channel/S/R levels are too tight. */
function enforceMinRiskReward(e, tp1, tp2, sl, isSell, minRR = 1.5) {
  if (!e || !Number.isFinite(+e)) return { tp1, tp2, sl };
  e = +e;
  tp1 = tp1 != null ? +tp1 : null;
  tp2 = tp2 != null ? +tp2 : null;
  sl = sl != null ? +sl : null;
  if (!Number.isFinite(tp1) || !Number.isFinite(sl)) return { tp1, tp2, sl };

  if (isSell) {
    let risk = sl - e;
    let reward = e - tp1;
    if (!Number.isFinite(risk) || risk <= 0) risk = e * 0.02;
    if (!Number.isFinite(reward) || reward < risk * minRR) {
      tp1 = roundPrice(e - risk * minRR);
    }
    if (!Number.isFinite(tp2) || tp2 >= tp1) tp2 = roundPrice(tp1 * 0.96);
  } else {
    let risk = e - sl;
    let reward = tp1 - e;
    if (!Number.isFinite(risk) || risk <= 0) risk = e * 0.02;
    if (!Number.isFinite(reward) || reward < risk * minRR) {
      tp1 = roundPrice(e + risk * minRR);
    }
    if (!Number.isFinite(tp2) || tp2 <= tp1) tp2 = roundPrice(tp1 * 1.04);
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
      row[hz + 'Entry'] = row[hz + 'Target1'] = row[hz + 'Target2'] = row[hz + 'StopLoss'] = '';
      continue;
    }
    const isSell = act === 'sell';
    if (hz === 'short') {
      // Short = mean-reversion: defined target at the channel mean/resistance, fixed
      // stop beyond the band. (No trailing — bank the bounce in choppy markets.)
      const lv = computeMeanReversionLevels(tech, e, isSell);
      if (!lv) { row[hz + 'Entry'] = row[hz + 'Target1'] = row[hz + 'Target2'] = row[hz + 'StopLoss'] = ''; continue; }
      row[hz + 'Entry'] = String(roundPrice(e));
      row[hz + 'Target1'] = String(lv.target);
      row[hz + 'Target2'] = '';
      row[hz + 'StopLoss'] = String(lv.stop);
      row[hz + 'TrailingSL'] = false;
      continue;
    }
    const sl = computeTrailingStopFromTech(tech, e, hz, isSell, fund);
    if (!sl) {
      row[hz + 'Entry'] = row[hz + 'Target1'] = row[hz + 'Target2'] = row[hz + 'StopLoss'] = '';
      continue;
    }
    // Hybrid exit: TP1 = first target where we book a partial (locks a win), then
    // trail the remainder (no hard TP2 — let winners run via the trailing stop).
    const tp1 = computeFirstTargetFromTech(tech, e, hz, isSell, sl);
    row[hz + 'Entry'] = String(roundPrice(e));
    row[hz + 'Target1'] = tp1 ? String(tp1) : '';
    row[hz + 'Target2'] = '';
    row[hz + 'StopLoss'] = String(sl);
    row[hz + 'TrailingSL'] = true;
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
    let btShort = null, btMedium = null, btLong = null;
    try {
      btShort  = ohlcv ? await backtestSignal(ohlcv, 'short', weeklyBySym[sym])  : null;
      btMedium = ohlcv ? await backtestSignal(ohlcv, 'medium', weeklyBySym[sym]) : null;
      btLong   = ohlcv ? await backtestSignal(ohlcv, 'long', weeklyBySym[sym])   : null;
    } catch (e) {
      console.warn('backtest failed for', sym, '-', e.message);
    }
    if (tech) {
      tech._supertrendBacktestWR = btShort?.supertrendWinRate ?? btMedium?.supertrendWinRate ?? null;
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
      await applyMarketTierOverlays(sym, shell, { batchMode: false, fundPre: fund });
      if (shell.fmpScore) sig.fmpScore = shell.fmpScore;
      if (shell.danelfin) sig.danelfin = shell.danelfin;
    })
  );

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
        const df = await fetchDanelfinRow(dk, sym);
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
async function simulateTradeExitTrailing(bars, entryMs, entry, hz, isSell, markPrice = null) {
  if (!Array.isArray(bars) || !bars.length || !entry) return null;
  const weeklyAll = dailyToWeeklyBars(bars);
  let startIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if ((bars[i].t || 0) * 1000 >= entryMs) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  const res = await simulateHybridExit(bars, startIdx, entry, hz, isSell, weeklyAll, null, markPrice);
  if (!res) return null;
  const open = res.status === 'open' || res.status === 'tp1_open';
  let status;
  if (open) status = 'open';
  else if (res.status.startsWith('tp1')) status = res.ret > 0 ? 'tp1_hit' : 'sl_hit';
  else if (res.status.includes('sl')) status = 'sl_hit';
  else if (res.status.includes('signal')) status = 'signal_exit';
  else status = 'time_limit';
  return { status, ret: res.ret, exit: res.exitPrice, stopLoss: res.stopLoss, tp1Hit: res.tp1Hit, open };
}

/** Close an open position the moment the live signal stops supporting it.
 *  Per the trading spec: a Buy that decays to Hold/Sell (or a Sell that decays
 *  to Hold/Buy) is booked out immediately. We use a small 4-pt buffer below the
 *  62 entry threshold (i.e. <58) so a genuine downgrade to Hold closes, while a
 *  trivial 62→61 wobble does not churn the book. */
function liveSignalFlipExit(ticker, hz, isSell, techMap) {
  const tech = techMap?.[ticker];
  if (!tech?.quantSignal?.[hz]) return null;
  const sig = tech.quantSignal[hz];
  const HOLD_FLOOR = 58; // below this the side is no longer a valid signal
  if (!isSell) {
    if (sig.sellScore >= 62) return { flipped: true, reason: 'Sell' };
    if ((sig.buyScore || 0) < HOLD_FLOOR) return { flipped: true, reason: 'Hold (Buy lost)' };
  } else {
    if (sig.buyScore >= 62) return { flipped: true, reason: 'Buy' };
    if ((sig.sellScore || 0) < HOLD_FLOOR) return { flipped: true, reason: 'Hold (Sell lost)' };
  }
  return null;
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

  const sinceMs = req.body?.since ? new Date(req.body.since).getTime() : 0;
  const tickers = [...new Set(
    tradeHistory
      .filter(h => !sinceMs || new Date(h.entryDate || h.timestamp || 0).getTime() >= sinceMs)
      .map(h => h.ticker)
      .filter(Boolean)
  )];
  const priceMap = {};
  await Promise.all(tickers.map(async sym => {
    try {
      const q = await fetchSinglePrice(sym);
      if (q?.price) priceMap[sym] = parseFloat(q.price);
    } catch (_) {}
  }));

  const ohlcvMap = {};
  const techLiveMap = {};
  for (let off = 0; off < tickers.length; off += 6) {
    const slice = tickers.slice(off, off + 6);
    await Promise.all(slice.map(async sym => {
      try {
        let bars = await fetchOHLCV(sym, '5y', '1d').catch(() => null);
        if (!bars || bars.length < 100) bars = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
        if (bars && bars.length) {
          ohlcvMap[sym] = bars;
          const weekly = await fetchOHLCV(sym, '5y', '1wk').catch(() => dailyToWeeklyBars(bars));
          const tech = buildFullTechResult(sym, bars, weekly);
          tech.quantSignal = {
            short: computeQuantSignal(tech, null, 'short'),
            medium: computeQuantSignal(tech, null, 'medium'),
            long: computeQuantSignal(tech, null, 'long')
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
    if (!curr || !Number.isFinite(curr)) continue;
    const isSell = String(h.action || '').toLowerCase() === 'sell';
    const dir = isSell ? -1 : 1;
    const hzList = h.hz ? [h.hz] : ['short', 'medium', 'long'];
    let rowChanged = false;

    for (const hz of hzList) {
      const st = h[hz + 'Status'];
      if (st === 'tp1_hit' || st === 'tp2_hit' || st === 'signal_exit') continue;
      const entry = parseFloat(h[hz + 'Entry'] || h.entry || 0);
      if (!entry) continue;
      const entryMs = new Date(h.entryDate || h.timestamp || 0).getTime();
      const bars = ohlcvMap[h.ticker];

      // Immediate exit if live signal has flipped against the open position
      const flip = (st === 'open' || !st || st === 'n/a') ? liveSignalFlipExit(h.ticker, hz, isSell, techLiveMap) : null;
      if (flip) {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * 10000).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'signal_exit';
        h[hz + 'ExitPrice'] = curr;
        h[hz + 'ExitReason'] = 'Signal → ' + flip.reason;
        rowChanged = true;
        signalExits++;
        continue;
      }

      const pathExit = (bars && entry) ? await simulateTradeExitTrailing(bars, entryMs, entry, hz, isSell, curr) : null;

      // Fixed $10k notional for the $ figure. Sizing by floor(10000/entry) shares
      // collapses to 0 shares for high-priced names (e.g. ¥-denominated stocks),
      // which made the $ PnL show $0 even when the % was non-zero.
      const NOTIONAL = 10000;
      if (pathExit) {
        // res.ret is already directional (profit>0 for both long & short) and
        // already blends the TP1 partial — use it directly, don't re-apply `dir`.
        h[hz + 'PnlPct'] = +(pathExit.ret * 100).toFixed(2);
        h[hz + 'PnlDollar'] = +(pathExit.ret * NOTIONAL).toFixed(2);
        h[hz + 'Status'] = pathExit.status;
        h[hz + 'Tp1Hit'] = !!pathExit.tp1Hit;
        if (!pathExit.open && pathExit.exit != null) h[hz + 'ExitPrice'] = pathExit.exit;
        if (pathExit.stopLoss) h[hz + 'StopLoss'] = pathExit.stopLoss;
        if (pathExit.status === 'sl_hit') setSLCooldown(h.ticker, hz);
        rowChanged = true;
      } else if (horizonTimeLimitExceededServer(hz, h.entryDate || h.timestamp)) {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * NOTIONAL).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'time_limit';
        h[hz + 'ExitPrice'] = curr;
        rowChanged = true;
      } else if (st !== 'time_limit' && st !== 'sl_hit') {
        const pct = ((curr - entry) / entry) * dir;
        h[hz + 'PnlDollar'] = +(pct * NOTIONAL).toFixed(2);
        h[hz + 'PnlPct'] = +(pct * 100).toFixed(2);
        h[hz + 'Status'] = 'open';
        rowChanged = true;
      }
      h[hz + 'CurrentPrice'] = curr;
      if (h.hz === hz || !h.hz) {
        h.pnlDollar = h[hz + 'PnlDollar'];
        h.pnlPct = h[hz + 'PnlPct'];
        h.status = h[hz + 'Status'];
      }
    }
    h.currentPrice = curr;
    if (rowChanged) updated++;
  }

  saveHistoryFile(tradeHistory);
  res.json({
    ok: true,
    updated,
    legacyReflored: legacyFix.refloored,
    legacyReopened: legacyFix.reopened,
    pricesFetched: Object.keys(priceMap).length,
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

// Static files AFTER /api routes so `/api/*` never gets swallowed by filesystem lookup
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
});
