const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ──────────────────────────────────────────────────────────────────
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
    hasKey: !!process.env.ANTHROPIC_API_KEY, 
    ts: Date.now(),
    historyVersion: HISTORY_VERSION,
    historyCount: tradeHistory.length
  });
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
// Try to persist in /opt/render/project/src (persists across restarts on Render disk)
// Fallback to /tmp if that fails
const HISTORY_FILE = (() => {
  const paths = [
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


// ── Earnings data from Yahoo Finance ────────────────────────────────
app.get('/api/earnings/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const todayISO = new Date().toISOString().slice(0,10);
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  const apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    let nextDate=null,nextDateEnd=null,epsEst=null,callTime=null,quarter=null,epsHistory=[];
    if(apiKey) {
      // Step 1: Next earnings date via web search
      try {
        const r1 = await fetch('https://api.anthropic.com/v1/messages',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05'},
          body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:400,
            tools:[{type:'web_search_20250305',name:'web_search'}],
            system:'Financial data. Today='+todayStr+' ('+todayISO+'). Return ONLY JSON object, no text.',
            messages:[{role:'user',content:'Search "'+sym+' next earnings date 2026" and return ONLY JSON: {"nextDate":"YYYY-MM-DD","nextDateEnd":"YYYY-MM-DD or null","earningsTime":"pre-market or post-market","epsEstimate":"number","quarter":"Q1 FY2026"} Date must be after '+todayISO+'.'}]}),
          signal:AbortSignal.timeout(20000)});
        if(r1.ok){
          const d1=await r1.json();
          let raw=''; if(d1.content)d1.content.forEach(b=>{if(b.type==='text')raw+=b.text; if(b.type==='tool_result'&&b.content)(Array.isArray(b.content)?b.content:[b.content]).forEach(tc=>{if(tc&&tc.type==='text')raw+=tc.text;});});
          raw=raw.replace(/```json/gi,'').replace(/```/g,'').trim();
          const si=raw.indexOf('{'),ei=raw.lastIndexOf('}');
          if(si!==-1&&ei>si){try{
            const p=JSON.parse(raw.slice(si,ei+1));
            if(p.nextDate&&p.nextDate>=todayISO){nextDate=p.nextDate;nextDateEnd=p.nextDateEnd&&p.nextDateEnd!=='null'?p.nextDateEnd:null;epsEst=p.epsEstimate||null;callTime=p.earningsTime||null;quarter=p.quarter||null;}
          }catch(pe){console.log('next parse:',pe.message);}}
        }
      } catch(e){console.log('Claude next err:',e.message);}
      // Step 2: Historical earnings via web search
      try {
        const r2 = await fetch('https://api.anthropic.com/v1/messages',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05'},
          body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:700,
            tools:[{type:'web_search_20250305',name:'web_search'}],
            system:'Financial data. Return ONLY valid JSON array, no markdown.',
            messages:[{role:'user',content:'Search "'+sym+' earnings results 2024 2025 actual vs estimate EPS beat miss" and return ONLY JSON array of last 4 quarters: [{"quarter":"Q1 FY2026","date":"YYYY-MM-DD","epsActual":"1.86","epsEstimate":"1.79","epsSurprise":"+3.9%","revenueActual":"27.2B","revenueEstimate":"26.1B","stockReaction":"+3.2%","beat":true}] All dates before '+todayISO+'.'}]}),
          signal:AbortSignal.timeout(20000)});
        if(r2.ok){
          const d2=await r2.json();
          let raw2=''; if(d2.content)d2.content.forEach(b=>{if(b.type==='text')raw2+=b.text; if(b.type==='tool_result'&&b.content)(Array.isArray(b.content)?b.content:[b.content]).forEach(tc=>{if(tc&&tc.type==='text')raw2+=tc.text;});});
          raw2=raw2.replace(/```json/gi,'').replace(/```/g,'').trim();
          const si=raw2.indexOf('['),ei=raw2.lastIndexOf(']');
          if(si!==-1&&ei>si){try{epsHistory=JSON.parse(raw2.slice(si,ei+1)).slice(0,4);}catch(pe){console.log('hist parse:',pe.message);}}
        }
      } catch(e){console.log('Claude hist err:',e.message);}
    }
    // Fallback: Yahoo v8 chart events for history only
    if(!epsHistory.length){
      for(const host of ['query1','query2']){
        try{
          const url=`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3y&interval=3mo&events=earnings&includePrePost=false`;
          const r=await fetch(url,{headers:YF_HEADERS,signal:AbortSignal.timeout(8000)});
          if(!r.ok)continue;
          const d=await r.json();
          const result=d?.chart?.result?.[0];
          if(!result)continue;
          const nowTs=Date.now()/1000;
          const evts=Object.values(result.events?.earnings||{}).sort((a,b)=>a.date-b.date);
          const past=evts.filter(e=>e.date<=nowTs);
          if(past.length){
            epsHistory=past.slice(-4).reverse().map(e=>{
              const surp=(e.epsActual!=null&&e.epsEstimate!=null)?((e.epsActual-e.epsEstimate)/Math.abs(e.epsEstimate)*100):null;
              return{quarter:new Date(e.date*1000).toLocaleDateString('en-GB',{month:'short',year:'numeric'}),
                date:new Date(e.date*1000).toISOString().slice(0,10),
                epsActual:e.epsActual!=null?String(e.epsActual):null,
                epsEstimate:e.epsEstimate!=null?String(e.epsEstimate):null,
                epsSurprise:surp!=null?(surp>=0?'+':'')+surp.toFixed(1)+'%':null,
                beat:surp!=null?surp>=0:null,revenueActual:null,stockReaction:null};
            });
          }
          break;
        }catch(e){console.log('Yahoo fallback:',e.message);}
      }
    }
    console.log('Earnings',sym+': next='+nextDate+', hist='+epsHistory.length);
    res.json({symbol:sym,nextEarningsDate:nextDate,nextEarningsDateEnd:nextDateEnd,epsEstimate:epsEst,earningsTime:callTime,quarter,history:epsHistory.slice(0,4)});
  }catch(e){console.error('Earnings err:',e.message);res.status(500).json({error:e.message});}
});


