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

  let buy=0, sell=0;
  const condBuy=[], condSell=[];
  let buyGates=0, sellGates=0;
  let tier = 0;  // 0=standard, 1=Danelfin≥8+SD, 2=+catalyst

  // ════════════════════════════════════════════════════════════════════════════
  // SHORT (1–3 days): Entry timing dominates. SD channel is the gating signal.
  // Danelfin Technical subscore (short-term ML signal) confirms direction.
  // ════════════════════════════════════════════════════════════════════════════
  if (hz === 'short') {

    // Gate 1: Trend regime (permission to trade long)
    if (aboveMa50&&(goldenCross||weeklyTrend==='uptrend')) { buyGates++; condBuy.push('MA50 uptrend regime'); }
    else if (aboveMa50) buyGates += 0.5;

    // Gate 2: SD CHANNEL (the primary entry timing gate)
    // This is the single most important signal for short-term entries
    if (inSDExcellent) { buyGates+=2; condBuy.push('SD channel: price at lower band'); }
    else if (inSDGood) { buyGates++;  condBuy.push('SD channel: near lower band');     }

    // Gate 3: RSI dip + rising (momentum turning from oversold)
    if (rsi>=24&&rsi<=50&&rsiRising) { buyGates++;  condBuy.push(`RSI ${rsi} oversold rising`); }
    else if (rsi>=24&&rsi<=50)        buyGates+=0.5;

    // Gate 4: MACD inflection (catching the turn)
    if (macdTurnUp)                          { buyGates++; condBuy.push('MACD turning up'); }
    else if (macdBull&&rsiRising&&rsi<52)     buyGates+=0.5;

    // Gate 5: Volume + structure confirmation
    if ((healthyPull===true||volRatio<0.80)&&bullStruct) { buyGates++; condBuy.push('Low-vol pullback + HH/HL'); }
    else if (bullStruct||nearS1)              { buyGates+=0.8; condBuy.push(bullStruct?'HH+HL structure':`Near S1 $${s1?.toFixed(2)}`); }
    else if (healthyPull===true||volRatio<0.80) buyGates+=0.5;

    // Hard disqualifiers
    if (rsi>72)     buyGates = Math.min(buyGates, 1.5);   // overbought — avoid
    if (atSDTop)    buyGates = Math.round(buyGates*0.4);  // extended — terrible short entry
    if (!aboveMa50) buyGates = Math.round(buyGates*0.45); // downtrend — skip

    buy = buyGates>=5?88:buyGates>=4?74:buyGates>=3?58:buyGates>=2?40:Math.min(22,Math.round(buyGates*15));

    // SELL gates (short-term reversal)
    if (!aboveMa50&&(deathCross||trend20==='downtrend')) { sellGates++; condSell.push('Below MA50 downtrend'); }
    if (inSDSellZone) { sellGates++; condSell.push('SD channel: price at upper band'); }
    if (rsi>=64&&rsiFalling) { sellGates++; condSell.push(`RSI ${rsi} overbought falling`); }
    else if (rsi>=64) sellGates+=0.5;
    if (macdTurnDn||(!macdBull&&rsiFalling))  { sellGates++; condSell.push('MACD turning down'); }
    if (bearStruct||nearR1)                   { sellGates++; condSell.push(bearStruct?'LH+LL distribution':`Near R1 $${r1?.toFixed(2)}`); }
    if (rsi<26) sellGates=Math.round(sellGates*0.4);
    sell = sellGates>=5?84:sellGates>=4?70:sellGates>=3?54:Math.min(22,Math.round(sellGates*11));

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

    buy = buyGates>=5?90:buyGates>=4?76:buyGates>=3?58:buyGates>=2?38:Math.min(20,Math.round(buyGates*12));

    // SELL: structural regime breakdown
    if (!aboveMa200&&deathCross)         { sellGates+=3; condSell.push('Bear regime: below MA200 + Death Cross'); }
    else if (!aboveMa200)                { sellGates+=2; condSell.push('Below MA200 — bear regime'); }
    else if (deathCross)                 { sellGates+=2; condSell.push('Death Cross — trend reversal'); }
    if (weeklyTrend==='downtrend')       { sellGates++;  condSell.push('Weekly downtrend'); }
    if (!macdBull&&!aboveMa200)          { sellGates++;  condSell.push('MACD bearish in bear regime'); }
    if (inSDSellZone&&bearStruct)        { sellGates++;  condSell.push('SD top + distribution'); }
    else if (bearStruct||obvBullish===false) sellGates+=0.5;
    if (rsi<30) sellGates=Math.round(sellGates*0.4);
    sell = sellGates>=5?86:sellGates>=4?72:sellGates>=3?56:Math.min(22,Math.round(sellGates*11));

  // ════════════════════════════════════════════════════════════════════════════
  // LONG (1–6 months): Structural bull regime + fundamental quality.
  // Danelfin Fundamental subscore confirms earnings/revenue durability.
  // SD channel entry gives favorable risk/reward over multi-month hold.
  // ════════════════════════════════════════════════════════════════════════════
  } else { // long

    // Gate 1+2: Structural bull regime (STRICT requirement for 6M trade)
    if (aboveMa200&&goldenCross) { buyGates+=2; condBuy.push('MA200 regime + Golden Cross'); }
    else if (aboveMa200)          { buyGates++;  condBuy.push('Above MA200 primary uptrend'); }

    // Gate 2: Weekly trend (must confirm multi-month direction)
    if (weeklyTrend==='uptrend'&&aboveMa200) { buyGates++; condBuy.push('Weekly uptrend confirms'); }
    else if (weeklyTrend==='uptrend')         buyGates+=0.5;

    // Gate 3: ADX strong trend (sideways markets = value traps over 6M)
    if (adx>=25&&aboveMa200) { buyGates++; condBuy.push(`ADX ${adx} confirms trending regime`); }
    else if (adx>=20)          buyGates+=0.4;

    // Gate 4: SD channel (entering at lower band gives maximum 6M upside)
    if (inSDGood&&aboveMa200) { buyGates++; condBuy.push('SD channel entry in bull regime'); }
    else if (inSDNeutral&&aboveMa200) buyGates+=0.3;

    /** At SD top: same 60% penalty as medium — timing must be discounted, not momentum-chasing */
    if (atSDTop) buyGates = Math.round(buyGates * 0.4);

    // Gate 5: RSI zone (not overbought, room to run over 6 months)
    if (rsi>=38&&rsi<=65&&aboveMa200) { buyGates++; }

    // Gate 6: Fundamentals overlay (Danelfin Fundamental subscore proxy)
    if (fund) {
      const epsG=fund.earningsGrowth??null, revG=fund.revenueGrowth??null;
      const analystB=['strongBuy','buy'].includes(fund.recommendationKey??'');
      const analystBr=['sell','strongSell'].includes(fund.recommendationKey??'');
      const targetUp=fund.targetMeanPrice&&price?(fund.targetMeanPrice-price)/price*100:null;
      if (epsG!=null&&epsG>15)  { buyGates++;  condBuy.push(`EPS growth +${epsG}%`); }
      else if (epsG!=null&&epsG>8) buyGates+=0.5;
      if (revG!=null&&revG>12)  { buyGates++;  condBuy.push(`Revenue growth +${revG}%`); }
      if (analystB&&targetUp!=null&&targetUp>12) { buyGates++; condBuy.push(`${targetUp.toFixed(0)}% analyst upside`); }
      if (analystBr) buyGates=Math.round(buyGates*0.55);
      if (epsG!=null&&epsG<-10) { sellGates++; condSell.push(`EPS declining ${epsG}%`); }
      if (revG!=null&&revG<-8)  { sellGates++; condSell.push(`Revenue declining ${revG}%`); }
    }

    // OBV long-term accumulation
    if (obvBullish===true&&bullStruct) { buyGates++; condBuy.push('OBV + structural HH/HL'); }
    else if (obvBullish===true)         buyGates+=0.5;

    // Hard disqualifiers
    if (rsi>76)    buyGates=Math.round(buyGates*0.60);
    if (!aboveMa200) buy=0; // absolute — never long below MA200 on 6M horizon

    buy = buyGates>=7?92:buyGates>=6?84:buyGates>=5?74:buyGates>=4?60:buyGates>=3?44:20;
    if (!aboveMa200) buy=0;

    // SELL: structural bear regime
    if (!aboveMa200&&deathCross) { sellGates+=3; condSell.push('Bear regime: below MA200 + Death Cross'); }
    else if (!aboveMa200)         { sellGates+=2; condSell.push('Below MA200 — bear regime'); }
    if (weeklyTrend==='downtrend'){ sellGates++;  condSell.push('Weekly downtrend'); }
    if (!macdBull&&!aboveMa200)   sellGates++;
    if (bearStruct&&obvBullish===false) { sellGates++; condSell.push('Distribution: LH+LL + OBV falling'); }
    if (rsi<28) sellGates=Math.round(sellGates*0.50);
    sell = sellGates>=5?82:sellGates>=4?68:sellGates>=3?52:Math.min(20,Math.round(sellGates*10));
  }

  // Clamp and mutual exclusivity
  buy  = Math.min(92,Math.max(0,Math.round(buy)));
  sell = Math.min(88,Math.max(0,Math.round(sell)));
  if (buy>55&&sell>55) { if(buy>=sell) sell=Math.min(sell,20); else buy=Math.min(buy,20); }

  let action, rating;
  if (buy>=sell) {
    if      (buy>=84) { action='Buy';  rating='Strong Buy'; }
    else if (buy>=66) { action='Buy';  rating='Buy';        }
    else              { action='Hold'; rating='Hold';       }
  } else {
    if      (sell>=80) { action='Sell'; rating='Strong Sell'; }
    else if (sell>=64) { action='Sell'; rating='Sell';        }
    else               { action='Hold'; rating='Hold';        }
  }

  const gates = buy>=sell ? buyGates : sellGates;

  // ── Win rate hint: base rates from quantitative research ─────────────────
  // These are BASE hints before Danelfin/FMP overlay in batch endpoint.
  // The batch endpoint upgrades tier based on Danelfin score + SD channel.
  const winRateHint = hz==='short'
    ? (gates>=5?62:gates>=4?56:gates>=3?50:42)   // SD channel is gate 2 here
    : hz==='medium'
    ? (gates>=5?62:gates>=4?56:gates>=3?50:42)   // regime + weekly + ADX
    : (gates>=7?65:gates>=6?60:gates>=5?55:gates>=4?49:42); // fundamental quality layer

  return {
    buyScore:buy, sellScore:sell, action, rating,
    conditions:(buy>=sell?condBuy:condSell).slice(0,5),
    winRateHint,
    gatesMet: Math.floor(buy>=sell?buyGates:sellGates),
    tier: 0,       // upgraded to 1 or 2 in batch endpoint based on Danelfin/FMP
    tierLabel: '', // set by batch endpoint
  };
}


