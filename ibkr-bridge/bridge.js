#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge (v2)
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events (JSONL feed)
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and mirrors the AlphaSignal exit spec exactly:
 *
 *     entry        → parent MARKET / US-extended LMT entry (recommended price sizes shares + gates US pre/post):
 *                      • US pre/post: if the live print is at/better than the model entry,
 *                        LMT @ the recommended cap immediately (buy rec 224 / pre 222 →
 *                        LMT 224, fills at ~222). Never MKT-EXT (IB queues those until 09:30).
 *                        Unfilled into 09:28 ET → OPG; keep OPG through the 09:30 auction
 *                        (do not cancel at the bell). After ~2 min of RTH still unfilled → MKT.
 *                      • US RTH first fire: MKT with chase cap; skipped when converting a
 *                        missed pre/OPG so the open print is taken.
 *                      • US fully closed: MOO for next open
 *                      • JP / HK / EU / UK: OPG before the open; hold OPG through the auction
 *                        (~2 min); only then MKT if still unfilled.
 *                      • Unfilled HK/JP still open on the model are re-armed
 *                        (missed Asia opens are chased while the signal is live)
 *                    + STP stop  @ SL   for the FULL quantity  (pre-TP1 an SL hit
 *                      exits the WHOLE position — same as the simulator)
 *                    + LMT TP1   @ TP1  for the partial (half) quantity
 *     TP1 fill     → stop is resized to the runner quantity and raised to
 *                    breakeven (never lower) — mirrors the sim's post-TP1 floor
 *     tsl_update   → stop price ratcheted (modify in place, never loosened)
 *     exit         → cancel all open child orders + flatten any remaining
 *                    position at market. NO ORPHANS: an exited trade always
 *                    ends with zero open orders and zero position.
 *
 *   A reconciliation sweep runs every few minutes as a belt-and-braces pass:
 *   any open order belonging to a closed key is cancelled, and any key flat
 *   in IB but still "open" in state is marked closed.
 *
 * Env:
 *   ALPHASIGNAL_URL      e.g. https://your-app.onrender.com
 *   IBKR_EVENTS_TOKEN    same as AlphaSignal IBKR_EVENTS_TOKEN (optional)
 *   IBKR_HOST            default 127.0.0.1
 *   IBKR_PORT            7497 (TWS paper) or 4002 (Gateway paper)
 *   IBKR_CLIENT_ID       default 17
 *   IBKR_ACCOUNT         paper account id (optional; IB default if unset)
 *   IBKR_DRY_RUN         1 = log only, no orders (default 1)
 *   IBKR_POLL_MS         default 15000
 *   IBKR_NOTIONAL        default 10000 (USD per trade, FX-converted per market)
 *   IBKR_MAX_EVENT_AGE_H default 24 — entry events older than this are skipped
 *                        (prevents replaying stale history on a fresh cursor)
 *   IBKR_ALLOW_NSE       1 = attempt NSE orders (default skip — IB restricts
 *                        NSE for most non-India accounts)
 *   STATE_FILE           cursor + order map path (default ./bridge-state.json)
 *   IBKR_RECON_MS        full reconcile sweep interval (default 900000 = 15 min)
 *   TELEGRAM_BOT_TOKEN   BotFather token — risk alerts + US EOD performance summary
 *   TELEGRAM_CHAT_ID     chat/group id to receive alerts
 *   TELEGRAM_ALERTS      set 0 to disable (default on when token+chat set)
 *   IBKR_EOD_ALERTS      set 0 to disable EOD summary only (default on with Telegram)
 *   IBKR_ALERT_MIN_MS    min gap between identical alerts (default = IBKR_RECON_MS)
 *   IBKR_UNFILLED_ALERT_MIN_MS  unfilled RTH entry age before alert (default 10 min)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { telegramConfigured, sendTelegramAlert } = require('./telegram');

const DRY = process.env.IBKR_DRY_RUN !== '0';
const BASE = String(process.env.ALPHASIGNAL_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.IBKR_EVENTS_TOKEN || '';
const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '7497', 10);
/** Prefer env; else randomize per launch (avoids zombie clientId conflicts). */
const CLIENT_ID = (() => {
  const fromEnv = parseInt(process.env.IBKR_CLIENT_ID || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 20 + Math.floor(Math.random() * 40); // 20–59
})();
const ACCOUNT = process.env.IBKR_ACCOUNT || '';
const POLL_MS = Math.max(5000, parseInt(process.env.IBKR_POLL_MS || '15000', 10));
const NOTIONAL = Math.max(1000, parseInt(process.env.IBKR_NOTIONAL || '10000', 10));
const MAX_EVENT_AGE_MS = Math.max(1, parseFloat(process.env.IBKR_MAX_EVENT_AGE_H || '24')) * 3600 * 1000;
const ALLOW_NSE = process.env.IBKR_ALLOW_NSE === '1';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'bridge-state.json');
/** Full reconcile + risk-alert cadence (default 15 min). */
const SWEEP_MS = Math.max(
  60 * 1000,
  parseInt(process.env.IBKR_RECON_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000)
);
const ALERT_MIN_MS = Math.max(
  60 * 1000,
  parseInt(process.env.IBKR_ALERT_MIN_MS || String(SWEEP_MS), 10) || SWEEP_MS
);
const UNFILLED_ALERT_MIN_MS = Math.max(
  60 * 1000,
  parseInt(process.env.IBKR_UNFILLED_ALERT_MIN_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000)
);
/** EOD Telegram summary after US post-market close (default on with Telegram). */
const EOD_ALERTS = process.env.IBKR_EOD_ALERTS !== '0';
/** Minutes after US post close (20:00 ET / 00:00 UTC DST) to attempt EOD send. */
const EOD_WINDOW_MIN = Math.max(30, parseInt(process.env.IBKR_EOD_WINDOW_MIN || '120', 10) || 120);
/** Force-error tickers: env + error-tickers.txt (AIR.DE / AIR.PA dual-list, etc.).
 *  These win over provenance for flatten + UI classification. */
function loadErrorTradeTickers() {
  const out = new Set(
    String(process.env.IBKR_ERROR_TICKERS || '')
      .split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase())
  );
  try {
    const p = path.join(__dirname, 'error-tickers.txt');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const t = line.replace(/#.*$/, '').trim().toUpperCase();
        if (t) out.add(t);
      }
    }
  } catch (_) { /* optional file */ }
  return out;
}
const ERROR_TRADE_TICKERS = loadErrorTradeTickers();
const ENTRY_RELEASE_HOUR_SGT = Math.max(
  0,
  Math.min(23, parseInt(process.env.PICKS_REFRESH_HOUR_SGT || '6', 10) || 6)
);
function scheduledEntryReleaseAllowed(evt) {
  if (!evt) return false;
  if (evt.userReentry === true || evt.correctiveReentry === true
    || String(evt.reason || '') === 'rearm-model-entry') return true;
  const ts = Date.parse(evt.entryDate || evt.t || 0);
  if (!Number.isFinite(ts)) return false;
  const sgt = new Date(ts + 8 * 60 * 60 * 1000);
  return sgt.getUTCHours() >= ENTRY_RELEASE_HOUR_SGT;
}
function isForceErrorTicker(ticker) {
  const y = normalizeYahooTicker(ticker);
  if (!y) return false;
  if (ERROR_TRADE_TICKERS.has(y)) return true;
  for (const a of yahooAliases(y)) {
    if (ERROR_TRADE_TICKERS.has(a)) return true;
  }
  return false;
}
/** Max adverse slippage vs model entry for US RTH market chase (bps). */
const US_RTH_MAX_CHASE_BPS = Math.max(0, parseInt(process.env.IBKR_US_RTH_MAX_CHASE_BPS || '100', 10) || 100);

/** Match server.js singaporeToDateString — IBKR keys use Asia/Singapore calendar days. */
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

/** Dual-list aliases — same conId identity; authorize by provenance not name. */
const {
  normalizeYahooTicker,
  yahooAliases,
  setHasYahooAlias,
  bloombergTicker,
  yahooSuffixFromIbPrimary
} = require('./listing-aliases.js');

/**
 * IB execDetails sometimes returns coarse integer prices (9988 @124) while
 * orderStatus.avgFillPrice / portfolio averageCost show the true ~123.8.
 */
function pickFillPrice(execPrice, avgFillPrice, lastFillPrice, contract) {
  const ep = Number(execPrice);
  const avg = Number(avgFillPrice);
  const last = Number(lastFillPrice);
  const candidates = [last, avg, ep].filter(x => Number.isFinite(x) && x > 0);
  if (!candidates.length) return ep;
  // Prefer non-integer when exec looks truncated (common on HK/JP).
  const coarse = Number.isFinite(ep) && Number.isInteger(ep) && ep >= 10;
  if (coarse) {
    if (Number.isFinite(last) && last > 0 && !Number.isInteger(last)) return last;
    if (Number.isFinite(avg) && avg > 0 && !Number.isInteger(avg)) return avg;
  }
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(ep) && ep > 0) return ep;
  return avg;
}

function log(...a) {
  const line = [new Date().toISOString(), ...a].map(x => (typeof x === 'string' ? x : String(x))).join(' ');
  // Always append to the daily log (cmd >> redirection block-buffers Node stdout
  // so the bridge can look "dead" for minutes while still running).
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `bridge-${day}.log`), line + '\n');
  } catch (_) {}
  if (process.stdout.isTTY) {
    try { process.stdout.write(line + '\n'); } catch (_) {}
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { since: 0, byKey: {} }; }
}
function saveState(st) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

function fetchJson(urlPath) {
  const u = new URL(BASE + urlPath);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Bad JSON ${res.statusCode}: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

/** Direct Yahoo v7 pre/post print — used when Render /api/prices is not yet deployed. */
function fetchYahooExtQuote(ticker) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://finance.yahoo.com/',
    Origin: 'https://finance.yahoo.com'
  };
  const urls = [
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(ticker),
    'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(ticker)
  ];
  function one(url) {
    return new Promise((resolve) => {
      const req = https.get(url, { headers }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try {
            const q = JSON.parse(raw)?.quoteResponse?.result?.[0] || {};
            resolve({
              pre: Number(q.preMarketPrice) || 0,
              post: Number(q.postMarketPrice) || 0,
              last: Number(q.regularMarketPrice) || 0,
              state: String(q.marketState || '').toUpperCase()
            });
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { try { req.destroy(); } catch (_) {} resolve(null); });
    });
  }
  return (async () => {
    for (const url of urls) {
      const y = await one(url);
      if (y && (y.pre > 0 || y.post > 0)) return y;
    }
    return null;
  })();
}

function postJson(urlPath, body) {
  const u = new URL(BASE + urlPath);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Bad JSON ${res.statusCode}: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

// ── Contract mapping ─────────────────────────────────────────────────────────
/**
 * Yahoo continuous futures (=F) → IB root + exchange + default multiplier.
 * Front month is resolved live via reqContractDetails.
 */
const YAHOO_FUTURES = {
  'GC=F': { symbol: 'GC', exchange: 'COMEX', currency: 'USD', multiplier: 100,   tick: 0.1,    market: 'GLOBE' },
  'SI=F': { symbol: 'SI', exchange: 'COMEX', currency: 'USD', multiplier: 5000,  tick: 0.005,  market: 'GLOBE' },
  'HG=F': { symbol: 'HG', exchange: 'COMEX', currency: 'USD', multiplier: 25000, tick: 0.0005, market: 'GLOBE' },
  'PL=F': { symbol: 'PL', exchange: 'NYMEX', currency: 'USD', multiplier: 50,    tick: 0.1,    market: 'GLOBE' },
  'PA=F': { symbol: 'PA', exchange: 'NYMEX', currency: 'USD', multiplier: 100,   tick: 0.05,   market: 'GLOBE' },
  'CL=F': { symbol: 'CL', exchange: 'NYMEX', currency: 'USD', multiplier: 1000,  tick: 0.01,   market: 'GLOBE' },
  'BZ=F': { symbol: 'BZ', exchange: 'NYMEX', currency: 'USD', multiplier: 1000,  tick: 0.01,   market: 'GLOBE' },
  'NG=F': { symbol: 'NG', exchange: 'NYMEX', currency: 'USD', multiplier: 10000, tick: 0.001,  market: 'GLOBE' },
  'ES=F': { symbol: 'ES', exchange: 'CME',   currency: 'USD', multiplier: 50,    tick: 0.25,   market: 'GLOBE' },
  'NQ=F': { symbol: 'NQ', exchange: 'CME',   currency: 'USD', multiplier: 20,    tick: 0.25,   market: 'GLOBE' },
  'YM=F': { symbol: 'YM', exchange: 'CBOT',  currency: 'USD', multiplier: 5,     tick: 1,      market: 'GLOBE' },
  'RTY=F':{ symbol: 'RTY',exchange: 'CME',   currency: 'USD', multiplier: 50,    tick: 0.1,    market: 'GLOBE' },
  'ZN=F': { symbol: 'ZN', exchange: 'CBOT',  currency: 'USD', multiplier: 1000,  tick: 0.015625, market: 'GLOBE' }
};

/** Yahoo crypto → IB CRYPTO (PAXOS). */
const YAHOO_CRYPTO = {
  'BTC-USD': { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', market: 'CRYPTO', lotHint: 0.0001 },
  'ETH-USD': { symbol: 'ETH', exchange: 'PAXOS', currency: 'USD', market: 'CRYPTO', lotHint: 0.001 }
};

/** Yahoo-style ticker → IB contract stub. Live orders are qualified by resolveInstrument(). */
function toContract(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (YAHOO_FUTURES[t]) {
    const f = YAHOO_FUTURES[t];
    return {
      yahooTicker: t,
      symbol: f.symbol,
      secType: 'FUT',
      exchange: f.exchange,
      currency: f.currency,
      multiplier: f.multiplier,
      tick: f.tick,
      market: f.market,
      lotHint: 1,
      needsFrontMonth: true
    };
  }
  if (YAHOO_CRYPTO[t]) {
    const c = YAHOO_CRYPTO[t];
    return {
      yahooTicker: t,
      symbol: c.symbol,
      secType: 'CRYPTO',
      exchange: c.exchange,
      currency: c.currency,
      market: c.market,
      lotHint: c.lotHint || 0.0001,
      crypto: true
    };
  }
  if (t.includes('=F') || t.endsWith('-USD')) {
    // Unknown continuous future / crypto pair — leave null (logged at place).
    return null;
  }
  if (t.endsWith('.NS') || t.endsWith('.BO')) {
    if (!ALLOW_NSE) return null;                                      // IB NSE restriction
    return { symbol: t.replace(/\.(NS|BO)$/, ''), secType: 'STK', exchange: 'NSE', currency: 'INR' };
  }
  // SMART routing everywhere (primaryExch pins the listing) — direct routing
  // trips TWS's "higher trade fees" API precaution and orders get discarded.
  if (t.endsWith('.L')) {
    // Yahoo drops punctuation from some LSE symbols. BAE Systems is BA. on
    // LSE/IB; bare BA is Boeing's US symbol and IB rejects BA/LSE/GBP.
    const base = t.replace(/\.L$/, '');
    const ibSymbol = t === 'BA.L' ? 'BA.' : base;
    return { symbol: ibSymbol, localSymbol: t === 'BA.L' ? 'BA.' : undefined, secType: 'STK', exchange: 'SMART', primaryExch: 'LSE', currency: 'GBP', penceQuoted: true, market: 'LSE', yahooTicker: t, bloomberg: bloombergTicker(t) };
  }
  if (t.endsWith('.DE')) return { symbol: t.replace(/\.DE$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'IBIS', currency: 'EUR', market: 'XETRA', yahooTicker: t, bloomberg: bloombergTicker(t), listingCountry: 'Germany' };
  if (t.endsWith('.PA')) return { symbol: t.replace(/\.PA$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'SBF',  currency: 'EUR', market: 'EURONEXT', yahooTicker: t, bloomberg: bloombergTicker(t), listingCountry: 'France' };
  if (t.endsWith('.AS')) return { symbol: t.replace(/\.AS$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'AEB',  currency: 'EUR', market: 'EURONEXT', yahooTicker: t, bloomberg: bloombergTicker(t) };
  if (t.endsWith('.MI')) return { symbol: t.replace(/\.MI$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'BVME', currency: 'EUR', market: 'EURONEXT', yahooTicker: t, bloomberg: bloombergTicker(t) };
  if (t.endsWith('.HK')) return { symbol: String(parseInt(t.replace(/\.HK$/, ''), 10)), secType: 'STK', exchange: 'SMART', primaryExch: 'SEHK', currency: 'HKD', lotHint: 100, market: 'HK', yahooTicker: t, bloomberg: bloombergTicker(t) };
  if (t.endsWith('.T'))  return { symbol: t.replace(/\.T$/, ''),  secType: 'STK', exchange: 'SMART', primaryExch: 'TSEJ', currency: 'JPY', lotHint: 100, market: 'JP', yahooTicker: t, bloomberg: bloombergTicker(t) };
  if (t.includes('.'))   return null;                                 // unknown suffix
  // Yahoo uses BRK-B; IB's local symbol is "BRK B". Sending "BRK-B" is error 200.
  const US_SHARE_CLASS = {
    'BRK-B': 'BRK B', 'BRK.B': 'BRK B', BRKB: 'BRK B',
    'BRK-A': 'BRK A', 'BRK.A': 'BRK A', BRKA: 'BRK A',
    'BF-B': 'BF B', 'BF.B': 'BF B'
  };
  const symbol = US_SHARE_CLASS[t] || t;
  return {
    symbol, secType: 'STK', exchange: 'SMART', currency: 'USD',
    primaryExch: 'NYSE', usRth: true, market: 'US', yahooTicker: t
  };
}

function riskFindingsFingerprint(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return list.map(f => f.fingerprint || (f.code + ':' + f.text)).sort().join('|') || 'ok';
}

/**
 * Session phase for the listing. Approximate local RTH windows in UTC —
 * used for MOO vs MKT and to stamp fills as Market / Pre / Post.
 * Returns 'pre' | 'rth' | 'post' | 'lunch' | 'closed'.
 */
function sessionPhase(contract, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow = d.getUTCDay(); // 0=Sun
  if (dow === 0 || dow === 6) return 'closed';
  const m = contract.market || (contract.usRth ? 'US' : 'OTHER');
  // Windows are [open, close) in UTC minutes. Summer EU (CEST=UTC+2) used as
  // the default European window — winter is 60 min later, still correct for
  // "are we in cash hours?" decisions within a few minutes of the open.
  const windows = {
    // US: pre 04:00–09:30 ET, RTH 09:30–16:00, post 16:00–20:00 ET (UTC-4 DST)
    US:       { open: 13 * 60 + 30, close: 20 * 60, preOpen: 8 * 60, postClose: 24 * 60 },
    JP:       { open: 0 * 60,       close: 6 * 60 },                     // 09:00–15:00 JST
    // HK: 09:30–12:00 & 13:00–16:00 HKT (lunch 12:00–13:00 — IB rejects many orders)
    HK:       { open: 1 * 60 + 30, close: 8 * 60, lunchStart: 4 * 60, lunchEnd: 5 * 60 },
    XETRA:    { open: 7 * 60,       close: 15 * 60 + 30 },               // 09:00–17:30 CEST
    EURONEXT: { open: 7 * 60,       close: 15 * 60 + 30 },
    LSE:      { open: 7 * 60,       close: 15 * 60 + 30 },               // 08:00–16:30 BST
    // CME Globex / crypto: nearly 24h Sun–Fri. Treat weekday as RTH; Sat closed;
    // Sun before ~22:00 UTC still closed (Globex reopen ~6pm ET Sunday).
    GLOBE:    { open: 0, close: 24 * 60 },
    CRYPTO:   { open: 0, close: 24 * 60 }
  };
  const w = windows[m] || windows.XETRA;
  if (m === 'GLOBE' || m === 'CRYPTO') {
    if (dow === 6) return 'closed';
    if (dow === 0 && utcMin < 22 * 60) return 'closed';
    return 'rth';
  }
  if (m === 'US') {
    if (utcMin >= w.open && utcMin < w.close) return 'rth';
    if (utcMin >= (w.preOpen || 0) && utcMin < w.open) return 'pre';
    if (utcMin >= w.close && utcMin < (w.postClose || 24 * 60)) return 'post';
    return 'closed';
  }
  if (m === 'HK' && w.lunchStart != null
    && utcMin >= w.lunchStart && utcMin < w.lunchEnd) return 'lunch';
  if (utcMin >= w.open && utcMin < w.close) return 'rth';
  // Before open same calendar day → pre (MOO queues for today's auction)
  if (utcMin < w.open) return 'pre';
  return 'closed'; // after close → MOO for tomorrow's open
}

/** Keep OPG live through the opening auction; do not cancel at the bell. */
const AUCTION_HOLD_MIN = 2;

/** Minutes until US 09:30 ET (DST window in sessionPhase). Negative = already RTH. */
function minutesUntilUsRth(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (13 * 60 + 30) - utcMin;
}

/** Minutes since US 09:30 ET (DST window). Negative = still pre. */
function minutesSinceUsRth(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin - (13 * 60 + 30);
}

/** Minutes since Xetra / Euronext / LSE cash open (07:00 UTC in summer). */
function minutesSinceEuRth(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin - (7 * 60);
}

/** Human label for fill/session stamps on the IBKR tab. */
function sessionLabel(phase) {
  return ({
    rth: 'Market', pre: 'Pre-market', post: 'Post-market',
    lunch: 'Lunch', closed: 'After hours'
  })[phase] || phase || '—';
}

/** True when extended-hours quote is at/better than the model entry. */
function premarketFavorable(side, entryPx, quotePx) {
  const e = Number(entryPx);
  const q = Number(quotePx);
  if (!(e > 0) || !(q > 0)) return false;
  const sell = String(side || '').toLowerCase() === 'sell';
  return sell ? q >= e : q <= e;
}

/** Parent styles that were meant to work in US pre/post (LMT-EXT is the real one). */
function isUsExtStyle(style) {
  return style === 'LMT-EXT' || style === 'MKT-EXT';
}

/** Marketable pre/post LMT at the model cap. Rec 224 / pre 222 → LMT 224, which
 *  still fills at ~222. A tight LMT-at-print misses on a 1-tick move. */
function extendedFillLimit(side, entryPx, quotePx, contract) {
  const e = Number(entryPx);
  if (!(e > 0)) return null;
  const sell = String(side || '').toLowerCase() === 'sell';
  return roundPx(e, contract, sell ? 'down' : 'up');
}

/**
 * Parent entry order: MOO / RTH MKT / US extended LMT (price-gated).
 * opts: { side, entryPx, quotePx } — quotePx gates US pre/extended only.
 */
function parentEntrySpec(contract, action, qty, opts = {}) {
  const phase = opts.phaseOverride || sessionPhase(contract);
  const side = opts.side || (String(action).toUpperCase() === 'SELL' ? 'sell' : 'buy');
  const entryPx = Number(opts.entryPx);
  const quotePx = Number(opts.quotePx);
  // Futures / crypto on Globex & PAXOS — MKT while the venue is open.
  if (contract.secType === 'FUT' || contract.secType === 'CRYPTO' || contract.market === 'GLOBE' || contract.market === 'CRYPTO') {
    if (phase === 'closed') {
      return { defer: true, entryStyle: 'DEFER-GLOBE-CLOSED', action, totalQuantity: qty };
    }
    return {
      orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY',
      outsideRth: true, transmit: false, entryStyle: 'MKT-GLOBE'
    };
  }
  // IB SMART often rejects orderType 'MOO' (error 321). The portable form is
  // MKT + tif OPG (submit to the opening auction).
  if (contract.usRth) {
    if (opts.forceOpg && phase !== 'rth') {
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: false, transmit: false, entryStyle: 'OPG' };
    }
    if (phase === 'rth') {
      // Missed pre-market / OPG still working → take the open/RTH print even if
      // it is worse than the model entry. Chase cap only applies to a late first
      // RTH fire (FSLR 248 vs 236.8), not this handoff.
      if (!opts.skipChase && entryPx > 0 && quotePx > 0) {
        const sell = side === 'sell';
        const adverseBps = sell
          ? ((entryPx - quotePx) / entryPx) * 10000
          : ((quotePx - entryPx) / entryPx) * 10000;
        if (adverseBps > US_RTH_MAX_CHASE_BPS) {
          return {
            defer: true, entryStyle: 'SKIP-CHASE', action, totalQuantity: qty,
            skipReason: 'us-rth-chase ' + adverseBps.toFixed(0) + 'bps > ' + US_RTH_MAX_CHASE_BPS
          };
        }
      }
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: false, transmit: false, entryStyle: 'MKT' };
    }
    if (phase === 'pre' || phase === 'post') {
      // Premarket / post: only lift if quote is at or better than recommendation.
      // Must be LMT — IB SMART ignores outsideRth on MKT (2109 / 399) and holds
      // until 09:30, which is NOT a pre-market fill.
      if (premarketFavorable(side, entryPx, quotePx)) {
        const lmt = extendedFillLimit(side, entryPx, quotePx, contract);
        return {
          orderType: 'LMT', action, totalQuantity: qty, lmtPrice: lmt,
          tif: 'DAY', outsideRth: true, transmit: false, entryStyle: 'LMT-EXT'
        };
      }
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: false, transmit: false, entryStyle: 'OPG' };
    }
    // Fully closed (overnight before US pre) → next cash open
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: false, transmit: false, entryStyle: 'OPG' };
  }
  if (phase === 'rth') {
    // Late board after the cash open — take market now (HK/JP/EU/UK)
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: false, transmit: false, entryStyle: 'MKT' };
  }
  if (phase === 'lunch') {
    // SEHK midday break — do not submit (IB often returns error 200).
    return { defer: true, entryStyle: 'DEFER-LUNCH', action, totalQuantity: qty };
  }
  if (contract.market === 'LSE') {
    // LSE SMART rejects MKT+OPG for some listings (BA/ LN: IB error 201).
    // Queue a DAY limit at the recommendation price for the cash open instead.
    // A buy cannot fill above the model entry; a sell cannot fill below it.
    if (entryPx > 0) {
      return {
        orderType: 'LMT', action, totalQuantity: qty,
        lmtPrice: roundPx(entryPx, contract, side === 'sell' ? 'down' : 'up'),
        tif: 'DAY', outsideRth: false, transmit: false, entryStyle: 'LMT-OPEN'
      };
    }
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: false, transmit: false, entryStyle: 'MKT-OPEN' };
  }
  // Pre-open or after previous close → opening auction (EU/UK/Asia)
  return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: false, transmit: false, entryStyle: 'OPG' };
}