// ── Real Technical Analysis Engine ─────────────────────────────────────────
// Fetches actual OHLCV data from Yahoo Finance and calculates real indicators
// This replaces Claude's guessed RSI/MACD/MA values with real computed values

async function fetchOHLCV(symbol, range='6mo', interval='1d') {
  const sym = symbol.replace('.', '-');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Yahoo chart ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error('No chart data');
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const closes = q.close || [], highs = q.high || [], lows = q.low || [], volumes = q.volume || [];
  // Filter nulls
  const data = ts.map((t,i) => ({ t, o: q.open?.[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] }))
    .filter(x => x.c != null && x.h != null && x.l != null);
  return data;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(4));
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
}

function calcRSI(closes, period=14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period * 2 + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = recent[i] - recent[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < recent.length; i++) {
    const d = recent[i] - recent[i-1];
    avgG = (avgG * (period-1) + Math.max(d,0)) / period;
    avgL = (avgL * (period-1) + Math.max(-d,0)) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  // Signal = 9-period EMA of MACD line (approximate using last 9 MACD values)
  const macdValues = [];
  for (let i = closes.length - 9; i <= closes.length - 1; i++) {
    const e12 = calcEMA(closes.slice(0, i+1), 12);
    const e26 = calcEMA(closes.slice(0, i+1), 26);
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

function calcBollinger(closes, period=20) {
  const sma = calcSMA(closes, period);
  if (!sma) return null;
  const slice = closes.slice(-period);
  const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = parseFloat((sma + 2 * std).toFixed(2));
  const lower = parseFloat((sma - 2 * std).toFixed(2));
  const last = closes[closes.length - 1];
  const pct = parseFloat(((last - lower) / (upper - lower) * 100).toFixed(1));
  return { upper, middle: parseFloat(sma.toFixed(2)), lower, pct, width: parseFloat((2*std/sma*100).toFixed(2)) };
}

function findSupportResistance(data, lookback=60) {
  const recent = data.slice(-Math.min(lookback, data.length));
  const highs = recent.map(d => d.h), lows = recent.map(d => d.l);
  // Find pivot highs/lows (local maxima/minima with 3-bar confirmation)
  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      pivotHighs.push(highs[i]);
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      pivotLows.push(lows[i]);
  }
  const last = recent[recent.length-1].c;
  // Find nearest support (below price) and resistance (above price)
  const supports = pivotLows.filter(v => v < last * 0.995).sort((a,b) => b-a);
  const resistances = pivotHighs.filter(v => v > last * 1.005).sort((a,b) => a-b);
  return {
    support1: supports[0] ? parseFloat(supports[0].toFixed(2)) : null,
    support2: supports[1] ? parseFloat(supports[1].toFixed(2)) : null,
    resistance1: resistances[0] ? parseFloat(resistances[0].toFixed(2)) : null,
    resistance2: resistances[1] ? parseFloat(resistances[1].toFixed(2)) : null,
  };
}

function calcATR(data, period=14) {
  if (data.length < period + 1) return null;
  const recent = data.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i-1].c;
    trs.push(Math.max(recent[i].h - recent[i].l, Math.abs(recent[i].h - prev), Math.abs(recent[i].l - prev)));
  }
  return parseFloat((trs.reduce((a,b)=>a+b,0)/period).toFixed(4));
}