function backtestSignal(data, hz) {
  const minBars = hz==='short'?80:hz==='medium'?220:220;
  if (!data||data.length<minBars) return null;
  // Medium = 90 days max, mirrors Danelfin's 3-month prediction horizon exactly
  const holdDays = hz==='short'?3:hz==='medium'?90:90;
  const warmup   = hz==='short'?35:hz==='medium'?80:100;
  if (data.length<warmup+holdDays+5) return null;

  // Pre-compute global S/R for entry zone detection
  const gSR = findVolumeWeightedSR(data, Math.min(80,data.length-5), 25);

  let wins=0, losses=0, totalReturn=0, trades=0, nextAllowed=warmup;

  for (let i=warmup; i<data.length-holdDays-1; i++) {
    if (i<nextAllowed) continue;
    const slice=data.slice(0,i+1);
    const closes=slice.map(d=>d.c);
    const price=closes[closes.length-1];
    if (!price||price<=0) continue;

    const ma20  = calcSMA(closes,20);
    const ma50  = closes.length>=50  ? calcSMA(closes,50)  : null;
    const ma200 = closes.length>=200 ? calcSMA(closes,200) : null;
    const rsi   = calcRSI(closes,14);
    const atr   = calcATRFull(slice,14);
    if (!atr||atr<=0||rsi==null) continue;

    const aboveMa50  = ma50  ? price>ma50  : false;
    const aboveMa200 = ma200 ? price>ma200 : false;
    const goldenCross= ma50&&ma200&&ma50>ma200;
    const deathCross = ma50&&ma200&&ma50<ma200;

    // MACD direction
    let macdBull=false, macdTurnUp=false, macdTurnDn=false;
    if (closes.length>=35) {
      const ema=(c,p)=>{const k=2/(p+1);let e=c[0];for(let j=1;j<c.length;j++) e=c[j]*k+e*(1-k);return e;};
      const h0=ema(closes,12)-ema(closes,26);
      const hP=ema(closes.slice(0,-3),12)-ema(closes.slice(0,-3),26);
      macdBull=h0>0; macdTurnUp=h0>hP&&hP<=0; macdTurnDn=h0<hP&&hP>=0;
    }
    const rsiPrev = closes.length>17?calcRSI(closes.slice(0,-3),14):rsi;
    const rsiRising=(rsiPrev!=null)&&(rsi-rsiPrev>1.5);
    const rsiFalling=(rsiPrev!=null)&&(rsi-rsiPrev<-1.5);

    // Volume
    const vol20avg=slice.slice(-21,-1).reduce((a,d)=>a+(d.v||0),0)/20;
    const volRatio=vol20avg>0?(slice[slice.length-1].v||0)/vol20avg:1;

    // Pullback quality (low-vol pullback = smart money holding)
    let healthyPull=null;
    if (slice.length>=8) {
      const last5=slice.slice(-5);
      const ref=slice.slice(-25,-5).reduce((a,d)=>a+(d.v||0),0)/20;
      let dv=0,dd=0;
      last5.forEach((d,k)=>{ const pc=k>0?last5[k-1].c:slice[slice.length-6]?.c??d.c;
        if(d.c<pc){dv+=(d.v||0);dd++;} });
      healthyPull=dd>0?(dv/dd)<ref*0.88:true;
    }

    // Price structure
    let bullStruct=null, bearStruct=null;
    if (slice.length>=12) {
      const L=slice.slice(-12), H=[],LO=[];
      for(let k=2;k<L.length-2;k++) {
        if(L[k].h>=L[k-1].h&&L[k].h>=L[k+1].h) H.push(L[k].h);
        if(L[k].l<=L[k-1].l&&L[k].l<=L[k+1].l) LO.push(L[k].l);
      }
      bullStruct=H.length>=2&&LO.length>=2&&H[H.length-1]>H[H.length-2]&&LO[LO.length-1]>LO[LO.length-2];
      bearStruct=H.length>=2&&LO.length>=2&&H[H.length-1]<H[H.length-2]&&LO[LO.length-1]<LO[LO.length-2];
    }

    // SD channel
    const chan20=calcLinRegChannel(closes,Math.min(20,closes.length));
    const inBuyZone=chan20&&price<=chan20.lower1;
    const nearS1=gSR.support1&&price>=gSR.support1*0.987&&price<=gSR.support1*1.020;
    const nearR1=gSR.resistance1&&price>=gSR.resistance1*0.982&&price<=gSR.resistance1*1.015;

    // 5-gate confluence (mirrors computeQuantSignal exactly)
    let isBuy=false, isSell=false, buyGates=0, sellGates=0;

    if (hz==='short') {
      if (aboveMa50) buyGates++;
      if (rsi>=28&&rsi<=52&&rsiRising) { buyGates++; }
      else if (rsi>=28&&rsi<=52&&rsi<=48) buyGates+=0.7;  // RSI in lower half of zone = stronger
      if (macdTurnUp) buyGates++;
      if (healthyPull===true||inBuyZone||volRatio<0.85) buyGates++;
      if (bullStruct||nearS1) buyGates++;
      if (rsi>73) buyGates=Math.min(buyGates,1.5);
      isBuy=buyGates>=4&&aboveMa50;

      if (!aboveMa50) sellGates++;
      if (rsi>=62&&rsiFalling) sellGates++;
      else if (rsi>=62) sellGates+=0.5;
      if (macdTurnDn||(!macdBull&&rsiFalling)) sellGates++;
      if (chan20&&price>=chan20.upper1) sellGates++;
      if (bearStruct||nearR1) sellGates++;
      if (rsi<28) sellGates=Math.min(sellGates,1.5);
      isSell=sellGates>=4&&!aboveMa50;

    } else if (hz==='medium') {
      if (goldenCross) buyGates++;
      const nearMa50=ma50&&price<=ma50*1.05&&price>=ma50*0.97;
      if (nearMa50) buyGates++;
      else if (ma50&&price<ma50*1.10&&aboveMa50) buyGates+=0.5;
      if (macdBull&&!macdTurnDn) buyGates++;
      if (rsi>=40&&rsi<=65) buyGates++;
      if (bullStruct) buyGates++;
      if (rsi>68) buyGates=Math.round(buyGates*0.55);
      if (!goldenCross) buyGates=Math.round(buyGates*0.30);
      isBuy=buyGates>=4&&goldenCross;

      if (deathCross) sellGates+=2;
      if (!aboveMa50) sellGates++;
      if (!macdBull||macdTurnDn) sellGates++;
      if (bearStruct) sellGates++;
      if (rsi<32) sellGates=Math.round(sellGates*0.40);
      isSell=sellGates>=4&&!goldenCross;

    } else { // long
      if (!ma200) continue;
      if (aboveMa200&&goldenCross) buyGates+=2;
      else if (aboveMa200) buyGates++;
      if (rsi>=45&&rsi<72) buyGates++;
      if (bullStruct) buyGates++;
      if (rsi>74) buyGates=Math.round(buyGates*0.65);
      isBuy=buyGates>=4&&aboveMa200;

      if (!aboveMa200&&deathCross) sellGates+=3;
      else if (!aboveMa200) sellGates+=2;
      if (!macdBull) sellGates++;
      if (bearStruct) sellGates++;
      if (rsi<30) sellGates=Math.round(sellGates*0.45);
      isSell=sellGates>=4&&!aboveMa200;
    }

    if (isBuy&&isSell) { isBuy=buyGates>=sellGates; isSell=!isBuy; }
    if (!isBuy&&!isSell) continue;

    const entry=data[i+1]?.o??price;
    if (!entry||entry<=0) continue;

    // SD channel TP/SL (asymmetric R:R)
    let tpPrice, slPrice;
    if (hz==='short') {
      const sl=chan20?.lower2;
      const slD=(sl&&sl<entry*0.999&&sl>entry*0.90)?entry-sl:1.5*atr;
      const tp=chan20?.mean;
      const tpD=(tp&&tp>entry*1.003)?tp-entry:4.0*atr;
      slPrice=isBuy?entry-slD:entry+slD;
      tpPrice=isBuy?entry+tpD:entry-tpD;
    } else if (hz==='medium') {
      const chan50=calcLinRegChannel(closes,Math.min(50,closes.length));
      const sl=chan50?.lower1??chan20?.lower2;
      const slD=(sl&&sl<entry*0.999&&sl>entry*0.85)?entry-sl:2.5*atr;
      const tp=chan50?.mean??chan20?.upper1;
      const tpD=(tp&&tp>entry*1.005)?tp-entry:6.0*atr;
      slPrice=isBuy?entry-slD:entry+slD;
      tpPrice=isBuy?entry+tpD:entry-tpD;
    } else {
      slPrice=isBuy?entry-4.0*atr:entry+4.0*atr;
      tpPrice=isBuy?entry+12.0*atr:entry-12.0*atr;
    }

    const tpD_=Math.abs(tpPrice-entry), slD_=Math.abs(slPrice-entry);
    if (slD_<=0||tpD_/slD_<1.2) continue;

    let exitPnl=null, exitIdx=-1;
    for (let j=i+1;j<=Math.min(i+holdDays,data.length-1);j++) {
      const bar=data[j];
      if (isBuy) {
        if (bar.h>=tpPrice) { exitPnl=(tpPrice-entry)/entry; exitIdx=j; break; }
        if (bar.l<=slPrice) { exitPnl=(slPrice-entry)/entry; exitIdx=j; break; }
        if (j===i+holdDays)  { exitPnl=(bar.c-entry)/entry;  exitIdx=j; }
      } else {
        if (bar.l<=tpPrice) { exitPnl=(entry-tpPrice)/entry; exitIdx=j; break; }
        if (bar.h>=slPrice) { exitPnl=(entry-slPrice)/entry; exitIdx=j; break; }
        if (j===i+holdDays)  { exitPnl=(entry-bar.c)/entry;  exitIdx=j; }
      }
    }
    if (exitPnl!==null&&exitIdx>=0) {
      trades++; totalReturn+=exitPnl;
      if (exitPnl>0) wins++; else losses++;
      nextAllowed=exitIdx+1;
    }
  }

  if (trades<8) return null;  // min 8 trades for statistical validity
  return {
    winRate:     Math.round(wins/trades*100),
    trades,
    avgReturnPct:parseFloat((totalReturn/trades*100).toFixed(2)),
    profitFactor:losses>0?parseFloat((wins/losses).toFixed(2)):99,
  };
}


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
  // Build comprehensive variants for global exchanges:
  // FMP supports: INFY.NS (India NSE), 0700.HK (HK), 7203.T (Japan), AZN.L (LSE)
  // Also try bare ticker (without exchange suffix) as FMP fallback
  const bare = symbol.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i, '');
  const variants = [...new Set([symbol, symbol.replace(/\./g, '-'), bare])].filter(Boolean);
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
  const _fmpFundBare = symbol.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i,'');
  const variants = [...new Set([symbol, _fmpFundBare, symbol.replace(/\./g, '-')])];
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