// ── FX sizing ────────────────────────────────────────────────────────────────
// NOTIONAL is USD. Convert to the contract currency so a ¥2,800 or 450p stock
// gets a genuine ~$10k position instead of 3 shares.
const FX_SYMBOLS = { JPY: 'USDJPY=X', HKD: 'USDHKD=X', INR: 'USDINR=X', EUR: 'EURUSD=X', GBP: 'GBPUSD=X' };
const _fxCache = { at: 0, rates: {} };
async function usdToCurrency(ccy) {
  if (!ccy || ccy === 'USD') return 1;
  if (Date.now() - _fxCache.at > 3600 * 1000) {
    try {
      const syms = Object.values(FX_SYMBOLS).join(',');
      const j = await fetchJson('/api/prices?symbols=' + encodeURIComponent(syms));
      const px = {};
      for (const [k, v] of Object.entries(j || {})) px[k] = Number(v && (v.price ?? v.regularMarketPrice ?? v)) || null;
      _fxCache.rates = px;
      _fxCache.at = Date.now();
    } catch (e) { log('FX fetch failed (sizing falls back to 1:1):', e.message); }
  }
  const r = _fxCache.rates || {};
  switch (ccy) {
    case 'JPY': return r['USDJPY=X'] || 150;
    case 'HKD': return r['USDHKD=X'] || 7.8;
    case 'INR': return r['USDINR=X'] || 84;
    case 'EUR': return r['EURUSD=X'] ? 1 / r['EURUSD=X'] : 0.92;
    case 'GBP': return r['GBPUSD=X'] ? 1 / r['GBPUSD=X'] : 0.78;
    default: return 1;
  }
}

/** Whole-share / contract / crypto-qty split of the FX-adjusted notional. */
async function shareSplit(entry, contract, lotOverride) {
  const e = Number(entry);
  if (!(e > 0)) return { total: 0, sold: 0, runner: 0 };
  const lot = Math.max(Number(lotOverride || contract.lotHint) || 1, contract.secType === 'CRYPTO' ? 1e-8 : 1);

  // Futures: size by contract value (price × multiplier). Paper always takes at
  // least 1 contract so HG/CL etc. still execute when $10k < 1 contract value.
  if (contract.secType === 'FUT') {
    const mult = Math.max(1, Number(contract.multiplier) || 1);
    const contractUsd = e * mult;
    let total = Math.floor(NOTIONAL / contractUsd);
    if (total < 1) {
      total = 1;
      log('futures sizing: notional $' + NOTIONAL + ' < 1×' + contract.symbol
        + ' (~$' + Math.round(contractUsd) + ') — forcing 1 contract');
    }
    let sold = Math.floor(total / 2);
    if (sold < 1 && total >= 2) sold = 1;
    if (total === 1) sold = 0; // whole position is the runner
    return { total, sold, runner: total - sold };
  }

  // Crypto: fractional qty allowed on PAXOS.
  if (contract.secType === 'CRYPTO') {
    const raw = NOTIONAL / e;
    const step = lot > 0 && lot < 1 ? lot : 0.0001;
    let total = Math.floor(raw / step) * step;
    total = +total.toFixed(8);
    if (total < step) {
      total = step;
      log('crypto sizing: forcing min lot', step, 'for', contract.symbol);
    }
    let sold = Math.floor((total / 2) / step) * step;
    sold = +sold.toFixed(8);
    if (sold < step) sold = 0;
    return { total, sold, runner: +(total - sold).toFixed(8) };
  }

  let localNotional = NOTIONAL * await usdToCurrency(contract.currency);
  if (contract.penceQuoted) localNotional *= 100; // LSE quotes in pence
  let total = Math.floor(localNotional / e);
  total = Math.floor(total / lot) * lot;
  if (total < lot) return { total: 0, sold: 0, runner: 0 };
  let sold = Math.floor(total / 2 / lot) * lot;
  if (sold < lot) sold = 0; // too small to split — runner carries everything
  return { total, sold, runner: total - sold };
}

function hkTickSize(px) {
  const a = Math.abs(Number(px) || 0);
  if (a < 0.25) return 0.001;
  if (a < 0.5) return 0.005;
  if (a < 10) return 0.01;
  if (a < 20) return 0.02;
  if (a < 100) return 0.05;
  if (a < 200) return 0.1;
  if (a < 500) return 0.2;
  if (a < 1000) return 0.5;
  if (a < 2000) return 1;
  return 2;
}

/** Round to exchange tick. HK uses SEHK price bands; others keep legacy steps.
 *  dir: 'up' | 'down' | undefined (nearest) — use up/down for stop/TP validity. */
function roundPx(x, contract, dir) {
  const n = Number(x);
  if (!Number.isFinite(n)) return n;
  if (contract && (contract.secType === 'FUT' || contract.tick > 0)) {
    const tick = Number(contract.tick) || 0.01;
    const dp = tick >= 1 ? 0 : Math.min(8, (String(tick).split('.')[1] || '').length);
    let stepped;
    if (dir === 'down') stepped = Math.floor(n / tick + 1e-12) * tick;
    else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-12) * tick;
    else stepped = Math.round(n / tick) * tick;
    return +stepped.toFixed(dp);
  }
  if (contract && contract.market === 'HK') {
    const tick = hkTickSize(n);
    const dp = tick >= 1 ? 0 : (String(tick).split('.')[1] || '').length;
    let stepped;
    if (dir === 'down') stepped = Math.floor(n / tick + 1e-9) * tick;
    else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-9) * tick;
    else stepped = Math.round(n / tick) * tick;
    return +stepped.toFixed(dp);
  }
  return n >= 1000 ? +n.toFixed(0) : n >= 100 ? +n.toFixed(1) : +n.toFixed(2);
}

/**
 * Build a placeable IB contract from a position snapshot.
 * Position events often omit primaryExch; SMART + bare "6690" then returns
 * error 200 (no security definition). Pin the listing exchange from currency.
 */
/** Attach market/usRth so sessionPhase does not fall through to XETRA for US names. */
function enrichSessionMeta(c) {
  if (!c) return c;
  if (c.secType === 'FUT' || c.market === 'GLOBE') {
    c.market = 'GLOBE';
    c.usRth = false;
    return c;
  }
  if (c.secType === 'CRYPTO' || c.market === 'CRYPTO') {
    c.market = 'CRYPTO';
    c.usRth = false;
    return c;
  }
  const ccy = String(c.currency || '');
  if (ccy === 'USD' || c.usRth) {
    c.usRth = true;
    c.market = 'US';
  } else if (ccy === 'HKD') c.market = 'HK';
  else if (ccy === 'JPY') c.market = 'JP';
  else if (ccy === 'GBP') c.market = 'LSE';
  else if (ccy === 'EUR') {
    const suf = yahooSuffixFromIbPrimary(c.primaryExch);
    c.market = (suf === '.PA' || suf === '.AS' || suf === '.MI') ? 'EURONEXT' : 'XETRA';
  }
  return c;
}

function orderContractFromPos(c) {
  if (!c) return null;
  if (c.secType === 'FUT') {
    const out = {
      secType: 'FUT',
      symbol: String(c.symbol || ''),
      exchange: c.exchange || 'COMEX',
      currency: c.currency || 'USD',
      lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth,
      multiplier: c.multiplier != null ? String(c.multiplier) : undefined,
      tradingClass: c.tradingClass || undefined,
      localSymbol: c.localSymbol || undefined
    };
    const conId = Number(c.conId);
    if (conId > 0) out.conId = conId;
    return enrichSessionMeta(Object.assign({}, c, out));
  }
  if (c.secType === 'CRYPTO') {
    const out = {
      secType: 'CRYPTO',
      symbol: String(c.symbol || ''),
      exchange: c.exchange || 'PAXOS',
      currency: c.currency || 'USD'
    };
    const conId = Number(c.conId);
    if (conId > 0) out.conId = conId;
    return enrichSessionMeta(Object.assign({}, c, out));
  }
  const out = {
    secType: c.secType || 'STK',
    exchange: 'SMART',
    currency: c.currency || 'USD'
  };
  const conId = Number(c.conId);
  if (conId > 0) out.conId = conId;
  if (c.symbol != null && c.symbol !== '') out.symbol = String(c.symbol);
  if (c.localSymbol) out.localSymbol = String(c.localSymbol);
  if (c.primaryExch) {
    out.primaryExch = c.primaryExch;
  } else if (out.currency === 'HKD') {
    out.primaryExch = 'SEHK';
  } else if (out.currency === 'JPY') {
    out.primaryExch = 'TSEJ';
  } else if (out.currency === 'EUR') {
    // Never invent IBIS (GY / .DE). A French listing (FP / .PA) with omitted
    // primaryExch would be remapped onto Xetra. conId is enough for IB.
    if (!(conId > 0)) out.primaryExch = 'IBIS';
  } else if (out.currency === 'GBP') {
    out.primaryExch = 'LSE';
  } else if (out.currency === 'USD') {
    out.primaryExch = 'NASDAQ';
  }
  return enrichSessionMeta(out);
}