function calcVolumeAnalysis(data, period=20) {
  if (data.length < period) return null;
  const recent = data.slice(-period);
  const avgVol = recent.reduce((s,d)=>s+(d.v||0),0)/period;
  const lastVol = data[data.length-1].v || 0;
  const lastClose = data[data.length-1].c;
  const prevClose = data[data.length-2]?.c;
  const priceUp = prevClose && lastClose > prevClose;
  return {
    avgVolume: Math.round(avgVol),
    lastVolume: lastVol,
    relativeVolume: parseFloat((lastVol/avgVol).toFixed(2)),
    confirmation: priceUp && lastVol > avgVol * 1.2 ? 'bullish_volume' :
                  !priceUp && lastVol > avgVol * 1.2 ? 'bearish_volume' : 'neutral'
  };
}

function detectPattern(data) {
  if (data.length < 5) return 'insufficient data';
  const last = data[data.length-1];
  const prev = data[data.length-2];
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;
  if (body < range * 0.1) return range > 0.02 * last.c ? 'Doji (indecision)' : 'Small Doji';
  if (last.c > last.o && last.c > prev.c * 1.005 && body > prev.h - prev.l) return 'Bullish Engulfing';
  if (last.c < last.o && last.c < prev.c * 0.995 && body > prev.h - prev.l) return 'Bearish Engulfing';
  if (lowerWick > body * 2 && upperWick < body * 0.5) return last.c > last.o ? 'Hammer (bullish)' : 'Hanging Man';
  if (upperWick > body * 2 && lowerWick < body * 0.5) return last.c < last.o ? 'Shooting Star (bearish)' : 'Inverted Hammer';
  return last.c > last.o ? 'Bullish candle' : 'Bearish candle';
}

function calcTrend(data, period=20) {
  if (data.length < period) return 'unknown';
  const recent = data.slice(-period);
  const first = recent[0].c, last = recent[recent.length-1].c;
  const change = (last - first) / first;
  // Linear regression slope
  const n = recent.length;
  const x = Array.from({length:n},(_,i)=>i);
  const y = recent.map(d=>d.c);
  const meanX = (n-1)/2, meanY = y.reduce((a,b)=>a+b,0)/n;
  const slope = x.reduce((s,xi,i)=>s+(xi-meanX)*(y[i]-meanY),0) / x.reduce((s,xi)=>s+(xi-meanX)**2,0);
  const slopePct = slope / first * 100;
  if (slopePct > 0.3) return 'uptrend';
  if (slopePct < -0.3) return 'downtrend';
  return 'sideways';
}