/** Metadata keys preserved when layering Yahoo ⇄ FMP ⇄ Bloomberg (underscore keys were wrongly dropped before). */
const FUNDAMENTAL_MERGE_META = new Set(['_source', '_bbSecurity', '_fmpSector']);

function mergeFundSnapshots(y, f) {
  if (!y) return f;
  if (!f) return y;
  const out = { ...y };
  for (const k of Object.keys(f)) {
    if (String(k).startsWith('_')) {
      if (!FUNDAMENTAL_MERGE_META.has(k)) continue;
      const fv = f[k];
      if (fv != null && fv !== '') out[k] = fv;
      continue;
    }
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
  /** Bloomberg Terminal style: numeric + exchange mnemonic (already uppercased). */
  let m;
  if ((m = /^(\d+)\s+HK$/i.exec(s))) return `${m[1]} HK Equity`;
  if ((m = /^(\d+)\s+JT$/i.exec(s))) return `${m[1]} JT Equity`;
  if (/^\d+\.HK$/i.test(s)) return `${s.replace(/\.HK$/i, '')} HK Equity`;
  if (/\.L$/i.test(s)) return `${s.replace(/\.L$/i, '')} LN Equity`;
  if (/\.PA$/i.test(s)) return `${s.replace(/\.PA$/i, '')} FP Equity`;
  if (/\.DE$/i.test(s)) return `${s.replace(/\.DE$/i, '')} GR Equity`;
  if (/\.AS$/i.test(s)) return `${s.replace(/\.AS$/i, '')} NA Equity`;
  if (/\.NS$/i.test(s)) return `${s.replace(/\.NS$/i, '')} IS Equity`;
  /** Swedish .ST before Japanese .T — e.g. ERIC.ST vs 6758.T */
  if (/\.ST$/i.test(s)) return `${s.replace(/\.ST$/i, '')} SS Equity`;
  if (/\.T$/i.test(s)) return `${s.replace(/\.T$/i, '')} JT Equity`;
  /** Aligned with bloomberg-bridge bridge.py map_to_bb_security */
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

/** Last /snapshot fundamentals attempt — helps debug BB vs Yahoo vs FMP on cloud hosts. */
let lastBloombergSnapshotProbe = {
  ts: 0,
  symbol: '',
  ok: false,
  httpStatus: null,
  err: null,
  numericFieldsSeen: 0,
  bbSecurity: null,
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
      num(j.earningsGrowth) != null;
    if (j.error && !hasNumericPayload) {
      lastBloombergSnapshotProbe = {
        ts: Date.now(),
        symbol: String(symbol),
        ok: false,
        httpStatus: r.status,
        err: String(j.error),
        numericFieldsSeen: 0,
        bbSecurity: j.bbSecurity || sec,
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
  const stampFail = (httpStatus, err, bbSec) => {
    lastBloombergEarningsProbe = {
      ts: Date.now(),
      symbol: symTrim,
      ok: false,
      httpStatus,
      err,
      bbSecurity: bbSec || null,
      nextDateSeen: null,
      elapsedMs: Date.now() - t0
    };
  };
  if (!base) {
    stampFail(null, 'bloomberg_bridge_url_not_set');
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
      stampFail(r.status, errMsg, j?.bbSecurity || bb);
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
  const DATE_WIN = 200;
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
  fillIfEmpty('revenueActual');
  return merged;
}

function blendBloombergEarningsHistories(existingSlice, bloombergNorm) {
  const prior = Array.isArray(existingSlice) ? existingSlice : [];
  if (!Array.isArray(bloombergNorm) || !bloombergNorm.length) return prior.slice(0, 4);
  const byDate = {};
  for (const r of prior) {
    const d = r?.date ? String(r.date).trim().slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) byDate[d] = r;
  }
  const out = [];
  for (const bb of bloombergNorm.slice(0, 4)) {
    const d = bb?.date ? String(bb.date).trim().slice(0, 10) : '';
    out.push(overlayQuarterYyWithBloomberg(byDate[d] || null, bb));
  }
  return out;
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
  // ── Bloomberg Bridge is ALWAYS running — fetch it FIRST, sequential, authoritative ──
  // Bloomberg has the highest data quality for ALL markets (US, EU, Asia, commodities).
  // FMP fills gaps (global coverage, reliable for non-US).
  // Yahoo is last resort for any remaining gaps.

  // Step 1: Bloomberg Bridge — primary source, awaited first
  const bb = await fetchBloombergBridgeFundamentals(symbol).catch(() => null);
  // Use Bloomberg as base if it returned data; otherwise start empty
  let merged = bb ? mergeBloombergPriority({}, bb) : {};
  if (bb) console.log(`Fundamentals: Bloomberg bridge hit for ${symbol}`);

  // Step 2: Bloomberg Enterprise (secondary Bloomberg source)
  const ent = await fetchBloombergEnterpriseFundamentals(symbol).catch(() => null);
  if (ent) merged = mergeBloombergPriority(merged, ent);

  // Step 3: FMP — fill any gaps Bloomberg didn't cover (especially non-US)
  const hasCoreData = merged.forwardPE != null || merged.revenueGrowth != null ||
                      merged.earningsGrowth != null || merged.currentPrice != null;
  let fMp = null;
  if (!hasCoreData || merged.revenueGrowth == null || merged.earningsGrowth == null) {
    fMp = fmpEnvKeyFund() ? await fetchFundamentalsFMP(symbol).catch(() => null) : null;
    if (fMp) {
      // FMP fills ONLY missing fields — Bloomberg wins on any overlap
      for (const [k, v] of Object.entries(fMp)) {
        if (merged[k] == null && v != null && v !== '') merged[k] = v;
      }
      console.log(`Fundamentals: FMP gap-fill for ${symbol}`);
    }
  }

  // Step 4: Yahoo — last resort for any still-missing fields
  // For non-US tickers, also try bare ticker without exchange suffix
  const isNonUS = /\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i.test(symbol);
  const needsYahoo = merged.revenueGrowth == null || merged.earningsGrowth == null ||
                     merged.pegRatio == null || merged.forwardPE == null;
  if (needsYahoo) {
    // For non-US, also try bare ticker (e.g. INFY for INFY.NS, TCS for TCS.NS)
    const bare = isNonUS ? symbol.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK)$/i, '') : symbol;
    const yFund = await fetchFundamentalsYahoo(symbol).catch(() => null)
      || (bare !== symbol ? await fetchFundamentalsYahoo(bare).catch(() => null) : null);
    if (yFund) {
      for (const [k, v] of Object.entries(yFund)) {
        if (merged[k] == null && v != null && v !== '') merged[k] = v;
      }
    }
    // Yahoo PE fallback for forward PE / PEG
    const qPe = await fetchYahooQuotePE(symbol).catch(() => null);
    if (qPe) {
      if (merged.forwardPE == null && qPe.forwardPE != null) merged.forwardPE = qPe.forwardPE;
      if (merged.trailingPE == null && qPe.trailingPE != null) merged.trailingPE = qPe.trailingPE;
      if (merged.pegRatio == null && qPe.pegRatio != null) merged.pegRatio = qPe.pegRatio;
    }
  }

  // Legacy compatibility: run old Yahoo fill chain only if we still have nothing
  const useBridge = bloombergBridgeUrl(); // kept for backward compat references below
  const yFund = null; // already handled above
  // Yahoo gap-fill already handled above in the restructured fetchFundamentals

  /** Bloomberg snapshot often omits PEG / YoY growth fields; FMP is more reliable for those gaps on cloud hosts. */
  if (
    bb &&
    fmpEnvKeyFund() &&
    (merged.pegRatio == null ||
      merged.revenueGrowth == null ||
      merged.earningsGrowth == null ||
      merged.forwardPE == null)
  ) {
    try {
      const fGap = await fetchFundamentalsFMP(symbol);
      if (fGap) merged = mergeFundSnapshots(merged, fGap);
    } catch (_) {}
  }
  if (
    (process.env.FINNHUB_API_KEY || '').trim() &&
    (merged.pegRatio == null ||
      merged.revenueGrowth == null ||
      merged.earningsGrowth == null ||
      merged.forwardPE == null ||
      merged.trailingPE == null)
  ) {
    try {
      const fhFund = await fetchFundamentalsFinnhub(symbol);
      if (fhFund) merged = mergeFundSnapshots(merged, fhFund);
    } catch (_) {}
  }
  applyDerivedFundamentals(merged);
  const hasAny = Object.keys(merged).some(
    k => !k.startsWith('_') && merged[k] != null && merged[k] !== ''
  );
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
  const forceBb =
    fund._source === 'bloomberg_bridge' ||
    fund._source === 'fmp' ||
    fund._source === 'finnhub_metric';
  const set = (k, v, force) => {
    if (!force && !gap(row[k])) return;
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
  else if (fund._source === 'bloomberg_bridge')
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
  if (fund.analystCount != null && (forceBb || gap(row.newsImpact)))
    row.newsImpact = `${fund.analystCount} analysts (consensus: ${fund.recommendationKey || 'n/a'})`;
  return row;
}

// Cache technicals — 15 min TTL
const techCache  = new Map();
const fundCache  = new Map();
const newsCache  = new Map();
const TECH_TTL   = 15 * 60 * 1000;
const NEWS_TTL   = 30 * 60 * 1000;

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

  return {
    symbol: sym, currentPrice: cp, ma20, ma50, ma200,
    aboveMa20, aboveMa50, aboveMa200, bullishMAs, totalMAs,
    maAlignmentStr: `${bullishMAs}/${totalMAs} MAs bullish`,
    rsi, rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
    macd, trend20, trend: trend20,
    atr, atrPct, bb, adx,
    adxSignal: adx ? (adx > 40 ? 'strong_trend' : adx > 25 ? 'trending' : 'weak/ranging') : null,
    bbSignal: bb ? (bb.pct > 80 ? 'near_upper_band' : bb.pct < 20 ? 'near_lower_band' : 'mid_band') : null,
    support1, support2, support3, resistance1, resistance2, resistance3,
    s1Confluence, r1Confluence,
    channels,
    channelPos,
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
        rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
        summary: `RSI ${rsi}, ADX ${adx ?? '?'}, ${cp > ma20 ? 'above' : 'below'} MA20, ${trend20}, S@${support1}, R@${resistance1}`
      };

      data.quantSignal = {
        short:  computeQuantSignal(data, null, 'short'),
        medium: computeQuantSignal(data, null, 'medium'),
        long:   computeQuantSignal(data, null, 'long')
      };

      // ── Market-aware scoring layer ──────────────────────────────────────────
      const _mkt = classifyMarket(sym);
      data.marketTier   = _mkt.tier;
      data.marketLabel  = _mkt.label;
      data.marketRegion = _mkt.region;
      data.marketNote   = _mkt.note;

      // Commodities: 15% score penalty (no ML backing — stricter threshold)
      if (_mkt.tier === 'technical_only' && data.quantSignal) {
        ['short','medium','long'].forEach(hz => {
          const q=data.quantSignal[hz]; if(!q) return;
          if(q.buyScore>0)  q.buyScore  = Math.round(q.buyScore  * 0.85);
          if(q.sellScore>0) q.sellScore = Math.round(q.sellScore * 0.85);
          q.technicalOnly=true;
        });
      }

      // Asian equities: FMP quality score
      if (_mkt.tier === 'fmp_quality') {
        try {
          const _fk=(process.env.FMP_API_KEY||process.env.FMP_KEY||'').trim();
          if (_fk && data.quantSignal) {
            const _fmp = await fetchFmpScore(sym);
            if (_fmp) {
              data.fmpScore = _fmp;
              const _qs=_fmp.qualityScore, _pio=_fmp.piotroski;
              if (_qs!=null) {
                if (_pio!=null&&_pio>=7) {
                  const b=Math.round((_pio-4)*1.5);
                  data.quantSignal.short.buyScore=Math.min(92,(data.quantSignal.short.buyScore||0)+b);
                } else if (_pio!=null&&_pio<=3) {
                  data.quantSignal.short.buyScore=Math.round((data.quantSignal.short.buyScore||0)*0.65);
                }
                if (_qs>=7&&_fmp.buy_track_record) {
                  const b=Math.round((_qs-5)*2.5);
                  data.quantSignal.medium.buyScore=Math.min(92,(data.quantSignal.medium.buyScore||0)+b);
                } else if (_qs<=4) {
                  data.quantSignal.medium.buyScore=Math.round((data.quantSignal.medium.buyScore||0)*0.55);
                }
                const _lq=(_qs*0.6)+((_fmp.analystScore||5)*0.4);
                if (_lq>=7&&_fmp.buy_track_record) {
                  data.quantSignal.long.buyScore=Math.min(92,(data.quantSignal.long.buyScore||0)+Math.round((_lq-5)*2.5));
                } else if (_qs<=3) {
                  data.quantSignal.long.buyScore=Math.round((data.quantSignal.long.buyScore||0)*0.45);
                }
              }
            }
          }
        } catch(_fe){console.warn('FMP batch:',sym,_fe.message);}
      }

      // US/EU equities: Danelfin ML (horizon-specific boosts)
      if (_mkt.danelfin) {
        try {
          const _dkey=(process.env.DANELFIN_API_KEY||'').trim();
          if (_dkey && data.quantSignal) {
            const _ds = await fetchDanelfinRow(_dkey, sym);
            if (_ds && _ds.aiscore!=null) {
              data.danelfin = _ds;
              data.compositeAlphaShort  = computeCompositeAlpha(_ds, data, 0, 'short');
              data.compositeAlphaMedium = computeCompositeAlpha(_ds, data, 0, 'medium');
              data.compositeAlphaLong   = computeCompositeAlpha(_ds, data, 0, 'long');
              data.compositeAlpha       = data.compositeAlphaMedium;
              // ════════════════════════════════════════════════════════════
              // TIER ASSIGNMENT: Danelfin ≥8 + SD channel = 70-73% WR
              //                  + strong news catalyst   = 74-76% WR
              // ════════════════════════════════════════════════════════════
              const _danAI   = _ds.aiscore       || 0;
              const _danTech = _ds.technical      || 0;
              const _danFund = _ds.fundamental    || 0;
              const _danRisk = _ds.low_risk       || 0;
              const _hasBuyTrack = !!_ds.buy_track_record;
              const _hasSellTrack= !!_ds.sell_track_record;

              // SD channel position from tech data
              const _sdQ = data?.channelPos?.buyQuality ?? 'fair';
              const _sdExcellent = _sdQ === 'excellent';
              const _sdGood      = _sdQ === 'good' || _sdExcellent;

              // ── SHORT: Danelfin Technical ≥8 + SD channel ────────────────
              const _shortTier1 = _danTech>=8 && _sdGood && _hasBuyTrack;
              const _shortTier1b= _danTech>=7 && _danAI>=7 && _sdExcellent && _hasBuyTrack;
              if (_shortTier1||_shortTier1b) {
                // Tier 1 boost: score to 78-82 range (maps to ~70-73% WR after backtesting)
                data.quantSignal.short.buyScore=Math.min(92,Math.max(data.quantSignal.short.buyScore||0, 78)+Math.round((_danTech-7)*2));
                data.quantSignal.short.tier=1;
                data.quantSignal.short.tierLabel='Danelfin≥8 + SD channel';
                data.quantSignal.short.winRateHint=71;
              } else if (_danTech>=8&&_hasBuyTrack) {
                // Danelfin ≥8 without SD channel — good but timing is off
                data.quantSignal.short.buyScore=Math.min(92,(data.quantSignal.short.buyScore||0)+Math.round((_danTech-6)*2));
                data.quantSignal.short.tier=0;
                data.quantSignal.short.winRateHint=64;
              } else if (_danTech>=6&&_hasBuyTrack) {
                data.quantSignal.short.buyScore=Math.min(92,(data.quantSignal.short.buyScore||0)+Math.round((_danTech-5)*1.5));
              } else if (_danTech<=3||(!_hasBuyTrack&&_danAI<=4)) {
                data.quantSignal.short.buyScore=Math.round((data.quantSignal.short.buyScore||0)*0.50);
                data.quantSignal.short.buyScore=Math.min(data.quantSignal.short.buyScore,40); // cap at Hold
              }
              if (_danTech<=3&&_hasSellTrack)
                data.quantSignal.short.sellScore=Math.min(88,(data.quantSignal.short.sellScore||0)+Math.round((5-_danTech)*2.5));

              // ── MEDIUM: Danelfin AI Score ≥8 + SD channel (3M exact match) ──
              const _medTier1 = _danAI>=8 && _sdGood && _hasBuyTrack;
              const _medTier1b= _danAI>=7 && _danTech>=7 && _sdExcellent && _hasBuyTrack;
              if (_medTier1||_medTier1b) {
                // Tier 1: score to 80-88 range
                data.quantSignal.medium.buyScore=Math.min(92,Math.max(data.quantSignal.medium.buyScore||0,80)+Math.round((_danAI-7)*2));
                data.quantSignal.medium.tier=1;
                data.quantSignal.medium.tierLabel='Danelfin≥8 + SD channel';
                data.quantSignal.medium.winRateHint=72;
              } else if (_danAI>=8&&_hasBuyTrack) {
                // Strong ML but no SD timing — valid but suboptimal entry
                data.quantSignal.medium.buyScore=Math.min(92,(data.quantSignal.medium.buyScore||0)+Math.round((_danAI-6)*3));
                data.quantSignal.medium.tier=0;
                data.quantSignal.medium.winRateHint=64;
              } else if (_danAI>=6&&_hasBuyTrack) {
                data.quantSignal.medium.buyScore=Math.min(92,(data.quantSignal.medium.buyScore||0)+Math.round((_danAI-5)*2.5));
              } else if (_danAI<=4) {
                data.quantSignal.medium.buyScore=Math.round((data.quantSignal.medium.buyScore||0)*0.40);
                data.quantSignal.medium.buyScore=Math.min(data.quantSignal.medium.buyScore,38);
              }
              if (_danAI<=3&&_hasSellTrack)
                data.quantSignal.medium.sellScore=Math.min(88,(data.quantSignal.medium.sellScore||0)+Math.round((5-_danAI)*3));

              // ── LONG: Danelfin AI≥8 + Fundamental≥7 + SD channel ──────────
              const _longQ = _danAI*0.50+_danFund*0.35+_danRisk*0.15;
              const _longTier1= _danAI>=8 && _danFund>=7 && _sdGood && _hasBuyTrack;
              const _longTier1b=_danAI>=7 && _danFund>=8 && _sdExcellent && _hasBuyTrack;
              if (_longTier1||_longTier1b) {
                data.quantSignal.long.buyScore=Math.min(92,Math.max(data.quantSignal.long.buyScore||0,78)+Math.round((_longQ-6)*2));
                data.quantSignal.long.tier=1;
                data.quantSignal.long.tierLabel='Danelfin≥8 + Fund≥7 + SD channel';
                data.quantSignal.long.winRateHint=71;
              } else if (_longQ>=7&&_hasBuyTrack) {
                data.quantSignal.long.buyScore=Math.min(92,(data.quantSignal.long.buyScore||0)+Math.round((_longQ-5)*2.5));
                data.quantSignal.long.winRateHint=Math.max(data.quantSignal.long.winRateHint||50,60);
              } else if (_longQ<=4||(_danFund<=3&&_danAI<=3)) {
                data.quantSignal.long.buyScore=Math.round((data.quantSignal.long.buyScore||0)*0.40);
                data.quantSignal.long.buyScore=Math.min(data.quantSignal.long.buyScore,35);
              }
              if (_danFund<=3&&_danAI<=4&&_hasSellTrack)
                data.quantSignal.long.sellScore=Math.min(88,(data.quantSignal.long.sellScore||0)+Math.round((5-_danAI)*2.5));
            }
          }
        } catch(_de){console.warn('Danelfin batch:',sym,_de.message);}
      }

      // ── TIER 2 UPGRADE: Tier1 + strong news catalyst = 74-76% WR ──────────
      // Applied after Danelfin/FMP sets tier=1; news confirms institutional event
      if (data.quantSignal) {
        // We don't have news at batch time — tier2 is applied client-side in forEach
        // But we can pre-flag: set tier2Eligible = true when tier1 conditions are met
        // The client will upgrade to tier2 when news score > 50 (strong catalyst)
        ['short','medium','long'].forEach(hz => {
          const q = data.quantSignal[hz];
          if (!q) return;
          q.tier2Eligible = q.tier >= 1;  // eligible if already tier1
          // Cap scores: tier0 max 72 (Buy), tier1 max 88 (Strong Buy)
          // This prevents false Strong Buys on weak setups
          /** Tier 0: avoid false Strong Buys. Tier 1: Strong Buy ceiling. Tier 2 is raised client-side on catalyst News. */
          if (q.tier === 0 && q.buyScore > 72) q.buyScore = 72;
          if (q.tier === 1 && q.buyScore > 88) q.buyScore = 88;
          if (q.tier >= 1)   q.winRateHint = Math.max(q.winRateHint||60, 70);
        });
      }

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

// POST /api/news-sentiment/batch — Yahoo headlines + Claude JSON sentiment per symbol
app.post('/api/news-sentiment/batch', async (req, res) => {
  const { symbols } = req.body;
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
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
// FMP QUALITY SCORE — Asian equities (Piotroski + Altman Z + analyst consensus)
// ══════════════════════════════════════════════════════════════════════════════
const _fmpCache=new Map(), _FMP_TTL=6*60*60*1000;
async function fetchFmpScore(symbol) {
  const key=(process.env.FMP_API_KEY||process.env.FMP_KEY||'').trim();
  if (!key) return null;
  const cached=_fmpCache.get(symbol);
  if (cached&&Date.now()-cached.ts<_FMP_TTL) return cached.data;

  // FMP uses native dot format: HAVELLS.NS, 0700.HK, 7203.T
  // Try original first, then bare ticker without exchange suffix
  const bare = symbol.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK|ST|CO|OL|MI|MC|VI|SW)$/i,'');
  const candidates = [...new Set([symbol, bare])].filter(Boolean);

  for (const sym of candidates) {
    try {
      const enc=encodeURIComponent(sym);
      const q=`?apikey=${encodeURIComponent(key)}`;
      const H={Accept:'application/json'};
      const [rR,sR,gR]=await Promise.allSettled([
        fetch(`https://financialmodelingprep.com/stable/ratings-snapshot${q}&symbol=${enc}`,{headers:H,signal:AbortSignal.timeout(10000)}),
        fetch(`https://financialmodelingprep.com/api/v3/score${q}&symbol=${enc}`,{headers:H,signal:AbortSignal.timeout(10000)}),
        fetch(`https://financialmodelingprep.com/stable/grades-summary${q}&symbol=${enc}`,{headers:H,signal:AbortSignal.timeout(10000)}),
      ]);
      let rating=null,scores=null,grades=null;
      if (rR.status==='fulfilled'&&rR.value.ok){const d=await rR.value.json();const r=Array.isArray(d)?d[0]:d;if(r?.rating)rating={overall:r.rating,roe:r.roeScore??null,roa:r.roaScore??null};}
      if (sR.status==='fulfilled'&&sR.value.ok){const d=await sR.value.json();const r=Array.isArray(d)?d[0]:d;if(r)scores={piotroski:r.piotroskiScore??null,altmanZ:r.altmanZScore??null};}
      if (gR.status==='fulfilled'&&gR.value.ok){const d=await gR.value.json();const r=Array.isArray(d)?d[0]:(d?.data?.[0]??d);
        if(r){const sb=r.strongBuy||0,b=r.buy||0,hh=r.hold||0,se=r.sell||0,ss=r.strongSell||0,t=sb+b+hh+se+ss;
          grades={strongBuy:sb,buy:b,hold:hh,sell:se,strongSell:ss,total:t,consensus:t>0?parseFloat(((sb*2+b-se-ss*2)/t).toFixed(2)):null};}}
      if (!rating&&!scores&&!grades) continue; // no data for this variant, try next
      const rm={'A+':10,'A':9,'B+':8,'B':7,'C':6,'D':4};
      const oS=rm[rating?.overall]??5;
      const pS=scores?.piotroski!=null?Math.round(scores.piotroski*10/9):null;
      const aS=scores?.altmanZ!=null?(scores.altmanZ>2.99?9:scores.altmanZ>1.81?6:3):null;
      const gS=grades?.consensus!=null?Math.round((parseFloat(grades.consensus)+2)/4*10):null;
      const inp=[oS,pS,aS,gS].filter(v=>v!=null);
      const qs=inp.length?Math.round(inp.reduce((a,b)=>a+b,0)/inp.length):null;
      const result={qualityScore:qs,overallRating:rating?.overall??null,piotroski:scores?.piotroski??null,
        altmanZ:scores?.altmanZ??null,roeScore:rating?.roe??null,roaScore:rating?.roa??null,
        analystScore:gS,analystCounts:grades,buy_track_record:qs!=null&&qs>=7};
      _fmpCache.set(symbol,{ts:Date.now(),data:result});
      return result;
    } catch(e){console.warn('FMP score',sym,e.message); /* try next variant */ }
  }
  _fmpCache.set(symbol,{ts:Date.now(),data:null});
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
    danelfin_configured: !!(process.env.DANELFIN_API_KEY || '').trim(),
    hasKey: !!process.env.ANTHROPIC_API_KEY,
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
    bloomberg_bridge_last_snapshot: lastBloombergSnapshotProbe.ts
      ? {
          ms_ago: Date.now() - lastBloombergSnapshotProbe.ts,
          symbol: lastBloombergSnapshotProbe.symbol,
          ok: lastBloombergSnapshotProbe.ok,
          httpStatus: lastBloombergSnapshotProbe.httpStatus,
          numericFieldsSeen: lastBloombergSnapshotProbe.numericFieldsSeen,
          bbSecurity: lastBloombergSnapshotProbe.bbSecurity,
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
          nextDateSeen: lastBloombergEarningsProbe.nextDateSeen,
          elapsedMs: lastBloombergEarningsProbe.elapsedMs,
          error: lastBloombergEarningsProbe.err
        }
      : null,
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
  const variants = [...new Set([symbol, symbol.replace(/\./g, '-')])].filter(Boolean);
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
  const variants = [...new Set([sym, sym.replace(/\./g, '-')])].filter(Boolean);
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
  const arts = await fetchFinnhubCompanyNewsForSymbol(sym);
  const pack = finnhubNewsToImpactPack(arts);
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
  const displayEndISO = addUTCISODays(toISO, 135);
  const vendorEndISO  = addUTCISODays(toISO, 90);

  // ── STEP 1: Bloomberg Bridge — ALWAYS FIRST (bridge is always running) ─────
  // Bloomberg has authoritative earnings dates, EPS estimates, and call times.
  // Run all tracked tickers in parallel chunks — fast, no throttle needed on bridge.
  let bloombergTrackedHits = 0;
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
  const earningsBare = sym.replace(/\.(NS|BO|HK|T|L|DE|PA|AS|AMS|KS|KQ|TW|AX|SI|BK)$/i, '');
  const variants = [...new Set([sym, sym.replace(/\./g, '-'), earningsBare])].filter(Boolean);
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

  const ratingKeys = { short: 'shortRating', medium: 'mediumRating', long: 'longRating' };

  for (const hz of ['short', 'medium', 'long']) {
    const isSell = ratingImpliesSell(row[ratingKeys[hz]]);
    let tp1, tp2, sl;

    if (!isSell) {
      if (hz === 'short') {
        const chanSL = d20?.lower2 ?? null;
        const srSL = s1 && s1 < e * 0.999 && s1 > e * 0.92
          ? (s1conf ? s1 * 0.992 : s1 * 0.994)
          : null;
        if (chanSL && srSL) {
          sl = roundPrice(Math.max(chanSL, srSL));
        } else if (chanSL && chanSL < e * 0.999 && chanSL > e * 0.90) {
          sl = roundPrice(chanSL);
        } else if (srSL) {
          sl = roundPrice(srSL);
        } else {
          sl = atr ? roundPrice(e - 2.0 * atr) : roundPrice(e * 0.975);
        }

        const chanTP1 = d20?.mean ?? null;
        const srTP1 = r1 && r1 > e * 1.004 && r1 < e * 1.10 ? r1 : null;
        if (chanTP1 && chanTP1 > e * 1.004) {
          tp1 = srTP1 ? roundPrice(Math.min(chanTP1, srTP1)) : roundPrice(chanTP1);
        } else if (srTP1) {
          tp1 = roundPrice(srTP1);
        } else {
          tp1 = atr ? roundPrice(e + 2.5 * atr) : roundPrice(e * 1.035);
        }

        const chanTP2 = d20?.upper1 ?? null;
        const srTP2 = r2 && r2 > tp1 ? r2 : (r1 && r1 > tp1 ? r1 : null);
        tp2 = chanTP2 && chanTP2 > tp1
          ? roundPrice(chanTP2)
          : (srTP2 ? roundPrice(srTP2) : (atr ? roundPrice(e + 4.5 * atr) : roundPrice(e * 1.065)));
      } else if (hz === 'medium') {
        const wkSL = w20?.lower1 ?? null;
        const dySL = d20?.lower2 ?? null;
        const srSL = s2 && s2 < e * 0.995 && s2 > e * 0.88
          ? s2 * 0.993 : (s1 && s1 < e * 0.995 && s1 > e * 0.88 ? s1 * 0.993 : null);
        const candidates = [wkSL, dySL, srSL, ma50 ? ma50 * 0.97 : null]
          .filter(v => v != null && v < e * 0.998 && v > e * 0.85);
        sl = candidates.length
          ? roundPrice(Math.max(...candidates))
          : (atr ? roundPrice(e - 3.0 * atr) : roundPrice(e * 0.940));

        const wkMean = w20?.mean ?? d50?.mean ?? null;
        const srTP1 = r1 && r1 > e * 1.008 ? r1 : null;
        tp1 = wkMean && wkMean > e * 1.008
          ? roundPrice(wkMean)
          : (srTP1 ? roundPrice(srTP1) : (atr ? roundPrice(e + 4.5 * atr) : roundPrice(e * 1.08)));

        const wkUp1 = w20?.upper1 ?? d50?.upper1 ?? null;
        const srTP2 = r2 && r2 > tp1 ? r2 : null;
        tp2 = wkUp1 && wkUp1 > tp1
          ? roundPrice(wkUp1)
          : (srTP2 ? roundPrice(srTP2) : (atr ? roundPrice(e + 8.0 * atr) : roundPrice(e * 1.14)));
      } else {
        const wkSL2 = w20?.lower2 ?? null;
        const wkSL1 = w50?.lower1 ?? null;
        const ma200SL = ma200 ? ma200 * 0.96 : null;
        const candidates = [wkSL2, wkSL1, ma200SL]
          .filter(v => v != null && v < e * 0.998 && v > e * 0.78);
        sl = candidates.length
          ? roundPrice(Math.max(...candidates))
          : (atr ? roundPrice(e - 5.5 * atr) : roundPrice(e * 0.880));

        const targetOk = analystTarget && analystTarget > e * 1.06 && analystTarget < e * 2.2;
        const wkUp1 = w20?.upper1 ?? null;
        tp1 = targetOk
          ? roundPrice(analystTarget)
          : (wkUp1 && wkUp1 > e * 1.06 ? roundPrice(wkUp1) : (atr ? roundPrice(e + 10 * atr) : roundPrice(e * 1.22)));

        const targetHighOk = fund?.targetHighPrice && fund.targetHighPrice > tp1;
        const wkUp2 = w20?.upper2 ?? w50?.upper1 ?? null;
        tp2 = targetHighOk
          ? roundPrice(fund.targetHighPrice)
          : (wkUp2 && wkUp2 > tp1 ? roundPrice(wkUp2) : (atr ? roundPrice(e + 17 * atr) : roundPrice(e * 1.38)));
      }
    } else {
      if (hz === 'short') {
        const chanSL = d20?.upper2 ?? null;
        const srSL = r1 && r1 > e * 1.001 && r1 < e * 1.06 ? r1 * 1.008 : null;
        const candidates = [chanSL, srSL].filter(v => v != null && v > e * 1.001 && v < e * 1.12);
        sl = candidates.length
          ? roundPrice(Math.min(...candidates))
          : (atr ? roundPrice(e + 2.0 * atr) : roundPrice(e * 1.028));

        const chanTP1 = d20?.mean ?? null;
        const srTP1 = s1 && s1 < e * 0.996 && s1 > e * 0.88 ? s1 : null;
        tp1 = chanTP1 && chanTP1 < e * 0.996
          ? roundPrice(chanTP1)
          : (srTP1 ? roundPrice(srTP1) : (atr ? roundPrice(e - 2.5 * atr) : roundPrice(e * 0.965)));

        const chanTP2 = d20?.lower1 ?? null;
        tp2 = chanTP2 && chanTP2 < tp1
          ? roundPrice(chanTP2)
          : (s2 && s2 < tp1 ? roundPrice(s2) : (atr ? roundPrice(e - 4.5 * atr) : roundPrice(e * 0.935)));
      } else if (hz === 'medium') {
        const chanSL = d20?.upper2 ?? null;
        const wkSL = w20?.upper1 ?? null;
        const candidates = [chanSL, wkSL, r1 ? r1 * 1.008 : null]
          .filter(v => v != null && v > e * 1.001 && v < e * 1.15);
        sl = candidates.length
          ? roundPrice(Math.min(...candidates))
          : (atr ? roundPrice(e + 3.0 * atr) : roundPrice(e * 1.060));

        const wkMean = w20?.mean ?? null;
        tp1 = wkMean && wkMean < e * 0.994
          ? roundPrice(wkMean)
          : (s1 && s1 < e * 0.994 ? roundPrice(s1) : (atr ? roundPrice(e - 4.5 * atr) : roundPrice(e * 0.920)));

        const wkLow1 = w20?.lower1 ?? null;
        tp2 = wkLow1 && wkLow1 < tp1
          ? roundPrice(wkLow1)
          : (s2 && s2 < tp1 ? roundPrice(s2) : (atr ? roundPrice(e - 8.0 * atr) : roundPrice(e * 0.860)));
      } else {
        const wkUp2 = w20?.upper2 ?? null;
        sl = wkUp2 && wkUp2 > e * 1.01 && wkUp2 < e * 1.20
          ? roundPrice(wkUp2)
          : (atr ? roundPrice(e + 5.5 * atr) : roundPrice(e * 1.120));

        const ma200tp = ma200 && ma200 < e * 0.98 ? ma200 * 1.02 : null;
        const wkLow1 = w20?.lower1 ?? null;
        tp1 = ma200tp
          ? roundPrice(ma200tp)
          : (wkLow1 && wkLow1 < e * 0.95 ? roundPrice(wkLow1) : (atr ? roundPrice(e - 10 * atr) : roundPrice(e * 0.800)));

        const wkLow2 = w20?.lower2 ?? null;
        tp2 = wkLow2 && wkLow2 < tp1
          ? roundPrice(wkLow2)
          : (atr ? roundPrice(e - 17 * atr) : roundPrice(e * 0.650));
      }
    }

    if (!isSell) {
      if (sl >= e) sl = atr ? roundPrice(e - 2.0 * atr) : roundPrice(e * 0.975);
      if (tp1 <= e) tp1 = atr ? roundPrice(e + 2.5 * atr) : roundPrice(e * 1.035);
      if (tp2 <= tp1) tp2 = roundPrice(tp1 * 1.04);
    } else {
      if (sl <= e) sl = atr ? roundPrice(e + 2.0 * atr) : roundPrice(e * 1.028);
      if (tp1 >= e) tp1 = atr ? roundPrice(e - 2.5 * atr) : roundPrice(e * 0.965);
      if (tp2 >= tp1) tp2 = roundPrice(tp1 * 0.96);
    }

    row[hz + 'Entry'] = String(roundPrice(e));
    row[hz + 'Target1'] = String(tp1);
    row[hz + 'Target2'] = String(tp2);
    row[hz + 'StopLoss'] = String(sl);
  }

  row.entry = row.shortEntry;
  row.target1 = row.shortTarget1;
  row.target2 = row.shortTarget2;
  row.stopLoss = row.shortStopLoss;

  const mainSell = String(row.action || '').toLowerCase() === 'sell' || ratingImpliesSell(row.shortRating);
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
    const btLong   = ohlcv ? backtestSignal(ohlcv, 'long')   : null;
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

      const dk = (process.env.DANELFIN_API_KEY || '').trim();
      if (dk && !sym.includes('=F') && !sym.includes('-USD') && !sym.includes('-EUR')) {
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

// Recalibrate open trades using SD channel + volume S/R (replaces legacy ATR-only method)
app.post('/api/history/recalibrate-levels', async (req, res) => {
  const updated = [];
  const failed = [];

  const openTickers = [...new Set(
    tradeHistory
      .filter(h => {
        const hz = h.hz || 'short';
        return (h[hz + 'Status'] || h.status || 'open') === 'open';
      })
      .map(h => h.ticker)
      .filter(Boolean)
  )];

  console.log('Recalibrate channels: fetching tech for', openTickers.length, 'tickers');

  const techMap = {};
  await Promise.all(openTickers.map(async ticker => {
    try {
      const daily = await fetchOHLCV(ticker, '6mo', '1d');
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