/** Placeable IB contract object for placeOrder. */
function placeableContract(contract) {
  if (!contract) return null;
  if (contract.secType === 'FUT') {
    const oc = {
      symbol: String(contract.symbol),
      secType: 'FUT',
      exchange: contract.exchange || 'COMEX',
      currency: contract.currency || 'USD',
      lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
      multiplier: contract.multiplier != null ? String(contract.multiplier) : undefined
    };
    if (contract.conId > 0) oc.conId = Number(contract.conId);
    if (contract.localSymbol) oc.localSymbol = String(contract.localSymbol);
    if (contract.tradingClass) oc.tradingClass = String(contract.tradingClass);
    return oc;
  }
  if (contract.secType === 'CRYPTO') {
    const oc = {
      symbol: String(contract.symbol),
      secType: 'CRYPTO',
      exchange: contract.exchange || 'PAXOS',
      currency: contract.currency || 'USD'
    };
    if (contract.conId > 0) oc.conId = Number(contract.conId);
    return oc;
  }
  if (contract.conId > 0) {
    return {
      conId: Number(contract.conId),
      symbol: contract.symbol != null ? String(contract.symbol) : undefined,
      localSymbol: contract.localSymbol || undefined,
      secType: contract.secType || 'STK',
      exchange: contract.market === 'HK' ? 'SEHK' : 'SMART',
      primaryExch: contract.primaryExch,
      currency: contract.currency
    };
  }
  return orderContractFromPos(contract) || contract;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | dryRun=${DRY} | notional=$${NOTIONAL}`);
  log(`Reconcile every ${(SWEEP_MS / 60000).toFixed(0)}m | Telegram alerts=${telegramConfigured() ? 'ON' : 'OFF (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`
    + (telegramConfigured() && EOD_ALERTS ? ' | EOD summary after US post-close' : ''));
  if (!state.alertMeta || typeof state.alertMeta !== 'object') {
    state.alertMeta = { lastFp: '', lastAt: 0, lastHadIssues: false, eodSentDay: '' };
  }

  let ib = null;
  let EventName = null;
  let nextOrderId = 1;
  const orderFills = {}; // orderId -> filled qty (from orderStatus) — LOST on restart
  const orderAvgFill = new Map(); // orderId -> { avgFillPrice, lastFillPrice, filled }
  // Live positions from IB (survives restarts, unlike orderFills). Keyed
  // "SYMBOL|CCY" -> { pos, contract }. Populated by the reqPositions subscription.
  const posMap = new Map();
  let positionsReady = false; // set once IB's initial position snapshot lands
  let forceReconcile = false; // set on positionEnd so Asia re-arms don't wait 5m
  const posKeyOf = c => {
    if (!c) return '';
    if (c.secType === 'FUT' && c.lastTradeDateOrContractMonth) {
      return `${String(c.symbol).toUpperCase()}|${c.lastTradeDateOrContractMonth}|${c.currency || 'USD'}`;
    }
    if (c.secType === 'CRYPTO') {
      return `${String(c.symbol).toUpperCase()}|CRYPTO|${c.currency || 'USD'}`;
    }
    return `${String(c.symbol).toUpperCase()}|${c.currency}`;
  };
  const _flattenTried = new Map(); // pk -> last reconcile-flatten attempt ts
  const _orphanFlattenedConIds = new Set(); // conIds we sold as "IB-only orphan"
  // Persist debounce across restarts (in-memory Map was resetting to 1/2 every boot).
  if (!state.unauthStreak || typeof state.unauthStreak !== 'object') state.unauthStreak = {};
  const _cancelWaiters = new Map(); // orderId -> { resolve, timer }
  const portfolioAvgCost = new Map(); // normalized yahoo -> averageCost from IB
  const lotCache = new Map(); // posKey -> board lot
  let nextDetailsId = 900000;
  let nextExecHistId = 910000;
  let nextPnlReqId = 880001;
  // Paper account cash / equity from IB (updateAccountValue + reqPnL).
  const accountSnap = {
    account: ACCOUNT || '',
    currency: 'USD',
    at: null,
    netLiquidation: null,
    availableFunds: null,
    buyingPower: null,
    totalCashValue: null,
    previousDayEquity: null,
    startingBalance: null,
    equityWithLoan: null,
    grossPositionValue: null,
    excessLiquidity: null,
    realizedPnl: null,
    unrealizedPnl: null,
    dailyPnl: null,
    accruedCash: null,
    accruedDividend: null,
    dividendReceivable: null,
    initMarginReq: null,
    maintMarginReq: null,
    fullInitMarginReq: null,
    fullMaintMarginReq: null,
    cushion: null,
    marginsUsed: null
  };
  const commissionByExec = new Map(); // execId -> { commission, currency, realizedPNL }
  // Durable charge/dividend events queued for AlphaSignal (ibkr_charges.jsonl).
  if (!Array.isArray(state.pendingCharges)) state.pendingCharges = [];
  const _lastChargeVal = Object.create(null); // tag -> last numeric value
  /** Queue a ledger line when AccruedDividend / receivable move.
   *  AccruedCash is an account-level IB tag (interest / borrow). Reconnects
   *  flip BASE vs USD and spam ±$300 Δ rows that are not per-equity fees —
   *  never queue those. Live AccruedCash is shown from the account snapshot. */
  function noteChargeMove(type, label, value, currency, signHint) {
    if (type === 'accrued_cash') return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const key = type;
    const prev = _lastChargeVal[key];
    // First observation: seed only (balances already shown via account snapshot).
    if (prev == null) {
      _lastChargeVal[key] = n;
      return;
    }
    const delta = +(n - prev).toFixed(6);
    _lastChargeVal[key] = n;
    if (Math.abs(delta) < 1e-6) return;
    if ((type === 'dividend' || type === 'dividend_receivable') && Math.abs(delta) < 0.05) return;
    const isIncome = type === 'dividend' || type === 'dividend_receivable'
      || (signHint === 'income');
    state.pendingCharges = state.pendingCharges || [];
    state.pendingCharges.push({
      id: type + '-' + Date.now() + '-' + Math.abs(delta).toFixed(4),
      type,
      label: label + ' (Δ)',
      amount: delta,
      currency: currency || 'USD',
      income: !!isIncome,
      accountLevel: false,
      time: new Date().toISOString()
    });
    saveState(state);
    log('charge event', type, delta, currency || 'USD');
  }
  function takePendingCharges() {
    const raw = Array.isArray(state.pendingCharges) ? state.pendingCharges.slice() : [];
    const batch = raw.filter(c => !/accrued_cash/i.test(String(c && c.type || '')));
    if (!raw.length) return [];
    state.pendingCharges = [];
    saveState(state);
    return batch;
  }
  function restorePendingCharges(batch) {
    if (!Array.isArray(batch) || !batch.length) return;
    state.pendingCharges = (state.pendingCharges || []).concat(batch);
    saveState(state);
  }
  // Live IBKR market data for MTM (posted to AlphaSignal every ~10s).
  const mktById = new Map(); // reqId -> { ticker, last, bid, ask, close }
  const mktSubscribed = new Set(); // AlphaSignal ticker already subscribed
  // Account portfolio marks from IB (same marks TWS shows) — does NOT need a
  // separate live market-data stream (avoids error 10197 competing session).
  const portfolioMarks = new Map(); // yahooTicker -> { price, at, unrealizedPNL }
  let nextMktId = 1;
  /** Active reqExecutions id → buffer historical execs for exit recovery. */
  let _execHistReqId = null;
  let _execHistBuf = [];
  let lastExecRecoverAt = 0;

  function nid() { return nextOrderId++; }

  function ibSignedQtyForYahoo(ticker) {
    const aliases = yahooAliases(ticker);
    let total = 0;
    for (const [, { pos, contract }] of posMap) {
      const y = normalizeYahooTicker(yahooFromContract(contract) || '');
      if (!y) continue;
      if (aliases.has(y)) total += Number(pos) || 0;
    }
    return total;
  }

  function formatIbExecFilterTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '  ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function parseIbExecTime(t) {
    // IB: "yyyyMMdd  HH:mm:ss" or ISO
    const s = String(t || '').trim();
    if (!s) return NaN;
    const iso = Date.parse(s);
    if (Number.isFinite(iso)) return iso;
    const m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  // Declared before IB error handler — early connect errors must not hit a TDZ.
  let mdType = Math.max(1, Math.min(4, parseInt(process.env.IBKR_MARKET_DATA_TYPE || '3', 10) || 3));
  let mdFellBack = false;
  let mdCompeteLogged = false;

  // Single-connection guard: reuse last successful clientId unless env pinned.
  let activeClientId = CLIENT_ID;
  if (!process.env.IBKR_CLIENT_ID && Number(state.clientId) > 0) {
    activeClientId = Number(state.clientId);
  }

  if (!DRY) {
    const stoqey = require('@stoqey/ib');
    EventName = stoqey.EventName;
    ib = new stoqey.IBApi({ host: HOST, port: PORT, clientId: activeClientId });
    ib.on(EventName.error, (err, code, reqId) => {
      // 2104/2106/2158 are benign "market data farm OK" notices
      if ([2104, 2106, 2107, 2158].includes(Number(code))) return;
      // 10197: IB allows only one live market-data consumer per user. TWS/Gateway
      // UI often holds it — tick streams fail. Portfolio marks (updatePortfolio)
      // still work and are the primary MTM source.
      if ([10197, 354].includes(Number(code))) {
        if (mdType !== 3 && !mdFellBack) {
          mdFellBack = true;
          try {
            ib.reqMarketDataType(3);
            mdType = 3;
            log('marketDataType switched to 3 (delayed) after error', code);
            resubscribeAllMkt('delayed-fallback');
          } catch (_) {}
        } else if (!mdCompeteLogged) {
          mdCompeteLogged = true;
          log('IB error', code, '— tick stream blocked (competing live MD); using account portfolio marks for MTM');
        }
        return;
      }
      log('IB error', code, 'reqId=' + reqId, err && err.message ? err.message : err);
      if (Number(code) === 200 || Number(code) === 201) {
        for (const [key, row] of Object.entries(state.byKey || {})) {
          if (!row || row.closed || row.entryFilled) continue;
          if (row.parentId !== reqId && row.stopId !== reqId && row.tp1Id !== reqId) continue;
          row.contractRejected = true;
          row.updated = new Date().toISOString();
          saveState(state);
          forceReconcile = true;
          log('IB entry rejected — will retry', key, row.ticker, 'code=' + code);
        }
      }
    });
    ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice) => {
      orderFills[orderId] = Number(filled) || 0;
      const avg = Number(avgFillPrice);
      const last = Number(lastFillPrice);
      if ((Number.isFinite(avg) && avg > 0) || (Number.isFinite(last) && last > 0)) {
        orderAvgFill.set(Number(orderId), {
          avgFillPrice: Number.isFinite(avg) && avg > 0 ? avg : null,
          lastFillPrice: Number.isFinite(last) && last > 0 ? last : null,
          filled: Number(filled) || 0
        });
      }
      onOrderStatus(orderId, status, Number(filled) || 0, avg);
    });
    // Real executions → queue a report for the AlphaSignal site (IBKR tab).
    ib.on(EventName.execDetails, (reqId, contract, exec) => {
      try {
        const orderId = Number(exec.orderId);
        const oa = orderAvgFill.get(orderId) || {};
        const px = pickFillPrice(exec.price, oa.avgFillPrice, oa.lastFillPrice, contract);
        // Historical pull buffer (reqExecutions) — matched later in recoverMissingExitFills.
        if (_execHistReqId != null && Number(reqId) === Number(_execHistReqId)) {
          _execHistBuf.push({ contract, exec, price: px, orderId });
          return;
        }
        for (const [key, row] of Object.entries(state.byKey)) {
          let role = null;
          if (row.parentId === orderId) role = 'entry';
          else if (row.tp1Id === orderId) role = 'tp1';
          else if (row.stopId === orderId) role = 'stop';
          else if ((row.closeIds || []).includes(orderId)) role = 'flatten';
          if (!role) continue;
          if (role === 'entry') {
            row.entryFilled = true;
            if (Number.isFinite(oa.avgFillPrice) && oa.avgFillPrice > 0) {
              row.ibAvgFill = oa.avgFillPrice;
            }
          }
          const fillAt = new Date().toISOString();
          const cMeta = enrichSessionMeta(row.contract || contract || toContract(row.ticker));
          const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
          state.pendingReports = state.pendingReports || [];
          const comm = commissionByExec.get(String(exec.execId));
          const report = {
            kind: 'exec', execId: exec.execId, key,
            ticker: row.ticker, hz: row.hz, side: row.side, role,
            orderId, qty: Number(exec.shares), price: px,
            currency: row.contract && row.contract.currency || 'USD',
            ccyScale: row.contract && row.contract.penceQuoted ? 100 : 1,
            errorTrade: !!(row.errorTrade || ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase())),
            userReentry: row.userReentry === true,
            session: phase,
            sessionLabel: sessionLabel(phase),
            time: fillAt
          };
          if (comm) {
            report.commission = comm.commission;
            report.commissionCcy = comm.currency;
            if (comm.realizedPNL != null) report.ibRealizedPnl = comm.realizedPNL;
          }
          state.pendingReports.push(report);
          saveState(state);
          if (role === 'flatten' && row.correctiveReentry) {
            row.correctiveExitFilled = (Number(row.correctiveExitFilled) || 0) + (Number(exec.shares) || 0);
            const expected = Number(row.correctiveExitQty) || Number(row.qtyTotal) || 0;
            if (!row.correctiveReentryTriggered && row.correctiveExitFilled >= expected) {
              row.correctiveReentryTriggered = true;
              saveState(state);
              const reports = state.pendingReports.filter(r => r && r.key === key);
              postJson('/api/ibkr/report', { reports }).then(() => {
                state.pendingReports = state.pendingReports.filter(r => !reports.includes(r));
                saveState(state);
                return postJson('/api/ibkr/rearm', { key, force: true });
              }).then(r => {
                log('corrective re-entry emitted after confirmed flatten', key, JSON.stringify(r));
              }).catch(e => {
                row.correctiveReentryTriggered = false;
                saveState(state);
                log('corrective re-entry failed — retained for retry', key, e.message);
              });
            }
          }
          if (Number(exec.price) !== px) {
            log('exec captured', role, key, exec.shares + '@' + px,
              '(IB exec.price=' + exec.price + ' avgFill=' + (oa.avgFillPrice || 'n/a') + ')');
          } else {
            log('exec captured', role, key, exec.shares + '@' + px);
          }
          break;
        }
      } catch (e) { log('execDetails error', e.message); }
    });
    // Only exit on disconnect AFTER a full handshake. Early "disconnected"
    // during connect usually means clientId is already taken by a zombie.
    let ibReady = false;
    ib.on(EventName.disconnected, () => {
      if (!ibReady) {
        log('IB disconnected during connect — is clientId', activeClientId, 'already in use?');
        return;
      }
      log('IB disconnected — exiting so run-forever can restart');
      process.exit(2);
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('IB connect timeout — is TWS/Gateway paper running with API enabled?')), 20000);
        ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
        ib.connect();
      });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('IB nextValidId timeout — is another API client using clientId ' + activeClientId + '?')), 20000);
        ib.once(EventName.nextValidId, id => { clearTimeout(t); nextOrderId = id; resolve(); });
        ib.reqIds();
      });
    } catch (e1) {
      // Probe-increment persisted clientId so run-forever restart avoids the zombie.
      if (!process.env.IBKR_CLIENT_ID) {
        state.clientId = activeClientId + 1;
        saveState(state);
        log('IB handshake failed on clientId', activeClientId, '— next launch will try', state.clientId);
      }
      throw e1;
    }
    state.clientId = activeClientId;
    saveState(state);
    log('IB connected with clientId', activeClientId);
    ibReady = true;
    // TWS's nextValidId can lag behind ids burned by other API clients in the
    // same TWS session (e.g. flatten-all), causing "Duplicate order id" (103).
    // Floor the counter to seconds-since-2025 so every run starts above any
    // previous session's range.
    const timeFloor = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000);
    nextOrderId = Math.max(nextOrderId, timeFloor);
    log('Connected to IB paper. starting orderId=', nextOrderId);
    try { ib.reqMarketDataType(mdType); log('marketDataType=' + mdType + (mdType === 1 ? ' (live)' : mdType === 3 ? ' (delayed)' : '')); } catch (_) {}
    // Subscribe to positions — the source of truth for how many shares are
    // actually held (orderFills is in-memory only and dies with each restart).
    ib.on(EventName.position, (account, contract, pos) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      posMap.set(posKeyOf(contract), { pos: Number(pos) || 0, contract: enrichSessionMeta(contract) });
    });
    ib.on(EventName.positionEnd, () => {
      positionsReady = true;
      forceReconcile = true;
      log('IB position snapshot ready —', posMap.size, 'symbol(s)');
    });
    ib.reqPositions();
    // Account values (cash, equity, available) — same numbers TWS Account window shows.
    const ACCOUNT_VALUE_TAGS = {
      NetLiquidation: 'netLiquidation',
      AvailableFunds: 'availableFunds',
      FullAvailableFunds: 'availableFunds',
      BuyingPower: 'buyingPower',
      TotalCashValue: 'totalCashValue',
      PreviousDayEquityWithLoanValue: 'previousDayEquity',
      EquityWithLoanValue: 'equityWithLoan',
      GrossPositionValue: 'grossPositionValue',
      ExcessLiquidity: 'excessLiquidity',
      FullExcessLiquidity: 'excessLiquidity',
      InitMarginReq: 'initMarginReq',
      MaintMarginReq: 'maintMarginReq',
      FullInitMarginReq: 'fullInitMarginReq',
      FullMaintMarginReq: 'fullMaintMarginReq',
      RealizedPnL: 'realizedPnl',
      UnrealizedPnL: 'unrealizedPnl',
      AccruedCash: 'accruedCash',
      AccruedDividend: 'accruedDividend',
      DividendReceivable: 'dividendReceivable'
    };
    function refreshAccountDerived() {
      if (accountSnap.netLiquidation != null) accountSnap.currentBalance = accountSnap.netLiquidation;
      if (accountSnap.availableFunds != null) accountSnap.netLiquidityAvailable = accountSnap.availableFunds;
      // Prefer IB initial margin as "margin used"; fall back to NLV − available.
      const initM = accountSnap.fullInitMarginReq != null
        ? accountSnap.fullInitMarginReq
        : accountSnap.initMarginReq;
      if (initM != null && Number.isFinite(Number(initM))) {
        accountSnap.marginsUsed = +Number(initM).toFixed(2);
      } else if (accountSnap.netLiquidation != null && accountSnap.availableFunds != null) {
        accountSnap.marginsUsed = +(accountSnap.netLiquidation - accountSnap.availableFunds).toFixed(2);
      }
      refreshStartingBalance();
    }
    function refreshStartingBalance() {
      if (accountSnap.previousDayEquity != null) {
        accountSnap.startingBalance = accountSnap.previousDayEquity;
      } else if (accountSnap.netLiquidation != null && accountSnap.dailyPnl != null) {
        accountSnap.startingBalance = +(accountSnap.netLiquidation - accountSnap.dailyPnl).toFixed(2);
      }
    }
    ib.on(EventName.updateAccountValue, (key, value, currency, accountName) => {
      try {
        if (ACCOUNT && accountName && accountName !== ACCOUNT) return;
        if (!accountSnap._tagLog) accountSnap._tagLog = 0;
        if (accountSnap._tagLog < 40) {
          accountSnap._tagLog++;
          log('acctVal', key, value, currency || '(blank)', accountName || '');
        }
        const field = ACCOUNT_VALUE_TAGS[key];
        if (!field) return;
        const ccy = String(currency || '').toUpperCase();
        const prefer = !ccy || ccy === 'BASE' || ccy === 'USD';
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return;
        const prev = accountSnap[field];
        if (prev != null && !prefer) return;
        if (!(prev != null && prefer && accountSnap['_' + field + 'Ccy'] === 'BASE' && ccy === 'USD')) {
          accountSnap[field] = n;
          accountSnap['_' + field + 'Ccy'] = ccy || 'BASE';
        }
        accountSnap.currency = (!ccy || ccy === 'BASE') ? 'USD' : (prefer ? ccy : (accountSnap.currency || 'USD'));
        accountSnap.account = accountName || ACCOUNT || accountSnap.account;
        accountSnap.at = new Date().toISOString();
        refreshAccountDerived();
        if (field === 'accruedDividend') {
          noteChargeMove('dividend', 'Accrued dividend (IB)', n, accountSnap.currency, 'income');
        } else if (field === 'dividendReceivable') {
          noteChargeMove('dividend_receivable', 'Dividend receivable (IB)', n, accountSnap.currency, 'income');
        }
        if (accountSnap.netLiquidation != null && !accountSnap._loggedOnce) {
          accountSnap._loggedOnce = true;
          log('account values live',
            'NLV=' + accountSnap.netLiquidation,
            'Avail=' + accountSnap.availableFunds,
            'Margin=' + accountSnap.marginsUsed,
            'Cash=' + accountSnap.totalCashValue);
        }
      } catch (_) { /* ignore */ }
    });
    // AccountSummary is a second path — some Gateway sessions only fill this.
    const ACC_SUMMARY_REQ = 870001;
    const ACC_SUMMARY_TAGS = [
      'NetLiquidation', 'AvailableFunds', 'FullAvailableFunds', 'BuyingPower',
      'TotalCashValue', 'PreviousDayEquityWithLoanValue', 'EquityWithLoanValue',
      'GrossPositionValue', 'ExcessLiquidity', 'InitMarginReq', 'MaintMarginReq',
      'FullInitMarginReq', 'FullMaintMarginReq',
      'RealizedPnL', 'UnrealizedPnL', 'AccruedCash', 'AccruedDividend',
      'DividendReceivable', 'Cushion'
    ].join(',');
    try {
      ib.reqAccountSummary(ACC_SUMMARY_REQ, 'All', ACC_SUMMARY_TAGS);
      log('reqAccountSummary subscribed');
    } catch (e) { log('reqAccountSummary failed', e.message); }
    ib.on(EventName.accountSummary, (reqId, account, tag, value, currency) => {
      try {
        if (ACCOUNT && account && account !== ACCOUNT) return;
        if (!accountSnap._sumLog) accountSnap._sumLog = 0;
        if (accountSnap._sumLog < 30) {
          accountSnap._sumLog++;
          log('acctSum', tag, value, currency || '(blank)', account || '');
        }
        const field = ACCOUNT_VALUE_TAGS[tag];
        if (!field) {
          if (tag === 'Cushion') accountSnap.cushion = parseFloat(value);
          else return;
        } else {
          const ccy = String(currency || '').toUpperCase();
          const prefer = !ccy || ccy === 'BASE' || ccy === 'USD';
          const n = parseFloat(value);
          if (!Number.isFinite(n)) return;
          const prev = accountSnap[field];
          if (prev != null && !prefer) return;
          accountSnap[field] = n;
          if (field === 'accruedDividend') {
            noteChargeMove('dividend', 'Accrued dividend (IB)', n, ccy || 'USD', 'income');
          } else if (field === 'dividendReceivable') {
            noteChargeMove('dividend_receivable', 'Dividend receivable (IB)', n, ccy || 'USD', 'income');
          }
        }
        accountSnap.account = account || ACCOUNT || accountSnap.account;
        accountSnap.at = new Date().toISOString();
        refreshAccountDerived();
        if (accountSnap.netLiquidation != null && !accountSnap._loggedOnce) {
          accountSnap._loggedOnce = true;
          log('account values live (summary)',
            'NLV=' + accountSnap.netLiquidation,
            'Avail=' + accountSnap.availableFunds,
            'Margin=' + accountSnap.marginsUsed);
        }
      } catch (_) { /* ignore */ }
    });
    try {
      ib.reqPnL(nextPnlReqId++, ACCOUNT || '', '');
      log('reqPnL subscribed for daily account PnL', ACCOUNT || '(default)');
    } catch (e) { log('reqPnL failed', e.message); }
    ib.on(EventName.pnl, (reqId, dailyPnL, unrealizedPnL, realizedPnL) => {
      if (Number.isFinite(Number(dailyPnL))) accountSnap.dailyPnl = Number(dailyPnL);
      if (unrealizedPnL != null && Number.isFinite(Number(unrealizedPnL))) {
        accountSnap.unrealizedPnl = Number(unrealizedPnL);
      }
      if (realizedPnL != null && Number.isFinite(Number(realizedPnL))) {
        accountSnap.realizedPnl = Number(realizedPnL);
      }
      accountSnap.at = new Date().toISOString();
      refreshStartingBalance();
    });
    // Brokerage — attach to the matching exec report (or patch later).
    ib.on(EventName.commissionReport, (cr) => {
      try {
        if (!cr || !cr.execId) return;
        const commission = Number(cr.commission);
        if (!Number.isFinite(commission)) return;
        const payload = {
          commission,
          currency: cr.currency || 'USD',
          realizedPNL: cr.realizedPNL != null && Number.isFinite(Number(cr.realizedPNL))
            ? Number(cr.realizedPNL) : null
        };
        commissionByExec.set(String(cr.execId), payload);
        // Patch any queued exec report waiting for commission.
        let patched = false;
        for (const r of (state.pendingReports || [])) {
          if (r && String(r.execId) === String(cr.execId)) {
            r.commission = payload.commission;
            r.commissionCcy = payload.currency;
            if (payload.realizedPNL != null) r.ibRealizedPnl = payload.realizedPNL;
            patched = true;
          }
        }
        if (!patched) {
          state.pendingReports = state.pendingReports || [];
          state.pendingReports.push({
            kind: 'commission',
            execId: String(cr.execId),
            commission: payload.commission,
            commissionCcy: payload.currency,
            ibRealizedPnl: payload.realizedPNL,
            time: new Date().toISOString()
          });
        }
        saveState(state);
        log('commission', cr.execId, payload.commission, payload.currency);
      } catch (e) { log('commissionReport error', e.message); }
    });
    // Account portfolio stream — IB's own mark + averageCost (true fill avg).
    ib.on(EventName.updatePortfolio, (contract, position, marketPrice, marketValue, averageCost) => {
      const pos = Number(position) || 0;
      const px = Number(marketPrice);
      const avgCost = Number(averageCost);
      if (!contract || !(px > 0) || !pos) return;
      const now = Date.now();
      const aliases = new Set();
      const y = yahooFromContract(contract);
      if (y) aliases.add(y);
      // Dual-listed names (e.g. AIR on IBIS vs SBF) — AlphaSignal may use AIR.DE
      // while IB portfolio reports AIR.PA. Alias via conId / open bridge keys.
      const conId = contract.conId != null ? Number(contract.conId) : null;
      for (const row of Object.values(state.byKey)) {
        if (!row || row.closed || !row.ticker) continue;
        if (conId && row.contract && Number(row.contract.conId) === conId) aliases.add(row.ticker);
        else if (String(row.contract && row.contract.symbol || '') === String(contract.symbol || '')
          && String(row.contract && row.contract.currency || '') === String(contract.currency || '')) {
          aliases.add(row.ticker);
        }
      }
      // Venue-correct Yahoo only. Do not stamp both .DE (GY) and .PA (FP) —
      // that made a Xetra name look Paris-listed (and the reverse). Dual-list
      // names still alias via conId / LISTING_ALIASES above.
      // HK padded aliases (5.HK ↔ 0005.HK)
      for (const a of [...aliases]) {
        aliases.add(normalizeYahooTicker(a));
        const m = String(a).match(/^0*(\d+)\.HK$/i);
        if (m) aliases.add(m[1] + '.HK');
      }
      if (Number.isFinite(avgCost) && avgCost > 0) {
        for (const t of aliases) portfolioAvgCost.set(normalizeYahooTicker(t), avgCost);
      }
      for (const t of aliases) {
        const prev = portfolioMarks.get(t);
        // Only bump `at` when price moves — sticky portfolio reprints must not
        // look like fresh ticks on the AlphaSignal server.
        const moved = !prev || Math.abs(Number(prev.price) - px) > 1e-9;
        portfolioMarks.set(t, {
          price: px, at: moved ? now : (prev.at || now), contract,
          avgCost: Number.isFinite(avgCost) && avgCost > 0 ? avgCost : (prev && prev.avgCost)
        });
      }
    });
    try {
      ib.reqAccountUpdates(true, ACCOUNT || '');
      log('accountUpdates subscribed for portfolio marks', ACCOUNT || '(default)');
    } catch (e) { log('accountUpdates failed', e.message); }
    // Streaming ticks (secondary) — may be blocked by competing live MD (10197).
    // Live: 1=bid 2=ask 4=last 9=close | Delayed: 66/67/68/75
    ib.on(EventName.tickPrice, (tickerId, field, price) => {
      const row = mktById.get(Number(tickerId));
      if (!row || !(Number(price) > 0)) return;
      const px = Number(price);
      const now = Date.now();
      row.lastTickAt = now;
      if (field === 4 || field === 66) { row.last = px; row.lastAt = now; }
      else if (field === 1 || field === 67) row.bid = px;
      else if (field === 2 || field === 68) row.ask = px;
      else if (field === 9 || field === 75) row.close = px;
    });
  } else {
    log('DRY RUN — orders are logged only. Set IBKR_DRY_RUN=0 to place paper orders.');
  }

  function yahooFromContract(c) {
    if (!c) return null;
    if (c.yahooTicker) return String(c.yahooTicker).toUpperCase();
    if (c.secType === 'FUT') {
      const sym = String(c.symbol || '').toUpperCase();
      for (const [y, meta] of Object.entries(YAHOO_FUTURES)) {
        if (meta.symbol === sym) return y;
      }
      return sym ? sym + '=F' : null;
    }
    if (c.secType === 'CRYPTO') {
      const sym = String(c.symbol || '').toUpperCase();
      for (const [y, meta] of Object.entries(YAHOO_CRYPTO)) {
        if (meta.symbol === sym) return y;
      }
      return sym ? sym + '-USD' : null;
    }
    const sym = String(c.symbol || '');
    const ccy = c.currency;
    if (ccy === 'HKD') {
      // Pad numeric HK codes so IB "5" matches AlphaSignal "0005.HK"
      if (/^\d+$/.test(sym)) return sym.padStart(4, '0') + '.HK';
      return sym + '.HK';
    }
    if (ccy === 'JPY') return sym + '.T';
    if (ccy === 'GBP') return String(sym).replace(/\.$/, '') + '.L';
    if (ccy === 'EUR') {
      const suf = yahooSuffixFromIbPrimary(c.primaryExch)
        || yahooSuffixFromIbPrimary(c.exchange);
      if (suf) return String(sym).toUpperCase() + suf;
      // IB often omits primaryExch. Do not invent GY vs FP — match the open
      // model ticker by conId, else return the bare symbol (aliases still hit).
      const conId = Number(c.conId);
      if (conId > 0) {
        for (const row of Object.values(state.byKey || {})) {
          if (!row || !row.ticker) continue;
          if (row.contract && Number(row.contract.conId) === conId) {
            const yt = normalizeYahooTicker(row.ticker);
            if (/\.(DE|PA|AS|MI)$/.test(yt)) return yt;
          }
        }
      }
      return String(sym || '').toUpperCase();
    }
    return sym;
  }

  /** Board lot from IB contract details (critical for HK — 0005 is 400, not 100). */
  function resolveLot(contract) {
    if (!contract) return Promise.resolve(1);
    if (contract.secType === 'FUT') return Promise.resolve(1);
    if (contract.secType === 'CRYPTO') {
      return Promise.resolve(Math.max(1e-8, Number(contract.lotHint) || 0.0001));
    }
    const key = posKeyOf(contract);
    if (lotCache.has(key)) return Promise.resolve(lotCache.get(key));
    const fallback = Math.max(1, Number(contract.lotHint) || 1);
    if (DRY || !ib || !EventName) {
      lotCache.set(key, fallback);
      return Promise.resolve(fallback);
    }
    return new Promise(resolve => {
      const reqId = nextDetailsId++;
      let done = false;
      const finish = (lot) => {
        if (done) return;
        done = true;
        try { ib.off(EventName.contractDetails, onDet); } catch (_) {}
        try { ib.off(EventName.contractDetailsEnd, onEnd); } catch (_) {}
        const out = Math.max(1, Number(lot) || fallback);
        lotCache.set(key, out);
        if (out !== fallback) log('lot size', contract.symbol, contract.currency, '→', out);
        resolve(out);
      };
      const t = setTimeout(() => finish(fallback), 5000);
      const onDet = (id, details) => {
        if (Number(id) !== reqId) return;
        clearTimeout(t);
        const d = details || {};
        const c = d.contract || {};
        const minSize = Number(d.minSize || d.orderMinSize || c.minSize || 0);
        // Prefer IB minSize; else keep exchange hint
        finish(minSize > 0 ? minSize : fallback);
        // Stash conId for cleaner subsequent orders
        const conId = Number(c.conId || d.conId);
        if (conId > 0) contract.conId = conId;
        if (c.localSymbol) contract.localSymbol = String(c.localSymbol);
      };
      const onEnd = (id) => {
        if (Number(id) !== reqId) return;
        clearTimeout(t);
        finish(fallback);
      };
      ib.on(EventName.contractDetails, onDet);
      ib.on(EventName.contractDetailsEnd, onEnd);
      try {
        ib.reqContractDetails(reqId, {
          symbol: String(contract.symbol),
          secType: contract.secType || 'STK',
          exchange: 'SMART',
          currency: contract.currency,
          primaryExch: contract.primaryExch
        });
      } catch (e) {
        clearTimeout(t);
        finish(fallback);
      }
    });
  }

  /**
   * Resolve stocks, futures front-month, or crypto via IB contract details.
   * International stocks must have a conId before an order is submitted:
   * symbol-only stubs can be ambiguous (BA = Boeing vs BA. = BAE Systems).
   * Mutates and returns the contract stub.
   */
  const _stockContractCache = new Map(); // yahooTicker -> qualified fields
  const _futFrontCache = new Map(); // yahooTicker -> { at, contract }
  async function resolveInstrument(contract) {
    if (!contract) return null;
    enrichSessionMeta(contract);
    if ((contract.secType || 'STK') === 'STK') {
      if (contract.conId > 0 || DRY || !ib || !EventName) return contract;
      const yKey = String(contract.yahooTicker || '').toUpperCase();
      const cached = _stockContractCache.get(yKey);
      if (cached && (Date.now() - cached.at) < 24 * 3600 * 1000) {
        Object.assign(contract, cached.contract);
        delete contract.contractResolutionFailed;
        return contract;
      }
      const symbols = [String(contract.localSymbol || contract.symbol || '')];
      // Controlled LSE punctuation fallback. Keep the normal symbol first so
      // MNDI.L/HSBA.L continue to resolve exactly as before.
      if (contract.market === 'LSE' && yKey === 'BA.L' && !symbols.includes('BA.')) symbols.push('BA.');
      if (contract.market === 'LSE' && contract.symbol && !String(contract.symbol).endsWith('.')) {
        symbols.push(String(contract.symbol) + '.');
      }
      const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
      const tryCandidate = (symbol) => new Promise(resolve => {
        const reqId = nextDetailsId++;
        const matches = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { ib.off(EventName.contractDetails, onDet); } catch (_) {}
          try { ib.off(EventName.contractDetailsEnd, onEnd); } catch (_) {}
          const wantedCcy = String(contract.currency || '').toUpperCase();
          const wantedPrimary = String(contract.primaryExch || '').toUpperCase();
          const pick = matches.find(c => {
            const ccyOk = !wantedCcy || String(c.currency || '').toUpperCase() === wantedCcy;
            const exch = String(c.primaryExch || c.exchange || '').toUpperCase();
            const venueOk = !wantedPrimary || exch === wantedPrimary || String(c.validExchanges || '').toUpperCase().split(',').includes(wantedPrimary);
            return ccyOk && venueOk;
          }) || matches.find(c => !wantedCcy || String(c.currency || '').toUpperCase() === wantedCcy);
          resolve(pick || null);
        };
        const timer = setTimeout(finish, 4500);
        const onDet = (id, details) => {
          if (Number(id) !== reqId) return;
          const c = (details && details.contract) || {};
          if (Number(c.conId) > 0) matches.push({ ...c, validExchanges: details && details.validExchanges });
        };
        const onEnd = (id) => {
          if (Number(id) !== reqId) return;
          finish();
        };
        ib.on(EventName.contractDetails, onDet);
        ib.on(EventName.contractDetailsEnd, onEnd);
        try {
          ib.reqContractDetails(reqId, {
            symbol,
            localSymbol: symbol.endsWith('.') ? symbol : undefined,
            secType: 'STK',
            exchange: 'SMART',
            currency: contract.currency,
            primaryExch: contract.primaryExch
          });
        } catch (_) { finish(); }
      });
      let pick = null;
      for (const symbol of uniqueSymbols) {
        pick = await tryCandidate(symbol);
        if (pick) break;
      }
      if (pick && Number(pick.conId) > 0) {
        const qualified = {
          conId: Number(pick.conId),
          symbol: String(pick.symbol || contract.symbol),
          localSymbol: pick.localSymbol ? String(pick.localSymbol) : contract.localSymbol,
          primaryExch: pick.primaryExch || contract.primaryExch,
          tradingClass: pick.tradingClass || contract.tradingClass
        };
        Object.assign(contract, qualified);
        delete contract.contractResolutionFailed;
        _stockContractCache.set(yKey, { at: Date.now(), contract: qualified });
        log('stock contract', yKey || contract.symbol, '→',
          (contract.localSymbol || contract.symbol), 'conId=' + contract.conId,
          'primary=' + (contract.primaryExch || '?'));
      } else {
        contract.contractResolutionFailed = true;
        log('stock contract NOT FOUND for', yKey || contract.symbol,
          'candidates=' + uniqueSymbols.join(','));
      }
      return contract;
    }
    if (contract.secType === 'CRYPTO') {
      if (contract.conId > 0 || DRY || !ib || !EventName) return contract;
      return new Promise(resolve => {
        const reqId = nextDetailsId++;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { ib.off(EventName.contractDetails, onDet); } catch (_) {}
          try { ib.off(EventName.contractDetailsEnd, onEnd); } catch (_) {}
          resolve(contract);
        };
        const t = setTimeout(finish, 6000);
        const onDet = (id, details) => {
          if (Number(id) !== reqId) return;
          const c = (details && details.contract) || {};
          const conId = Number(c.conId);
          if (conId > 0) contract.conId = conId;
          if (c.localSymbol) contract.localSymbol = String(c.localSymbol);
        };
        const onEnd = (id) => {
          if (Number(id) !== reqId) return;
          clearTimeout(t);
          finish();
        };
        ib.on(EventName.contractDetails, onDet);
        ib.on(EventName.contractDetailsEnd, onEnd);
        try {
          ib.reqContractDetails(reqId, {
            symbol: String(contract.symbol),
            secType: 'CRYPTO',
            exchange: contract.exchange || 'PAXOS',
            currency: contract.currency || 'USD'
          });
        } catch (e) {
          clearTimeout(t);
          finish();
        }
      });
    }
    if (contract.secType !== 'FUT' || !contract.needsFrontMonth) return contract;
    const yKey = contract.yahooTicker || contract.symbol;
    const cached = _futFrontCache.get(yKey);
    if (cached && (Date.now() - cached.at) < 6 * 3600 * 1000 && cached.contract) {
      Object.assign(contract, cached.contract);
      contract.needsFrontMonth = false;
      return contract;
    }
    if (DRY || !ib || !EventName) {
      // Offline / dry: next calendar month YYYYMM as a best-effort stub.
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + 1);
      const yyyymm = String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0');
      contract.lastTradeDateOrContractMonth = yyyymm;
      contract.needsFrontMonth = false;
      return contract;
    }
    return new Promise(resolve => {
      const reqId = nextDetailsId++;
      const cands = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { ib.off(EventName.contractDetails, onDet); } catch (_) {}
        try { ib.off(EventName.contractDetailsEnd, onEnd); } catch (_) {}
        const today = new Date();
        const todayKey = String(today.getUTCFullYear())
          + String(today.getUTCMonth() + 1).padStart(2, '0')
          + String(today.getUTCDate()).padStart(2, '0');
        const live = cands
          .filter(x => String(x.month || '') >= todayKey.slice(0, 6))
          .sort((a, b) => String(a.month).localeCompare(String(b.month)));
        const pick = live[0] || cands.sort((a, b) => String(a.month).localeCompare(String(b.month)))[0];
        if (pick) {
          contract.lastTradeDateOrContractMonth = pick.month;
          if (pick.conId > 0) contract.conId = pick.conId;
          if (pick.localSymbol) contract.localSymbol = pick.localSymbol;
          if (pick.tradingClass) contract.tradingClass = pick.tradingClass;
          if (pick.multiplier > 0) contract.multiplier = pick.multiplier;
          if (pick.exchange) contract.exchange = pick.exchange;
          contract.needsFrontMonth = false;
          _futFrontCache.set(yKey, {
            at: Date.now(),
            contract: {
              lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
              conId: contract.conId,
              localSymbol: contract.localSymbol,
              tradingClass: contract.tradingClass,
              multiplier: contract.multiplier,
              exchange: contract.exchange,
              tick: contract.tick,
              symbol: contract.symbol,
              secType: 'FUT',
              currency: contract.currency,
              market: 'GLOBE',
              yahooTicker: contract.yahooTicker
            }
          });
          log('futures front month', contract.yahooTicker || contract.symbol,
            '→', contract.lastTradeDateOrContractMonth,
            'mult=' + contract.multiplier, 'conId=' + (contract.conId || 'n/a'));
        } else {
          log('futures front month NOT FOUND for', contract.yahooTicker || contract.symbol,
            '(', cands.length, 'candidates)');
        }
        resolve(contract);
      };
      const t = setTimeout(finish, 8000);
      const onDet = (id, details) => {
        if (Number(id) !== reqId) return;
        const d = details || {};
        const c = d.contract || {};
        const month = String(c.lastTradeDateOrContractMonth || '');
        if (!month) return;
        cands.push({
          month,
          conId: Number(c.conId) || 0,
          localSymbol: c.localSymbol ? String(c.localSymbol) : null,
          tradingClass: c.tradingClass ? String(c.tradingClass) : null,
          multiplier: Number(c.multiplier || d.multiplier || contract.multiplier) || contract.multiplier,
          exchange: c.exchange || contract.exchange
        });
      };
      const onEnd = (id) => {
        if (Number(id) !== reqId) return;
        clearTimeout(t);
        finish();
      };
      ib.on(EventName.contractDetails, onDet);
      ib.on(EventName.contractDetailsEnd, onEnd);
      try {
        ib.reqContractDetails(reqId, {
          symbol: String(contract.symbol),
          secType: 'FUT',
          exchange: contract.exchange,
          currency: contract.currency || 'USD'
        });
      } catch (e) {
        clearTimeout(t);
        log('reqContractDetails FUT failed', e.message);
        finish();
      }
    });
  }

  /** Subscribe to IB market data for an AlphaSignal ticker (idempotent). */
  function ensureMktData(ticker, contract) {
    if (DRY || !ib || !ticker || !contract || mktSubscribed.has(ticker)) return;
    const id = nextMktId++;
    mktById.set(id, {
      ticker, last: null, bid: null, ask: null, close: null,
      lastTickAt: null, lastAt: null, contract
    });
    mktSubscribed.add(ticker);
    const oc = (contract.secType === 'FUT' || contract.secType === 'CRYPTO')
      ? placeableContract(contract)
      : (orderContractFromPos(contract) || {
        symbol: contract.symbol, secType: contract.secType || 'STK',
        exchange: 'SMART', currency: contract.currency,
        primaryExch: contract.primaryExch, conId: contract.conId
      });
    try {
      ib.reqMktData(id, oc, '', false, false);
      log('mktData subscribed', ticker, 'reqId=' + id);
    } catch (e) { log('mktData subscribe failed', ticker, e.message); }
  }

  /** After marketDataType change, IB keeps old streams mute — cancel & re-req. */
  function resubscribeAllMkt(reason) {
    if (DRY || !ib) return;
    const saved = [];
    for (const row of mktById.values()) {
      if (row && row.ticker && row.contract) saved.push({ ticker: row.ticker, contract: row.contract });
    }
    for (const id of [...mktById.keys()]) {
      try { ib.cancelMktData(id); } catch (_) {}
    }
    mktById.clear();
    mktSubscribed.clear();
    for (const s of saved) ensureMktData(s.ticker, s.contract);
    log('mktData resubscribed', saved.length, 'symbol(s) reason=' + (reason || ''));
  }

  let _openTickersCache = { at: 0, rows: [] };
  async function syncMktSubscriptions() {
    // Open AlphaSignal trades that have (or may have) a live position
    for (const row of Object.values(state.byKey)) {
      if (row.closed || !row.contract || !row.ticker) continue;
      ensureMktData(row.ticker, row.contract);
    }
    // Any non-zero IB position (covers orphans / missed state keys)
    for (const { pos, contract } of posMap.values()) {
      if (!pos) continue;
      const y = yahooFromContract(contract);
      if (y) ensureMktData(y, contract);
    }
    // Rarely refresh from the IBKR tab open list — /api/ibkr/trades is heavy
    // (FMP/Yahoo fallbacks) and was stalling the bridge every 10s.
    if (Date.now() - _openTickersCache.at > 120000) {
      try {
        const t = await fetchJson('/api/ibkr/trades');
        _openTickersCache = { at: Date.now(), rows: (t && t.trades) || [] };
      } catch (_) { _openTickersCache.at = Date.now(); }
    }
    for (const row of _openTickersCache.rows) {
      if (!row || row.openQty <= 0 || !row.ticker) continue;
      const c = toContract(row.ticker);
      if (c) ensureMktData(row.ticker, c);
    }
  }

  async function flushMarks() {
    if (DRY) return;
    await syncMktSubscriptions();
    const byTicker = new Map(); // ticker -> mark row
    // 1) Primary: IB account portfolio marks (same as TWS paper MTM).
    for (const [ticker, pm] of portfolioMarks) {
      if (!(pm.price > 0)) continue;
      byTicker.set(ticker, {
        ticker, price: pm.price,
        bid: null, ask: null, last: pm.price,
        lastTickAt: pm.at || Date.now(),
        src: 'ibkr', at: new Date().toISOString()
      });
    }
    // 2) Secondary: tick stream when available (may be empty under 10197).
    for (const row of mktById.values()) {
      const spreadOk = row.bid > 0 && row.ask > 0 && row.ask >= row.bid
        && ((row.ask - row.bid) / ((row.ask + row.bid) / 2) < 0.02);
      const mid = spreadOk ? (row.bid + row.ask) / 2 : null;
      const px = (row.last > 0 ? row.last : null) || mid || (row.close > 0 ? row.close : null);
      if (!(px > 0)) continue;
      const prev = byTicker.get(row.ticker);
      // Prefer fresher tick over a stale portfolio print.
      if (!prev || (row.lastTickAt && row.lastTickAt >= (prev.lastTickAt || 0))) {
        byTicker.set(row.ticker, {
          ticker: row.ticker, price: px,
          bid: row.bid, ask: row.ask, last: row.last,
          lastTickAt: row.lastTickAt || null,
          src: 'ibkr', at: new Date().toISOString()
        });
      }
    }
    const marks = [...byTicker.values()];
    if (!marks.length && accountSnap.netLiquidation == null && accountSnap.availableFunds == null
        && !(state.pendingCharges && state.pendingCharges.length)) return;
    const charges = takePendingCharges();
    try {
      const body = {
        marks,
        charges,
        accountSnapshot: {
          ...accountSnap,
          startingBalance: accountSnap.startingBalance,
          availableFunds: accountSnap.availableFunds,
          netLiquidation: accountSnap.netLiquidation,
          marginsUsed: accountSnap.marginsUsed,
          initMarginReq: accountSnap.initMarginReq,
          maintMarginReq: accountSnap.maintMarginReq,
          fullInitMarginReq: accountSnap.fullInitMarginReq,
          fullMaintMarginReq: accountSnap.fullMaintMarginReq,
          accruedCash: accountSnap.accruedCash,
          accruedDividend: accountSnap.accruedDividend,
          dividendReceivable: accountSnap.dividendReceivable
        }
      };
      const resp = await postJson('/api/ibkr/marks', body);
      if (resp && resp.ok) {
        if (marks.length) {
          log('marks posted', marks.length, '→', marks.map(m => m.ticker + '=' + m.price).join(' '));
        }
        if (charges.length) log('charges posted', charges.length);
      } else if (charges.length) {
        restorePendingCharges(charges);
      }
    } catch (e) {
      if (charges.length) restorePendingCharges(charges);
      log('marks flush failed:', e.message);
    }
  }

  function baseOrder(extra) {
    return { tif: 'GTC', ...(ACCOUNT ? { account: ACCOUNT } : {}), ...extra };
  }

  /** Place / replace an order (IB modifies in place when the orderId is reused). */
  function transmitOrder(orderId, contract, order, label) {
    if (DRY || !ib) { log('DRY order', label, JSON.stringify({ orderId, contract: contract.symbol, ...order })); return; }
    ib.placeOrder(orderId, contract, order);
    log('order sent', label, contract.symbol, order.action, order.orderType, 'qty=' + order.totalQuantity,
      order.lmtPrice != null ? 'lmt=' + order.lmtPrice : '', order.auxPrice != null ? 'stp=' + order.auxPrice : '');
  }

  function cancelOrder(orderId, label) {
    if (orderId == null) return;
    if (DRY || !ib) { log('DRY cancel', label, orderId); return; }
    try { ib.cancelOrder(orderId); log('cancel sent', label, orderId); } catch (e) { log('cancel failed', label, orderId, e.message); }
  }

  /** Wait until IB acks cancel (or timeout). Used to close the place-then-cancel double-fill window. */
  function waitCancel(orderId, timeoutMs = 3000) {
    if (orderId == null || DRY || !ib) return Promise.resolve('skip');
    return new Promise(resolve => {
      const prev = _cancelWaiters.get(orderId);
      if (prev) { try { clearTimeout(prev.timer); prev.resolve('superseded'); } catch (_) {} }
      const timer = setTimeout(() => {
        _cancelWaiters.delete(orderId);
        resolve('timeout');
      }, timeoutMs);
      _cancelWaiters.set(orderId, { resolve, timer });
    });
  }

  function noteCancelAck(orderId, status) {
    const w = _cancelWaiters.get(orderId);
    if (!w) return;
    clearTimeout(w.timer);
    _cancelWaiters.delete(orderId);
    w.resolve(status || 'Cancelled');
  }

  function ibQuoteForTicker(ticker) {
    const pm = portfolioMarks.get(ticker);
    if (pm && pm.price > 0) return Number(pm.price);
    for (const row of mktById.values()) {
      if (!row || row.ticker !== ticker) continue;
      const spreadOk = row.bid > 0 && row.ask > 0 && row.ask >= row.bid;
      const mid = spreadOk ? (row.bid + row.ask) / 2 : null;
      const px = (row.last > 0 ? row.last : null) || mid || (row.close > 0 ? row.close : null);
      if (px > 0) return Number(px);
    }
    return null;
  }

  /** Live IB tick for US pre/post — bid/ask/last, never yesterday's close alone. */
  function ibLiveExtQuote(ticker) {
    for (const row of mktById.values()) {
      if (!row || row.ticker !== ticker) continue;
      const bid = Number(row.bid) || 0;
      const ask = Number(row.ask) || 0;
      const last = Number(row.last) || 0;
      const close = Number(row.close) || 0;
      const tickAt = row.lastTickAt || row.lastAt;
      const fresh = tickAt && (Date.now() - tickAt) < 20 * 60 * 1000;
      const lastIsClose = close > 0 && last > 0 && Math.abs(last - close) < 1e-6;
      const lastOk = last > 0 && fresh && !(lastIsClose && bid <= 0 && ask <= 0);
      const px = lastOk ? last
        : (ask > 0 && bid > 0 ? (ask + bid) / 2
          : (ask || bid || 0));
      if (px > 0 || bid > 0 || ask > 0) {
        return { px: px || ask || bid || last, bid, ask, last, src: 'ibkr' };
      }
    }
    return null;
  }

  function ibExtTradePx(side, q) {
    if (!q) return null;
    const sell = String(side || '').toLowerCase() === 'sell';
    if (sell && q.bid > 0) return q.bid;
    if (!sell && q.ask > 0) return q.ask;
    const px = Number(q.px) || Number(q.last) || 0;
    return px > 0 ? px : null;
  }

  async function waitIbExtQuote(ticker, timeoutMs = 1800) {
    const t0 = Date.now();
    for (;;) {
      const q = ibLiveExtQuote(ticker);
      if (q && (q.ask > 0 || q.bid > 0 || q.px > 0)) return q;
      if (Date.now() - t0 >= timeoutMs) return ibLiveExtQuote(ticker);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  /** US extended quote: IBKR bid/ask/last first; Yahoo only if IB has no tick. */
  async function fetchEntryQuote(ticker, phase, side) {
    const waitMs = (phase === 'pre' || phase === 'post') ? 5000 : 1800;
    const ib = await waitIbExtQuote(ticker, waitMs);
    const ibPx = ibExtTradePx(side, ib);
    if ((phase === 'pre' || phase === 'post') && ibPx > 0) {
      log('IBKR ext quote', ticker, 'phase=' + phase,
        'last=' + ((ib && ib.last) || 'n/a'),
        'bid=' + ((ib && ib.bid) || 'n/a'),
        'ask=' + ((ib && ib.ask) || 'n/a'),
        'trade=' + ibPx);
      return { px: ibPx, src: 'ibkr', bid: ib && ib.bid, ask: ib && ib.ask };
    }
    try {
      const j = await fetchJson('/api/prices?symbols=' + encodeURIComponent(ticker));
      const v = j && j[ticker];
      const pre = Number(v && (v.preMarketPrice ?? v.preMarket));
      const post = Number(v && (v.postMarketPrice ?? v.postMarket));
      const last = Number(v && (v.price ?? v.regularMarketPrice ?? v.last ?? v));
      const state = String((v && v.marketState) || '').toUpperCase();
      let prePx = pre, postPx = post, mktState = state;
      if ((phase === 'pre' || phase === 'post') && !(prePx > 0) && !(postPx > 0)) {
        const y = await fetchYahooExtQuote(ticker);
        if (y) {
          if (y.pre > 0) prePx = y.pre;
          if (y.post > 0) postPx = y.post;
          if (y.state) mktState = y.state;
          log('yahoo ext fallback', ticker, y.state || '', 'pre=' + (y.pre || 'n/a'), 'post=' + (y.post || 'n/a'));
        }
      }
      if ((phase === 'pre' || mktState === 'PRE') && prePx > 0) {
        return { px: prePx, src: 'pre', bid: ib && ib.bid, ask: ib && ib.ask };
      }
      if ((phase === 'post' || mktState === 'POST') && postPx > 0) {
        return { px: postPx, src: 'post', bid: ib && ib.bid, ask: ib && ib.ask };
      }
      if (phase === 'pre' || phase === 'post') {
        return { px: null, src: null };
      }
      if (ibPx > 0) return { px: ibPx, src: 'ibkr', bid: ib && ib.bid, ask: ib && ib.ask };
      if (last > 0) return { px: last, src: 'last' };
    } catch (e) { log('entry quote fetch failed', ticker, e.message); }
    if (ibPx > 0) return { px: ibPx, src: 'ibkr' };
    const stale = ibQuoteForTicker(ticker);
    if (phase !== 'pre' && phase !== 'post' && stale > 0) return { px: stale, src: 'ibkr' };
    return { px: null, src: null };
  }

  // ── Entry: full bracket ────────────────────────────────────────────────────
  async function placeBracket(evt) {
    let contract = toContract(evt.ticker);
    if (!contract) {
      log('skip entry (unsupported instrument for IB paper):', evt.ticker);
      return null;
    }
    contract = await resolveInstrument(contract);
    if (contract.secType === 'FUT' && !contract.lastTradeDateOrContractMonth && !contract.conId) {
      log('skip entry (futures front month unresolved):', evt.ticker);
      return null;
    }
    const isSell = evt.side === 'sell';
    const lot = await resolveLot(contract);
    contract.lotHint = lot;
    const split = await shareSplit(evt.entry, contract, lot);
    if (!(split.total > 0)) { log('skip entry — zero size for', evt.ticker, 'entry', evt.entry, 'lot', lot); return null; }
    const openAction = isSell ? 'SELL' : 'BUY';
    const closeAction = isSell ? 'BUY' : 'SELL';
    // Stops: round away from the market so STP is valid on SEHK tick grid.
    // Nudge one extra HK tick — IB rejected 44.65 (error 110) even though it
    // sits on the 0.05 band; child reject leaves parent transmit=false.
    const rawStop = evt.trailSl != null ? evt.trailSl : evt.sl;
    let stopPx = roundPx(rawStop, contract, isSell ? 'up' : 'down');
    if (contract.market === 'HK' && stopPx > 0) {
      const tick = hkTickSize(stopPx);
      stopPx = roundPx(isSell ? stopPx + tick : stopPx - tick, contract);
    }
    const tp1Px = roundPx(evt.tp1, contract, isSell ? 'down' : 'up');
    if (!(stopPx > 0)) { log('skip entry — no stop level for', evt.ticker); return null; }
    if (!DRY && contract.secType === 'STK' && !(Number(contract.conId) > 0)) {
      // Never manufacture order IDs for a contract IB could not qualify. This
      // row remains recoverable by reconcile, but no phantom "Placed bracket"
      // or order-not-found cancellations are produced.
      log('defer entry — IB stock contract unresolved:', evt.ticker);
      return {
        parentId: null, stopId: null, tp1Id: null,
        ticker: evt.ticker, hz: evt.hz, side: evt.side,
        entry: evt.entry, stopPx, tp1Px, entryStyle: 'CONTRACT-RETRY',
        extLmt: null, qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
        contract, tp1Done: false, closed: false, deferred: true,
        contractRejected: true, entryFilled: false,
        updated: evt.t || new Date().toISOString(), dry: DRY
      };
    }
    const rthOk = !!(contract.usRth || contract.secType === 'FUT' || contract.secType === 'CRYPTO');
    const parentId = nid(), stopId = nid(), tp1Id = tp1Px > 0 && split.sold > 0 ? nid() : null;

    // US pre/extended + RTH chase: gate on live quote vs recommended entry.
    let quotePx = null;
    let quoteSrc = null;
    const usPhase = contract.usRth ? sessionPhase(contract) : null;
    if (contract.usRth && (usPhase === 'pre' || usPhase === 'post' || usPhase === 'rth')) {
      ensureMktData(evt.ticker, contract);
      const q = await fetchEntryQuote(evt.ticker, usPhase, evt.side);
      quotePx = q.px;
      quoteSrc = q.src;
    }
    const parentSpec = parentEntrySpec(contract, openAction, split.total, {
      side: evt.side, entryPx: evt.entry, quotePx,
      forceOpg: !!evt.forceOpg, skipChase: !!evt.skipChase
    });
    if (parentSpec.defer) {
      log('defer entry', evt.ticker, parentSpec.entryStyle, 'phase=', sessionPhase(contract));
      // Keep a stub so lunch/closed names re-arm at the next session instead of
      // vanishing (0669.HK 17 Aug: DEFER-LUNCH returned null → no row → no 13:00 fire).
      return {
        parentId: null, stopId: null, tp1Id: null,
        ticker: evt.ticker, hz: evt.hz, side: evt.side,
        entry: evt.entry, stopPx, tp1Px, entryStyle: parentSpec.entryStyle,
        extLmt: null, qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
        contract, tp1Done: false, closed: false, deferred: true,
        entryFilled: false, updated: evt.t || new Date().toISOString(), dry: DRY
      };
    }
    const { entryStyle, defer, ...parentFields } = parentSpec;
    const parent = baseOrder({ orderId: parentId, ...parentFields });
    // Stop child: FULL quantity — pre-TP1 an SL hit closes the whole position
    // (identical to the simulator's sl_hit). GTC so it survives sessions.
    const stopOrder = baseOrder({
      orderId: stopId, action: closeAction, orderType: 'STP',
      auxPrice: stopPx, totalQuantity: split.total,
      parentId, transmit: tp1Id == null,
      outsideRth: rthOk
    });
    // TP1 child: partial quantity. NOT OCA with the stop — a TP1 fill must not
    // cancel the stop; instead onOrderStatus resizes the stop to the runner.
    const tp1Order = tp1Id != null ? baseOrder({
      orderId: tp1Id, action: closeAction, orderType: 'LMT',
      lmtPrice: tp1Px, totalQuantity: split.sold,
      parentId, outsideRth: rthOk, transmit: true
    }) : null;

    if (DRY || !ib) {
      log('DRY bracket', evt.ticker, evt.side, JSON.stringify({ contract, parent, stopOrder, tp1Order, split, entryStyle, phase: sessionPhase(contract), quotePx, quoteSrc }, null, 1));
    } else {
      const oc = placeableContract(contract);
      ib.placeOrder(parentId, oc, parent);
      ib.placeOrder(stopId, oc, stopOrder);
      if (tp1Order) ib.placeOrder(tp1Id, oc, tp1Order);
      const gateNote = contract.usRth && (sessionPhase(contract) === 'pre' || sessionPhase(contract) === 'post')
        ? ` quote=${quotePx != null ? quotePx : 'n/a'}(${quoteSrc || 'none'}) vs entry=${roundPx(evt.entry)} lmt=${parent.lmtPrice != null ? parent.lmtPrice : 'n/a'} → ${entryStyle}`
        : '';
      const sizeNote = contract.secType === 'FUT'
        ? ` futMonth=${contract.lastTradeDateOrContractMonth} mult=${contract.multiplier}`
        : (contract.secType === 'CRYPTO' ? ' crypto' : '');
      const bb = contract.bloomberg || bloombergTicker(evt.ticker);
      const listingNote = bb ? ` ${bb}` : '';
      log('Placed bracket', evt.ticker + listingNote, evt.side,
        `exch=${contract.primaryExch || contract.market || ''} style=${entryStyle} phase=${sessionPhase(contract)} qty=${split.total} sizePx=${roundPx(evt.entry, contract)} stop=${stopPx}(full) tp1=${tp1Px}x${split.sold} runner=${split.runner}${sizeNote}${gateNote}`);
    }
    return {
      parentId, stopId, tp1Id,
      ticker: evt.ticker, hz: evt.hz, side: evt.side,
      entry: evt.entry, stopPx, tp1Px, entryStyle,
      extLmt: parent.lmtPrice != null ? Number(parent.lmtPrice) : null,
      qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
      contract, tp1Done: false, closed: false, updated: evt.t || new Date().toISOString(), dry: DRY
    };
  }

  // ── TP1 fill → resize stop to runner + raise to breakeven ─────────────────
  function onTp1Filled(key, row) {
    if (row.tp1Done || row.closed) return;
    row.tp1Done = true;
      const beStop = row.side === 'sell'
      ? Math.min(row.stopPx, roundPx(row.entry, row.contract))
      : Math.max(row.stopPx, roundPx(row.entry, row.contract));
    row.stopPx = beStop;
    if (row.qtyRunner > 0) {
      transmitOrder(row.stopId, row.contract, baseOrder({
        orderId: row.stopId,
        action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'STP', auxPrice: beStop,
        totalQuantity: row.qtyRunner, parentId: row.parentId, transmit: true
      }), 'stop→runner/BE ' + key);
    } else {
      cancelOrder(row.stopId, 'stop (no runner) ' + key);
    }
    log('TP1 filled', key, '— stop resized to runner', row.qtyRunner, '@ breakeven-floor', beStop);
  }

  function onOrderStatus(orderId, status, filled, avgFillPrice) {
    const st = String(status || '');
    if (st === 'Cancelled' || st === 'ApiCancelled' || st === 'Inactive') {
      noteCancelAck(orderId, st);
    }
    for (const [key, row] of Object.entries(state.byKey)) {
      if (row.closed) continue;
      // Persist the parent-fill fact — entry_finalized's safety guard reads it
      // after restarts, when the in-memory orderFills counters are gone.
      if (row.parentId === orderId && filled > 0 && !row.entryFilled) {
        row.entryFilled = true;
        if (Number.isFinite(avgFillPrice) && avgFillPrice > 0) row.ibAvgFill = avgFillPrice;
        saveState(state);
      } else if (row.parentId === orderId && Number.isFinite(avgFillPrice) && avgFillPrice > 0) {
        row.ibAvgFill = avgFillPrice;
      }
      if (row.tp1Id === orderId && (status === 'Filled' || filled >= row.qtySold) && filled > 0) {
        onTp1Filled(key, row);
        saveState(state);
      }
      if (row.stopId === orderId && status === 'Filled') {
        // Stop filled → position flat; cancel a still-open TP1 (no orphan limit).
        if (row.tp1Id != null && !row.tp1Done) cancelOrder(row.tp1Id, 'tp1 after stop-out ' + key);
        row.closed = true;
        log('Stop filled — trade closed at IB', key);
        saveState(state);
      }
    }
  }

  // ── Exit: cancel children + flatten remainder ─────────────────────────────
  function closeOut(key, row, reason) {
    if (!row || row.closed) return;
    cancelOrder(row.stopId, 'stop @exit ' + key);
    if (row.tp1Id != null && !row.tp1Done) cancelOrder(row.tp1Id, 'tp1 @exit ' + key);
    // Flatten whatever is still held. Prefer the LIVE IB position (survives
    // bridge restarts); orderFills is only a fallback for the first seconds
    // before the position snapshot arrives. The old fills-only math flattened
    // ZERO shares after a restart and left positions running forever.
    const held = row.contract ? posMap.get(posKeyOf(row.contract)) : null;
    let remaining;
    if (!DRY && held) {
      remaining = row.side === 'sell' ? Math.max(0, -held.pos) : Math.max(0, held.pos);
      // Cap at what THIS trade can still hold: after TP1 banked the partial,
      // only the runner remains. posMap is per-SYMBOL, so when two trades
      // (e.g. medium + long) share a symbol, capping at qtyTotal would eat
      // the sibling trade's shares (audit finding B2).
      remaining = Math.min(remaining, row.tp1Done ? row.qtyRunner : row.qtyTotal);
    } else {
      const parentFilled = DRY ? row.qtyTotal : (orderFills[row.parentId] || 0);
      const soldAtTp1 = row.tp1Done ? row.qtySold : (row.tp1Id != null ? (orderFills[row.tp1Id] || 0) : 0);
      remaining = Math.max(0, parentFilled - soldAtTp1);
    }
    if (remaining > 0) {
      const fid = nid();
      row.closeIds = [...(row.closeIds || []), fid];
      const phase = sessionPhase(row.contract);
      const openingCorrection = !!(row.correctiveReentry && row.contract.usRth && phase !== 'rth');
      if (row.correctiveReentry) row.correctiveExitQty = remaining;
      transmitOrder(fid, row.contract, baseOrder({
        orderId: fid,
        action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'MKT', totalQuantity: remaining,
        tif: openingCorrection ? 'OPG' : 'DAY',
        outsideRth: false, transmit: true
      }), 'flatten @exit ' + key);
    }
    row.closed = true;
    row.updated = new Date().toISOString();
    log('Exit handled', key, reason || '', '— children cancelled, flattened', remaining, 'share(s)');
  }

  // ── Event dispatcher ───────────────────────────────────────────────────────
  async function handleEvent(evt) {
    const key = evt.key || `${evt.ticker}|${evt.hz}|${evt.entryDate}`;
    if (evt.type === 'entry') {
      const prior = state.byKey[key];
      // Allow re-entry after a closed row (orphan flatten / error close). Same-day
      // key must not be blocked forever by a leftover parentId.
      if (prior && prior.contractRejected && !prior.entryFilled && !prior.closed) {
        log('retry entry after IB contract reject', key, prior.ticker);
        delete state.byKey[key];
        saveState(state);
      } else if (prior && prior.parentId && !prior.closed) {
        log('skip duplicate entry', key);
        return;
      } else if (prior && prior.deferred && !prior.closed) {
        log('skip duplicate entry (deferred stub)', key);
        return;
      }
      if (prior && prior.closed) {
        log('re-entry after closed state row', key, 'priorReason=', prior.flatReason || prior.holdCancelledUnfilled || 'closed');
        delete state.byKey[key];
        saveState(state);
      }
      // Hard gate: only real Buy/Sell with levels. Hold must never trade
      // (server used to default Hold→buy and paper-bought FSLR/BMY/…).
      const side = String(evt.side || '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') {
        log('skip entry (not Buy/Sell):', key, 'side=', evt.side);
        return;
      }
      if (ERROR_TRADE_TICKERS.has(String(evt.ticker || '').toUpperCase())) {
        log('skip entry (error-trade ticker blocklist):', key);
        return;
      }
      if (!scheduledEntryReleaseAllowed(evt)) {
        log('skip entry (before configured SGT recommendation release):', key,
          'entryDate=', evt.entryDate || evt.t || 'missing',
          'releaseHour=', ENTRY_RELEASE_HOUR_SGT);
        return;
      }
      if (!(Number(evt.entry) > 0) || !(Number(evt.trailSl != null ? evt.trailSl : evt.sl) > 0)) {
        log('skip entry (missing entry/SL):', key);
        return;
      }
      // Defense in depth: if history still shows Hold for this key day, skip.
      // Missing history row must NOT block — board backfill can emit entry before
      // history ingest (SU.PA / AFL 2026-08-12). Trust the Buy/Sell event side.
      try {
        const hist = await fetchJson('/api/history');
        const rows = Array.isArray(hist) ? hist : [];
        const hz = evt.hz || 'short';
        const keyDay = String(key.split('|')[2] || '');
        const keyDayMs = Date.parse(keyDay);
        const h = rows.find(x => {
          if (!x || x.ticker !== evt.ticker) return false;
          if (String(x.hz || 'short') !== String(hz)) return false;
          const ms = Date.parse(x.entryDate || x.timestamp || 0);
          if (!Number.isFinite(ms)) return false;
          if (singaporeToDateString(ms) === keyDay) return true;
          return Number.isFinite(keyDayMs) && Math.abs(ms - keyDayMs) <= 2 * 3600 * 1000
            && singaporeToDateString(ms) === singaporeToDateString(keyDayMs);
        });
        if (h) {
          const act = String((h[hz + 'Action'] || h.action) || '').toLowerCase();
          if (act !== 'buy' && act !== 'sell') {
            log('skip entry (history not Buy/Sell):', key, 'action=', act || 'missing');
            return;
          }
        } else {
          log('entry history row missing — trusting event side', key, 'side=', side);
        }
      } catch (e) { log('entry history check failed (continuing with event side):', e.message); }
      // Age gate on the TRADE's entry date (not the event emit time). A stale
      // history re-save can emit a fresh evt.t for a months-old trade — that
      // must NEVER place a live order (AZN.L Jun-09 incident).
      const tradeTs = Date.parse(evt.entryDate || 0);
      const emitTs = Date.parse(evt.t || 0);
      const tradeAge = Date.now() - (Number.isFinite(tradeTs) ? tradeTs : emitTs);
      if (Number.isFinite(tradeAge) && tradeAge > MAX_EVENT_AGE_MS) {
        log('skip stale entry', key, '(trade age h:', (tradeAge / 3600000).toFixed(1) + ' — entryDate=', evt.entryDate || 'n/a', ')');
        return;
      }
      const emitAge = Date.now() - (Number.isFinite(emitTs) ? emitTs : 0);
      if (Number.isFinite(emitAge) && emitAge > MAX_EVENT_AGE_MS) {
        log('skip stale entry', key, '(emit age h:', (emitAge / 3600000).toFixed(1) + ')');
        return;
      }
      const placed = await placeBracket(evt);
      if (placed) state.byKey[key] = placed;
      return;
    }
    const row = state.byKey[key];
    if (evt.type === 'entry_finalized') {
      // Entries are MOO / MKT (outsideRth) — there is no parent limit to re-price.
      // Keep the finalized open on the row for analytics / slippage vs model only.
      if (row && evt.entry > 0) {
        row.entry = evt.entry;
        row.updated = evt.t || new Date().toISOString();
        saveState(state);
      }
      return;
    }
    if (evt.type === 'tsl_update') {
      if (!row || row.closed) { log('tsl_update for unknown/closed key', key); return; }
      const newStop = roundPx(evt.trailSl, row.contract);
      if (!(newStop > 0)) return;
      // Ratchet only — never loosen (mirror of the sim's "never down" rule).
      const improves = row.side === 'sell' ? newStop < row.stopPx : newStop > row.stopPx;
      if (!improves) return;
      row.stopPx = newStop;
      const qty = row.tp1Done ? row.qtyRunner : row.qtyTotal;
      transmitOrder(row.stopId, row.contract, baseOrder({
        orderId: row.stopId, action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'STP', auxPrice: newStop, totalQuantity: qty,
        parentId: row.parentId, transmit: true
      }), 'tsl ratchet ' + key);
      row.updated = evt.t;
      return;
    }
    if (evt.type === 'tp1_partial') {
      // Server-side confirmation (EOD). The realtime orderStatus handler usually
      // got here first; this is the fallback when the bridge restarted mid-day.
      if (row && !row.tp1Done && !row.closed) onTp1Filled(key, row);
      return;
    }
    if (evt.type === 'exit') {
      if (row && evt.errorTrade === true) row.errorTrade = true;
      if (row && evt.correctiveReentry === true) row.correctiveReentry = true;
      closeOut(key, row, 'server exit: ' + (evt.status || evt.exitReason || ''));
      return;
    }
    log('event (ignored)', evt.type, key);
  }

  // ── Orphan sweep: no order may outlive its trade ───────────────────────────
  function sweepOrphans() {
    if (DRY || !ib) return;
    try {
      const openIds = new Set();
      const onOpen = (orderId) => { openIds.add(orderId); };
      const onEnd = () => {
        ib.off(EventName.openOrder, onOpen);
        ib.off(EventName.openOrderEnd, onEnd);
        for (const [key, row] of Object.entries(state.byKey)) {
          if (!row.closed) continue;
          for (const [label, oid] of [['stop', row.stopId], ['tp1', row.tp1Id], ['parent', row.parentId]]) {
            if (oid != null && openIds.has(oid)) {
              log('ORPHAN sweep: cancelling', label, 'order', oid, 'for closed', key);
              cancelOrder(oid, 'orphan ' + key);
            }
          }
        }
      };
      ib.on(EventName.openOrder, onOpen);
      ib.on(EventName.openOrderEnd, onEnd);
      ib.reqAllOpenOrders();
    } catch (e) { log('sweep error', e.message); }
  }

  /**
   * Site open + IB flat (FANG/VTR/AIR): pull IB execution history and post the
   * real exit VWAP as role=flatten so the IBKR tab shows IB's exit price.
   */
  async function recoverMissingExitFills() {
    if (DRY || !ib || !EventName || !positionsReady) return;
    if (Date.now() - lastExecRecoverAt < 8 * 60 * 1000) return;
    lastExecRecoverAt = Date.now();
    let serverTrades = null;
    try { serverTrades = await fetchJson('/api/ibkr/trades'); }
    catch (e) { log('exec-history: trades fetch failed', e.message); return; }
    const need = (serverTrades.trades || []).filter(t => {
      if (!t || !(t.openQty > 0) || !t.key) return false;
      return ibSignedQtyForYahoo(t.ticker) === 0;
    });
    if (!need.length) return;
    log('exec-history: recovering exits for', need.map(t => t.ticker).join(','));
    const thesisOpen = new Set();
    try {
      const ev = await fetchJson('/api/ibkr/events?since=0&limit=4000&tail=1');
      const last = new Map();
      for (const e of (ev.events || [])) {
        if (!e || !e.key || (e.type !== 'entry' && e.type !== 'exit')) continue;
        last.set(e.key, e.type);
      }
      for (const [k, typ] of last) if (typ === 'entry') thesisOpen.add(k);
    } catch (e) { log('exec-history: events fetch failed', e.message); }

    const earliest = Math.min(
      ...need.map(t => Date.parse(t.entryTime || 0) || Date.now())
    );
    const fromMs = Math.max(earliest - 2 * 86400000, Date.now() - 14 * 86400000);
    _execHistBuf = [];
    const reqId = nextExecHistId++;
    _execHistReqId = reqId;
    await new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        _execHistReqId = null;
        try { ib.off(EventName.execDetailsEnd, onEnd); } catch (_) {}
        resolve();
      };
      const onEnd = (id) => {
        if (Number(id) !== reqId) return;
        finish();
      };
      timer = setTimeout(finish, 20000);
      try {
        ib.on(EventName.execDetailsEnd, onEnd);
        const filter = { time: formatIbExecFilterTime(fromMs) };
        if (ACCOUNT) filter.acctCode = ACCOUNT;
        ib.reqExecutions(reqId, filter);
      } catch (e) {
        log('exec-history: reqExecutions failed', e.message);
        finish();
      }
    });
    _execHistReqId = null;
    if (!_execHistBuf.length) {
      log('exec-history: no IB executions returned in window');
      return;
    }

    let queued = 0;
    const usedExecIds = new Set(); // dual-list (AIR.DE/PA) must not reuse the same IB exit
    // Prefer non-error / model listing first so AIR.DE claims fills before AIR.PA.
    need.sort((a, b) => Number(!!a.errorTrade) - Number(!!b.errorTrade));
    for (const t of need) {
      const aliases = yahooAliases(t.ticker);
      const wantClose = t.side === 'sell' ? 'BOT' : 'SLD'; // close long → SELL
      const entryMs = Date.parse(t.entryTime || 0) || 0;
      const matches = _execHistBuf.filter((e) => {
        const eid = String(e.exec.execId || '');
        if (eid && usedExecIds.has(eid)) return false;
        const ey = normalizeYahooTicker(yahooFromContract(e.contract) || '');
        if (!ey || !aliases.has(ey)) {
          // bare symbol match (IB AIR vs AIR.DE)
          const sym = String((e.contract && e.contract.symbol) || '').toUpperCase();
          const bare = String(t.ticker || '').toUpperCase().split('.')[0];
          if (!(sym && bare && sym === bare)) return false;
        }
        const side = String(e.exec.side || '').toUpperCase();
        const okSide = side === wantClose
          || side === (wantClose === 'SLD' ? 'SELL' : 'BUY')
          || side === (wantClose === 'SLD' ? 'S' : 'B');
        if (!okSide) return false;
        const ets = parseIbExecTime(e.exec.time || e.exec.dateTime || '');
        if (Number.isFinite(ets) && entryMs && ets + 120000 < entryMs) return false;
        return Number(e.exec.shares) > 0 && Number(e.price) > 0;
      });
      if (!matches.length) {
        log('exec-history: no closing fills for', t.ticker, t.key);
        continue;
      }
      // Live model thesis still open: an IB sell is a false orphan flatten
      // (DSY.PA vs DSY.DE), not a model exit. Do not close the model key.
      if (!t.errorTrade && thesisOpen.has(t.key)) {
        log('exec-history: skip model close — thesis still open', t.key,
          '(IB exit belongs on Error book, not model realised)');
        const cid = Number((state.byKey[t.key] && state.byKey[t.key].contract
          && state.byKey[t.key].contract.conId) || 0);
        if (cid > 0) _orphanFlattenedConIds.add(cid);
        if (state.byKey[t.key]) {
          state.byKey[t.key].restoreAfterFalseOrphan = true;
          state.byKey[t.key].entryFilled = false;
          state.byKey[t.key].closed = false;
          saveState(state);
        }
        continue;
      }
      let qSum = 0, vSum = 0;
      let lastTs = null;
      let lastExecId = null;
      for (const m of matches) {
        const q = Number(m.exec.shares) || 0;
        const p = Number(m.price) || 0;
        if (!(q > 0) || !(p > 0)) continue;
        qSum += q;
        vSum += q * p;
        lastTs = m.exec.time || m.exec.dateTime || lastTs;
        lastExecId = m.exec.execId || lastExecId;
        if (m.exec.execId) usedExecIds.add(String(m.exec.execId));
      }
      if (!(qSum > 0) || !(vSum > 0)) continue;
      const vwap = vSum / qSum;
      const closeQty = Math.min(Number(t.openQty), qSum);
      const fillAt = Number.isFinite(parseIbExecTime(lastTs))
        ? new Date(parseIbExecTime(lastTs)).toISOString()
        : new Date().toISOString();
      const cMeta = enrichSessionMeta(
        (state.byKey[t.key] && state.byKey[t.key].contract)
          || toContract(t.ticker)
      );
      const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
      state.pendingReports = state.pendingReports || [];
      state.pendingReports.push({
        kind: 'exec',
        execId: 'ibhist-flat-' + t.key + '-' + String(lastExecId || Date.now()),
        key: t.key,
        ticker: t.ticker,
        hz: t.hz || 'short',
        side: t.side === 'sell' ? 'sell' : 'buy',
        role: 'flatten',
        orderId: matches[0].orderId || null,
        qty: closeQty,
        price: +vwap.toFixed(6),
        currency: (cMeta && cMeta.currency) || t.currency || 'USD',
        ccyScale: cMeta && cMeta.penceQuoted ? 100 : 1,
        errorTrade: !!t.errorTrade,
        session: phase,
        sessionLabel: sessionLabel(phase),
        recon: 'ib-exec-history',
        markSrc: 'ibkr-exec',
        time: fillAt
      });
      if (state.byKey[t.key]) {
        state.byKey[t.key].closed = true;
        state.byKey[t.key].updated = new Date().toISOString();
      }
      queued++;
      log('exec-history: queued flatten', t.key, closeQty + '@' + vwap.toFixed(4),
        '(' + matches.length + ' IB exec(s))');
    }
    if (queued) {
      saveState(state);
      await flushReports();
    }
  }

  // ── IB ↔ AlphaSignal ledger sync ───────────────────────────────────────────
  // Posts paper positions + avgCost so the site open qty / entry avg / ghost
  // opens match DU1764495. Untracked IB leftovers are reported, not invented.
  let lastIbReconAt = 0;
  let lastIbReconResp = null;
  async function postIbRecon() {
    if (DRY || !ib || !positionsReady) return null;
    const positions = [];
    const marks = {};
    const seenCon = new Set();
    for (const [, { pos, contract }] of posMap) {
      if (!pos) continue;
      const conId = contract && contract.conId != null ? Number(contract.conId) : null;
      if (conId && seenCon.has(conId)) continue;
      if (conId) seenCon.add(conId);
      const y = normalizeYahooTicker(yahooFromContract(contract) || '');
      if (!y) continue;
      const avgCost = Number(portfolioAvgCost.get(y))
        || Number(portfolioMarks.get(y) && portfolioMarks.get(y).avgCost)
        || null;
      positions.push({
        ticker: y,
        qty: pos,
        avgCost: avgCost > 0 ? avgCost : null,
        currency: contract.currency || null,
        conId: conId || null,
        symbol: contract.symbol || null
      });
      const mk = portfolioMarks.get(y);
      if (mk && Number(mk.price) > 0) marks[y] = Number(mk.price);
    }
    const charges = takePendingCharges();
    try {
      const resp = await postJson('/api/ibkr/recon', {
        positions,
        marks,
        charges,
        account: ACCOUNT || accountSnap.account || '',
        accountSnapshot: {
          ...accountSnap,
          startingBalance: accountSnap.startingBalance,
          availableFunds: accountSnap.availableFunds,
          netLiquidation: accountSnap.netLiquidation,
          marginsUsed: accountSnap.marginsUsed,
          initMarginReq: accountSnap.initMarginReq,
          maintMarginReq: accountSnap.maintMarginReq,
          fullInitMarginReq: accountSnap.fullInitMarginReq,
          fullMaintMarginReq: accountSnap.fullMaintMarginReq,
          accruedCash: accountSnap.accruedCash,
          accruedDividend: accountSnap.accruedDividend,
          dividendReceivable: accountSnap.dividendReceivable
        }
      });
      if (!(resp && resp.ok) && charges.length) restorePendingCharges(charges);
      lastIbReconAt = Date.now();
      lastIbReconResp = resp;
      if (resp && resp.ok) {
        const bits = [
          'matched=' + (resp.matched || 0),
          'adjusted=' + (resp.adjusted || 0),
          'pending=' + (resp.pendingIssues || 0),
          'untracked=' + (resp.untrackedIb || 0)
        ];
        if (resp.storedFills) bits.push('fills+' + resp.storedFills);
        if (resp.avgFixed) bits.push('avgFix=' + resp.avgFixed);
        log('RECONCILE: IB↔AS', bits.join(' '), resp.inSync ? '✓' : '…');
        if (Array.isArray(resp.adjustedRows) && resp.adjustedRows.length) {
          log('RECONCILE: adjustments',
            resp.adjustedRows.map(a => a.action + ':' + a.ticker
              + (a.qty != null ? '×' + a.qty : '')
              + (a.to != null ? '@' + a.to : (a.price != null ? '@' + a.price : ''))
            ).join(' '));
        }
      }
      return resp;
    } catch (e) {
      if (charges.length) restorePendingCharges(charges);
      log('RECONCILE: IB↔AS recon failed', e.message);
      lastIbReconResp = { ok: false, error: e.message, inSync: false };
      return lastIbReconResp;
    }
  }

  /**
   * Risk digest for Telegram: untracked IB lots, ledger errors, and model
   * entries still unfilled during RTH (order not executed).
   */
  function collectRiskFindings(keyState, reconResp) {
    const findings = [];
    const resp = reconResp || lastIbReconResp;
    const isLocallyAuthorizedPosition = (ibRow) => {
      if (!ibRow || !ibRow.ticker) return false;
      const ibTicker = normalizeYahooTicker(ibRow.ticker);
      const ibConId = Number(ibRow.conId) || 0;
      const ibQty = Number(ibRow.qty) || 0;
      for (const [key, row] of Object.entries(state.byKey || {})) {
        if (!row || row.closed || row.errorTrade || !row.entryFilled) continue;
        const modelTicker = normalizeYahooTicker(row.ticker || key.split('|')[0]);
        const aliasesMatch = setHasYahooAlias(yahooAliases(modelTicker), ibTicker);
        const modelConId = Number(row.contract && row.contract.conId) || 0;
        const conIdMatch = ibConId > 0 && modelConId > 0 && ibConId === modelConId;
        if (!aliasesMatch && !conIdMatch) continue;
        const sideMatches = row.side === 'sell' ? ibQty < 0 : ibQty > 0;
        if (sideMatches) return true;
      }
      return false;
    };
    if (!positionsReady) {
      findings.push({ sev: 'warn', code: 'positions-not-ready', text: 'IB position snapshot not ready — reconcile deferred' });
    }
    if (resp && resp.ok === false && resp.error) {
      findings.push({ sev: 'error', code: 'recon-http', text: 'IB↔AS recon failed: ' + resp.error });
    }
    if (resp && resp.ok !== false) {
      if ((resp.untrackedIb || 0) > 0) {
        // The deployed server can briefly retain an older symbol/provenance
        // snapshot. Never alert or flatten when the live bridge state proves
        // the same conId/ticker, side and filled model key are still open.
        const untrackedRows = (resp.untrackedIbRows || [])
          .filter(r => !isLocallyAuthorizedPosition(r));
        const rows = untrackedRows.slice(0, 8)
          .map(r => `${r.ticker || '?'}×${r.qty != null ? r.qty : '?'}`).join(', ');
        if (untrackedRows.length || !(resp.untrackedIbRows || []).length) {
          const count = untrackedRows.length || Number(resp.untrackedIb) || 0;
          findings.push({
            sev: 'error',
            code: 'untracked',
            text: `Untracked IB position(s): ${count}${rows ? ' (' + rows + ')' : ''}`
          });
        }
      }
      if ((resp.errors || 0) > 0) {
        const errs = (resp.issues || []).filter(i => i && i.severity === 'error').slice(0, 6)
          .map(i => `${i.ticker || '?'}: ${i.message || i.code || 'error'}`).join('; ');
        findings.push({
          sev: 'error',
          code: 'recon-errors',
          text: `Recon errors: ${resp.errors}${errs ? ' — ' + errs : ''}`
        });
      }
      if ((resp.pendingIssues || 0) > 0) {
        const pend = (resp.issues || []).filter(i => i && i.severity === 'pending').slice(0, 6)
          .map(i => `${i.ticker || '?'}: ${i.message || i.code || 'pending'}`).join('; ');
        findings.push({
          sev: 'warn',
          code: 'recon-pending',
          text: `Pending execution / drift: ${resp.pendingIssues}${pend ? ' — ' + pend : ''}`
        });
      }
      if ((resp.adjusted || 0) > 0) {
        const adj = (resp.adjustedRows || []).slice(0, 6)
          .map(a => `${a.action || 'adj'}:${a.ticker || '?'}`
            + (a.qty != null ? '×' + a.qty : '')).join(', ');
        findings.push({
          sev: 'warn',
          code: 'recon-adjusted',
          text: `Ledger adjustments: ${resp.adjusted}${adj ? ' (' + adj + ')' : ''}`
        });
      }
    }

    // Model-open entries still not filled while the market is in RTH.
    const now = Date.now();
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || row.entryFilled) continue;
      if (keyState && keyState.get(key) !== 'open') continue;
      if (!row.contract) continue;
      const phase = sessionPhase(row.contract);
      if (phase !== 'rth') continue;
      const ageMs = row.updated ? (now - Date.parse(row.updated)) : (row.placedAt ? (now - Date.parse(row.placedAt)) : 0);
      const ageOk = Number.isFinite(ageMs) ? ageMs : 0;
      // Alert once the working order has had enough RTH time (or re-arm age).
      const rearmTs = row.lastRearmAt ? Date.parse(row.lastRearmAt) : NaN;
      const rearmAge = Number.isFinite(rearmTs) ? (now - rearmTs) : ageOk;
      const waitMs = Math.max(ageOk, rearmAge || 0);
      if (waitMs < UNFILLED_ALERT_MIN_MS) continue;
      const mins = Math.round(waitMs / 60000);
      findings.push({
        sev: 'error',
        code: row.contractRejected ? 'contract-rejected' : 'unfilled-rth',
        fingerprint: `${row.contractRejected ? 'contract-rejected' : 'unfilled-rth'}:${key}:${row.entryStyle || '?'}:${row.side || '?'}`,
        text: row.contractRejected
          ? `IB contract rejected (RTH ${mins}m): ${key} style=${row.entryStyle || '?'} side=${row.side || '?'}`
          : `Order NOT executed (RTH ${mins}m): ${key} style=${row.entryStyle || '?'} side=${row.side || '?'}`
      });
    }

    // Filled model lot with no protective stop id (bracket missing).
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || !row.entryFilled) continue;
      if (keyState && keyState.get(key) !== 'open') continue;
      if (row.stopId != null) continue;
      const pos = row.contract ? (posMap.get(posKeyOf(row.contract)) || {}).pos : 0;
      if (!pos) continue;
      findings.push({
        sev: 'error',
        code: 'missing-stop',
        text: `Risk: filled but no stop order id — ${key} IB pos=${pos}`
      });
    }
    return findings;
  }

  async function maybeSendRiskAlert(findings, { force = false } = {}) {
    if (!telegramConfigured() || DRY) return;
    const list = Array.isArray(findings) ? findings : [];
    // Human-readable elapsed minutes may change every poll; fingerprint only
    // the underlying incident so the configured alert cadence is respected.
    const fp = riskFindingsFingerprint(list);
    const now = Date.now();
    const meta = state.alertMeta || (state.alertMeta = {});
    const hadIssues = list.length > 0;
    const sameFp = meta.lastFp === fp;
    const withinGap = (now - (Number(meta.lastAt) || 0)) < ALERT_MIN_MS;

    // All-clear once when we recover from a prior alert state.
    if (!hadIssues) {
      if (meta.lastHadIssues) {
        try {
          await sendTelegramAlert(
            '✅ AlphaSignal IBKR risk check OK\n'
            + `Account: ${ACCOUNT || 'paper'}\n`
            + `Time: ${new Date().toISOString()}\n`
            + 'All trades matched — no untracked / unfilled RTH / recon errors.'
          );
          log('TELEGRAM: all-clear sent');
        } catch (e) { log('TELEGRAM: all-clear failed', e.message); }
        meta.lastHadIssues = false;
        meta.lastFp = 'ok';
        meta.lastAt = now;
        saveState(state);
      }
      return;
    }

    if (!force && sameFp && withinGap) return;

    const errors = list.filter(f => f.sev === 'error');
    const warns = list.filter(f => f.sev !== 'error');
    const lines = [
      '🚨 AlphaSignal IBKR risk alert',
      `Account: ${ACCOUNT || 'paper'}`,
      `Time: ${new Date().toISOString()}`,
      `Reconcile cadence: every ${(SWEEP_MS / 60000).toFixed(0)} min`,
      ''
    ];
    if (errors.length) {
      lines.push('ERRORS:');
      for (const f of errors.slice(0, 12)) lines.push('• ' + f.text);
    }
    if (warns.length) {
      lines.push('WARNINGS:');
      for (const f of warns.slice(0, 12)) lines.push('• ' + f.text);
    }
    lines.push('');
    lines.push('Bridge will keep reconciling / re-arming / flattening orphans. Check TWS + History if this repeats.');

    try {
      await sendTelegramAlert(lines.join('\n'));
      log('TELEGRAM: risk alert sent (', list.length, 'finding(s))');
      meta.lastFp = fp;
      meta.lastAt = now;
      meta.lastHadIssues = true;
      saveState(state);
    } catch (e) {
      log('TELEGRAM: send failed', e.message);
    }
  }

  /** US post-market ends 20:00 ET ≈ 00:00 UTC (EDT). Return ET session date if we should send. */
  function usEodSummaryDayKey(nowMs = Date.now()) {
    const d = new Date(nowMs);
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    // Tue–Sat UTC: session that ended at this UTC midnight (Mon–Fri ET).
    if (!(dow >= 2 && dow <= 6)) return null;
    // Primary window: first EOD_WINDOW_MIN after post-close.
    // Catch-up until 12:00 UTC (20:00 SGT) if the bridge was down overnight.
    const catchUpUntil = Math.max(EOD_WINDOW_MIN, 12 * 60);
    if (!(utcMin >= 0 && utcMin < catchUpUntil)) return null;
    const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const et = new Date(midnightUtc - 4 * 3600 * 1000);
    return et.toISOString().slice(0, 10);
  }

  function fmtUsdSigned(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    return sign + '$' + Math.abs(v).toFixed(2);
  }

  function fmtUsdPlain(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return '$' + Number(n).toFixed(2);
  }

  async function buildEodPerformancePayload(dayKey) {
    let tradesPayload = null;
    try { tradesPayload = await fetchJson('/api/ibkr/trades'); }
    catch (e) { log('TELEGRAM EOD: trades fetch failed', e.message); }
    const tt = (tradesPayload && tradesPayload.totals) || {};
    const acct = (tradesPayload && tradesPayload.account) || {};
    const daily = Array.isArray(tradesPayload && tradesPayload.daily) ? tradesPayload.daily : [];
    let dayRow = daily.find(x => x && x.date === dayKey) || null;
    if (!dayRow && daily.length) dayRow = daily[daily.length - 1];
    const dayReal = dayRow && dayRow.realizedUsd != null ? Number(dayRow.realizedUsd) : null;
    const dayLabel = (dayRow && dayRow.date) || dayKey;

    const closedToday = ((tradesPayload && tradesPayload.trades) || [])
      .filter(t => {
        if (!t || t.errorTrade) return false;
        if (t.status !== 'closed' && t.status !== 'tp1_open') return false;
        const exitDay = String(t.exitTime || t.exitTs || t.closedAt || t.updatedAt || '').slice(0, 10);
        const entryDay = String(t.entryTime || t.entryDate || '').slice(0, 10);
        return exitDay === dayLabel || (!exitDay && entryDay === dayLabel && Number(t.realizedUsd));
      })
      .sort((a, b) => Math.abs(Number(b.realizedUsd) || 0) - Math.abs(Number(a.realizedUsd) || 0))
      .slice(0, 8);

    const openN = Number(tt.openCount) || 0;
    const closedN = Number(tt.closedCount) || 0;
    const netPnl = (Number(tt.realizedUsd) || 0) + (Number(tt.unrealizedUsd) || 0)
      - (Number(tt.openCommissionUsd) || 0);
    const snapshot = {
      date: dayLabel,
      session: 'us-post-close',
      account: acct.account || ACCOUNT || null,
      at: new Date().toISOString(),
      todayRealizedUsd: dayReal,
      realizedUsd: tt.realizedUsd != null ? Number(tt.realizedUsd) : null,
      unrealizedUsd: tt.unrealizedUsd != null ? Number(tt.unrealizedUsd) : null,
      netPnlUsd: +netPnl.toFixed(2),
      winRate: tt.winRate != null ? Number(tt.winRate) : null,
      wins: tt.wins != null ? Number(tt.wins) : null,
      losses: tt.losses != null ? Number(tt.losses) : null,
      openCount: openN,
      closedCount: closedN,
      currentBalance: acct.currentBalance != null ? Number(acct.currentBalance)
        : (acct.netLiquidation != null ? Number(acct.netLiquidation) : null),
      netLiquidityAvailable: acct.netLiquidityAvailable != null ? Number(acct.netLiquidityAvailable)
        : (acct.availableFunds != null ? Number(acct.availableFunds) : null),
      marginsUsed: acct.marginsUsed != null ? Number(acct.marginsUsed) : null,
      liquidityPct: acct.liquidityPct != null ? Number(acct.liquidityPct) : null,
      ibDailyPnl: accountSnap.dailyPnl != null ? Number(accountSnap.dailyPnl) : null,
      notableCloses: closedToday.map(t => ({
        ticker: t.ticker || null,
        side: t.side || null,
        hz: t.hz || null,
        realizedUsd: t.realizedUsd != null ? Number(t.realizedUsd) : null
      }))
    };
    const lines = [
      '📊 AlphaSignal IBKR — end of day',
      `Session: ${dayLabel} (after US post-market close)`,
      `Account: ${snapshot.account || 'paper'}`,
      `Sent: ${snapshot.at}`,
      '',
      '— Performance —',
      `Today realised: ${fmtUsdSigned(dayReal)}`,
      `Total realised (net): ${fmtUsdSigned(tt.realizedUsd)}`,
      `Unrealised: ${fmtUsdSigned(tt.unrealizedUsd)}`,
      `Net PnL: ${fmtUsdSigned(netPnl)}`,
      `Win rate: ${tt.winRate != null ? tt.winRate + '%' : '—'} (${tt.wins || 0}W / ${tt.losses || 0}L)`,
      `Trades: ${openN} open · ${closedN} closed`,
      '',
      '— Account —',
      `Balance: ${fmtUsdPlain(snapshot.currentBalance)}`,
      `Net liquidity avail: ${fmtUsdPlain(snapshot.netLiquidityAvailable)}`,
      `Margin used: ${fmtUsdPlain(snapshot.marginsUsed)}`,
      `Liquidity: ${snapshot.liquidityPct != null ? Number(snapshot.liquidityPct).toFixed(1) + '%' : '—'}`
        + (acct.liquidityRiskOff ? ' · NEW ENTRIES PAUSED' : '')
    ];
    if (snapshot.ibDailyPnl != null && Number.isFinite(snapshot.ibDailyPnl)) {
      lines.push(`IB daily PnL: ${fmtUsdSigned(snapshot.ibDailyPnl)}`);
    }
    if (closedToday.length) {
      lines.push('');
      lines.push('— Notable closes —');
      for (const t of closedToday) {
        lines.push(
          `• ${t.ticker || '?'} ${t.side || ''} ${t.hz || ''}: ${fmtUsdSigned(t.realizedUsd)}`
        );
      }
    }
    return { text: lines.join('\n'), snapshot };
  }

  async function maybeSendEodPerformanceSummary() {
    if (DRY || !EOD_ALERTS) return;
    const dayKey = usEodSummaryDayKey();
    if (!dayKey) return;
    const meta = state.alertMeta || (state.alertMeta = {});
    if (meta.eodSentDay === dayKey) return;
    try {
      const { text, snapshot } = await buildEodPerformancePayload(dayKey);
      // Durable analysis store on AlphaSignal (Render disk).
      try {
        const saved = await postJson('/api/ibkr/eod-performance', snapshot);
        if (saved && saved.ok) log('EOD performance persisted for', dayKey);
        else log('EOD performance persist soft-fail', saved && saved.error);
      } catch (e) {
        log('EOD performance persist failed:', e.message);
      }
      if (telegramConfigured()) {
        await sendTelegramAlert(text);
        log('TELEGRAM: EOD performance summary sent for', dayKey);
      } else {
        log('EOD recorded (Telegram off) for', dayKey);
      }
      meta.eodSentDay = dayKey;
      meta.eodSentAt = new Date().toISOString();
      saveState(state);
    } catch (e) {
      log('TELEGRAM: EOD summary failed', e.message);
    }
  }

  // ── Position reconciliation ─────────────────────────────────────────────────
  // The account is the source of truth for SHARES; AlphaSignal events are the
  // source of truth for which trades are model-authorized. Every sweep:
  //   1. Flatten ONLY error-tagged unauthorized names (Hold→Buy bugs, dual-list
  //      duplicates). NEVER flatten a live model recommendation (e.g. 9988 short).
  //      Untagged IB leftovers are left alone until the model exits or manual close.
  //   2. State rows flat at IB with no model-open key are marked closed; if the
  //      server still shows open qty, a synthetic stop exec is reported.
  async function reconcilePositions() {
    if (DRY || !ib) return;
    if (!positionsReady) { log('reconcile skipped — waiting for IB position snapshot'); return; }
    try {
      // tail=1 → NEWEST 2000 events (oldest-first truncation went stale past
      // the limit). Old keys whose entries fall outside the window fail closed:
      // unknown tickers are never flattened.
      const feed = await fetchJson('/api/ibkr/events?since=0&limit=2000&tail=1');
      const events = (feed && feed.events) || [];
      if (!events.length) return;
      const keyState = new Map(); // key -> 'open' | 'closed'
      for (const e of events) {
        if (!e.key) continue;
        if (e.type === 'entry') { if (!keyState.has(e.key)) keyState.set(e.key, 'open'); }
        else if (e.type === 'exit') keyState.set(e.key, 'closed');
      }
      // Open model lots by normalized Yahoo ticker (not SYM|CCY — that merged
      // dual listings and dropped padded HK codes from orphan eligibility).
      const openYahoo = new Set();
      const openQtyByYahoo = new Map(); // normalized yahoo -> model open qty
      for (const [key, st] of keyState) {
        if (st !== 'open') continue;
        const ticker = normalizeYahooTicker(key.split('|')[0]);
        if (!ticker) continue;
        openYahoo.add(ticker);
        const row = state.byKey[key];
        const q = row && (Number(row.qtyRunner) > 0 && row.tp1Done
          ? Number(row.qtyRunner)
          : Number(row.qtyTotal) || Number(row.qtySold) || 0);
        if (q > 0) openQtyByYahoo.set(ticker, (openQtyByYahoo.get(ticker) || 0) + q);
      }
      // Prefer live openQty from site fills when available (more accurate).
      try {
        const tr = await fetchJson('/api/ibkr/trades');
        for (const t of (tr && tr.trades) || []) {
          if (!t || !(t.openQty > 0) || t.errorTrade) continue;
          const y = normalizeYahooTicker(t.ticker);
          // Don't shrink below event-open presence
          openYahoo.add(y);
          const prev = openQtyByYahoo.get(y) || 0;
          // Use max of state estimate vs reported open (avoid under-protecting)
          openQtyByYahoo.set(y, Math.max(prev, Number(t.openQty) || 0));
        }
      } catch (_) { /* keep state-based qtys */ }

      // 0a. Cancel working orders for ANCIENT keys only (e.g. Jun-09 re-emits).
      // Do NOT use the 24h entry-event age here — open trades routinely live
      // multi-day; a 24h cut wrongly closed VTR/FANG/9988 and dropped their
      // market-data subscriptions. Only cancel if the key day is >7d old AND
      // IB holds no position for that contract.
      const STALE_ORDER_MS = 7 * 24 * 3600 * 1000;
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || row.staleCancelled || !row.contract) continue;
        const dayPart = key.split('|')[2];
        const keyTs = Date.parse(dayPart || 0);
        if (!Number.isFinite(keyTs) || (Date.now() - keyTs) <= STALE_ORDER_MS) continue;
        const held = posMap.get(posKeyOf(row.contract));
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir > 0) continue; // still live at IB — leave alone
        log('RECONCILE: cancelling ANCIENT trade orders', key, '(key age h:', ((Date.now() - keyTs) / 3600000).toFixed(1) + ')');
        cancelOrder(row.parentId, 'stale parent ' + key);
        cancelOrder(row.stopId, 'stale stop ' + key);
        if (row.tp1Id != null) cancelOrder(row.tp1Id, 'stale tp1 ' + key);
        row.closed = true;
        row.staleCancelled = true;
        row.updated = new Date().toISOString();
        saveState(state);
      }

      // 0a2. Re-open rows wrongly marked closed while IB still holds the shares
      // (recovery from the old 24h stale-cancel bug).
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row.closed || !row.staleCancelled || !row.contract) continue;
        const held = posMap.get(posKeyOf(row.contract));
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir <= 0) continue;
        row.closed = false;
        row.staleCancelled = false;
        row.entryFilled = true;
        log('RECONCILE: re-opened', key, '— IB still holds', posInDir, 'shares');
        saveState(state);
      }

      // Latest entry levels from the feed (state may have tp1=0 / stale stops).
      const entryByKey = new Map();
      for (const e of events) {
        if (e && e.type === 'entry' && e.key) entryByKey.set(e.key, e);
      }

      // History Hold-check: ONLY cancel *unfilled* parents.
      // Never flatten a filled position because history was rewritten to Hold
      // (conf demote / board refresh). That bug closed live Asia fills as
      // "signal/time exit". Filled trades exit via TP/SL or an explicit server
      // `exit` event only.
      try {
        const hist = await fetchJson('/api/history');
        const rows = Array.isArray(hist) ? hist : [];
        for (const [key, row] of Object.entries(state.byKey)) {
          if (row.closed || !row.ticker) continue;
          const hz = row.hz || 'short';
          const keyDay = String(key.split('|')[2] || '');
          const keyDayMs = Date.parse(keyDay);
          let h = rows.find(x => {
            if (!x || x.ticker !== row.ticker) return false;
            if (String(x.hz || 'short') !== String(hz)) return false;
            const ms = Date.parse(x.entryDate || x.timestamp || 0);
            if (!Number.isFinite(ms)) return false;
            if (singaporeToDateString(ms) === keyDay) return true;
            return Number.isFinite(keyDayMs) && Math.abs(ms - keyDayMs) <= 2 * 3600 * 1000
              && singaporeToDateString(ms) === singaporeToDateString(keyDayMs);
          });
          if (!h) {
            // Fall back to latest history row for ticker+hz (weekend re-keys
            // like BP.L Aug-09/10 never match key-day and kept re-arming forever).
            const same = rows.filter(x => x && x.ticker === row.ticker
              && String(x.hz || 'short') === String(hz))
              .sort((a, b) => Date.parse(b.entryDate || b.timestamp || 0)
                - Date.parse(a.entryDate || a.timestamp || 0));
            h = same[0] || null;
          }
          if (!h) continue;
          const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
          if (act === 'buy' || act === 'sell') continue;
          const live = entryByKey.get(key);
          const liveSide = live ? String(live.side || '').toLowerCase() : '';
          if (liveSide === 'buy' || liveSide === 'sell') {
            log('RECONCILE: skip hold-cancel — live entry still', liveSide, key, '(history=', act || 'Hold', ')');
            continue;
          }
          const contract = row.contract || toContract(row.ticker);
          const held = contract ? posMap.get(posKeyOf(contract)) : null;
          const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
          if (row.entryFilled || posInDir > 0) {
            log('RECONCILE: history is', act || 'Hold', 'but filled — keep until server exit', key);
            continue;
          }
          log('RECONCILE: history is', act || 'Hold', '— cancelling unfilled parent', key);
          if (row.parentId != null) cancelOrder(row.parentId, 'hold-cancel parent ' + key);
          if (row.stopId != null) cancelOrder(row.stopId, 'hold-cancel stop ' + key);
          if (row.tp1Id != null) cancelOrder(row.tp1Id, 'hold-cancel tp1 ' + key);
          row.closed = true;
          row.holdCancelledUnfilled = true;
          row.updated = new Date().toISOString();
          saveState(state);
        }
      } catch (e) { log('RECONCILE: history Hold-check failed', e.message); }

      // 0z. Seed missing state for open entry events (state loss / cursor past
      // entry / history-gate false skip). Recent entries, all markets.
      const SEED_MAX_AGE_MS = MAX_EVENT_AGE_MS; // same 24h gate as live entries
      for (const [key, stOpen] of keyState) {
        if (stOpen !== 'open') continue;
        const existing = state.byKey[key];
        // Re-seed rows that were Hold-cancelled while a live Buy/Sell event
        // was still open (NVDA 13 Aug: history fallback matched an old Hold).
        if (existing && !(existing.closed && existing.holdCancelledUnfilled)) continue;
        if (existing && existing.holdCancelledUnfilled) {
          const lastSeed = existing.holdReseedAt ? Date.parse(existing.holdReseedAt) : 0;
          if (lastSeed && Date.now() - lastSeed < 2 * 60 * 1000) continue;
          existing.holdReseedAt = new Date().toISOString();
          log('RECONCILE: re-seeding hold-cancelled unfilled', key);
          saveState(state);
        }
        const src = entryByKey.get(key);
        if (!src || !src.ticker) continue;
        const side = String(src.side || '').toLowerCase();
        if (side !== 'buy' && side !== 'sell') continue;
        if (!(Number(src.entry) > 0) || !(Number(src.sl || src.trailSl) > 0)) continue;
        const c = toContract(src.ticker);
        if (!c) continue;
        const tradeTs = Date.parse(src.entryDate || src.t || 0);
        const keyDayTs = Date.parse(String(key.split('|')[2] || ''));
        const oldest = Math.min(
          Number.isFinite(tradeTs) ? tradeTs : Infinity,
          Number.isFinite(keyDayTs) ? keyDayTs : Infinity
        );
        if (!Number.isFinite(oldest) || oldest === Infinity || (Date.now() - oldest) > SEED_MAX_AGE_MS) {
          log('RECONCILE: skip seed (stale key)', key);
          continue;
        }
        // If IB already holds this symbol in the trade direction, assume the
        // original fill survived state loss — mark filled, do not double-enter.
        const held = posMap.get(posKeyOf(c));
        const posInDir = held ? (src.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir > 0) {
          state.byKey[key] = {
            ticker: src.ticker, hz: src.hz, side: src.side,
            entry: src.entry, stopPx: src.sl || src.trailSl, tp1Px: src.tp1 || 0,
            entryStyle: 'MKT', entryFilled: true, closed: false,
            contract: c, qtyTotal: posInDir, updated: new Date().toISOString(),
            recoveredFromPosition: true
          };
          const avg = Number(portfolioAvgCost.get(normalizeYahooTicker(src.ticker)))
            || Number(src.entry) || 0;
          if (avg > 0) {
            state.pendingReports = state.pendingReports || [];
            state.pendingReports.push({
              kind: 'exec',
              execId: `recover-entry-${key}-q${posInDir}`,
              key, ticker: src.ticker, hz: src.hz || 'short',
              side: src.side === 'sell' ? 'sell' : 'buy', role: 'entry',
              orderId: null, qty: posInDir, price: avg,
              currency: c.currency || 'USD',
              ccyScale: c.penceQuoted ? 100 : 1,
              errorTrade: false, synthetic: true, recon: 'recover-entry',
              time: new Date().toISOString()
            });
          }
          log('RECONCILE: recovered filled row from IB position', key, 'qty', posInDir);
          saveState(state);
          continue;
        }
        log('RECONCILE: seeding missing entry from open event', key);
        try {
          const placed = await placeBracket(src);
          if (placed) {
            state.byKey[key] = placed;
            saveState(state);
          }
        } catch (e) {
          log('RECONCILE: seed place failed', key, e.message);
        }
      }

      // 0z2. Any market: model-open + IB holds shares but site has no fill →
      // report synthetic entry (fixes KHC "import/fill lag" untracked).
      try {
        const trFill = await fetchJson('/api/ibkr/trades');
        const siteOpen = new Set();
        for (const t of (trFill && trFill.trades) || []) {
          if (t && t.openQty > 0 && t.ticker) siteOpen.add(normalizeYahooTicker(t.ticker));
        }
        for (const [key, stOpen] of keyState) {
          if (stOpen !== 'open') continue;
          const src = entryByKey.get(key);
          if (!src || !src.ticker) continue;
          // Already filled live this session — never invent a second entry fill
          // (SU.PA: real 28@309.25 + recover-entry 28@302.25 → fake flatten×56).
          const live = state.byKey[key];
          if (live && (live.entryFilled || live.recoveredFromPosition)) continue;
          if ((state.pendingReports || []).some(r => r && r.key === key && r.role === 'entry')) continue;
          const y = normalizeYahooTicker(src.ticker);
          if (setHasYahooAlias(siteOpen, y)) continue;
          const c0 = toContract(src.ticker);
          if (!c0) continue;
          const held0 = posMap.get(posKeyOf(c0));
          const posInDir0 = held0 ? (src.side === 'sell' ? -held0.pos : held0.pos) : 0;
          if (!(posInDir0 > 0)) continue;
          const avg0 = Number(portfolioAvgCost.get(y)) || Number(src.entry) || 0;
          if (!(avg0 > 0)) continue;
          if (!state.byKey[key]) {
            state.byKey[key] = {
              ticker: src.ticker, hz: src.hz, side: src.side,
              entry: src.entry, stopPx: src.sl || src.trailSl, tp1Px: src.tp1 || 0,
              entryStyle: 'MKT', entryFilled: true, closed: false,
              contract: c0, qtyTotal: posInDir0, updated: new Date().toISOString(),
              recoveredFromPosition: true
            };
          } else {
            state.byKey[key].entryFilled = true;
            state.byKey[key].qtyTotal = posInDir0;
            state.byKey[key].recoveredFromPosition = true;
          }
          const execId0 = `recover-entry-${key}-q${posInDir0}`;
          state.pendingReports = state.pendingReports || [];
          if (!state.pendingReports.some(r => r.execId === execId0)) {
            state.pendingReports.push({
              kind: 'exec', execId: execId0, key, ticker: src.ticker, hz: src.hz || 'short',
              side: src.side === 'sell' ? 'sell' : 'buy', role: 'entry',
              orderId: null, qty: posInDir0, price: avg0,
              currency: c0.currency || 'USD', ccyScale: c0.penceQuoted ? 100 : 1,
              errorTrade: false, synthetic: true, recon: 'recover-entry',
              time: new Date().toISOString()
            });
            log('RECONCILE: import missing entry fill from IB', key, 'qty', posInDir0, '@', avg0);
          }
          saveState(state);
        }
      } catch (e) { log('RECONCILE: recover-entry import failed', e.message); }

      // 0. Re-arm unfilled parents still open on the model.
      //   • HK / JP: chase while model open (missed OPG must not stay dead)
      //   • EU / UK: OPG before open; hold through the auction; then MKT
      //   • US: OPG overnight; in pre/extended upgrade to LMT-EXT immediately
      //     when the live quote is at/better than the AlphaSignal entry; else
      //     stay OPG through 09:30. Never MKT-EXT (IB queues those until RTH).
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.ticker) continue;
        if (keyState.get(key) !== 'open' && !row.userReentry) continue;
        const contract = row.contract || toContract(row.ticker);
        if (!contract) continue;
        const market = contract.market || (contract.usRth ? 'US' : '');
        const phase = sessionPhase(contract);
        const asia = market === 'HK' || market === 'JP';
        const held = posMap.get(posKeyOf(contract));
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        // Only attribute fills to THIS parent — sibling horizons share a symbol
        // (e.g. 2914.T short filled must not mark 2914.T long filled).
        const parentFilledQty = orderFills[row.parentId] || 0;
        // False fill: sibling horizon stamped entryFilled while this OPG never
        // filled. Only clear when THIS parent has zero fills — otherwise we
        // re-arm and double-buy (2914.T long entered twice today).
        if (row.entryFilled && asia && phase === 'rth' && row.entryStyle === 'OPG'
          && parentFilledQty <= 0) {
          log('RECONCILE: clearing false entryFilled on OPG Asia row', key);
          row.entryFilled = false;
          saveState(state);
        }
        const cid = Number(contract.conId) || 0;
        const falseOrphanFlat = posInDir <= 0
          && !(row.errorTrade)
          && (row.restoreAfterFalseOrphan
            || (cid > 0 && _orphanFlattenedConIds.has(cid)));
        if (falseOrphanFlat && (row.entryFilled || parentFilledQty > 0) && phase === 'rth') {
          log('RECONCILE: restoring model lot after false orphan flatten', key, 'conId=' + cid);
          row.entryFilled = false;
          row.restoreAfterFalseOrphan = true;
          row.entryStyle = 'OPG';
          saveState(state);
        } else if (row.entryFilled || parentFilledQty > 0) {
          if (!row.entryFilled && parentFilledQty > 0) {
            row.entryFilled = true;
            saveState(state);
          }
          continue;
        }
        if (posInDir > 0 && parentFilledQty > 0) {
          row.entryFilled = true;
          saveState(state);
          continue;
        }
        // Never chase keys older than the event-age gate (prevents Aug 05
        // shorts / BP.L weekend re-keys being MKT-bought days later).
        // Explicit user re-entry (e.g. Friday BRK-B missed on error 200) is exempt.
        if (!row.userReentry) {
          const srcAge = entryByKey.get(key);
          const tradeTs = Date.parse((srcAge && (srcAge.entryDate || srcAge.t)) || 0);
          const keyDayTs = Date.parse(String(key.split('|')[2] || ''));
          const oldest = Math.min(
            Number.isFinite(tradeTs) ? tradeTs : Infinity,
            Number.isFinite(keyDayTs) ? keyDayTs : Infinity
          );
          if (Number.isFinite(oldest) && oldest !== Infinity && (Date.now() - oldest) > MAX_EVENT_AGE_MS) {
            log('RECONCILE: abandon stale unfilled key', key);
            if (row.parentId != null) cancelOrder(row.parentId, 'stale-unfilled parent ' + key);
            if (row.stopId != null) cancelOrder(row.stopId, 'stale-unfilled stop ' + key);
            if (row.tp1Id != null) cancelOrder(row.tp1Id, 'stale-unfilled tp1 ' + key);
            row.closed = true;
            row.staleUnfilledAbandoned = true;
            row.updated = new Date().toISOString();
            saveState(state);
            continue;
          }
        }
        const eu = market === 'XETRA' || market === 'EURONEXT' || market === 'LSE';
        const us = !!contract.usRth;

        let reason = null;
        if (asia) {
          if (phase === 'lunch') {
            // Wait for 13:00 HKT reopen — do not cancel/replace during the break
          } else if (phase === 'rth' && (row.entryStyle !== 'MKT' || row.contractRejected || row.deferred)) {
            reason = 'asia-rth';
          }
          else if (phase === 'rth' && row.entryStyle === 'MKT' && row.lastRearmAt
            && (Date.now() - Date.parse(row.lastRearmAt)) > 2 * 60 * 1000) {
            // Prior MKT place rejected (lot/tick/contract/lunch) — retry
            reason = 'asia-rth-retry';
          } else if (phase !== 'rth' && phase !== 'lunch' && row.entryStyle === 'MKT') reason = 'asia-to-opg';
          else if (!row.entryStyle) reason = 'asia-missing-style';
        } else if (eu && phase === 'rth' && (row.entryStyle === 'OPG' || row.restoreAfterFalseOrphan)) {
          if (row.restoreAfterFalseOrphan) {
            reason = 'eu-restore-after-orphan';
          } else if (minutesSinceEuRth() < AUCTION_HOLD_MIN) {
            log('RECONCILE: hold EU/UK OPG through auction', key, 'minsSinceRth=', minutesSinceEuRth());
          } else {
            reason = 'eu-rth-after-opg';
          }
        } else if (eu && phase === 'rth' && row.contractRejected) {
          reason = 'contract-retry';
        } else if (us) {
          if (phase === 'pre' || phase === 'post') {
            ensureMktData(row.ticker, contract);
            // Last 2 minutes of US pre: park unfilled LMT-EXT into the opening
            // auction so a gap-up still fills at 09:30 even above the buy entry.
            if (phase === 'pre' && isUsExtStyle(row.entryStyle)
              && minutesUntilUsRth() <= AUCTION_HOLD_MIN) {
              reason = 'us-pre-handoff-opg';
              log('RECONCILE: US pre handoff to OPG for cash open', key, 'minsToRth=', minutesUntilUsRth());
            } else {
            const q = await fetchEntryQuote(row.ticker, phase, row.side);
            const fav = premarketFavorable(row.side, row.entry, q.px);
            if (fav && row.entryStyle !== 'LMT-EXT') {
              reason = row.entryStyle === 'MKT-EXT' ? 'us-pre-mkt-to-lmt' : 'us-pre-favorable';
              log('RECONCILE: US pre/post gate OPEN', key, 'phase=' + phase, 'quote=', q.px, '(' + (q.src || '?') + ') entry=', row.entry, 'side=', row.side, 'was=', row.entryStyle);
            } else if (fav && row.entryStyle === 'LMT-EXT') {
              const want = extendedFillLimit(row.side, row.entry, q.px, contract);
              const have = Number(row.extLmt) || Number(row.entry) || 0;
              if (want > 0 && have > 0 && Math.abs(want - have) > 1e-6) {
                reason = 'us-pre-reprice';
                log('RECONCILE: US pre/post reprice', key, 'phase=' + phase, 'quote=', q.px, '(' + (q.src || '?') + ') lmt', have, '→', want);
              }
            } else if (q.px > 0 && !fav && isUsExtStyle(row.entryStyle)) {
              // Was chasing extended; quote no longer good → park at next open
              reason = 'us-pre-unfavorable-to-opg';
              log('RECONCILE: US pre/post gate CLOSED', key, 'quote=', q.px, 'entry=', row.entry, '→ OPG');
            }
            }
          } else if (phase === 'rth' && (row.entryStyle === 'OPG' || isUsExtStyle(row.entryStyle))) {
            if (row.entryStyle === 'OPG' && minutesSinceUsRth() < AUCTION_HOLD_MIN) {
              log('RECONCILE: hold US OPG through auction', key, 'minsSinceRth=', minutesSinceUsRth());
            } else {
              reason = 'us-rth-after-opg';
            }
          } else if (phase === 'closed' && (isUsExtStyle(row.entryStyle) || row.userReentry)) {
            // Overnight leftover extended order — convert to next-open OPG
            reason = 'us-overnight-to-opg';
          } else if (phase === 'rth' && row.contractRejected) {
            reason = 'contract-retry';
          } else if (row.userReentry && row.parentId == null) {
            reason = phase === 'rth' ? 'contract-retry' : 'us-overnight-to-opg';
          }
        }
        if (!reason) continue;

        const last = row.lastRearmAt ? Date.parse(row.lastRearmAt) : 0;
        const auctionNow = reason === 'us-pre-handoff-opg' || reason === 'us-rth-after-opg'
          || reason === 'eu-restore-after-orphan' || reason === 'eu-rth-after-opg'
          || reason === 'us-pre-favorable' || reason === 'us-pre-mkt-to-lmt'
          || reason === 'us-pre-reprice' || reason === 'us-pre-unfavorable-to-opg'
          || reason === 'asia-rth'
          || reason === 'us-overnight-to-opg';
        const contractRetryGap = Math.min(
          15 * 60 * 1000,
          Math.max(60 * 1000, Math.pow(2, Math.min(4, Number(row.rearmCount) || 0)) * 60 * 1000)
        );
        const minGap = reason === 'contract-retry'
          ? contractRetryGap
          : ((reason === 'asia-rth-retry' || auctionNow)
            ? (auctionNow ? 0 : 2 * 60 * 1000)
            : 15 * 60 * 1000);
        if (last && Date.now() - last < minGap) continue;

        try {
          const src = entryByKey.get(key) || {};
          // Cancel-confirm-place: never leave two parents live (place-then-cancel
          // double-filled 2914.T long). Lunch path never reaches here (no reason).
          const oldParent = row.parentId, oldStop = row.stopId, oldTp1 = row.tp1Id;
          const cancelWaits = [];
          if (oldParent != null) {
            cancelOrder(oldParent, 'rearm parent ' + key);
            cancelWaits.push(waitCancel(oldParent, 3500));
          }
          if (oldStop != null) {
            cancelOrder(oldStop, 'rearm stop ' + key);
            cancelWaits.push(waitCancel(oldStop, 3500));
          }
          if (oldTp1 != null) {
            cancelOrder(oldTp1, 'rearm tp1 ' + key);
            cancelWaits.push(waitCancel(oldTp1, 3500));
          }
          if (cancelWaits.length) await Promise.all(cancelWaits);
          const placed = await placeBracket({
            key, ticker: row.ticker, hz: row.hz, side: row.side || src.side,
            entry: src.entry != null ? src.entry : row.entry,
            tp1: src.tp1 != null ? src.tp1 : row.tp1Px,
            sl: src.sl != null ? src.sl : row.stopPx,
            trailSl: src.trailSl != null ? src.trailSl : (src.sl != null ? src.sl : row.stopPx),
            t: new Date().toISOString(),
            forceOpg: reason === 'us-pre-handoff-opg' || reason === 'us-overnight-to-opg'
              || reason === 'us-pre-unfavorable-to-opg',
            skipChase: reason === 'us-rth-after-opg' || reason === 'eu-rth-after-opg'
          });
          if (placed) {
            placed.lastRearmAt = new Date().toISOString();
            placed.rearmReason = reason;
            placed.rearmCount = (Number(row.rearmCount) || 0) + 1;
            placed.entryFilled = false;
            if (row.userReentry) placed.userReentry = true;
            state.byKey[key] = placed;
            log('RECONCILE: re-armed', key, 'reason=' + reason, '→', placed.entryStyle,
              'lot=' + (placed.contract && placed.contract.lotHint));
          } else {
            row.lastRearmAt = new Date().toISOString();
            log('RECONCILE: rearm place skipped (after cancel)', key, reason);
          }
          saveState(state);
        } catch (e) { log('RECONCILE: rearm failed', key, e.message); }
      }

      // 0e. Clear error-flatten tags when provenance says authorized — except
      // force-error tickers (AIR.DE / AIR.PA dual-list stay Error trades).
      for (const k of Object.keys(state.byKey)) {
        const row = state.byKey[k];
        if (!row) continue;
        const yClear = normalizeYahooTicker(row.ticker || '');
        if (isForceErrorTicker(yClear)) continue;
        if (setHasYahooAlias(openYahoo, yClear)
          && (row.errorTrade || row.flatReason === 'unauthorized-non-recommendation' || /\|error\|/.test(k))) {
          log('RECONCILE: clearing error-flatten state (provenance-authorized)', k);
          delete state.byKey[k];
          saveState(state);
        }
      }

      // 0e2. Resume flattens for rows already tagged unauthorized in local state
      // (Hold→Buy episode). Force-error tickers flatten even if provenance open.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row) continue;
        if (!row.errorTrade && row.flatReason !== 'unauthorized-non-recommendation'
          && row.flatReason !== 'dual-list-duplicate-accounting') continue;
        const yProt = normalizeYahooTicker(row.ticker || '');
        if (yProt && setHasYahooAlias(openYahoo, yProt) && !isForceErrorTicker(yProt)) {
          log('RECONCILE: skip state error-flatten — open MODEL entry', yProt, key);
          continue;
        }
        // Re-open if still held at IB (prior DAY MKT expired unfilled).
        if (row.closed) {
          const c0 = enrichSessionMeta(row.contract || toContract(row.ticker));
          const h0 = c0 ? posMap.get(posKeyOf(c0)) : null;
          if (!h0 || !h0.pos) continue;
          row.closed = false;
          saveState(state);
          log('RECONCILE: re-open unauthorized row still held', key, 'pos=' + h0.pos);
        }
        if (row.closed) continue;
        const contract = enrichSessionMeta(row.contract || toContract(row.ticker));
        if (!contract) continue;
        if (sessionPhase(contract) === 'lunch') continue;
        // US: only submit in true RTH — pre/closed DAY MKTs were dying unfilled
        if (contract.usRth && sessionPhase(contract) !== 'rth') continue;
        const pk = posKeyOf(contract);
        const held = posMap.get(pk);
        if (!held || !held.pos) { row.closed = true; saveState(state); continue; }
        // Dual-list: if this listing aliases an open model key, keep one model lot.
        // Skip when both sides are force-error (AIR.DE + AIR.PA → flatten all).
        let qty = Math.abs(held.pos);
        if (!isForceErrorTicker(yProt)) {
          const aliasModelOpen = [...keyState.entries()].some(([ek, st]) => {
            if (st !== 'open') return false;
            const et = normalizeYahooTicker(String(ek).split('|')[0] || '');
            return setHasYahooAlias(new Set([et]), yProt) && et !== yProt;
          });
          if (aliasModelOpen) {
            const modelLot = Number(row.qtyTotal) > 0 ? Number(row.qtyTotal)
              : (openQtyByYahoo.get([...yahooAliases(yProt)].find(a => openQtyByYahoo.has(a)) || '') || 0);
            qty = Math.max(0, Math.abs(held.pos) - (modelLot || 0));
            if (!(qty > 0)) {
              log('RECONCILE: dual-list accounting-only — keeping model lot, no flatten', key, 'pos=' + held.pos);
              row.closed = true;
              row.flatReason = 'dual-list-duplicate-accounting';
              saveState(state);
              continue;
            }
          }
        }
        const lastTry = _flattenTried.get('err|' + key) || 0;
        if (Date.now() - lastTry < 15 * 60 * 1000) continue;
        _flattenTried.set('err|' + key, Date.now());
        const fid = nid();
        const oc = orderContractFromPos(held.contract || contract);
        if (!oc || (!oc.conId && !oc.symbol)) continue;
        row.errorTrade = true;
        row.flatReason = row.flatReason || 'unauthorized-non-recommendation';
        row.closeIds = [...(row.closeIds || []), fid];
        row.updated = new Date().toISOString();
        saveState(state);
        log('RECONCILE: unauthorized-state flatten', key, 'pos=' + held.pos, 'qty=' + qty, 'phase=' + sessionPhase(contract));
        transmitOrder(fid, oc, baseOrder({
          orderId: fid, action: held.pos > 0 ? 'SELL' : 'BUY',
          orderType: 'MKT', totalQuantity: qty, tif: 'DAY', transmit: true
        }), 'error-flatten ' + key);
      }

      // 0e3. Force-error flatten from env + error-tickers.txt (includes AIR.*).
      if (ERROR_TRADE_TICKERS.size) {
        for (const [pk, { pos, contract }] of posMap) {
          if (!pos) continue;
          const y = yahooFromContract(contract);
          const yU = String(y || '').toUpperCase();
          const symU = String(contract.symbol || '').toUpperCase();
          const isErr = isForceErrorTicker(yU) || ERROR_TRADE_TICKERS.has(symU)
            || [...ERROR_TRADE_TICKERS].some(t => t.replace(/\.(DE|PA|L|HK|T)$/i, '') === symU);
          if (!isErr) continue;
          if (y && setHasYahooAlias(openYahoo, y) && !isForceErrorTicker(y)) {
            log('RECONCILE: skip ENV error-flatten — open MODEL entry', y);
            continue;
          }
          if (sessionPhase(contract) === 'lunch') continue;
          if (contract.usRth && sessionPhase(contract) === 'closed') continue;
          const lastTry = _flattenTried.get('err|' + pk) || 0;
          if (Date.now() - lastTry < 15 * 60 * 1000) continue;
          _flattenTried.set('err|' + pk, Date.now());
          const qty = Math.abs(pos);
          const fid = nid();
          const oc = orderContractFromPos(contract);
          if (!oc || (!oc.conId && !oc.symbol)) continue;
          const ticker = y || symU;
          const errKey = `${ticker}|error|${singaporeToDateString()}`;
          state.byKey[errKey] = {
            ...(state.byKey[errKey] || {}),
            ticker, hz: 'error', side: pos > 0 ? 'buy' : 'sell',
            contract: oc, closed: false, errorTrade: true,
            flatReason: 'env-error-ticker',
            closeIds: [...((state.byKey[errKey] && state.byKey[errKey].closeIds) || []), fid],
            qtyTotal: qty, updated: new Date().toISOString()
          };
          saveState(state);
          log('RECONCILE: ENV error-ticker flatten', errKey, 'pos=' + pos);
          transmitOrder(fid, oc, baseOrder({
            orderId: fid, action: pos > 0 ? 'SELL' : 'BUY',
            orderType: 'MKT', totalQuantity: qty, tif: 'DAY', transmit: true
          }), 'error-flatten ' + errKey);
        }
      }

      // 1. ONLY flatten explicitly unauthorized (error-tagged) names.
      // NEVER flatten a live model recommendation (open entry / non-error state).
      // Rule: execute & keep what the model recommended; do not close 9988 etc.
      // Recent entry events (within MAX_EVENT_AGE_MS) also protect by provenance.
      const recentEntryYahoo = new Set();
      for (const e of events) {
        if (!e || e.type !== 'entry' || !e.key) continue;
        const emitTs = Date.parse(e.t || e.entryDate || 0);
        if (!Number.isFinite(emitTs) || (Date.now() - emitTs) > MAX_EVENT_AGE_MS) continue;
        recentEntryYahoo.add(normalizeYahooTicker(e.key.split('|')[0]));
      }

      const unauthorizedYahoo = new Set();
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || !row.ticker) continue;
        if (!(row.errorTrade || row.flatReason === 'unauthorized-non-recommendation'
          || row.flatReason === 'env-error-ticker' || /\|error\|/.test(key))) continue;
        const y = normalizeYahooTicker(row.ticker);
        // Live open entry / alias / recent entry = genuine model trade.
        if (setHasYahooAlias(openYahoo, y) || setHasYahooAlias(recentEntryYahoo, y)) {
          log('RECONCILE: skip error-flatten — open MODEL entry protects', y, key);
          continue;
        }
        unauthorizedYahoo.add(y);
      }

      const protectedYahoo = new Set(openYahoo);
      for (const a of recentEntryYahoo) protectedYahoo.add(a);
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || row.closed || !row.ticker) continue;
        const y = normalizeYahooTicker(row.ticker);
        if (setHasYahooAlias(unauthorizedYahoo, y)) continue;
        if (row.errorTrade || /\|error\|/.test(key)) continue;
        protectedYahoo.add(y);
      }
      // Today's board protects ONLY names that also have a live model entry
      // (OPG not-yet-filled). Board/history ghosts (e.g. 0001.HK restored onto
      // the board with no open entry event) must NOT block IB-only orphan closes.
      try {
        const picks = await fetchJson('/api/dashboard/picks');
        const dd = picks && picks.dashData;
        if (dd) {
          for (const k of ['short', 'medium', 'long', 'shortSell', 'medSell', 'longSell']) {
            for (const r of (dd[k] || [])) {
              if (!r || !r.ticker) continue;
              const by = normalizeYahooTicker(r.ticker);
              if (setHasYahooAlias(openYahoo, by) || setHasYahooAlias(recentEntryYahoo, by)) {
                protectedYahoo.add(by);
              }
            }
          }
        }
      } catch (_) { /* board optional */ }
      // History-only opens (not on board / not in openYahoo) intentionally do
      // NOT protect — otherwise stale History rows blocked IB-only orphan closes.

      for (const [pk, { pos, contract }] of posMap) {
        if (!pos) {
          if (state.unauthStreak[pk]) { delete state.unauthStreak[pk]; saveState(state); }
          continue;
        }
        const cMeta = enrichSessionMeta(contract);
        const y = normalizeYahooTicker(yahooFromContract(cMeta) || '');
        if (!y) continue;
        const posConId = Number(cMeta.conId || contract.conId) || 0;
        const modelOwnsConId = posConId > 0 && Object.entries(state.byKey).some(([k, row]) => {
          if (!row || row.closed || !row.contract) return false;
          if (row.errorTrade || /\|error\|/.test(k)) return false;
          return Number(row.contract.conId) === posConId;
        });
        if (modelOwnsConId || setHasYahooAlias(protectedYahoo, y) || setHasYahooAlias(openYahoo, y)
          || setHasYahooAlias(recentEntryYahoo, y)) {
          const aliases = [...yahooAliases(y)];
          log('RECONCILE: skip orphan flatten — alias protected', y, 'aliases=', aliases.join(','),
            modelOwnsConId ? ('conId=' + posConId) : '');
          if (state.unauthStreak[pk]) { delete state.unauthStreak[pk]; saveState(state); }
          continue;
        }
        // Model-only book: IB position with no open model entry / history /
        // recent emit is an orphan (shows as "IB-only" on the site recon).
        // Flatten error-tagged names AND unprotected orphans — never 9988-style
        // protected model lots.
        // When the market is closed / pre-open, queue MKT+OPG so the close
        // hits tomorrow's opening auction (HK/JP/EU/US as each session opens).
        const isErrorTagged = setHasYahooAlias(unauthorizedYahoo, y);
        const isOrphanIbOnly = !isErrorTagged;
        const phase = sessionPhase(cMeta);
        // Debounce: require TWO consecutive sweeps agreeing + audit before flatten.
        const streak = (Number(state.unauthStreak[pk]) || 0) + 1;
        state.unauthStreak[pk] = streak;
        saveState(state);
        if (streak < 2) {
          log('RECONCILE: unauthorized/orphan candidate (debounce 1/2)', pk, 'pos=' + pos,
            'ticker=' + y, 'phase=' + phase, isOrphanIbOnly ? 'IB-only orphan' : 'error-tagged');
          continue;
        }
        const lastTry = _flattenTried.get(pk) || 0;
        if (Date.now() - lastTry < 15 * 60 * 1000) continue;
        _flattenTried.set(pk, Date.now());
        const qty = Math.abs(pos);
        const fid = nid();
        // Prefer conId + venue exchange — HK SMART+symbol "1" hits IB error 200
        // (0001.HK / CK Hutchison). Same shape as bracket placeOrder.
        const rawOc = orderContractFromPos(cMeta) || cMeta;
        const conId = Number(rawOc.conId || cMeta.conId) || 0;
        if (!(conId > 0)) {
          log('RECONCILE: skip orphan flatten — no conId', pk, y);
          continue;
        }
        const sec = String(rawOc.secType || cMeta.secType || 'STK').toUpperCase();
        let oc;
        if (sec === 'FUT' || sec === 'CRYPTO') {
          oc = placeableContract(Object.assign({}, cMeta, rawOc, { conId }));
        } else {
          const isHk = String(rawOc.currency || cMeta.currency || '') === 'HKD'
            || cMeta.market === 'HK' || /\.HK$/i.test(y);
          oc = {
            conId,
            symbol: rawOc.symbol != null ? String(rawOc.symbol) : undefined,
            localSymbol: rawOc.localSymbol || undefined,
            secType: 'STK',
            exchange: isHk ? 'SEHK' : 'SMART',
            primaryExch: rawOc.primaryExch || (isHk ? 'SEHK' : undefined),
            currency: rawOc.currency || cMeta.currency || 'USD'
          };
        }
        const action = pos > 0 ? 'SELL' : 'BUY';
        // RTH → market day order. Otherwise → opening auction (next session).
        const useOpg = phase !== 'rth';
        const tif = useOpg ? 'OPG' : 'DAY';
        log('RECONCILE: flattening', isOrphanIbOnly ? 'IB-ONLY ORPHAN' : 'UNAUTHORIZED',
          pk, 'pos=' + pos, 'ticker=' + y, 'streak=' + streak,
          'exch=' + oc.exchange, 'conId=' + conId,
          useOpg ? ('OPG→next open (' + phase + ')') : 'MKT RTH');
        if (conId > 0) _orphanFlattenedConIds.add(conId);
        transmitOrder(fid, oc, baseOrder({
          orderId: fid, action,
          orderType: 'MKT', totalQuantity: qty, tif, transmit: true,
          outsideRth: false
        }), (isOrphanIbOnly ? 'orphan-ib-only-flatten ' : 'unauthorized-flatten ') + pk
          + (useOpg ? ' OPG' : ' MKT'));
      }

      // No excess-qty trim — never reduce a live model lot (9988/0005/2914).

      // 1c. IB↔AS ledger sync (also runs on its own 60s timer — see postIbRecon).
      let serverTrades = null;
      await postIbRecon();
      // Prefer real IB exit prices from execution history when site is open / IB flat.
      await recoverMissingExitFills().catch(e => log('exec-history error', e.message));

      // 2. Rows flat at IB but never closed in state (exit filled while down).
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.contract) continue;
        // A pending or rejected parent with no fill is not a closed trade merely
        // because IB has no position yet. Re-arm logic owns these rows.
        if (!row.entryFilled) continue;
        const held = posMap.get(posKeyOf(row.contract));
        const flatAtIb = held ? held.pos === 0 : !posMap.has(posKeyOf(row.contract));
        if (!flatAtIb) continue;
        // Still model-open + IB flat: re-arm may re-enter unless this is an
        // error trade / already recovered via exec-history. Skip re-arm block
        // only for genuine live model names still held in thesis.
        const modelOpen = keyState.get(key) === 'open';
        const isErr = !!(row.errorTrade || ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase()));
        if (modelOpen && !isErr && ibSignedQtyForYahoo(row.ticker) === 0) {
          // Leave re-arm path for Asia chase — but still try to sync ledger if
          // server shows open qty (exec-history above should have closed it).
          try {
            if (!serverTrades) serverTrades = await fetchJson('/api/ibkr/trades');
            const t = (serverTrades.trades || []).find(x => x.key === key);
            if (t && t.openQty > 0) {
              // Do not invent stopPx; wait for next exec-history / yahoo recon.
              log('RECONCILE: model-open but IB flat — waiting exec-history/recon for', key);
            }
          } catch (_) { /* ignore */ }
          continue;
        }
        if (row.userReentry && !row.entryFilled) continue;
        row.closed = true;
        row.updated = new Date().toISOString();
        log('RECONCILE: marking', key, 'closed (flat at IB, model exited)');
        try {
          if (!serverTrades) serverTrades = await fetchJson('/api/ibkr/trades');
          const t = (serverTrades.trades || []).find(x => x.key === key);
          if (t && t.openQty > 0) {
            // Prefer portfolio / last mark over stopPx for missed fills.
            const mk = portfolioMarks.get(normalizeYahooTicker(row.ticker));
            const px = (mk && mk.price > 0) ? mk.price
              : (row.ibAvgFill > 0 ? row.ibAvgFill : row.stopPx);
            if (!(px > 0)) {
              log('RECONCILE: skip synth stop — no price for', key);
            } else {
              state.pendingReports = state.pendingReports || [];
              const fillAt = new Date().toISOString();
              const cMeta = enrichSessionMeta(row.contract || toContract(row.ticker));
              const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
              state.pendingReports.push({
                kind: 'exec', execId: `synth-${key}-${row.stopId || 'x'}`, key,
                ticker: row.ticker, hz: row.hz, side: row.side, role: 'flatten',
                orderId: row.stopId, qty: t.openQty, price: px,
                currency: row.contract.currency || 'USD',
                ccyScale: row.contract.penceQuoted ? 100 : 1,
                session: phase,
                sessionLabel: sessionLabel(phase),
                synthetic: true, recon: 'bridge-missed-exit',
                markSrc: (mk && mk.price > 0) ? 'ib-portfolio' : 'bridge-fallback',
                time: fillAt
              });
              log('RECONCILE: synthetic flatten reported for', key, t.openQty + '@' + px);
            }
          }
        } catch (e) { log('reconcile trades fetch failed:', e.message); }
        saveState(state);
      }

      // 15‑min risk digest → Telegram (untracked / unfilled RTH / recon errors).
      try {
        const findings = collectRiskFindings(keyState, lastIbReconResp);
        await maybeSendRiskAlert(findings);
      } catch (e) { log('TELEGRAM: risk check failed', e.message); }
      // Once per US session after post-market close (≈20:00 ET / 00:00 UTC EDT).
      try { await maybeSendEodPerformanceSummary(); }
      catch (e) { log('TELEGRAM: EOD check failed', e.message); }
    } catch (e) { log('reconcile error', e.message); }
  }

  async function pollOnce() {
    const data = await fetchJson(`/api/ibkr/events?since=${state.since}&limit=100`);
    const events = data.events || [];
    for (const evt of events) {
      try { await handleEvent(evt); } catch (e) { log('event error', evt.type, evt.ticker, e.message); }
      if (evt.seq > state.since) state.since = evt.seq;
    }
    if (events.length) { saveState(state); log(`Processed ${events.length} event(s); since=${state.since}`); }
    await flushReports();
  }

  // Push captured executions to AlphaSignal so the site's IBKR tab shows
  // real paper-account PnL. Reports stay queued until the server confirms.
  async function flushReports() {
    const pending = state.pendingReports || [];
    if (!pending.length) return;
    try {
      const resp = await postJson('/api/ibkr/report', { reports: pending });
      if (resp && resp.ok) {
        state.pendingReports = [];
        saveState(state);
        log(`Reported ${pending.length} execution(s) to AlphaSignal (stored=${resp.stored}, dup=${resp.skipped})`);
      }
    } catch (e) { log('report flush failed (will retry):', e.message); }
  }

  try {
    const st = await fetchJson('/api/ibkr/status');
    log('AlphaSignal IBKR feed OK', JSON.stringify(st));
  } catch (e) {
    log('WARN: cannot reach AlphaSignal feed:', e.message);
    log('Bridge keeps retrying. Set ALPHASIGNAL_URL to your deployed app.');
  }

  let lastSweep = 0;
  let lastMarks = 0;
  for (;;) {
    try { await pollOnce(); }
    catch (e) { log('poll error', e.message); }
    if (Date.now() - lastMarks > 10000) {
      lastMarks = Date.now();
      await flushMarks().catch(e => log('marks error', e.message));
    }
    // Ledger sync every 60s so qty/avg/PnL stay aligned without waiting for SWEEP.
    if (positionsReady && Date.now() - lastIbReconAt > 60 * 1000) {
      await postIbRecon().catch(e => log('recon error', e.message));
      await recoverMissingExitFills().catch(e => log('exec-history error', e.message));
    }
    // HK afternoon reopen: chase rows that are not on a live RTH MKT yet.
    // US pre: replace IB-ignored MKT-EXT / re-seed Hold-cancelled Buys now.
    if (!forceReconcile && positionsReady) {
      for (const row of Object.values(state.byKey)) {
        if (row.closed && row.holdCancelledUnfilled) { forceReconcile = true; break; }
        if (row.restoreAfterFalseOrphan && !row.closed && !row.entryFilled) { forceReconcile = true; break; }
        if (row.userReentry && !row.closed && !row.entryFilled) { forceReconcile = true; break; }
        if (row.closed || row.entryFilled || !row.contract) continue;
        if (row.contract.market === 'HK'
          && sessionPhase(row.contract) === 'rth'
          && (row.entryStyle !== 'MKT' || row.deferred || row.contractRejected)) {
          forceReconcile = true;
          break;
        }
        if (row.contract.usRth) {
          const usPh = sessionPhase(row.contract);
          if ((usPh === 'pre' || usPh === 'post') && !row.entryFilled) {
            forceReconcile = true;
            break;
          }
          if (usPh === 'rth' && !row.entryFilled
            && (row.entryStyle === 'OPG' || isUsExtStyle(row.entryStyle))) {
            forceReconcile = true;
            break;
          }
        }
        const euMkt = row.contract.market;
        if ((euMkt === 'XETRA' || euMkt === 'EURONEXT' || euMkt === 'LSE')
          && sessionPhase(row.contract) === 'rth'
          && (row.entryStyle === 'OPG' || row.contractRejected)) {
          forceReconcile = true;
          break;
        }
      }
    }
    if (forceReconcile || Date.now() - lastSweep > SWEEP_MS) {
      forceReconcile = false;
      lastSweep = Date.now();
      sweepOrphans();
      await reconcilePositions().catch(e => log('reconcile error', e.message));
    }
    // EOD summary is time-gated + once-per-day; cheap to check every poll.
    try { await maybeSendEodPerformanceSummary(); }
    catch (e) { log('TELEGRAM: EOD check failed', e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  toContract,
  parentEntrySpec,
  scheduledEntryReleaseAllowed,
  riskFindingsFingerprint
};