// Cache technicals for 15 minutes
const techCache = new Map();
const TECH_TTL = 15 * 60 * 1000;

app.get('/api/technicals/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const cacheKey = symbol;
  const cached = techCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TECH_TTL) {
    return res.json(cached.data);
  }
  try {
    const [daily, weekly] = await Promise.all([
      fetchOHLCV(symbol, '6mo', '1d'),
      fetchOHLCV(symbol, '2y', '1wk').catch(() => null)
    ]);
    if (!daily || daily.length < 20) return res.status(404).json({ error: 'Insufficient data' });
    const closes = daily.map(d => d.c);
    const currentPrice = closes[closes.length - 1];
    const ma20 = calcSMA(closes, 20);
    const ma50 = calcSMA(closes, 50);
    const ma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const rsi = calcRSI(closes, 14);
    const rsi5 = calcRSI(closes, 5); // Short-term RSI
    const macd = calcMACD(closes);
    const bb = calcBollinger(closes, 20);
    const atr = calcATR(daily, 14);
    const atrPct = atr ? parseFloat((atr / currentPrice * 100).toFixed(2)) : null;
    const { support1, support2, resistance1, resistance2 } = findSupportResistance(daily, 60);
    const volume = calcVolumeAnalysis(daily, 20);
    const pattern = detectPattern(daily);
    const trend20 = calcTrend(daily, 20);
    const trend50 = closes.length >= 50 ? calcTrend(daily.slice(-50), 50) : null;

    // Weekly indicators for medium/long term
    let weeklyRSI = null, weeklyTrend = null, weeklyMA20 = null;
    if (weekly && weekly.length >= 14) {
      const wCloses = weekly.map(d => d.c);
      weeklyRSI = calcRSI(wCloses, 14);
      weeklyTrend = calcTrend(weekly.slice(-20), 20);
      weeklyMA20 = calcSMA(wCloses, 20);
    }

    // Price position relative to MAs
    const aboveMa20 = ma20 ? currentPrice > ma20 : null;
    const aboveMa50 = ma50 ? currentPrice > ma50 : null;
    const aboveMa200 = ma200 ? currentPrice > ma200 : null;
    const maAlignment = [aboveMa20, aboveMa50, aboveMa200].filter(x=>x!==null);
    const bullishMAs = maAlignment.filter(Boolean).length;
    const totalMAs = maAlignment.length;

    // Distance to support/resistance (for TP/SL guidance)
    const distToRes1 = resistance1 ? parseFloat(((resistance1-currentPrice)/currentPrice*100).toFixed(2)) : null;
    const distToSup1 = support1 ? parseFloat(((currentPrice-support1)/currentPrice*100).toFixed(2)) : null;

    // Signal quality score (0-100) based on alignment
    let signalScore = 50;
    if (rsi >= 40 && rsi <= 65 && aboveMa20 && aboveMa50 && trend20 === 'uptrend') signalScore = 80;
    else if (rsi >= 55 && rsi <= 80 && !aboveMa20 && !aboveMa50 && trend20 === 'downtrend') signalScore = 75;
    else if (rsi > 70 || rsi < 30) signalScore = 35; // Extreme — avoid

    const result = {
      symbol, currentPrice,
      // Moving averages
      ma20, ma50, ma200, ema9, ema21,
      aboveMa20, aboveMa50, aboveMa200,
      bullishMAs, totalMAs,
      maAlignmentStr: `${bullishMAs}/${totalMAs} MAs bullish`,
      // Momentum
      rsi, rsi5,
      rsiSignal: rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral',
      macd,
      // Trend
      trend20, trend50,
      // Volatility
      atr, atrPct,
      bb,
      bbSignal: bb ? (bb.pct > 80 ? 'near_upper_band' : bb.pct < 20 ? 'near_lower_band' : 'mid_band') : null,
      // Support / Resistance (REAL levels from pivot analysis)
      support1, support2, resistance1, resistance2,
      distToRes1Pct: distToRes1,
      distToSup1Pct: distToSup1,
      // Volume
      volume,
      // Pattern
      candlePattern: pattern,
      // Weekly (for medium/long)
      weeklyRSI, weeklyTrend, weeklyMA20,
      // Summary
      signalScore,
      trend: trend20,
      summary: `RSI ${rsi} (${rsi>70?'overbought':rsi<30?'oversold':'neutral'}), ${bullishMAs}/${totalMAs} MAs bullish, ${trend20}, S1@${support1}, R1@${resistance1}`
    };
    techCache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);
  } catch(e) {
    console.error('Technicals error:', symbol, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Batch technicals for dashboard scan
app.post('/api/technicals/batch', async (req, res) => {
  const { symbols } = req.body;
  if (!symbols?.length) return res.json({});
  const results = {};
  await Promise.allSettled(symbols.map(async sym => {
    try {
      const cached = techCache.get(sym);
      if (cached && Date.now() - cached.ts < TECH_TTL) { results[sym] = cached.data; return; }
      const daily = await fetchOHLCV(sym, '3mo', '1d');
      if (!daily || daily.length < 20) return;
      const closes = daily.map(d => d.c);
      const cp = closes[closes.length-1];
      const ma20 = calcSMA(closes, 20), ma50 = calcSMA(closes, 50);
      const rsi = calcRSI(closes, 14);
      const macd = calcMACD(closes);
      const { support1, resistance1 } = findSupportResistance(daily, 40);
      const atr = calcATR(daily, 14);
      const volume = calcVolumeAnalysis(daily, 20);
      const trend20 = calcTrend(daily, 20);
      const data = { symbol: sym, currentPrice: cp, ma20, ma50, rsi, macd,
        support1, resistance1, atr, atrPct: atr?parseFloat((atr/cp*100).toFixed(2)):null,
        volume, trend20, aboveMa20: ma20?cp>ma20:null, aboveMa50: ma50?cp>ma50:null,
        candlePattern: detectPattern(daily),
        summary: `RSI ${rsi}, ${cp>ma20?'above':'below'} MA20, ${trend20}, S@${support1}, R@${resistance1}` };
      techCache.set(sym, { ts: Date.now(), data });
      results[sym] = data;
    } catch(e) { console.warn('Batch tech fail:', sym, e.message); }
  }));
  res.json(results);
});



// ── Claude proxy ─────────────────────────────────────────────────────────

// ── Earnings calendar (server-side with 6h cache) ──────────────────────
let calCache=null, calTs=0;
app.get('/api/earnings-calendar', async (req,res) => {
  const todayISO=new Date().toISOString().slice(0,10);
  const apiKey=process.env.ANTHROPIC_API_KEY;
  if(!req.query.force && calCache && (Date.now()-calTs)<21600000) return res.json(calCache);
  if(!apiKey) return res.status(500).json({error:'No API key configured'});
  try {
    const weekEnd=new Date(); weekEnd.setDate(weekEnd.getDate()+10);
    const weISO=weekEnd.toISOString().slice(0,10);
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json','x-api-key':apiKey,
        'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05'
      },
      body:JSON.stringify({
        model:'claude-haiku-4-5-20251001',max_tokens:1500,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        system:'Today='+todayISO+'. Use web search to find real upcoming earnings. Return ONLY a JSON array starting with [. No markdown.',
        messages:[{role:'user',content:'Search: "earnings this week" stock results announcements from '+todayISO+' to '+weISO+'. Include S&P500 NASDAQ FTSE DAX Nikkei companies. Return ONLY JSON array: [{"ticker":"AMZN","name":"Amazon.com Inc","date":"YYYY-MM-DD","time":"post-market","epsEst":"1.36","epsPrior":"0.98","note":"Q1 2026","market":"US"}] Dates must be >= '+todayISO+'.'}]
      }),
      signal:AbortSignal.timeout(30000)
    });
    if(!r.ok){
      const t=await r.text();
      console.log('Earnings cal API err:',r.status,t.slice(0,150));
      return res.status(r.status).json({error:'API error '+r.status});
    }
    const d=await r.json();
    console.log('Earnings cal blocks:', d.content?.map(b=>b.type).join(','));
    let raw='';
    if(d.content) d.content.forEach(b=>{
      if(b.type==='text') raw+=b.text;
      if(b.type==='tool_result'&&b.content)
        (Array.isArray(b.content)?b.content:[b.content]).forEach(tc=>{if(tc&&tc.type==='text')raw+=tc.text;});
    });
    raw=raw.replace(/```json/gi,'').replace(/```/g,'').trim();
    console.log('Earnings cal raw len:', raw.length, raw.slice(0,100));
    const si=raw.indexOf('['),ei=raw.lastIndexOf(']');
    if(si===-1||ei<=si) {
      console.log('No JSON array. Raw:', raw.slice(0,400));
      return res.status(500).json({error:'No JSON array in response', preview: raw.slice(0,200)});
    }
    let arr;
    try { arr=JSON.parse(raw.slice(si,ei+1)); }
    catch(pe) { return res.status(500).json({error:'Parse failed: '+pe.message}); }
    arr=arr.filter(e=>e.date&&e.date>=todayISO).sort((a,b)=>a.date.localeCompare(b.date));
    calCache=arr; calTs=Date.now();
    console.log('Earnings cal cached:',arr.length,'events');
    res.json(arr);
  } catch(e){
    console.error('Earnings cal:',e.message);
    res.status(500).json({error:e.message});
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// One-time cleanup: fix impossible entries in server history
app.post('/api/history/cleanup-entries', async (req, res) => {
  let fixed = 0;
  tradeHistory = tradeHistory.map(h => {
    if(!h.hz || !h.ticker) return h;
    const hz = h.hz;
    const status = h[hz+'Status'] || 'open';
    const isSell = (h.action||'').toLowerCase() === 'sell';
    const entry = parseFloat(h.entry || h[hz+'Entry'] || 0);
    if(!entry) return h;
    // Detect AI-generated entries: sell entry that's unrealistically high
    // AAPL sell entry 305 when it was trading at ~273 = AI resistance zone
    // Heuristic: if sell entry > 110% of target1, it's wrong (TP should be below entry for sells)
    const tp1 = parseFloat(h.target1 || h[hz+'Target1'] || 0);
    const sl = parseFloat(h.stopLoss || h[hz+'StopLoss'] || 0);
    let isBadEntry = false;
    if(isSell && tp1 && entry > 0) {
      // For a valid sell: entry > tp1 (target below entry)
      // Bad sell: entry < tp1 (AI set entry above current price as resistance)
      if(entry < tp1 * 0.98) isBadEntry = true;
    } else if(!isSell && tp1 && entry > 0) {
      // For a valid buy: entry < tp1
      // Bad buy: entry > tp1 * 1.02
      if(entry > tp1 * 1.02) isBadEntry = true;
    }
    if(!isBadEntry) return h;
    // Fix: calculate proper entry from tp1/sl percentages
    // For sell: if tp1=285 and sl=325, typical range is 5-15% moves
    // Use midpoint approach or just clear the bad data
    const newH = {...h};
    // Reset to recalculate - set entry to null so client re-fetches
    newH.entry = null;
    newH[hz+'Entry'] = null;
    newH[hz+'PnlDollar'] = null;
    newH[hz+'PnlPct'] = null;
    // Reset status if it was a fake TP hit
    if(status === 'tp1_hit' || status === 'tp2_hit') newH[hz+'Status'] = 'open';
    fixed++;
    return newH;
  });
  saveHistoryFile(tradeHistory);
  console.log('Cleanup: fixed', fixed, 'bad entries');
  res.json({ fixed, total: tradeHistory.length });
});


app.listen(PORT, () => {
  console.log('AlphaSignal on port', PORT);
  console.log('API key set:', !!process.env.ANTHROPIC_API_KEY);
  // Test price fetch on startup
  fetchSinglePrice('AAPL').then(p => {
    if (p) console.log('✓ Yahoo Finance working - AAPL:', p.price, p.currency);
    else console.warn('✗ Yahoo Finance not working - prices will be unavailable');
  });
});
