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

app.listen(PORT, () => {
  console.log('AlphaSignal on port', PORT);
  console.log('API key set:', !!process.env.ANTHROPIC_API_KEY);
  // Test price fetch on startup
  fetchSinglePrice('AAPL').then(p => {
    if (p) console.log('✓ Yahoo Finance working - AAPL:', p.price, p.currency);
    else console.warn('✗ Yahoo Finance not working - prices will be unavailable');
  });
});
