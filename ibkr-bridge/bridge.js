#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge (v2)
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events (JSONL feed)
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and mirrors the AlphaSignal exit spec exactly:
 *
 *     entry        → parent MARKET / US pre-market LMT / cash-open OPG:
 *                      • US pre: if the live print is at/better than the model entry,
 *                        LMT @ the recommended cap immediately (buy rec 224 / pre 222 →
 *                        LMT 224, fills at ~222). Never MKT-EXT (IB queues those until 09:30).
 *                        Unfilled into 09:28 ET → OPG; keep OPG through the 09:30 auction
 *                        (do not cancel at the bell). After ~2 min of RTH still unfilled → MKT.
 *                      • US post / overnight: do not submit. 06:00 SGT recs wait for
 *                        the next US pre (LMT-EXT if the quote is at/better than entry,
 *                        else OPG). Never fill after 16:00 ET.
 *                      • US RTH first fire: MKT with chase cap; skipped when converting a
 *                        missed pre/OPG so the open print is taken.
 *                      • US fully closed: MOO for next open
 *                      • JP / HK / EU / UK: OPG before the open; hold OPG through the auction
 *                        (~2 min); only then MKT if still unfilled.
 *                      • Unfilled HK/JP still open on the model are re-armed
 *                        (missed Asia opens are chased while the signal is live)
 *                    + STP stop  @ SL   for the FULL quantity  (pre-TP1 an SL hit
 *                      exits the WHOLE position — same as the simulator)
 *                    + LMT TP1   @ TP1  for 50% (2+ lots) or 100% (1-lot / 1-contract
 *                      futures). Unsplittable lots are OCA with the stop so a TP1
 *                      fill exits the whole position and cancels the SL.
 *                    After the entry fill prints, TP1 and SL are rescaled off
 *                    the actual fill (same % as rec entry→TP1 / entry→SL).
 *                    If the parent was sent standalone (HK/JP) or a child was
 *                    rejected, the fill handler parks TP1+SL immediately — it
 *                    does not wait for the 60s / 15-min sweep.
 *                    TP2 on the live book is the runner TSL, not a second limit.
 *     TP1 fill     → IB orderStatus on the TP1 child only. Stop resized to the
 *                    runner and raised to breakeven. Server `tp1_partial` is ignored.
 *     tsl_update   → after TP1 is done (IB fill or remaining runner), ratchet
 *                    the live STP. Never loosen. Never apply if TP1 has not
 *                    actually been banked. TP2 is a History reference only.
 *     exit         → flatten only on a live Buy↔Sell flip or an operational
 *                    close (unauthorized / abandon / IB-flat). Paper `tp1_then_sl`
 *                    / time-limit / simulated SL are ignored.
 *
 *   Venue routing is the bridge's job, not the operator's: HK→SEHK, JP→TSEJ,
 *   LSE→LSE, otherwise SMART (then listing venue on IB error 200). A reject
 *   is not "parked" — TP1 / SL / entries retry until IB shows Working.
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
 *   IBKR_CLIENT_ID       manager socket (run-forever pins 27)
 *   IBKR_EXEC_POOL_SIZE  execution sockets including manager (default 20, max 25)
 *   IBKR_EXEC_POOL_START first worker id (default 30; skips 18/19/25-26/28-29)
 *   IBKR_ACCOUNT         paper account id (optional; IB default if unset)
 *   IBKR_DRY_RUN         1 = log only, no orders (default 1)
 *   IBKR_POLL_MS         default 15000
 *   RISK_PER_TRADE_PCT   default 0.003 (0.30% of IBKR NLV before caps)
 *   IBKR_MAX_EVENT_AGE_H default 24 — entry events older than this are skipped
 *                        (prevents replaying stale history on a fresh cursor)
 *   IBKR_ALLOW_NSE       1 = attempt NSE orders (default skip — IB restricts
 *                        NSE for most non-India accounts)
 *   IBKR_OUTSIDE_RTH     0 = restore per-venue outsideRth (US pre/Globex true,
 *                        cash RTH/OPG/Asia false). Default: true on every order.
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
const crypto = require('crypto');
const Holidays = require('date-holidays');
const { telegramConfigured, sendTelegramAlert } = require('./telegram');
const { calculateRiskSize, DEFAULT_LIMITS: RISK_SIZING_LIMITS } = require('../lib/risk/sizing');
const {
  tp1SoldQty,
  tp1OrderQty,
  isFullQtyTp1,
  synthesizeTp1Px,
  openIfAboveSpec,
  passiveCloseLimit,
  maybeTwoLotTotal,
  isLimitTp1Fill
} = require('../lib/ibkr/tp1-policy');
const { tslAfterTp1 } = require('../lib/ibkr/tsl-policy');
const { rebaseExitsFromFill } = require('../lib/ibkr/fill-rebase');
const { evaluatePortfolioAddition, DEFAULT_CAPS } = require('../lib/risk/portfolio');
const { BridgeSqliteStore } = require('../lib/storage/bridge-sqlite');
const { atomicWriteJsonSync } = require('../lib/storage/atomic-json');
const {
  ENTRY_RELEASE_HOUR_SGT,
  scheduledEntryReleaseAllowed,
  boardPublishedAtRelease,
  isManualEntryBypass
} = require('../lib/schedule/entry-release');
const {
  isLiveAuthorizedServerExit,
  shouldApplyLiveTslUpdate,
  isForceCashOpenTicker,
  ignoreServerExitForUnfilledForcePrint
} = require('../lib/ibkr/live-exit-authority');
const {
  preferredExchange,
  fallbackExchange,
  isRoutingError,
  isSessionBlockedError,
  isShortSaleReject,
  asiaCashBlocksRestingOrders,
  shouldDeferProtectiveChildren,
  ibLocalSymbol,
  placeableStkContract
} = require('../lib/ibkr/order-routing');
const {
  parseIbExecTime: parseIbExecTimeRaw,
  execHistoryFilter
} = require('../lib/ibkr/ib-exec-time');
const { estimateIbkrCommission, fillNeedsEstimatedCommission, applyEstimatedCommission } = require('../lib/ibkr/ib-commission');
const {
  YAHOO_FUTURES,
  INSTRUMENT_NOTIONAL_USD,
  orderedCommoditySpecs,
  specFields,
  ibFutSymbolToYahoo,
  isCommodityYahoo
} = require('../lib/ibkr/commodity-futures');
const {
  buildExecPoolIds,
  orderIdFloor,
  pickLeastBusy,
  rememberOrderClient,
  clientForOrder,
  rowOwningOrder,
  runWithConcurrency
} = require('../lib/ibkr/exec-client-pool');

const DRY = process.env.IBKR_DRY_RUN !== '0';
const BASE = String(process.env.ALPHASIGNAL_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.IBKR_EVENTS_TOKEN || '';
const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '7497', 10);
const _bracketParkPending = new Set();
/** Prefer env; else randomize per launch (avoids zombie clientId conflicts). */
const CLIENT_ID = (() => {
  const fromEnv = parseInt(process.env.IBKR_CLIENT_ID || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 20 + Math.floor(Math.random() * 40); // 20–59
})();
const ACCOUNT = process.env.IBKR_ACCOUNT || '';
const POLL_MS = Math.max(5000, parseInt(process.env.IBKR_POLL_MS || '15000', 10));
const MAX_EVENT_AGE_MS = Math.max(1, parseFloat(process.env.IBKR_MAX_EVENT_AGE_H || '24')) * 3600 * 1000;
const ALLOW_NSE = process.env.IBKR_ALLOW_NSE === '1';
/** Trial: send outsideRth on every order. IB accepts, ignores (2109), or rejects per venue. */
const ORDER_OUTSIDE_RTH = process.env.IBKR_OUTSIDE_RTH !== '0';
const EXEC_POOL_SIZE = Math.max(1, Math.min(25, parseInt(process.env.IBKR_EXEC_POOL_SIZE || '20', 10) || 20));
const EXEC_POOL_START = Math.max(1, parseInt(process.env.IBKR_EXEC_POOL_START || '30', 10) || 30);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'bridge-state.json');
const STATE_DB_FILE = process.env.STATE_DB_FILE || path.join(__dirname, 'bridge-state.sqlite');
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

function dashboardPaneFor(hz, side) {
  if (String(side || '').toLowerCase() === 'sell') {
    return hz === 'medium' ? 'medSell' : hz === 'long' ? 'longSell' : 'shortSell';
  }
  return hz === 'medium' ? 'medium' : hz === 'long' ? 'long' : 'short';
}

function publishedBoardHasPick(dashData, ticker, hz, side) {
  if (!dashData || !ticker) return false;
  const pane = dashboardPaneFor(hz, side);
  const y = normalizeYahooTicker(ticker);
  return (dashData[pane] || []).some(r => r && setHasYahooAlias(yahooAliases(y), normalizeYahooTicker(r.ticker)));
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
const { asiaUnfilledRearmReason } = require('../lib/ibkr/asia-entry-rearm');

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

const _logOnceKeys = new Set();
function logOnce(key, ...a) {
  const k = String(key || '');
  if (!k || _logOnceKeys.has(k)) return;
  _logOnceKeys.add(k);
  log(...a);
}

let bridgeStore;
function getBridgeStore() {
  if (bridgeStore !== undefined) return bridgeStore;
  try { bridgeStore = new BridgeSqliteStore(STATE_DB_FILE); }
  catch (error) {
    console.error('Bridge SQLite unavailable; atomic JSON fallback active:', error.message);
    bridgeStore = null;
  }
  return bridgeStore;
}
function loadState() {
  try {
    const store = getBridgeStore();
    const persisted = store && store.loadState();
    if (persisted) return persisted;
  } catch (error) { console.error('Bridge SQLite load failed:', error.message); }
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { legacy = { since: 0, byKey: {} }; }
  try { const store = getBridgeStore(); if (store) store.saveState(legacy); } catch (_) {}
  return legacy;
}
function saveState(st) {
  const payload = JSON.stringify(st);
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  const store = getBridgeStore();
  if (store) store.saveState(st, checksum);
  atomicWriteJsonSync(STATE_FILE, st, 2);
}

function fetchJson(urlPath) {
  const u = new URL(BASE + urlPath);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
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
 * Yahoo continuous futures (=F) → IB root. Commodity names prefer the most
 * liquid mini/micro that can sit near a $10k notional; see commodity-futures.js.
 * Front month is resolved live via reqContractDetails (with mini fallbacks).
 */

/** Yahoo crypto → IB CRYPTO (PAXOS). */
const YAHOO_CRYPTO = {
  'BTC-USD': { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', market: 'CRYPTO', lotHint: 0.0001 },
  'ETH-USD': { symbol: 'ETH', exchange: 'PAXOS', currency: 'USD', market: 'CRYPTO', lotHint: 0.001 }
};

/** Yahoo-style ticker → IB contract stub. Live orders are qualified by resolveInstrument(). */
/** SEHK/TSE names whose board lot is not the 100-share default. */
const BOARD_LOT_OVERRIDES = {
  '0669.HK': 500, '669.HK': 500,
  '0992.HK': 2000, '992.HK': 2000,
  '4062.T': 100
};
function boardLotHint(ticker, fallback) {
  const y = String(ticker || '').toUpperCase();
  if (BOARD_LOT_OVERRIDES[y] != null) return BOARD_LOT_OVERRIDES[y];
  const n = Number(fallback);
  return n > 0 ? n : 1;
}

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
      tradingClass: f.tradingClass,
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
  if (t.endsWith('.HK')) return { symbol: String(parseInt(t.replace(/\.HK$/, ''), 10)), secType: 'STK', exchange: 'SMART', primaryExch: 'SEHK', currency: 'HKD', lotHint: boardLotHint(t, 100), market: 'HK', yahooTicker: t, bloomberg: bloombergTicker(t) };
  if (t.endsWith('.T'))  return { symbol: t.replace(/\.T$/, ''),  secType: 'STK', exchange: 'SMART', primaryExch: 'TSEJ', currency: 'JPY', lotHint: boardLotHint(t, 100), market: 'JP', yahooTicker: t, bloomberg: bloombergTicker(t) };
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

function isAuctionEntryStyle(style) {
  return style === 'OPG' || style === 'LMT-OPEN' || style === 'MKT-OPEN';
}

function riskFindingsFingerprint(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return list.map(f => f.fingerprint || (f.code + ':' + f.text)).sort().join('|') || 'ok';
}
function shouldAlertReconFailure(resp) {
  return !!(resp && resp.ok === false && resp.error
    && (!resp.transient || Number(resp.failureMs) >= 3 * 60 * 1000));
}

const MARKET_CLOCKS = Object.freeze({
  US: { timeZone: 'America/New_York', country: 'US', open: 570, close: 960, preOpen: 240, postClose: 1200 },
  JP: { timeZone: 'Asia/Tokyo', country: 'JP', open: 540, close: 900, lunchStart: 690, lunchEnd: 750 },
  HK: { timeZone: 'Asia/Hong_Kong', country: 'HK', open: 570, close: 960, lunchStart: 720, lunchEnd: 780 },
  XETRA: { timeZone: 'Europe/Berlin', country: 'DE', open: 540, close: 1050 },
  EURONEXT: { timeZone: 'Europe/Paris', country: 'FR', open: 540, close: 1050 },
  LSE: { timeZone: 'Europe/London', country: 'GB', open: 480, close: 990 }
});
const holidayCalendars = new Map();
function localClock(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(nowMs));
  const get = type => (parts.find(p => p.type === type) || {}).value;
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekend: ['Sat', 'Sun'].includes(get('weekday')),
    date: `${get('year')}-${get('month')}-${get('day')}`
  };
}
function isMarketHoliday(clock, country) {
  if (!country) return false;
  try {
    if (!holidayCalendars.has(country)) holidayCalendars.set(country, new Holidays(country));
    return Boolean(holidayCalendars.get(country).isHoliday(new Date(`${clock.date}T12:00:00Z`)));
  } catch (_) { return false; }
}
/** DST-, weekend-, and holiday-aware listing session phase. */
function sessionPhase(contract, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow = d.getUTCDay(); // 0=Sun
  const m = contract.market || (contract.usRth ? 'US' : 'OTHER');
  if (m === 'GLOBE' || m === 'CRYPTO') {
    if (dow === 6) return 'closed';
    if (dow === 0 && utcMin < 22 * 60) return 'closed';
    return 'rth';
  }
  const w = MARKET_CLOCKS[m] || MARKET_CLOCKS.XETRA;
  const clock = localClock(nowMs, w.timeZone);
  if (clock.weekend || isMarketHoliday(clock, w.country)) return 'closed';
  const localMin = clock.minutes;
  if (m === 'US') {
    if (localMin >= w.open && localMin < w.close) return 'rth';
    if (localMin >= w.preOpen && localMin < w.open) return 'pre';
    if (localMin >= w.close && localMin < w.postClose) return 'post';
    return 'closed';
  }
  if (m === 'HK' && w.lunchStart != null
    && localMin >= w.lunchStart && localMin < w.lunchEnd) return 'lunch';
  if (m === 'JP' && w.lunchStart != null
    && localMin >= w.lunchStart && localMin < w.lunchEnd) return 'lunch';
  if (localMin >= w.open && localMin < w.close) return 'rth';
  if (localMin < w.open) return 'pre';
  return 'closed';
}

function nextSgtWeekdayMs(fromMs) {
  const recDay = singaporeToDateString(fromMs);
  let t = Number(fromMs) + 12 * 3600 * 1000;
  while (singaporeToDateString(t) === recDay) t += 3600 * 1000;
  for (let i = 0; i < 3; i++) {
    const label = singaporeToDateString(t);
    if (!label.startsWith('Sat') && !label.startsWith('Sun')) return t;
    t += 24 * 3600 * 1000;
  }
  return t;
}

/**
 * Unfilled HK/JP board names keep one extra cash session. A 24h gate from
 * Thursday 06:00 SGT abandons 6098.T at Friday 06:00 — two hours before TSE open.
 */
function asiaUnfilledCarryActive(row, key, nowMs = Date.now()) {
  if (!row || row.closed || row.entryFilled) return false;
  const contract = row.contract || toContract(row.ticker);
  const m = contract && contract.market;
  if (m !== 'JP' && m !== 'HK') return false;
  const recMs = Date.parse(String(key || '').split('|')[2] || '');
  if (!Number.isFinite(recMs)) return false;
  const recDay = singaporeToDateString(recMs);
  const nowDay = singaporeToDateString(nowMs);
  if (nowDay === recDay) return true;
  const nextDay = singaporeToDateString(nextSgtWeekdayMs(recMs));
  if (nowDay !== nextDay) return false;
  const phase = sessionPhase(contract, nowMs);
  if (phase === 'pre' || phase === 'rth' || phase === 'lunch') return true;
  const w = MARKET_CLOCKS[m];
  const localMin = localClock(nowMs, w.timeZone).minutes;
  return localMin < w.open;
}

/** Pinned 6098.T stays live until the parent fills (or 5 days), board drop or not. */
function forceCashOpenActive(row, nowMs = Date.now()) {
  if (!row || row.closed || row.entryFilled) return false;
  if (!isForceCashOpenTicker(row.ticker)) return false;
  const t = Date.parse(row.admittedAt || '');
  if (!Number.isFinite(t)) return true;
  return (Number(nowMs) - t) < 5 * 24 * 3600 * 1000;
}

function keepUnfilledWorking(row, key, nowMs = Date.now()) {
  return asiaUnfilledCarryActive(row, key, nowMs) || forceCashOpenActive(row, nowMs);
}

/** Keep OPG live through the opening auction; do not cancel at the bell. */
const AUCTION_HOLD_MIN = 2;

/** Minutes until US 09:30 ET (DST window in sessionPhase). Negative = already RTH. */
function minutesUntilUsRth(nowMs = Date.now()) {
  return MARKET_CLOCKS.US.open - localClock(nowMs, MARKET_CLOCKS.US.timeZone).minutes;
}

/** Minutes since US 09:30 ET (DST window). Negative = still pre. */
function minutesSinceUsRth(nowMs = Date.now()) {
  return localClock(nowMs, MARKET_CLOCKS.US.timeZone).minutes - MARKET_CLOCKS.US.open;
}

/** Minutes since Xetra / Euronext / LSE cash open (07:00 UTC in summer). */
function minutesSinceEuRth(nowMs = Date.now()) {
  return localClock(nowMs, MARKET_CLOCKS.XETRA.timeZone).minutes - MARKET_CLOCKS.XETRA.open;
}

/** Minutes since TSE / SEHK cash open. */
function minutesSinceMarketRth(market, nowMs = Date.now()) {
  const w = MARKET_CLOCKS[market];
  if (!w) return null;
  return localClock(nowMs, w.timeZone).minutes - w.open;
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
      outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'MKT-GLOBE'
    };
  }
  // IB SMART often rejects orderType 'MOO' (error 321). The portable form is
  // MKT + tif OPG (submit to the opening auction).
  if (contract.usRth) {
    if (opts.forceOpg && phase === 'pre') {
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'OPG' };
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
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'MKT' };
    }
    if (phase === 'pre') {
      // Premarket only: lift if quote is at or better than recommendation.
      // Must be LMT — IB SMART ignores outsideRth on MKT (2109 / 399) and holds
      // until 09:30, which is NOT a pre-market fill. Never chase after the
      // cash close (post) — that is not pre-market and not the opening print.
      if (opts.forceExt && quotePx > 0) {
        return {
          orderType: 'LMT', action, totalQuantity: qty,
          lmtPrice: roundPx(quotePx, contract, side === 'sell' ? 'down' : 'up'),
          tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'LMT-EXT'
        };
      }
      if (premarketFavorable(side, entryPx, quotePx)) {
        const lmt = extendedFillLimit(side, entryPx, quotePx, contract);
        return {
          orderType: 'LMT', action, totalQuantity: qty, lmtPrice: lmt,
          tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'LMT-EXT'
        };
      }
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'OPG' };
    }
    // 06:00 SGT board is for the next US cash session. Do not send OPG/LMT
    // overnight — recon places at the next pre (LMT-EXT or OPG).
    return { defer: true, entryStyle: 'DEFER-US-UNTIL-PRE', action, totalQuantity: qty };
  }
  if (phase === 'rth') {
    // TSE does not accept native MKT during continuous trading. IB converts it
    // to a limit at last — delayed last + a transmit:false STP child left 6098
    // sitting unfilled all afternoon. Send a through-limit that transmits now.
    if (contract.market === 'JP') {
      const ref = quotePx > 0 ? quotePx : entryPx;
      if (ref > 0) {
        const sell = side === 'sell';
        const raw = sell ? ref * 0.98 : ref * 1.02;
        return {
          orderType: 'LMT', action, totalQuantity: qty,
          lmtPrice: roundPx(raw, contract, sell ? 'down' : 'up'),
          tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: true, entryStyle: 'LMT-THROUGH'
        };
      }
    }
    // Late board after the cash open — take market now (HK/EU/UK)
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'MKT' };
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
        tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'LMT-OPEN'
      };
    }
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'MKT-OPEN' };
  }
  // Pre-open or after previous close → opening auction (EU/UK/Asia).
  // JP parent transmits alone: TSE bag children (STP) never ack, leaving the
  // parent at transmit:false for the whole cash session (6098.T 27 Aug).
  if (contract.market === 'JP') {
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: ORDER_OUTSIDE_RTH, transmit: true, entryStyle: 'OPG' };
  }
  return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: ORDER_OUTSIDE_RTH, transmit: false, entryStyle: 'OPG' };
}

function correctiveExtExitSpec(contract, originalSide, qty, quotePx) {
  const action = String(originalSide || '').toLowerCase() === 'sell' ? 'BUY' : 'SELL';
  const px = roundPx(quotePx, contract, action === 'SELL' ? 'down' : 'up');
  if (!(qty > 0) || !(px > 0)) return null;
  return {
    action,
    orderType: 'LMT',
    totalQuantity: qty,
    lmtPrice: px,
    tif: 'DAY',
    outsideRth: ORDER_OUTSIDE_RTH,
    transmit: true
  };
}

// ── FX sizing ────────────────────────────────────────────────────────────────
// Convert the contract currency to USD for NLV/stop-risk sizing.
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
async function shareSplit(entry, contract, lotOverride, riskInput = {}) {
  const e = Number(entry);
  if (!(e > 0)) return { total: 0, sold: 0, runner: 0 };
  const lot = Math.max(Number(lotOverride || contract.lotHint) || 1, contract.secType === 'CRYPTO' ? 1e-8 : 1);
  const localPerUsd = await usdToCurrency(contract.currency);
  const penceScale = contract.penceQuoted ? 100 : 1;
  const normalizedEntry = e / penceScale;
  const normalizedStop = Number(riskInput.stop) / penceScale;
  const sizing = calculateRiskSize({
    nlv: riskInput.nlv,
    entry: normalizedEntry,
    stop: normalizedStop,
    fxToUsd: 1 / localPerUsd,
    multiplier: contract.secType === 'FUT' ? Number(contract.multiplier) || 1 : 1,
    lot: contract.secType === 'CRYPTO' ? (lot > 0 && lot < 1 ? lot : 0.0001) : lot,
    allowFractional: contract.secType === 'CRYPTO',
    secType: contract.secType,
    advShares: riskInput.advShares,
    spreadBps: riskInput.spreadBps,
    drawdownPct: riskInput.drawdownPct,
    capitalScale: riskInput.capitalScale,
    allowMinLot: riskInput.allowMinLot === true,
    netLiquidityAvailable: riskInput.netLiquidityAvailable,
    liquidityFloorPct: riskInput.liquidityFloorPct,
    maxNotionalUsd: contract.secType === 'FUT' ? INSTRUMENT_NOTIONAL_USD : undefined
  });
  if (!sizing.eligible) {
    log('risk sizing rejected', contract.symbol, sizing.reason,
      'NLV=' + (Number(riskInput.nlv) || 0), 'entry=' + e, 'stop=' + riskInput.stop);
    return { total: 0, sold: 0, runner: 0, risk: sizing };
  }
  if (sizing.bindingLimit === 'min-lot-liquidity') {
    log('risk sizing 1-lot override (liquidity still above 20% NLV)', contract.symbol,
      sizing.reason, 'qty=' + sizing.quantity, 'notionalUsd=' + sizing.notionalUsd,
      'stopRiskUsd=' + sizing.stopRiskUsd);
  }
  let total = sizing.quantity;
  if (contract.secType === 'STK' && sizing.bindingLimit !== 'min-lot-liquidity') {
    const bumped = maybeTwoLotTotal({
      total, lot, nlv: riskInput.nlv, entry: normalizedEntry,
      fxToUsd: 1 / localPerUsd,
      multiplier: contract.secType === 'FUT' ? Number(contract.multiplier) || 1 : 1,
      maxPositionPct: RISK_SIZING_LIMITS.maxPositionPct,
      secType: contract.secType
    });
    if (bumped > total) {
      log('size bump to 2 lots for TP1 split', contract.symbol, total, '→', bumped);
      total = bumped;
    }
  }
  const sold = tp1OrderQty(total, lot);
  return { total, sold, runner: total - sold, risk: sizing };
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

/** LSE SETS pence bands — 666.1 was IB error 110 (band tick is 0.5). */
function lseTickSize(px) {
  const a = Math.abs(Number(px) || 0);
  if (a < 10) return 0.01;
  if (a < 50) return 0.05;
  if (a < 100) return 0.1;
  if (a < 500) return 0.1;
  if (a < 1000) return 0.5;
  if (a < 5000) return 1;
  return 5;
}

/** TSE yen ticks (post-2023 table). 6098 @17155 lives on the 10-yen band. */
function jpTickSize(px) {
  const a = Math.abs(Number(px) || 0);
  if (a < 1000) return 1;
  if (a < 5000) return 5;
  if (a < 10000) return 5;
  if (a < 30000) return 10;
  if (a < 50000) return 50;
  return 100;
}

/** Xetra / Euronext cash ticks (MiFID-style). 53.41 was IB error 110. */
function xetraTickSize(px) {
  const a = Math.abs(Number(px) || 0);
  if (a < 1) return 0.001;
  if (a < 2) return 0.002;
  if (a < 5) return 0.005;
  if (a < 10) return 0.01;
  if (a < 20) return 0.01;
  if (a < 50) return 0.01;
  if (a < 100) return 0.02;
  if (a < 200) return 0.05;
  if (a < 500) return 0.1;
  return 0.5;
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
  if (contract && (contract.market === 'LSE' || contract.penceQuoted)) {
    const tick = lseTickSize(n);
    const dp = tick >= 1 ? 0 : (String(tick).split('.')[1] || '').length;
    let stepped;
    if (dir === 'down') stepped = Math.floor(n / tick + 1e-9) * tick;
    else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-9) * tick;
    else stepped = Math.round(n / tick) * tick;
    return +stepped.toFixed(dp);
  }
  if (contract && (contract.market === 'JP' || contract.currency === 'JPY')) {
    const tick = jpTickSize(n);
    const dp = tick >= 1 ? 0 : (String(tick).split('.')[1] || '').length;
    let stepped;
    if (dir === 'down') stepped = Math.floor(n / tick + 1e-9) * tick;
    else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-9) * tick;
    else stepped = Math.round(n / tick) * tick;
    return +stepped.toFixed(dp);
  }
  if (contract && (contract.market === 'XETRA' || contract.market === 'EURONEXT' || contract.currency === 'EUR')) {
    const tick = xetraTickSize(n);
    const dp = tick >= 1 ? 0 : Math.min(8, (String(tick).split('.')[1] || '').length);
    let stepped;
    if (dir === 'down') stepped = Math.floor(n / tick + 1e-9) * tick;
    else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-9) * tick;
    else stepped = Math.round(n / tick) * tick;
    return +stepped.toFixed(dp);
  }
  const tick = n >= 1000 ? 1 : n >= 100 ? 0.1 : 0.01;
  const dp = tick >= 1 ? 0 : (String(tick).split('.')[1] || '').length;
  let stepped;
  if (dir === 'down') stepped = Math.floor(n / tick + 1e-12) * tick;
  else if (dir === 'up') stepped = Math.ceil(n / tick - 1e-12) * tick;
  else stepped = Math.round(n / tick) * tick;
  return +stepped.toFixed(dp);
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
    exchange: preferredExchange(c),
    currency: c.currency || 'USD'
  };
  const conId = Number(c.conId);
  if (conId > 0) out.conId = conId;
  if (c.symbol != null && c.symbol !== '') out.symbol = String(c.symbol);
  const ls = ibLocalSymbol(c.localSymbol);
  if (ls) out.localSymbol = ls;
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
function placeableContract(contract, exchangeOverride) {
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
  return placeableStkContract(contract, exchangeOverride);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | execPool=${EXEC_POOL_SIZE} from ${EXEC_POOL_START} | dryRun=${DRY} | outsideRth=${ORDER_OUTSIDE_RTH} | risk/trade=${(RISK_SIZING_LIMITS.riskPct * 100).toFixed(2)}% NLV`);
  log(`Reconcile every ${(SWEEP_MS / 60000).toFixed(0)}m | Telegram alerts=${telegramConfigured() ? 'ON' : 'OFF (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`
    + (telegramConfigured() && EOD_ALERTS ? ' | EOD summary after US post-close' : ''));
  if (!state.alertMeta || typeof state.alertMeta !== 'object') {
    state.alertMeta = { lastFp: '', lastAt: 0, lastHadIssues: false, eodSentDay: '' };
  }

  let ib = null;
  let EventName = null;
  let nextOrderId = 1;
  const execSlots = [];
  let execRr = 0;
  let activeClientId = CLIENT_ID;
  if (!state.orderClients || typeof state.orderClients !== 'object') state.orderClients = {};
  const orderFills = {}; // orderId -> filled qty (from orderStatus) — LOST on restart
  const orderAvgFill = new Map(); // orderId -> { avgFillPrice, lastFillPrice, filled }
  // Live positions from IB (survives restarts, unlike orderFills). Keyed
  // "SYMBOL|CCY" -> { pos, contract }. Populated by the reqPositions subscription.
  const posMap = new Map();
  const pendingOrders = new Map(); // orderId → { contract, order, label, exchange, retried }
  const unknownOrderIds = new Set(); // IB 10147 — gone, do not keep cancelling
  let positionsReady = false; // set once IB's initial position snapshot lands
  let forceReconcile = false; // set on positionEnd so Asia re-arms don't wait 5m
  const _seedBlocked = new Set(); // tickers/keys that failed portfolio risk this session
  const posKeyOf = c => {
    if (!c) return '';
    if (c.secType === 'FUT') {
      const digits = String(c.lastTradeDateOrContractMonth || '').replace(/\D/g, '');
      const month = digits.length >= 6 ? digits.slice(0, 6) : (digits || 'FUT');
      return `${String(c.symbol).toUpperCase()}|${month}|${c.currency || 'USD'}`;
    }
    if (c.secType === 'CRYPTO') {
      return `${String(c.symbol).toUpperCase()}|CRYPTO|${c.currency || 'USD'}`;
    }
    return `${String(c.symbol).toUpperCase()}|${c.currency}`;
  };
  function heldForContract(contract) {
    if (!contract) return null;
    const direct = posMap.get(posKeyOf(contract));
    if (direct) return direct;
    const cid = Number(contract.conId);
    if (cid > 0) {
      for (const v of posMap.values()) {
        if (v && v.contract && Number(v.contract.conId) === cid) return v;
      }
    }
    if (contract.secType === 'FUT') {
      const wantY = ibFutSymbolToYahoo(contract.symbol) || String(contract.yahooTicker || '').toUpperCase();
      const ccy = contract.currency || 'USD';
      for (const v of posMap.values()) {
        const c = v && v.contract;
        if (!c || c.secType !== 'FUT') continue;
        if ((c.currency || 'USD') !== ccy) continue;
        if (String(c.symbol || '').toUpperCase() === String(contract.symbol || '').toUpperCase()) return v;
        const haveY = ibFutSymbolToYahoo(c.symbol) || String(c.yahooTicker || '').toUpperCase();
        if (wantY && haveY && wantY === haveY) return v;
      }
    }
    return null;
  }
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
  const postedCommissionExecIds = new Set();
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

  function slotByClientId(clientId) {
    const cid = Number(clientId);
    return execSlots.find(s => s && s.clientId === cid) || null;
  }
  function pickExecSlot() {
    return pickLeastBusy(execSlots, execRr++) || slotByClientId(activeClientId) || execSlots[0] || null;
  }
  function nid(clientId) {
    const slot = (clientId != null ? slotByClientId(clientId) : null) || pickExecSlot();
    if (slot) {
      const id = slot.nextOrderId++;
      rememberOrderClient(state.orderClients, id, slot.clientId);
      return id;
    }
    const id = nextOrderId++;
    rememberOrderClient(state.orderClients, id, activeClientId);
    return id;
  }
  function nidForRow(row) {
    return nid(row && (row.placeClientId || row.parentClientId));
  }
  function apiForOrderId(orderId) {
    const row = rowOwningOrder(state.byKey, orderId);
    const cid = clientForOrder(orderId, {
      orderClients: state.orderClients, row, managerId: activeClientId
    });
    const slot = slotByClientId(cid);
    return (slot && slot.api) || ib;
  }
  function bumpInflight(clientId, delta) {
    const slot = slotByClientId(clientId);
    if (slot) slot.inflight = Math.max(0, (Number(slot.inflight) || 0) + delta);
  }
  function releasePending(orderId) {
    const pending = pendingOrders.get(Number(orderId));
    if (pending && pending.clientId) bumpInflight(pending.clientId, -1);
    pendingOrders.delete(Number(orderId));
  }

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

  function tzForContract(contract) {
    const m = (contract && (contract.market || (contract.usRth ? 'US' : ''))) || '';
    return (MARKET_CLOCKS[m] && MARKET_CLOCKS[m].timeZone) || 'UTC';
  }

  function parseIbExecTime(t, timeZone) {
    return parseIbExecTimeRaw(t, timeZone);
  }

  function ibExecIso(exec, contract) {
    const ms = parseIbExecTime(exec && (exec.time || exec.dateTime), tzForContract(contract));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
  }

  // Declared before IB error handler — early connect errors must not hit a TDZ.
  let mdType = Math.max(1, Math.min(4, parseInt(process.env.IBKR_MARKET_DATA_TYPE || '3', 10) || 3));
  let mdFellBack = false;
  let mdCompeteLogged = false;

  // Manager socket: env pin (run-forever = 27). Workers 30+.
  if (!process.env.IBKR_CLIENT_ID && Number(state.clientId) > 0) {
    activeClientId = Number(state.clientId);
  }

  if (!DRY) {
    const stoqey = require('@stoqey/ib');
    EventName = stoqey.EventName;
    ib = new stoqey.IBApi({ host: HOST, port: PORT, clientId: activeClientId });
    ib.on(EventName.error, (err, code, reqId) => {
      // 2104/2106/2158 are benign "market data farm OK" notices.
      // 10311 is a direct-route fee warning — the order is still live.
      if ([2104, 2106, 2107, 2158, 10311].includes(Number(code))) return;
      if (Number(code) === 10147) {
        unknownOrderIds.add(Number(reqId));
        logOnce('gone-' + reqId, 'IB 10147 — order already gone, will not re-cancel', reqId);
        noteCancelAck(Number(reqId), 'Cancelled');
        releasePending(Number(reqId));
        return;
      }
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
      if (Number(code) === 110) {
        const oid = Number(reqId);
        releasePending(oid);
        for (const [key, row] of Object.entries(state.byKey || {})) {
          if (!row || row.closed) continue;
          if (row.tp1Id === oid) {
            row.tp1Id = null;
            row.tp1RoutingFailed = true;
            logOnce('tick110-tp1-' + key, 'IB error 110 — TP1 tick rejected, backing off', key);
          }
          if (row.stopId === oid) {
            row.stopId = null;
            row.stopRoutingFailed = true;
            logOnce('tick110-stop-' + key, 'IB error 110 — stop tick rejected, backing off', key);
          }
        }
        saveState(state);
        return;
      }
      log('IB error', code, 'reqId=' + reqId, err && err.message ? err.message : err);
      if (Number(code) === 103 || Number(code) === 105) {
        markChildUnparked(Number(reqId), 'error ' + code);
      }
      const msg = err && err.message ? err.message : String(err || '');
      if (isRoutingError(code) || isSessionBlockedError(code, msg) || isShortSaleReject(code, msg)) {
        retryRejectedOrder(Number(reqId), Number(code), msg);
      }
      if (Number(code) === 200 || Number(code) === 201) {
        for (const [key, row] of Object.entries(state.byKey || {})) {
          if (!row || row.closed) continue;
          const closeHit = (row.closeIds || []).includes(reqId);
          if (row.parentId !== reqId && row.stopId !== reqId && row.tp1Id !== reqId && !closeHit) continue;
          if (!row.entryFilled && row.parentId === reqId) {
            row.contractRejected = true;
            row.updated = new Date().toISOString();
            saveState(state);
            forceReconcile = true;
            log('IB entry rejected — will retry', key, row.ticker, 'code=' + code);
          }
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
      const st = String(status || '');
      if (st === 'Submitted' || st === 'PreSubmitted' || st === 'Filled') {
        releasePending(Number(orderId));
        for (const row of Object.values(state.byKey || {})) {
          if (!row) continue;
          if (row.tp1Id === Number(orderId)) row.tp1RoutingFailed = false;
          if (row.stopId === Number(orderId)) row.stopRoutingFailed = false;
        }
      }
      onOrderStatus(orderId, status, Number(filled) || 0, avg);
    });
    // Real executions → queue a report for the AlphaSignal site (IBKR tab).
    ib.on(EventName.execDetails, (reqId, contract, exec) => {
      try {
        const orderId = Number(exec.orderId);
        const oa = orderAvgFill.get(orderId) || {};
        const px = pickFillPrice(exec.price, oa.avgFillPrice, oa.lastFillPrice, contract);
        // Historical pull buffer (reqExecutions). IB may tag them with the
        // request id, or with -1/0; only skip live posting for the matching id.
        if (_execHistReqId != null && (
          Number(reqId) === Number(_execHistReqId) || Number(reqId) < 0 || Number(reqId) === 0
        )) {
          _execHistBuf.push({ contract, exec, price: px, orderId });
          if (Number(reqId) === Number(_execHistReqId)) return;
        }
        for (const [key, row] of Object.entries(state.byKey)) {
          let role = null;
          const fillOrderType = String(exec.orderType || '').toUpperCase();
          const isFlattenOrder = (row.closeIds || []).includes(orderId)
            || !!row.tp1CoverSentAt;
          if (row.parentId === orderId) role = 'entry';
          else if (row.stopId === orderId) role = 'stop';
          else if ((row.closeIds || []).includes(orderId)) role = 'flatten';
          else if (row.tp1Id === orderId) {
            const spec = openIfAboveSpec(row.ticker);
            const tp1Px = Number(row.tp1Px) > 0
              ? Number(row.tp1Px)
              : (spec && spec.minPx) || synthesizeTp1Px(Number(row.ibAvgFill || row.entry), row.hz || 'short', row.side === 'sell');
            role = isLimitTp1Fill({
              fillPx: px, tp1Px, isSellPosition: row.side === 'sell',
              orderType: fillOrderType, isFlattenOrder
            }) ? 'tp1' : 'flatten';
            if (role === 'flatten') {
              log('TP1 fill recast to flatten (not a TP1 limit print)', key,
                'px=' + px, 'tp1=' + tp1Px, 'type=' + (fillOrderType || 'n/a'));
            }
          }
          // Side-client TP1 LMT still reports execs on client 27. Qty match is
          // not enough — the print must be at/through TP1 and not a MKT flatten.
          if (!role && row && !row.closed && row.entryFilled && !row.tp1Done && !isFlattenOrder) {
            const yExec = normalizeYahooTicker(yahooFromContract(contract));
            const yRow = normalizeYahooTicker(row.ticker);
            const cid = Number(row.contract && row.contract.conId) || 0;
            const cidExec = Number(contract && contract.conId) || 0;
            const match = (cid > 0 && cidExec === cid) || (!!yExec && yExec === yRow);
            if (match) {
              const execSide = String(exec.side || '').toUpperCase();
              const isClose = row.side === 'sell' ? execSide === 'BOT' : execSide === 'SLD';
              const shares = Number(exec.shares) || 0;
              const lot = Number(row.contract && row.contract.lotHint) || 1;
              const held = row.contract ? heldForContract(row.contract) : null;
              const posInDir = held
                ? (row.side === 'sell' ? Math.max(0, -held.pos) : Math.max(0, held.pos))
                : (Number(row.qtyTotal) || 0);
              const spec = openIfAboveSpec(row.ticker);
              const half = spec && spec.qty > 0
                ? Number(spec.qty)
                : (tp1OrderQty(posInDir || Number(row.qtyTotal) || 0, lot) || Number(row.qtySold) || 0);
              const tp1Px = Number(row.tp1Px) > 0
                ? Number(row.tp1Px)
                : (spec && spec.minPx) || synthesizeTp1Px(Number(row.ibAvgFill || row.entry), row.hz || 'short', row.side === 'sell');
              if (isClose && half > 0 && Math.abs(shares - half) < 1e-6
                && isLimitTp1Fill({
                  fillPx: px, tp1Px, isSellPosition: row.side === 'sell',
                  orderType: fillOrderType, isFlattenOrder: false
                })) {
                role = 'tp1';
                row.tp1Id = orderId;
                row.qtySold = shares;
                row.qtyRunner = Math.max(0, posInDir - shares);
                row.qtyTotal = Math.max(Number(row.qtyTotal) || 0, posInDir, shares);
              }
            }
          }
          if (!role) continue;
          if (role === 'tp1') onTp1Filled(key, row);
          if (role === 'entry') {
            row.entryFilled = true;
            if (Number.isFinite(oa.avgFillPrice) && oa.avgFillPrice > 0) {
              row.ibAvgFill = oa.avgFillPrice;
            } else if (Number(px) > 0) {
              row.ibAvgFill = px;
            }
            applyFillRebase(key, row, row.ibAvgFill);
            scheduleProtectiveBracket(key);
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
            decisionId: row.decisionId || null,
            rulesVersion: row.rulesVersion || null,
            modelEntry: Number(row.entry) || null,
            arrivalPrice: Number(row.arrivalPrice) || null,
            quoteSource: row.quoteSource || null,
            orderType: row.entryStyle || null,
            fillOrderType: fillOrderType || null,
            orderSubmittedAt: row.orderSubmittedAt || null,
            implementationShortfallBps: role === 'entry' && Number(row.entry) > 0
              ? +(((row.side === 'sell' ? Number(row.entry) - px : px - Number(row.entry))
                / Number(row.entry)) * 10000).toFixed(2)
              : null,
            currency: row.contract && row.contract.currency || 'USD',
            ccyScale: row.contract && row.contract.penceQuoted ? 100 : 1,
            multiplier: row.contract && row.contract.secType === 'FUT'
              ? (Number(row.contract.multiplier) || null) : null,
            ibSymbol: row.contract && row.contract.symbol || null,
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
    execSlots.push({
      clientId: activeClientId,
      api: ib,
      nextOrderId,
      ready: true,
      inflight: 0,
      manager: true
    });
    log('Connected to IB paper. manager clientId=', activeClientId, 'starting orderId=', nextOrderId);

    const poolIds = buildExecPoolIds(activeClientId, EXEC_POOL_SIZE, EXEC_POOL_START);
    for (const cid of poolIds) {
      if (cid === activeClientId) continue;
      try {
        const api = new stoqey.IBApi({ host: HOST, port: PORT, clientId: cid });
        for (const ev of [EventName.error, EventName.orderStatus, EventName.execDetails]) {
          for (const fn of ib.listeners(ev)) api.on(ev, fn);
        }
        let workerReady = false;
        api.on(EventName.disconnected, () => {
          const slot = slotByClientId(cid);
          if (slot) slot.ready = false;
          if (workerReady) log('exec worker disconnected', cid);
        });
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('connect timeout')), 12000);
          api.once(EventName.connected, () => { clearTimeout(t); resolve(); });
          api.connect();
        });
        const ibNext = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('nextValidId timeout')), 12000);
          api.once(EventName.nextValidId, id => { clearTimeout(t); resolve(Number(id) || 1); });
          api.reqIds();
        });
        workerReady = true;
        const startId = orderIdFloor(cid, ibNext);
        execSlots.push({
          clientId: cid, api, nextOrderId: startId, ready: true, inflight: 0, manager: false
        });
        log('exec worker connected', cid, 'orderId=', startId);
      } catch (e) {
        log('exec worker skipped', cid, e.message);
      }
    }
    log('exec pool ready', execSlots.filter(s => s.ready).map(s => s.clientId).join(',')
      || String(activeClientId));
    try { ib.reqMarketDataType(mdType); log('marketDataType=' + mdType + (mdType === 1 ? ' (live)' : mdType === 3 ? ' (delayed)' : '')); } catch (_) {}
    // Subscribe to positions — the source of truth for how many shares are
    // actually held (orderFills is in-memory only and dies with each restart).
    ib.on(EventName.position, (account, contract, pos) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      const key = posKeyOf(contract);
      const quantity = Number(pos) || 0;
      if (!quantity) posMap.delete(key);
      else posMap.set(key, { pos: quantity, contract: enrichSessionMeta(contract) });
    });
    ib.on(EventName.positionEnd, () => {
      const first = !positionsReady;
      positionsReady = true;
      if (first) {
        forceReconcile = true;
        log('IB position snapshot ready —', posMap.size, 'symbol(s)');
      }
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
      if (!contract) return;
      if (!pos) {
        posMap.delete(posKeyOf(contract));
        return;
      }
      if (!(px > 0)) return;
      posMap.set(posKeyOf(contract), {
        pos,
        contract: enrichSessionMeta(contract),
        marketPrice: px,
        marketValue: Number(marketValue),
        averageCost: avgCost
      });
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
      return ibFutSymbolToYahoo(sym);
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
      const symbols = [];
      const cleanLocal = ibLocalSymbol(contract.localSymbol);
      if (cleanLocal) symbols.push(cleanLocal);
      if (contract.symbol) symbols.push(String(contract.symbol));
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
          localSymbol: ibLocalSymbol(pick.localSymbol) || ibLocalSymbol(contract.localSymbol),
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
    const specs = orderedCommoditySpecs(yKey, contract.entryPx);
    if (specs.length && specFields(specs[0])) {
      Object.assign(contract, specFields(specs[0]), { yahooTicker: contract.yahooTicker, secType: 'FUT' });
    }
    if (DRY || !ib || !EventName) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + 1);
      const yyyymm = String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0');
      contract.lastTradeDateOrContractMonth = yyyymm;
      contract.needsFrontMonth = false;
      return contract;
    }
    const reqOneFutFront = (spec) => new Promise(resolvePick => {
      const reqId = nextDetailsId++;
      const cands = [];
      let done = false;
      const wantMult = Number(spec.multiplier);
      const wantClass = spec.tradingClass ? String(spec.tradingClass).toUpperCase() : '';
      const finish = () => {
        if (done) return;
        done = true;
        try { ib.off(EventName.contractDetails, onDet); } catch (_) {}
        try { ib.off(EventName.contractDetailsEnd, onEnd); } catch (_) {}
        const today = new Date();
        const todayKey = String(today.getUTCFullYear())
          + String(today.getUTCMonth() + 1).padStart(2, '0')
          + String(today.getUTCDate()).padStart(2, '0');
        const matched = cands.filter(x => {
          if (wantClass && String(x.tradingClass || '').toUpperCase() !== wantClass
            && String(x.symbol || '').toUpperCase() !== String(spec.symbol).toUpperCase()) {
            return false;
          }
          if (wantMult > 0 && Number(x.multiplier) > 0
            && Math.abs(Number(x.multiplier) - wantMult) > 1e-6) return false;
          return true;
        });
        const pool = matched.length ? matched : cands;
        const live = pool
          .filter(x => String(x.month || '') >= todayKey.slice(0, 6))
          .sort((a, b) => String(a.month).localeCompare(String(b.month)));
        resolvePick(live[0] || pool.sort((a, b) => String(a.month).localeCompare(String(b.month)))[0] || null);
      };
      const t = setTimeout(finish, 5000);
      const onDet = (id, details) => {
        if (Number(id) !== reqId) return;
        const d = details || {};
        const c = d.contract || {};
        const month = String(c.lastTradeDateOrContractMonth || '');
        if (!month) return;
        cands.push({
          month,
          conId: Number(c.conId) || 0,
          symbol: c.symbol ? String(c.symbol) : spec.symbol,
          localSymbol: c.localSymbol ? String(c.localSymbol) : null,
          tradingClass: c.tradingClass ? String(c.tradingClass) : null,
          multiplier: Number(c.multiplier || d.multiplier || spec.multiplier) || spec.multiplier,
          exchange: c.exchange || spec.exchange,
          tick: spec.tick
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
        const req = {
          symbol: String(spec.symbol),
          secType: 'FUT',
          exchange: spec.exchange,
          currency: spec.currency || 'USD'
        };
        if (spec.tradingClass) req.tradingClass = spec.tradingClass;
        ib.reqContractDetails(reqId, req);
      } catch (e) {
        clearTimeout(t);
        log('reqContractDetails FUT failed', spec.symbol, spec.exchange, e.message);
        finish();
      }
    });
    const trySpecs = specs.length ? specs : [{
      symbol: contract.symbol, exchange: contract.exchange, currency: contract.currency,
      multiplier: contract.multiplier, tick: contract.tick, tradingClass: contract.tradingClass
    }];
    for (const spec of trySpecs) {
      const pick = await reqOneFutFront(spec);
      if (!pick || !(pick.conId > 0 || pick.month)) {
        log('futures route miss', yKey, spec.symbol, spec.exchange, 'mult=' + spec.multiplier);
        continue;
      }
      contract.symbol = spec.symbol;
      contract.exchange = pick.exchange || spec.exchange;
      contract.currency = spec.currency || 'USD';
      contract.tick = spec.tick != null ? spec.tick : contract.tick;
      if (spec.tradingClass) contract.tradingClass = spec.tradingClass;
      contract.lastTradeDateOrContractMonth = pick.month;
      if (pick.conId > 0) contract.conId = pick.conId;
      if (pick.localSymbol) contract.localSymbol = pick.localSymbol;
      if (pick.tradingClass) contract.tradingClass = pick.tradingClass;
      if (pick.multiplier > 0) contract.multiplier = pick.multiplier;
      else if (spec.multiplier > 0) contract.multiplier = spec.multiplier;
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
        '→', spec.symbol, contract.lastTradeDateOrContractMonth,
        'mult=' + contract.multiplier, 'conId=' + (contract.conId || 'n/a'),
        'exch=' + contract.exchange);
      return contract;
    }
    log('futures front month NOT FOUND for', contract.yahooTicker || contract.symbol,
      '(tried', trySpecs.map(s => s.symbol + '@' + s.exchange).join(', ') + ')');
    return contract;
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

  function ocaGroupForKey(key) {
    const s = String(key || 'lot').replace(/[^A-Za-z0-9]+/g, '').slice(0, 48);
    return ('AS1L-' + s).slice(0, 64);
  }

  function baseOrder(extra) {
    // eTradeOnly/firmQuoteOnly default true on newer IB API and reject cash-venue orders.
    return {
      tif: 'GTC',
      eTradeOnly: false,
      firmQuoteOnly: false,
      outsideRth: ORDER_OUTSIDE_RTH,
      ...(ACCOUNT ? { account: ACCOUNT } : {}),
      ...extra
    };
  }

  function remapPendingOrderId(oldId, newId) {
    const cid = state.orderClients[oldId] != null
      ? state.orderClients[oldId]
      : state.orderClients[String(oldId)];
    if (Number(cid) > 0) rememberOrderClient(state.orderClients, newId, cid);
    for (const row of Object.values(state.byKey || {})) {
      if (!row) continue;
      if (row.parentId === oldId) row.parentId = newId;
      if (row.stopId === oldId) row.stopId = newId;
      if (row.tp1Id === oldId) row.tp1Id = newId;
      if (Array.isArray(row.closeIds)) {
        row.closeIds = row.closeIds.map(id => id === oldId ? newId : id);
      }
    }
  }

  function markChildUnparked(orderId, reason) {
    const oid = Number(orderId);
    let changed = false;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed) continue;
      if (row.tp1Id === oid && !row.tp1Done) {
        row.tp1Id = null;
        row.tp1AttachAttemptAt = null;
        row.tp1RoutingFailed = true;
        changed = true;
        log('IB reject — TP1 not parked', key, reason || '');
      }
      if (row.stopId === oid && row.entryFilled) {
        row.stopId = null;
        row.stopAttachAttemptAt = null;
        row.stopRoutingFailed = true;
        changed = true;
        log('IB reject — stop not parked', key, reason || '');
      }
      if (row.parentId === oid && !row.entryFilled) {
        row.contractRejected = true;
        changed = true;
        forceReconcile = true;
      }
    }
    if (changed) saveState(state);
  }

  function retryRejectedOrder(orderId, code, message) {
    const pending = pendingOrders.get(Number(orderId));
    if (!pending || !ib) return;
    const oid = Number(orderId);
    if (isShortSaleReject(code, message)) {
      releasePending(oid);
      for (const [key, row] of Object.entries(state.byKey || {})) {
        if (!row) continue;
        if (row.tp1Id === oid) {
          row.tp1Id = null;
          row.tp1RoutingFailed = true;
          row.tp1ThroughMarket = true;
          log('IB short-sale reject — will park a resting TP1', key, 'code=' + code);
        }
        if (row.stopId === oid) {
          row.stopId = null;
          row.stopRoutingFailed = true;
          log('IB short-sale reject — stop not parked', key, 'code=' + code);
        }
      }
      saveState(state);
      return;
    }
    if (isSessionBlockedError(code, message)) {
      releasePending(oid);
      for (const [key, row] of Object.entries(state.byKey || {})) {
        if (!row) continue;
        if (row.tp1Id === oid) {
          row.tp1Id = null;
          row.tp1SessionBlocked = true;
          log('IB session reject — TP1 deferred to cash RTH', key, 'code=' + code);
        }
        if (row.stopId === oid) {
          row.stopId = null;
          row.stopSessionBlocked = true;
          log('IB session reject — stop deferred to cash RTH', key, 'code=' + code);
        }
        if (row.parentId === oid && !row.entryFilled) {
          row.contractRejected = true;
          forceReconcile = true;
        }
      }
      saveState(state);
      forceReconcile = true;
      return;
    }
    if (!isRoutingError(code)) return;
    if (pending.retried) {
      releasePending(oid);
      markChildUnparked(oid, pending.exchange + ' and fallback both error 200');
      return;
    }
    const nextEx = fallbackExchange(pending.exchange, pending.contract);
    if (!nextEx || nextEx === pending.exchange) {
      releasePending(oid);
      markChildUnparked(oid, 'error 200 no fallback from ' + pending.exchange);
      return;
    }
    const clientId = pending.clientId || clientForOrder(oid, {
      orderClients: state.orderClients,
      row: rowOwningOrder(state.byKey, oid),
      managerId: activeClientId
    });
    const newId = nid(clientId);
    pending.retried = true;
    releasePending(oid);
    remapPendingOrderId(oid, newId);
    const oc = placeableContract(pending.contract, nextEx);
    const order = { ...pending.order, orderId: newId };
    pendingOrders.set(newId, {
      contract: pending.contract,
      order,
      label: pending.label,
      exchange: nextEx,
      retried: true,
      clientId
    });
    bumpInflight(clientId, 1);
    const retryApi = (slotByClientId(clientId) && slotByClientId(clientId).api) || ib;
    retryApi.placeOrder(newId, oc, order);
    log('IB error 200 — retry', pending.label, pending.exchange, '→', nextEx,
      'oid=' + oid, '→', newId, 'client=' + clientId, oc.symbol || '');
    saveState(state);
    forceReconcile = true;
  }

  /** Place / replace an order. Always venue-routes the contract (SEHK vs SMART). */
  function transmitOrder(orderId, contract, order, label) {
    if (DRY || !ib) { log('DRY order', label, JSON.stringify({ orderId, contract: contract && contract.symbol, ...order })); return; }
    const oc = placeableContract(contract);
    const clientId = clientForOrder(orderId, {
      orderClients: state.orderClients,
      row: rowOwningOrder(state.byKey, orderId),
      managerId: activeClientId
    });
    rememberOrderClient(state.orderClients, orderId, clientId);
    pendingOrders.set(Number(orderId), {
      contract,
      order: { ...order, orderId },
      label,
      exchange: oc && oc.exchange,
      retried: false,
      clientId
    });
    bumpInflight(clientId, 1);
    const api = apiForOrderId(orderId);
    api.placeOrder(orderId, oc, order);
    log('order sent', label, oc && oc.symbol, 'exch=' + (oc && oc.exchange),
      order.action, order.orderType, 'qty=' + order.totalQuantity,
      order.lmtPrice != null ? 'lmt=' + order.lmtPrice : '', order.auxPrice != null ? 'stp=' + order.auxPrice : '',
      'outsideRth=' + !!order.outsideRth, 'client=' + clientId);
  }

  function cancelOrder(orderId, label) {
    if (orderId == null) return;
    if (unknownOrderIds.has(Number(orderId))) return;
    if (DRY || !ib) { log('DRY cancel', label, orderId); return; }
    const api = apiForOrderId(orderId);
    try { api.cancelOrder(orderId); log('cancel sent', label, orderId, 'client=' + clientForOrder(orderId, { orderClients: state.orderClients, row: rowOwningOrder(state.byKey, orderId), managerId: activeClientId })); } catch (e) { log('cancel failed', label, orderId, e.message); }
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
    // Hard choke: poll, seed, and re-arm all go through here. A 02:10 SGT emit
    // must not place even if reconcile thinks state is missing.
    if (!scheduledEntryReleaseAllowed(evt) && !evt.carryUnfilled) {
      log('placeBracket blocked (SGT release gate):', evt && (evt.key || evt.ticker),
        'entryDate=', evt && (evt.entryDate || evt.t) || 'missing',
        'releaseHour=', ENTRY_RELEASE_HOUR_SGT);
      return null;
    }
    if (!isManualEntryBypass(evt) && !evt.carryUnfilled) {
      try {
        const picks = await fetchJson('/api/dashboard/picks');
        if (!boardPublishedAtRelease(picks && picks.dashTs)) {
          log('placeBracket blocked (board is not the 06:00 SGT publish):',
            evt && (evt.key || evt.ticker), 'dashTs=', picks && picks.dashTs);
          return null;
        }
        if (picks && picks.dashData
          && !publishedBoardHasPick(picks.dashData, evt.ticker, evt.hz || 'short', evt.side)) {
          log('placeBracket blocked (not on published board):', evt && (evt.key || evt.ticker));
          return null;
        }
      } catch (e) {
        log('placeBracket blocked (board check failed closed):', evt && (evt.key || evt.ticker), e.message);
        return null;
      }
    }
    let contract = toContract(evt.ticker);
    if (!contract) {
      log('skip entry (unsupported instrument for IB paper):', evt.ticker);
      return null;
    }
    if (contract.secType === 'FUT') contract.entryPx = Number(evt.entry) || undefined;
    if (isCommodityYahoo(evt.ticker) && !evt.userReentry) {
      const wantY = normalizeYahooTicker(evt.ticker);
      for (const held of posMap.values()) {
        if (!held || !held.pos || !held.contract || held.contract.secType !== 'FUT') continue;
        const haveY = normalizeYahooTicker(yahooFromContract(held.contract));
        if (haveY !== wantY) continue;
        const sameDir = evt.side === 'sell' ? held.pos < 0 : held.pos > 0;
        if (sameDir) {
          log('skip entry — already holding', evt.ticker, 'via',
            held.contract.symbol, 'qty=' + held.pos, '(will not stack a mini on the live lot)');
          return null;
        }
      }
    }
    contract = await resolveInstrument(contract);
    if (contract.secType === 'FUT' && !contract.lastTradeDateOrContractMonth && !contract.conId) {
      log('skip entry (futures front month unresolved):', evt.ticker);
      return null;
    }
    const isSell = evt.side === 'sell';
    const lot = await resolveLot(contract);
    contract.lotHint = lot;
    const rawStop = evt.trailSl != null ? evt.trailSl : evt.sl;
    const nlv = Number(accountSnap.netLiquidation || evt.accountNlv);
    ensureMktData(evt.ticker, contract);
    const sizingQuote = DRY ? null : await waitIbExtQuote(evt.ticker, 800);
    const sizingMid = sizingQuote && sizingQuote.bid > 0 && sizingQuote.ask > 0
      ? (sizingQuote.bid + sizingQuote.ask) / 2 : 0;
    const liveSpreadBps = sizingMid > 0
      ? ((sizingQuote.ask - sizingQuote.bid) / sizingMid) * 10000 : null;
    const boardEntry = (scheduledEntryReleaseAllowed(evt) || !!evt.carryUnfilled) && !evt.userReentry;
    const availLiq = Number(accountSnap.netLiquidityAvailable != null
      ? accountSnap.netLiquidityAvailable : accountSnap.availableFunds);
    const split = await shareSplit(evt.entry, contract, lot, {
      nlv,
      stop: rawStop,
      advShares: evt.advShares,
      spreadBps: Number.isFinite(liveSpreadBps) ? liveSpreadBps : evt.spreadBps,
      drawdownPct: Number(evt.drawdownPct) || 0,
      capitalScale: evt.capitalScale,
      allowMinLot: boardEntry,
      netLiquidityAvailable: availLiq,
      liquidityFloorPct: 0.20
    });
    if (!(split.total > 0)) {
      log('skip entry — zero size for', evt.ticker, 'entry', evt.entry, 'lot', lot);
      postJson('/api/ibkr/risk-decision', {
        decisionId: evt.decisionId || null,
        ticker: evt.ticker,
        allowed: false,
        reasons: [split.risk && split.risk.reason || 'zero-size'],
        sizing: split.risk || null
      }).catch(error => log('risk-decision report failed', error.message));
      return null;
    }
    const existingPositions = [];
    for (const held of posMap.values()) {
      if (!held || !held.pos || !held.contract) continue;
      const heldContract = enrichSessionMeta(held.contract);
      const localPerUsd = await usdToCurrency(heldContract.currency);
      const heldPx = Number(held.marketPrice || held.averageCost) || 0;
      const heldScale = heldContract.penceQuoted ? 100 : 1;
      const notionalUsd = Math.abs(Number(held.pos)) * (heldPx / heldScale)
        * (heldContract.secType === 'FUT' ? Number(heldContract.multiplier) || 1 : 1)
        / localPerUsd;
      const heldTicker = yahooFromContract(heldContract);
      const heldState = Object.values(state.byKey || {}).find(row => row && !row.closed && (
        normalizeYahooTicker(row.ticker) === normalizeYahooTicker(heldTicker)
        || (row.contract && Number(row.contract.conId) > 0
          && Number(row.contract.conId) === Number(heldContract.conId))
      ));
      existingPositions.push({
        ticker: heldTicker,
        side: Number(held.pos) < 0 ? 'sell' : 'buy',
        notionalUsd,
        stopRiskUsd: Number(heldState && heldState.riskSizing && heldState.riskSizing.stopRiskUsd) || 0,
        sector: heldState && heldState.sector,
        country: heldState && heldState.country || heldContract.market,
        currency: heldContract.currency,
        cluster: heldState && heldState.correlationCluster || heldContract.market
      });
    }
    const dailyNewRiskUsd = Object.values(state.byKey || {}).reduce((sum, row) => {
      if (!row || !row.riskSizing) return sum;
      const at = Date.parse(row.admittedAt || 0);
      return Number.isFinite(at) && singaporeToDateString(at) === singaporeToDateString()
        ? sum + (Number(row.riskSizing.stopRiskUsd) || 0) : sum;
    }, 0);
    // 06:00 SGT published names are the day's allocation. The 30% gross /
    // country / USD cluster caps are for extras (re-entry, unauthorized), not
    // for blocking the board (DHL-day SNDK/PLTR/ABNB sat behind a 60% book).
    const portfolioCaps = boardEntry
      ? Object.assign({}, DEFAULT_CAPS, {
        grossPct: 1, netAbsPct: 1, sectorPct: 1,
        countryPct: 1, currencyPct: 1, clusterPct: 1,
        ...(split.risk && split.risk.bindingLimit === 'min-lot-liquidity'
          ? { singleNamePct: 1, dailyNewRiskPct: 1 } : {})
      })
      : DEFAULT_CAPS;
    const portfolioGate = evaluatePortfolioAddition({
      nlv,
      positions: existingPositions,
      ticker: evt.ticker,
      side: evt.side,
      notionalUsd: split.risk.notionalUsd,
      stopRiskUsd: split.risk.stopRiskUsd,
      dailyNewRiskUsd,
      sector: evt.sector,
      country: evt.country || contract.market,
      currency: contract.currency,
      cluster: evt.correlationCluster || evt.sector || contract.market
    }, portfolioCaps);
        if (!portfolioGate.allowed) {
      logOnce('risk-' + String(evt.ticker || ''), 'portfolio risk rejected', evt.ticker, portfolioGate.reasons.join(','),
        'gross=' + ((portfolioGate.projected && portfolioGate.projected.grossPct || 0) * 100).toFixed(2) + '%');
      if (evt.key) _seedBlocked.add(String(evt.key));
      if (evt.ticker) _seedBlocked.add(String(evt.ticker).toUpperCase());
      postJson('/api/ibkr/risk-decision', {
        decisionId: evt.decisionId || null,
        ticker: evt.ticker,
        allowed: false,
        reasons: portfolioGate.reasons,
        sizing: split.risk,
        projected: portfolioGate.projected
      }).catch(error => log('risk-decision report failed', error.message));
      return null;
    }
    postJson('/api/ibkr/risk-decision', {
      decisionId: evt.decisionId || null,
      ticker: evt.ticker,
      allowed: true,
      reasons: [],
      sizing: split.risk,
      projected: portfolioGate.projected
    }).catch(error => log('risk-decision report failed', error.message));
    const openAction = isSell ? 'SELL' : 'BUY';
    const closeAction = isSell ? 'BUY' : 'SELL';
    // Stops: round away from the market so STP is valid on SEHK tick grid.
    // Nudge one extra HK tick — IB rejected 44.65 (error 110) even though it
    // sits on the 0.05 band; child reject leaves parent transmit=false.
    let stopPx = roundPx(rawStop, contract, isSell ? 'up' : 'down');
    if (contract.market === 'HK' && stopPx > 0) {
      const tick = hkTickSize(stopPx);
      stopPx = roundPx(isSell ? stopPx + tick : stopPx - tick, contract);
    }
    let rawTp1 = Number(evt.tp1);
    if (!(rawTp1 > 0)) rawTp1 = synthesizeTp1Px(Number(evt.entry), evt.hz || 'short', isSell);
    const tp1Px = roundPx(rawTp1, contract, isSell ? 'down' : 'up');
    if (!(stopPx > 0)) { log('skip entry — no stop level for', evt.ticker); return null; }
    if (!DRY && contract.secType === 'STK' && !(Number(contract.conId) > 0)) {
      // Never manufacture order IDs for a contract IB could not qualify. This
      // row remains recoverable by reconcile, but no phantom "Placed bracket"
      // or order-not-found cancellations are produced.
      log('defer entry — IB stock contract unresolved:', evt.ticker);
      return {
        parentId: null, stopId: null, tp1Id: null,
        ticker: evt.ticker, hz: evt.hz, side: evt.side,
        entry: evt.entry, stopPx, originalSl: stopPx, tp1Px, entryStyle: 'CONTRACT-RETRY',
        extLmt: null, qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
        contract, tp1Done: false, closed: false, deferred: true,
        contractRejected: true, entryFilled: false,
        decisionId: evt.decisionId || null, rulesVersion: evt.rulesVersion || null,
        admittedAt: evt.admittedAt || evt.t || new Date().toISOString(),
        sector: evt.sector || null, country: evt.country || contract.market,
        correlationCluster: evt.correlationCluster || evt.sector || contract.market,
        riskSizing: split.risk,
        portfolioAdmission: portfolioGate,
        updated: evt.t || new Date().toISOString(), dry: DRY
      };
    }
    // TSE (and SEHK) STP children often never ack. Parent stays transmit:false
    // and IB 10147 on cancel — 6098.T sat unfilled all Tokyo cash. Transmit the
    // parent alone; park SL/TP1 after fill via ensureWorkingStops.
    const asiaStandalone = contract.market === 'JP' || contract.market === 'HK';

    // US pre/extended + RTH chase: gate on live quote vs recommended entry.
    // JP RTH: 1% through-limit needs last/quote (native MKT is not a TSE order).
    let quotePx = null;
    let quoteSrc = null;
    const usPhase = contract.usRth ? sessionPhase(contract) : null;
    const jpPhase = contract.market === 'JP' ? sessionPhase(contract) : null;
    if (contract.usRth && (usPhase === 'pre' || usPhase === 'post' || usPhase === 'rth')) {
      ensureMktData(evt.ticker, contract);
      const q = await fetchEntryQuote(evt.ticker, usPhase, evt.side);
      quotePx = q.px;
      quoteSrc = q.src;
      if (!(quotePx > 0) && usPhase === 'pre' && String(evt.reason || '') === 'rearm-model-entry') {
        const mark = ibQuoteForTicker(evt.ticker);
        const entryCap = Number(evt.entry) || 0;
        quotePx = mark > 0
          ? (evt.side === 'sell'
            ? Math.max(entryCap, mark * 0.98)
            : Math.min(entryCap, mark * 1.02))
          : entryCap;
        if (quotePx > 0) quoteSrc = mark > 0 ? 'portfolio-cap' : 'recommendation-cap';
      }
    } else if (jpPhase === 'rth') {
      ensureMktData(evt.ticker, contract);
      const q = await fetchEntryQuote(evt.ticker, 'rth', evt.side);
      quotePx = q.px;
      quoteSrc = q.src;
      if (!(quotePx > 0)) {
        const mark = ibQuoteForTicker(evt.ticker);
        quotePx = mark > 0 ? mark : (Number(evt.entry) || 0);
        quoteSrc = mark > 0 ? 'ib-last' : 'recommendation';
      }
    }
    const parentSpec = parentEntrySpec(contract, openAction, split.total, {
      side: evt.side, entryPx: evt.entry, quotePx,
      forceOpg: !!evt.forceOpg,
      forceExt: String(evt.reason || '') === 'rearm-model-entry',
      skipChase: !!evt.skipChase
    });
    if (parentSpec.defer) {
      log('defer entry', evt.ticker, parentSpec.entryStyle, 'phase=', sessionPhase(contract));
      // Keep a stub so lunch/closed names re-arm at the next session instead of
      // vanishing (0669.HK 17 Aug: DEFER-LUNCH returned null → no row → no 13:00 fire).
      return {
        parentId: null, stopId: null, tp1Id: null,
        ticker: evt.ticker, hz: evt.hz, side: evt.side,
        entry: evt.entry, stopPx, originalSl: stopPx, tp1Px, entryStyle: parentSpec.entryStyle,
        extLmt: null, qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
        contract, tp1Done: false, closed: false, deferred: true,
        entryFilled: false, decisionId: evt.decisionId || null,
        rulesVersion: evt.rulesVersion || null,
        admittedAt: evt.admittedAt || evt.t || new Date().toISOString(),
        sector: evt.sector || null, country: evt.country || contract.market,
        correlationCluster: evt.correlationCluster || evt.sector || contract.market,
        riskSizing: split.risk, portfolioAdmission: portfolioGate,
        updated: evt.t || new Date().toISOString(), dry: DRY
      };
    }
    const execSlot = pickExecSlot();
    const execClientId = execSlot ? execSlot.clientId : activeClientId;
    const parentId = nid(execClientId);
    const stopId = asiaStandalone ? null : nid(execClientId);
    const tp1Id = (!asiaStandalone && tp1Px > 0 && split.sold > 0) ? nid(execClientId) : null;
    const { entryStyle, defer, ...parentFields } = parentSpec;
    const parent = baseOrder({ orderId: parentId, ...parentFields });
    if (asiaStandalone) parent.transmit = true;
    const fullTp1 = split.sold > 0 && !(split.runner > 0);
    const oca = fullTp1 ? { ocaGroup: ocaGroupForKey(evt.key || evt.ticker), ocaType: 1 } : {};
    // Stop child: FULL quantity — pre-TP1 an SL hit closes the whole position
    // (identical to the simulator's sl_hit). GTC so it survives sessions.
    // 1-lot / 1-contract: OCA with TP1 so a TP1 fill cannot leave a live STP.
    const stopOrder = (!asiaStandalone && stopId != null) ? baseOrder({
      orderId: stopId, action: closeAction, orderType: 'STP',
      auxPrice: stopPx, totalQuantity: split.total,
      parentId, transmit: tp1Id == null,
      outsideRth: ORDER_OUTSIDE_RTH,
      ...oca
    }) : null;
    // TP1 child: 50% on splittable names; 100% (OCA with stop) when unsplittable.
    const tp1Order = (!asiaStandalone && tp1Id != null) ? baseOrder({
      orderId: tp1Id, action: closeAction, orderType: 'LMT',
      lmtPrice: tp1Px, totalQuantity: split.sold,
      parentId, outsideRth: ORDER_OUTSIDE_RTH, transmit: true,
      ...oca
    }) : null;

    if (DRY || !ib) {
      log('DRY bracket', evt.ticker, evt.side, JSON.stringify({ contract, parent, stopOrder, tp1Order, split, entryStyle, phase: sessionPhase(contract), quotePx, quoteSrc, asiaStandalone }, null, 1));
    } else {
      const oc = placeableContract(contract);
      transmitOrder(parentId, contract, parent, 'entry ' + evt.ticker);
      if (stopOrder) transmitOrder(stopId, contract, stopOrder, 'stop ' + evt.ticker);
      if (tp1Order) transmitOrder(tp1Id, contract, tp1Order, 'tp1 ' + evt.ticker);
      const gateNote = (contract.usRth && (sessionPhase(contract) === 'pre' || sessionPhase(contract) === 'post'))
        || (contract.market === 'JP' && sessionPhase(contract) === 'rth')
        ? ` quote=${quotePx != null ? quotePx : 'n/a'}(${quoteSrc || 'none'}) vs entry=${roundPx(evt.entry, contract)} lmt=${parent.lmtPrice != null ? parent.lmtPrice : 'n/a'} → ${entryStyle}`
        : '';
      const sizeNote = contract.secType === 'FUT'
        ? ` futMonth=${contract.lastTradeDateOrContractMonth} mult=${contract.multiplier}`
        : (contract.secType === 'CRYPTO' ? ' crypto' : '');
      const bb = contract.bloomberg || bloombergTicker(evt.ticker);
      const listingNote = bb ? ` ${bb}` : '';
      const jpNote = asiaStandalone ? ' asiaStandalone=1' : '';
      log('Placed bracket', evt.ticker + listingNote, evt.side,
        `exch=${(oc && oc.exchange) || contract.primaryExch || contract.market || ''} style=${entryStyle} phase=${sessionPhase(contract)} qty=${split.total} sizePx=${roundPx(evt.entry, contract)} stop=${stopPx}(full) tp1=${tp1Px}x${split.sold} runner=${split.runner}${sizeNote}${gateNote}${jpNote}`);
    }
    return {
      parentId, stopId, tp1Id,
      ticker: evt.ticker, hz: evt.hz, side: evt.side,
      entry: evt.entry, stopPx, originalSl: stopPx, tp1Px, entryStyle,
      extLmt: parent.lmtPrice != null ? Number(parent.lmtPrice) : null,
      qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
      contract, tp1Done: false, closed: false,
      ocaLinked: !!(split.sold > 0 && !(split.runner > 0)),
      decisionId: evt.decisionId || null,
      rulesVersion: evt.rulesVersion || null,
      admittedAt: evt.admittedAt || evt.t || new Date().toISOString(),
      sector: evt.sector || null, country: evt.country || contract.market,
      correlationCluster: evt.correlationCluster || evt.sector || contract.market,
      arrivalPrice: quotePx || Number(evt.entry) || null,
      quoteSource: quoteSrc || null,
      orderSubmittedAt: new Date().toISOString(),
      placeClientId: execClientId,
      parentClientId: execClientId,
      stopClientId: stopId != null ? execClientId : null,
      tp1ClientId: tp1Id != null ? execClientId : null,
      riskSizing: split.risk,
      portfolioAdmission: portfolioGate,
      updated: evt.t || new Date().toISOString(), dry: DRY
    };
  }

  // ── TP1 fill → resize stop to runner; SL shifts by the entry→TP1 % ───────
  function runnerStopPx(row, trail) {
    const raw = Number(trail != null ? trail : row.stopPx) || 0;
    const entryPx = Number(row.ibAvgFill || row.entry) || 0;
    if (!(raw > 0) && !(entryPx > 0)) return 0;
    const rounded = roundPx(raw || entryPx, row.contract);
    if (!(entryPx > 0)) return rounded;
    return row.side === 'sell'
      ? Math.min(rounded, roundPx(entryPx, row.contract))
      : Math.max(rounded, roundPx(entryPx, row.contract));
  }

  /** Remaining shares are the runner: no TP1 child, STP at TSL (BE floor). */
  function restoreRunnerStop(key, row, qty) {
    if (!row || !(qty > 0) || !row.contract) return false;
    const stp = runnerStopPx(row, row.stopPx);
    if (!(stp > 0)) return false;
    if (row.tp1Id != null) {
      cancelOrder(row.tp1Id, 'runner resume — no TP1 ' + key);
      row.tp1Id = null;
    }
    const sid = nidForRow(row);
    row.stopId = sid;
    row.stopClientId = state.orderClients[sid] || row.placeClientId;
    row.stopPx = stp;
    row.qtyRunner = qty;
    row.qtySold = Math.max(0, (Number(row.qtyTotal) || qty) - qty);
    row.tp1Done = true;
    transmitOrder(sid, row.contract, baseOrder({
      orderId: sid,
      action: row.side === 'sell' ? 'BUY' : 'SELL',
      orderType: 'STP', auxPrice: stp, totalQuantity: qty, transmit: true
    }), 'runner TSL restore ' + key);
    return true;
  }

  /**
   * After the entry prints, move working TP1 / SL so they keep the model's
   * percentages off the actual fill (not the recommended entry).
   */
  function applyFillRebase(key, row, fillPx) {
    if (!row || row.closed || row.tp1Done) return false;
    if (!(Number(fillPx) > 0) || !row.contract) return false;
    if (!(Number(row.modelEntry) > 0)) row.modelEntry = Number(row.entry);
    if (!(Number(row.modelTp1) > 0) && Number(row.tp1Px) > 0) row.modelTp1 = Number(row.tp1Px);
    if (!(Number(row.modelSl) > 0)) row.modelSl = Number(row.originalSl || row.stopPx);
    const planned = rebaseExitsFromFill({
      modelEntry: row.modelEntry,
      modelTp1: row.modelTp1,
      modelSl: row.modelSl,
      fillPx
    });
    if (!planned) return false;
    const isSell = row.side === 'sell';
    const tp1 = planned.tp1 > 0
      ? roundPx(planned.tp1, row.contract, isSell ? 'down' : 'up')
      : 0;
    const sl = planned.sl > 0
      ? roundPx(planned.sl, row.contract, isSell ? 'up' : 'down')
      : 0;
    if (!(sl > 0) && !(tp1 > 0)) return false;
    const tp1Same = !(tp1 > 0) || Math.abs(tp1 - Number(row.tp1Px || 0)) < 1e-9;
    const slSame = !(sl > 0) || Math.abs(sl - Number(row.stopPx || 0)) < 1e-9;
    if (tp1Same && slSame) return false;
    if (tp1 > 0) row.tp1Px = tp1;
    if (sl > 0) {
      row.stopPx = sl;
      row.originalSl = sl;
    }
    row.ibAvgFill = Number(fillPx);
    const closeAction = isSell ? 'BUY' : 'SELL';
    const oca = (!(Number(row.qtyRunner) > 0) && Number(row.qtySold) > 0)
      ? { ocaGroup: ocaGroupForKey(key), ocaType: 1 } : {};
    if (!tp1Same && Number(row.qtySold) > 0) {
      if (row.tp1Id != null) cancelOrder(row.tp1Id, 'TP1 rebase replace ' + key);
      const tp1Id = nidForRow(row);
      row.tp1Id = tp1Id;
      row.tp1ClientId = state.orderClients[tp1Id] || row.placeClientId;
      transmitOrder(tp1Id, row.contract, baseOrder({
        orderId: tp1Id, action: closeAction, orderType: 'LMT',
        lmtPrice: tp1, totalQuantity: row.qtySold, transmit: true, ...oca
      }), 'TP1 rebase ' + key);
    }
    const stopQty = Number(row.qtyTotal) || 0;
    if (!slSame && stopQty > 0) {
      if (row.stopId != null) cancelOrder(row.stopId, 'SL rebase replace ' + key);
      const sid = nidForRow(row);
      row.stopId = sid;
      row.stopClientId = state.orderClients[sid] || row.placeClientId;
      transmitOrder(sid, row.contract, baseOrder({
        orderId: sid, action: closeAction, orderType: 'STP',
        auxPrice: sl, totalQuantity: stopQty, transmit: true, ...oca
      }), 'SL rebase ' + key);
    }
    log('REBASE exits from fill', key, 'fill=' + fillPx,
      'model=' + row.modelEntry, 'tp1=' + (tp1 || row.tp1Px), 'sl=' + (sl || row.stopPx));
    saveState(state);
    return true;
  }

  function rebaseOpenLotsFromFill() {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || !row.entryFilled || row.tp1Done) continue;
      const y = normalizeYahooTicker(row.ticker);
      if (y === 'FAST' || y === 'DASH') continue;
      const submitted = Date.parse(row.orderSubmittedAt || 0);
      const recovered = !!row.recoveredFromPosition;
      const recent = submitted > cutoff;
      if (Number(row.modelTp1) > 0 && !recovered && !recent) {
        row.tp1Px = row.modelTp1;
        if (Number(row.modelSl) > 0) {
          row.stopPx = row.modelSl;
          row.originalSl = row.modelSl;
        }
        delete row.modelTp1;
        delete row.modelSl;
        delete row.modelEntry;
        log('REBASE revert older lot to model exits', key);
        saveState(state);
        continue;
      }
      if (!recovered && !recent) continue;
      const fill = Number(row.ibAvgFill) || Number(portfolioAvgCost.get(y)) || 0;
      if (!(fill > 0)) continue;
      applyFillRebase(key, row, fill);
    }
  }

  function onTp1Filled(key, row) {
    if (row.tp1Done || row.closed) return;
    row.tp1Done = true;
    if (!(Number(row.originalSl) > 0)) row.originalSl = Number(row.stopPx) || 0;
    const isSell = row.side === 'sell';
    const fillEntry = Number(row.ibAvgFill) || Number(row.entry);
    const tsl = tslAfterTp1({
      entry: fillEntry,
      tp1: Number(row.tp1Px),
      sl: Number(row.originalSl) || Number(row.stopPx),
      isSell
    });
    const beStop = isSell
      ? Math.min(row.stopPx, roundPx(fillEntry, row.contract))
      : Math.max(row.stopPx, roundPx(fillEntry, row.contract));
    const runnerStop = roundPx(tsl > 0 ? tsl : beStop, row.contract);
    row.stopPx = runnerStop;
    if (row.qtyRunner > 0) {
      transmitOrder(row.stopId, row.contract, baseOrder({
        orderId: row.stopId,
        action: isSell ? 'BUY' : 'SELL',
        orderType: 'STP', auxPrice: runnerStop,
        totalQuantity: row.qtyRunner, parentId: row.parentId, transmit: true
      }), 'stop→runner/TSL ' + key);
    } else {
      cancelOrder(row.stopId, 'stop (no runner) ' + key);
    }
    log('TP1 filled', key, '— stop resized to runner', row.qtyRunner, '@ TSL', runnerStop);
    cancelExtraStopsAfterTp1(key, row).catch(e => log('extra-stop cancel failed', key, e.message));
    if (!DRY && telegramConfigured()) {
      const side = isSell ? 'SHORT' : 'LONG';
      const msg = '🟢 <b>TP1 hit</b>\n'
        + String(row.ticker || key) + ' · ' + (row.hz || 'short') + ' ' + side + '\n'
        + 'Banked ' + (row.qtySold || '') + ' · runner ' + (row.qtyRunner || '')
        + (runnerStop ? (' · TSL ' + runnerStop) : '');
      sendTelegramAlert(msg, { html: true })
        .then(() => log('TELEGRAM: TP1 hit sent', key))
        .catch(e => log('TELEGRAM: TP1 hit failed', e.message));
    }
  }

  function onOrderStatus(orderId, status, filled, avgFillPrice) {
    const st = String(status || '');
    if (st === 'Cancelled' || st === 'ApiCancelled' || st === 'Inactive') {
      noteCancelAck(orderId, st);
    }
    // Keep pendingOrders on Inactive so a following error 200 can still retry
    // the other venue. Unpark only when IB has already dropped the pending row.
    if (st === 'Inactive' && !pendingOrders.has(Number(orderId))) {
      markChildUnparked(orderId, 'Inactive');
    }
    if (st === 'Cancelled' || st === 'ApiCancelled') {
      pendingOrders.delete(Number(orderId));
    }
    for (const [key, row] of Object.entries(state.byKey)) {
      if (row.closed) continue;
      // Persist the parent-fill fact — entry_finalized's safety guard reads it
      // after restarts, when the in-memory orderFills counters are gone.
      if (row.parentId === orderId && filled > 0 && !row.entryFilled) {
        row.entryFilled = true;
        if (Number.isFinite(avgFillPrice) && avgFillPrice > 0) row.ibAvgFill = avgFillPrice;
        applyFillRebase(key, row, row.ibAvgFill);
        scheduleProtectiveBracket(key);
        saveState(state);
      } else if (row.parentId === orderId && Number.isFinite(avgFillPrice) && avgFillPrice > 0) {
        row.ibAvgFill = avgFillPrice;
        applyFillRebase(key, row, avgFillPrice);
      }
      if (row.tp1Id === orderId && (status === 'Filled' || filled >= row.qtySold) && filled > 0) {
        const spec = openIfAboveSpec(row.ticker);
        const tp1Px = Number(row.tp1Px) > 0
          ? Number(row.tp1Px)
          : (spec && spec.minPx) || synthesizeTp1Px(Number(row.ibAvgFill || row.entry), row.hz || 'short', row.side === 'sell');
        if (!isLimitTp1Fill({
          fillPx: avgFillPrice, tp1Px, isSellPosition: row.side === 'sell',
          orderType: 'LMT',
          isFlattenOrder: !!(row.closeIds || []).includes(orderId) || !!row.tp1CoverSentAt
        })) {
          log('orderStatus ignored as TP1 (price/flatten)', key, 'px=' + avgFillPrice, 'tp1=' + tp1Px);
        } else {
          onTp1Filled(key, row);
          saveState(state);
        }
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
    const held = row.contract ? heldForContract(row.contract) : null;
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
      const fid = nidForRow(row);
      row.closeIds = [...(row.closeIds || []), fid];
      const phase = sessionPhase(row.contract);
      const openingCorrection = !!(row.correctiveReentry && row.contract.usRth && phase !== 'rth');
      if (row.correctiveReentry) row.correctiveExitQty = remaining;
      transmitOrder(fid, row.contract, baseOrder({
        orderId: fid,
        action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'MKT', totalQuantity: remaining,
        tif: openingCorrection ? 'OPG' : 'DAY',
        outsideRth: ORDER_OUTSIDE_RTH, transmit: true
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
      // Friday 06:00 board must not stack on Thursday's dead unfilled bag
      // (6098.T would have been bought twice at the TSE open).
      const yNew = normalizeYahooTicker(evt.ticker);
      const hzNew = String(evt.hz || 'short');
      const sideNew = String(evt.side || '').toLowerCase();
      for (const [oldKey, oldRow] of Object.entries(state.byKey || {})) {
        if (!oldRow || oldRow.closed || oldRow.entryFilled) continue;
        if (oldKey === key) continue;
        if (normalizeYahooTicker(oldRow.ticker) !== yNew) continue;
        if (String(oldRow.hz || 'short') !== hzNew) continue;
        if (String(oldRow.side || '').toLowerCase() !== sideNew) continue;
        log('cancel unfilled prior rec — new board', oldKey, '→', key);
        if (oldRow.parentId != null) cancelOrder(oldRow.parentId, 'superseded parent ' + oldKey);
        if (oldRow.stopId != null) cancelOrder(oldRow.stopId, 'superseded stop ' + oldKey);
        if (oldRow.tp1Id != null) cancelOrder(oldRow.tp1Id, 'superseded tp1 ' + oldKey);
        oldRow.closed = true;
        oldRow.supersededByNewBoard = true;
        oldRow.updated = new Date().toISOString();
        saveState(state);
      }
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
            if (isForceCashOpenTicker(evt.ticker)) {
              log('entry history Hold ignored — force cash open', key);
            } else {
              log('skip entry (history not Buy/Sell):', key, 'action=', act || 'missing');
              return;
            }
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
    let row = state.byKey[key];
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
      if (!shouldApplyLiveTslUpdate(row)) {
        log('tsl_update ignored (runner TSL not active yet)', key);
        return;
      }
      const newStop = roundPx(evt.trailSl, row.contract);
      if (!(newStop > 0)) return;
      const entryPx = Number(row.ibAvgFill || row.entry) || 0;
      const floored = entryPx > 0
        ? (row.side === 'sell'
          ? Math.min(newStop, roundPx(entryPx, row.contract))
          : Math.max(newStop, roundPx(entryPx, row.contract)))
        : newStop;
      const improves = row.side === 'sell' ? floored < row.stopPx : floored > row.stopPx;
      if (!improves) return;
      row.stopPx = floored;
      const held = row.contract ? heldForContract(row.contract) : null;
      const liveQty = held
        ? (row.side === 'sell' ? Math.max(0, -held.pos) : Math.max(0, held.pos))
        : 0;
      const qty = liveQty > 0 ? liveQty : (Number(row.qtyRunner) || Number(row.qtyTotal) || 0);
      if (!(qty > 0) || row.stopId == null) {
        log('tsl_update skipped — no live qty/stop', key);
        return;
      }
      transmitOrder(row.stopId, row.contract, baseOrder({
        orderId: row.stopId, action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'STP', auxPrice: floored, totalQuantity: qty,
        transmit: true
      }), 'tsl ratchet ' + key);
      row.updated = evt.t;
      saveState(state);
      return;
    }
    if (evt.type === 'tp1_partial') {
      // Server paper sim used to mark TP1 done without an IB fill (DSY.PA).
      // Real TP1 is orderStatus on row.tp1Id only.
      log('tp1_partial ignored (IB TP1 fill is the live authority)', key);
      return;
    }
    if (evt.type === 'exit') {
      if (!isLiveAuthorizedServerExit(evt)) {
        log('exit ignored (not live-authorized)', key,
          evt.status || evt.reason || evt.exitReason || '');
        return;
      }
      if (row && ignoreServerExitForUnfilledForcePrint(row, evt, {
        asiaCarry: asiaUnfilledCarryActive(row, key),
        forcePrint: forceCashOpenActive(row)
      })) {
        log('exit ignored — unfilled must print next cash', key,
          evt.status || evt.reason || evt.exitReason || '');
        return;
      }
      // A restart can prune a closed/error state row while IB still physically
      // holds the shares. Re-adopt that live position so a durable server exit
      // cannot become a no-op merely because the local row is missing.
      if (!row && evt.ticker) {
        const baseContract = toContract(evt.ticker);
        let held = posMap.get(posKeyOf(baseContract));
        if (!held) {
          const wanted = normalizeYahooTicker(evt.ticker);
          for (const candidate of posMap.values()) {
            if (!candidate || !candidate.pos || !candidate.contract) continue;
            const actual = normalizeYahooTicker(yahooFromContract(candidate.contract));
            if (setHasYahooAlias(yahooAliases(wanted), actual)) {
              held = candidate;
              break;
            }
          }
        }
        if (held && held.pos) {
          const liveContract = orderContractFromPos(held.contract || baseContract) || {};
          row = {
            ticker: evt.ticker,
            hz: evt.hz || 'short',
            side: evt.side === 'sell' ? 'sell' : 'buy',
            contract: { ...baseContract, ...liveContract },
            qtyTotal: Math.abs(Number(held.pos) || 0),
            qtySold: 0,
            qtyRunner: Math.abs(Number(held.pos) || 0),
            entryFilled: true,
            closed: false,
            errorTrade: evt.errorTrade === true,
            correctiveReentry: evt.correctiveReentry === true,
            updated: new Date().toISOString()
          };
          state.byKey[key] = row;
          saveState(state);
          log('exit adopted live IB position for missing state row', key, 'qty=' + row.qtyTotal);
        }
      }
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
        let dirty = false;
        for (const [key, row] of Object.entries(state.byKey)) {
          if (!row.closed) continue;
          const liveClaim = (oid) => Object.values(state.byKey || {}).some(other =>
            other && other !== row && !other.closed
            && (other.stopId === oid || other.tp1Id === oid || other.parentId === oid));
          for (const [label, oid] of [['stop', row.stopId], ['tp1', row.tp1Id], ['parent', row.parentId]]) {
            if (oid == null) continue;
            const dropPtr = () => {
              if (label === 'stop') row.stopId = null;
              else if (label === 'tp1') row.tp1Id = null;
              else row.parentId = null;
              dirty = true;
            };
            if (liveClaim(oid)) {
              dropPtr();
              log('ORPHAN sweep: dropped closed-row', label, oid, '— live sibling still owns it', key);
              continue;
            }
            if (!openIds.has(oid)) {
              dropPtr();
              continue;
            }
            const liveSameTicker = Object.values(state.byKey || {}).some(other =>
              other && other !== row && !other.closed
              && String(other.ticker || '').toUpperCase() === String(row.ticker || '').toUpperCase());
            if (liveSameTicker) {
              dropPtr();
              log('ORPHAN sweep: skip cancel — live row still exists for', row.ticker, label, oid);
              continue;
            }
            log('ORPHAN sweep: cancelling', label, 'order', oid, 'for closed', key);
            cancelOrder(oid, 'orphan ' + key);
            dropPtr();
          }
        }
        if (dirty) saveState(state);
      };
      ib.on(EventName.openOrder, onOpen);
      ib.on(EventName.openOrderEnd, onEnd);
      ib.reqAllOpenOrders();
    } catch (e) { log('sweep error', e.message); }
  }

  /**
   * Site open + IB flat: pull IB execution history for real exit VWAP.
   * Always also backfill commissions + replace recover-entry stamps (PH/NTAP
   * recovered overnight with no commissionReport and a false After-hours label).
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
    const fromMs = Date.now() - 21 * 86400000;
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
        const filter = execHistoryFilter({ fromMs, account: ACCOUNT });
        log('exec-history: filter', JSON.stringify(filter));
        ib.reqExecutions(reqId, filter);
      } catch (e) {
        log('exec-history: reqExecutions failed', e.message);
        finish();
      }
    });
    _execHistReqId = null;
    await new Promise(r => setTimeout(r, 1500));

    if (!_execHistBuf.length) {
      // Timed window can still 10314; empty filter = current IB day only.
      const reqId2 = nextExecHistId++;
      _execHistReqId = reqId2;
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
          if (Number(id) !== reqId2) return;
          finish();
        };
        timer = setTimeout(finish, 12000);
        try {
          ib.on(EventName.execDetailsEnd, onEnd);
          const filter = execHistoryFilter({ account: ACCOUNT });
          log('exec-history: retry empty filter', JSON.stringify(filter));
          ib.reqExecutions(reqId2, filter);
        } catch (e) {
          log('exec-history: empty reqExecutions failed', e.message);
          finish();
        }
      });
      _execHistReqId = null;
      await new Promise(r => setTimeout(r, 1500));
    }

    // Side-client fills (PH/NTAP) are invisible unless clientId=0. Pull that
    // separately so a failed all-clients request cannot wipe this-client execs.
    {
      const reqId3 = nextExecHistId++;
      _execHistReqId = reqId3;
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
          if (Number(id) !== reqId3) return;
          finish();
        };
        timer = setTimeout(finish, 12000);
        try {
          ib.on(EventName.execDetailsEnd, onEnd);
          const filter = execHistoryFilter({ fromMs, account: ACCOUNT, allClients: true });
          log('exec-history: all-clients filter', JSON.stringify(filter));
          ib.reqExecutions(reqId3, filter);
        } catch (e) {
          log('exec-history: all-clients reqExecutions failed', e.message);
          finish();
        }
      });
      _execHistReqId = null;
      await new Promise(r => setTimeout(r, 1500));
    }

    if (need.length) {
      log('exec-history: recovering exits for', need.map(t => t.ticker).join(','));
    }
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

    if (!_execHistBuf.length) {
      log('exec-history: no IB executions returned in window');
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
      const fillAt = ibExecIso({ time: lastTs }, cMeta);
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

    // Site still shows a full open lot while IB already sold TP1 (the 3-day
    // phantom-key filter used to drop GTC prints on older recommendation days).
    const pendingIds = new Set((state.pendingReports || [])
      .map(r => String(r && r.execId || '')).filter(Boolean));
    const tp1Need = (serverTrades.trades || []).filter(t => {
      if (!t || t.errorTrade || !(t.openQty > 0) || Number(t.exitQty) > 0) return false;
      const row = state.byKey[t.key];
      if (!row || !row.tp1Done || row.closed) return false;
      const ibAbs = Math.abs(ibSignedQtyForYahoo(t.ticker) || 0);
      const runner = Number(row.qtyRunner) || 0;
      return runner > 0 && Math.abs(ibAbs - runner) < 1;
    });
    for (const t of tp1Need) {
      const row = state.byKey[t.key];
      const aliases = yahooAliases(t.ticker);
      const wantClose = t.side === 'sell' ? 'BOT' : 'SLD';
      const spec = openIfAboveSpec(row.ticker);
      const tp1Px = Number(row.tp1Px) > 0
        ? Number(row.tp1Px)
        : (spec && spec.minPx) || 0;
      const sold = Number(row.qtySold) || 0;
      const matches = _execHistBuf.filter((e) => {
        const eid = String(e.exec.execId || '');
        if (!eid || usedExecIds.has(eid) || pendingIds.has(eid)) return false;
        const ey = normalizeYahooTicker(yahooFromContract(e.contract) || '');
        if (!ey || !aliases.has(ey)) {
          const sym = String((e.contract && e.contract.symbol) || '').toUpperCase();
          const bare = String(t.ticker || '').toUpperCase().split('.')[0];
          if (!(sym && bare && sym === bare)) return false;
        }
        const side = String(e.exec.side || '').toUpperCase();
        const okSide = side === wantClose
          || side === (wantClose === 'SLD' ? 'SELL' : 'BUY')
          || side === (wantClose === 'SLD' ? 'S' : 'B');
        if (!okSide) return false;
        const px = Number(e.price) || 0;
        const qty = Number(e.exec.shares) || 0;
        if (!(qty > 0) || !(px > 0)) return false;
        if (sold > 0 && Math.abs(qty - sold) > 1e-6) return false;
        return isLimitTp1Fill({
          fillPx: px, tp1Px, isSellPosition: row.side === 'sell',
          orderType: String(e.exec.orderType || 'LMT').toUpperCase(),
          isFlattenOrder: false
        });
      });
      if (!matches.length) {
        log('exec-history: no TP1 fills to restore', t.ticker, t.key);
        continue;
      }
      for (const m of matches) {
        const eid = String(m.exec.execId);
        const px = Number(m.price);
        const qty = Number(m.exec.shares);
        const cMeta = enrichSessionMeta(row.contract || toContract(t.ticker));
        const fillAt = ibExecIso({ time: m.exec.time || m.exec.dateTime }, cMeta);
        const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
        const comm = commissionByExec.get(eid);
        const report = {
          kind: 'exec', execId: eid, key: t.key,
          ticker: t.ticker, hz: t.hz || row.hz || 'short',
          side: t.side === 'sell' ? 'sell' : 'buy',
          role: 'tp1', orderId: m.orderId || row.tp1Id || null,
          qty, price: px, fillOrderType: 'LMT',
          currency: (cMeta && cMeta.currency) || t.currency || 'USD',
          ccyScale: cMeta && cMeta.penceQuoted ? 100 : 1,
          session: phase, sessionLabel: sessionLabel(phase),
          time: fillAt
        };
        if (comm) {
          report.commission = comm.commission;
          report.commissionCcy = comm.currency;
          if (comm.realizedPNL != null) report.ibRealizedPnl = comm.realizedPNL;
        }
        state.pendingReports = state.pendingReports || [];
        state.pendingReports.push(report);
        usedExecIds.add(eid);
        pendingIds.add(eid);
        queued++;
        log('exec-history: queued missing TP1', t.key, qty + '@' + px);
      }
    }

    const backfilled = backfillRealEntriesFromHistory(serverTrades, usedExecIds);
    queueCommissionPatchesFromMap();
    queueMissingCommissionPatches(serverTrades);
    if (queued || backfilled) saveState(state);
    await flushReports();
  }

  function queueCommissionPatchesFromMap() {
    for (const [execId, comm] of commissionByExec) {
      if (!comm || postedCommissionExecIds.has(String(execId))) continue;
      state.pendingReports = state.pendingReports || [];
      if ((state.pendingReports || []).some(r => r && String(r.execId) === String(execId)
        && (r.kind === 'commission' || r.commission != null))) continue;
      state.pendingReports.push({
        kind: 'commission',
        execId: String(execId),
        commission: comm.commission,
        commissionCcy: comm.currency,
        ibRealizedPnl: comm.realizedPNL,
        time: new Date().toISOString()
      });
    }
  }

  /** IB executed the lot — Brokerage cannot stay $0 because we recovered via a pad. */
  function queueMissingCommissionPatches(serverTrades) {
    state.pendingReports = state.pendingReports || [];
    for (const t of (serverTrades && serverTrades.trades) || []) {
      for (const f of t.fills || []) {
        if (!fillNeedsEstimatedCommission(f)) continue;
        const est = estimateIbkrCommission({
          ticker: t.ticker || f.ticker,
          qty: f.qty,
          price: f.price,
          currency: t.currency || f.currency,
          ccyScale: t.ccyScale || f.ccyScale,
          side: t.side
        });
        if (!est) continue;
        const execId = String(f.execId || '');
        if (!execId || postedCommissionExecIds.has(execId)) continue;
        if (state.pendingReports.some(r => r && String(r.execId) === execId
          && (r.kind === 'commission' || Number(r.commission) > 0))) continue;
        state.pendingReports.push({
          kind: 'commission',
          execId,
          ticker: t.ticker,
          key: t.key,
          qty: f.qty,
          role: f.role || 'entry',
          commission: est.commission,
          commissionCcy: est.commissionCcy,
          commissionSrc: est.commissionSrc,
          estimated: true,
          time: new Date().toISOString()
        });
        log('commission backfill', t.ticker, execId, est.commission, est.commissionCcy);
      }
    }
  }

  function fillLooksSynthetic(t) {
    if (!t) return true;
    return (t.fills || []).some(f => f && (
      String(f.execId || '').startsWith('recover-entry-')
      || String(f.execId || '').startsWith('recon-entry-')
      || f.synthetic === true
    ));
  }

  function backfillRealEntriesFromHistory(serverTrades, alreadyUsed) {
    if (!_execHistBuf.length) return 0;
    const used = alreadyUsed || new Set();
    const byKey = {};
    for (const t of (serverTrades && serverTrades.trades) || []) {
      if (t && t.key) byKey[t.key] = t;
    }
    let n = 0;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || !row.entryFilled || !row.ticker) continue;
      const site = byKey[key];
      const needs = !!(row.recoveredFromPosition) || fillLooksSynthetic(site);
      if (!needs) continue;
      const y = normalizeYahooTicker(row.ticker);
      const wantOpen = row.side === 'sell' ? 'SLD' : 'BOT';
      const recDay = Date.parse(String(key.split('|')[2] || '')) || 0;
      const matches = _execHistBuf.filter((e) => {
        const eid = String(e.exec.execId || '');
        if (!eid || used.has(eid)) return false;
        const ey = normalizeYahooTicker(yahooFromContract(e.contract) || '');
        const sym = String((e.contract && e.contract.symbol) || '').toUpperCase();
        const bare = String(row.ticker || '').toUpperCase().split('.')[0];
        const tickMatch = (ey && ey === y) || !!(sym && bare && sym === bare);
        if (!tickMatch) return false;
        const side = String(e.exec.side || '').toUpperCase();
        const isOpen = side === wantOpen
          || side === (wantOpen === 'SLD' ? 'SELL' : 'BUY')
          || side === (wantOpen === 'SLD' ? 'S' : 'B');
        if (!isOpen || !(Number(e.exec.shares) > 0)) return false;
        const ets = parseIbExecTime(e.exec.time || e.exec.dateTime, tzForContract(row.contract));
        if (Number.isFinite(recDay) && recDay > 0 && Number.isFinite(ets) && ets + 18 * 3600000 < recDay) {
          return false;
        }
        return true;
      });
      if (!matches.length) {
        log('exec-history: no IB entry exec for recovered', key);
        continue;
      }
      const cMeta = enrichSessionMeta(row.contract || toContract(row.ticker));
      let remaining = Math.abs(Number(row.qtyTotal) || 0) || Infinity;
      for (const m of matches) {
        if (!(remaining > 0)) break;
        const eid = String(m.exec.execId);
        const qty = Number(m.exec.shares) || 0;
        const px = Number(m.price) || 0;
        if (!(qty > 0) || !(px > 0)) continue;
        used.add(eid);
        remaining -= qty;
        const fillAt = ibExecIso(m.exec, cMeta);
        const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
        const comm = commissionByExec.get(eid);
        const report = {
          kind: 'exec', execId: eid, key,
          ticker: row.ticker, hz: row.hz || 'short',
          side: row.side === 'sell' ? 'sell' : 'buy', role: 'entry',
          orderId: Number(m.exec.orderId) || null, qty, price: px,
          currency: (cMeta && cMeta.currency) || 'USD',
          ccyScale: cMeta && cMeta.penceQuoted ? 100 : 1,
          errorTrade: false, time: fillAt,
          session: phase, sessionLabel: sessionLabel(phase)
        };
        if (comm) {
          report.commission = comm.commission;
          report.commissionCcy = comm.currency;
          if (comm.realizedPNL != null) report.ibRealizedPnl = comm.realizedPNL;
        }
        state.pendingReports = state.pendingReports || [];
        if (state.pendingReports.some(r => r && String(r.execId) === eid)) continue;
        state.pendingReports.push(report);
        n++;
        log('exec-history: backfill entry', key, qty + '@' + px, 'sess=' + phase,
          comm ? ('comm=' + comm.commission) : 'no-comm');
        if (Number(px) > 0) {
          row.ibAvgFill = (Number(row.ibAvgFill) > 0 ? row.ibAvgFill : px);
          applyFillRebase(key, row, row.ibAvgFill || px);
        }
      }
    }
    return n;
  }

  // ── IB ↔ AlphaSignal ledger sync ───────────────────────────────────────────
  // Posts paper positions + avgCost so the site open qty / entry avg / ghost
  // opens match DU1764495. Untracked IB leftovers are reported, not invented.
  let lastIbReconAt = 0;
  let lastIbReconResp = null;
  let reconFailureSince = 0;
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
      const futMult = contract.secType === 'FUT'
        ? (Number(contract.multiplier) || (YAHOO_FUTURES[y] && YAHOO_FUTURES[y].multiplier) || null)
        : null;
      positions.push({
        ticker: y,
        qty: pos,
        avgCost: avgCost > 0 ? avgCost : null,
        currency: contract.currency || null,
        conId: conId || null,
        symbol: contract.symbol || null,
        secType: contract.secType || null,
        multiplier: futMult
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
        reconFailureSince = 0;
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
      const now = Date.now();
      if (!reconFailureSince) reconFailureSince = now;
      const transient = /^HTTP 5\d\d$/i.test(String(e.message || ''))
        || /timeout|ECONNRESET|EAI_AGAIN|socket hang up/i.test(String(e.message || ''));
      lastIbReconResp = {
        ok: false,
        error: e.message,
        inSync: false,
        transient,
        failureMs: now - reconFailureSince
      };
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
        if (!row || !row.entryFilled) continue;
        const correctiveClosePending = !!(row.errorTrade && (row.closeIds || []).length);
        if (row.closed && !correctiveClosePending) continue;
        // A known error-cycle position with a submitted corrective close is
        // tracked until that close fills; it is not an unknown IB orphan.
        if (row.errorTrade && !correctiveClosePending) continue;
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
    if (shouldAlertReconFailure(resp)) {
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
          .map(i => `${i.ticker || '?'}: ${i.detail || i.message || i.code || 'error'}`).join('; ');
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
      const market = row.contract.market;
      const eu = market === 'XETRA' || market === 'EURONEXT' || market === 'LSE';
      // Opening-auction working orders are supposed to fill at the bell. Do not
      // page Telegram until the auction hold has elapsed (NWG.L LMT-OPEN).
      if (isAuctionEntryStyle(row.entryStyle) && !row.contractRejected) {
        if (eu && minutesSinceEuRth(now) < AUCTION_HOLD_MIN) continue;
        if (row.contract.usRth && minutesSinceUsRth(now) < AUCTION_HOLD_MIN) continue;
        if ((market === 'JP' || market === 'HK')
          && minutesSinceMarketRth(market, now) < AUCTION_HOLD_MIN) continue;
      }
      const rthMins = eu ? minutesSinceEuRth(now)
        : (row.contract.usRth ? minutesSinceUsRth(now) : null);
      const ageMs = row.updated ? (now - Date.parse(row.updated)) : (row.placedAt ? (now - Date.parse(row.placedAt)) : 0);
      const ageOk = Number.isFinite(ageMs) ? ageMs : 0;
      const rearmTs = row.lastRearmAt ? Date.parse(row.lastRearmAt) : NaN;
      const rearmAge = Number.isFinite(rearmTs) ? (now - rearmTs) : ageOk;
      const waitMs = Number.isFinite(rthMins) && rthMins >= 0 ? rthMins * 60000 : Math.max(ageOk, rearmAge || 0);
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
    // Don't page while the venue is shut — LSE STP before 08:00 BST is IB 200.
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || !row.entryFilled) continue;
      if (keyState && keyState.get(key) !== 'open') continue;
      if (row.stopId != null) continue;
      const phase = row.contract ? sessionPhase(row.contract) : 'closed';
      if (!row.contract || phase === 'closed') continue;
      if (asiaCashBlocksRestingOrders(row.contract, phase)) continue;
      const pos = row.contract ? (heldForContract(row.contract) || {}).pos : 0;
      if (!pos) continue;
      findings.push({
        sev: 'error',
        code: 'missing-stop',
        text: `Risk: filled but no stop order id — ${key} IB pos=${pos}`
      });
    }

    // Filled lot with no live TP1 LMT while the venue can rest a GTC.
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || row.errorTrade || !row.entryFilled || row.tp1Done) continue;
      if (keyState && keyState.get(key) !== 'open') continue;
      if (!row.contract || (row.contract.secType && row.contract.secType !== 'STK' && row.contract.secType !== 'FUT')) continue;
      if (ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase())) continue;
      const phase = sessionPhase(row.contract);
      if (phase === 'closed') continue;
      if (row.contract.secType === 'STK' && phase !== 'rth') continue;
      if (asiaCashBlocksRestingOrders(row.contract, phase)) continue;
      const held = row.contract ? heldForContract(row.contract) : null;
      const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
      const lot = Math.max(boardLotHint(row.ticker, row.contract.lotHint), 1);
      const half = tp1OrderQty(posInDir, lot);
      if (!(half >= lot) || half > posInDir + 1e-9) continue;
      if (row.tp1Id != null && !row.tp1RoutingFailed && !row.tp1SessionBlocked) continue;
      findings.push({
        sev: 'error',
        code: 'missing-tp1',
        text: `Risk: filled but TP1 LMT not parked — ${key} IB pos=${posInDir}`
      });
    }
    return findings;
  }

  function listWorkingOrdersDetailed() {
    return new Promise(resolve => {
      const orders = [];
      let complete = false;
      if (DRY || !ib || !EventName) return resolve({ orders, complete: true });
      const t = setTimeout(() => { cleanup(); resolve({ orders, complete }); }, 5000);
      const onOpen = (orderId, contract, order, orderState) => {
        const st = String((orderState && orderState.status) || '');
        if (st === 'Cancelled' || st === 'Filled' || st === 'Inactive') return;
        orders.push({
          orderId,
          conId: Number(contract && contract.conId) || 0,
          action: String(order.action || '').toUpperCase(),
          type: String(order.orderType || '').toUpperCase(),
          qty: Number(order.totalQuantity) || 0,
          lmt: Number(order.lmtPrice) || 0,
          aux: Number(order.auxPrice) || 0,
          tif: String(order.tif || '').toUpperCase(),
          yahoo: yahooFromContract(contract),
          status: st
        });
      };
      const onEnd = () => { complete = true; cleanup(); resolve({ orders, complete }); };
      const cleanup = () => {
        clearTimeout(t);
        try { ib.off(EventName.openOrder, onOpen); } catch (_) {}
        try { ib.off(EventName.openOrderEnd, onEnd); } catch (_) {}
      };
      ib.on(EventName.openOrder, onOpen);
      ib.on(EventName.openOrderEnd, onEnd);
      try { ib.reqAllOpenOrders(); } catch (e) { cleanup(); resolve({ orders, complete: false }); }
    });
  }
  function listWorkingOrders() {
    return listWorkingOrdersDetailed().then(r => r.orders);
  }

  /** Bind an already-working IB STP onto a recovered fill so Telegram does not
   *  page "no stop order id" for brackets placed on a side client. */
  function listWorkingStops() {
    return listWorkingOrders().then(os => os.filter(o => o.type === 'STP'));
  }

  async function adoptWorkingStops(workingOrders) {
    const stops = (workingOrders || await listWorkingStops()).filter(o => o.type === 'STP');
    if (!stops.length) return 0;
    let n = 0;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (!row || row.closed || !row.entryFilled || row.stopId != null) continue;
      const wantAction = row.side === 'sell' ? 'BUY' : 'SELL';
      const y = normalizeYahooTicker(row.ticker);
      const cid = Number(row.contract && row.contract.conId) || 0;
      const qty = Math.abs(Number(row.qtyTotal) || 0);
      const hit = stops.find(s =>
        s.action === wantAction
        && (cid > 0 ? s.conId === cid : normalizeYahooTicker(s.yahoo) === y)
        && (!(qty > 0) || Math.abs(s.qty - qty) < 1e-6)
      );
      if (!hit) continue;
      row.stopId = hit.orderId;
      if (hit.aux > 0) row.stopPx = hit.aux;
      row.stopRoutingFailed = false;
      row.stopSessionBlocked = false;
      row.updated = new Date().toISOString();
      n++;
      log('RECONCILE: adopted working stop', key, 'orderId=' + hit.orderId, 'stp=' + hit.aux);
    }
    if (n) saveState(state);
    return n;
  }

  async function cancelExtraStopsAfterTp1(key, row) {
    if (!row || !row.tp1Done) return;
    const working = await listWorkingOrders();
    const want = row.side === 'sell' ? 'BUY' : 'SELL';
    const stps = working.filter(o => o.type === 'STP' && o.action === want && rowMatchesWorking(row, o));
    for (const s of stps) {
      if (row.stopId != null && s.orderId === row.stopId) continue;
      cancelOrder(s.orderId, 'extra stop after TP1 ' + key);
    }
  }

  function rowMatchesWorking(row, order) {
    if (!row || !order) return false;
    const cid = Number(row.contract && row.contract.conId) || 0;
    const y = normalizeYahooTicker(row.ticker);
    if (cid > 0 && order.conId === cid) return true;
    return !!y && normalizeYahooTicker(order.yahoo) === y;
  }

  function childNotYetWorking(rowId, workingHit, attemptAt, failedFlag) {
    if (workingHit) return false;
    if (rowId != null && pendingOrders.has(Number(rowId))) {
      const age = attemptAt ? Date.now() - Date.parse(attemptAt) : Infinity;
      return !(Number.isFinite(age) && age < 20000);
    }
    if (failedFlag) return true;
    if (rowId == null) return true;
    const age = attemptAt ? Date.now() - Date.parse(attemptAt) : Infinity;
    return !Number.isFinite(age) || age > 20000;
  }

  function attachRetryWaitMs(failedFlag) {
    return failedFlag ? 10 * 60 * 1000 : 45 * 1000;
  }

  /** Place a live STP when the filled lot has none. Adopt existing first. */
  async function ensureWorkingStops(workingOrders, opts = {}) {
    if (DRY || !ib) return 0;
    const onFill = !!(opts && opts.onFill);
    const onlyKey = opts && opts.onlyKey;
    const working = workingOrders || await listWorkingOrders();
    await adoptWorkingStops(working);
    let n = 0;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (onlyKey && key !== onlyKey) continue;
      if (!row || row.closed || row.errorTrade || !row.entryFilled) continue;
      if (!row.contract || (row.contract.secType && row.contract.secType !== 'STK' && row.contract.secType !== 'FUT')) continue;
      if (ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase())) continue;
      const phase = sessionPhase(row.contract);
      if (shouldDeferProtectiveChildren(row.contract, phase, opts)) continue;
      if (row.stopSessionBlocked) row.stopSessionBlocked = false;
      const held = heldForContract(row.contract);
      let posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
      if (!(posInDir > 0)) {
        const yq = ibSignedQtyForYahoo(row.ticker);
        posInDir = row.side === 'sell' ? -yq : yq;
      }
      if (!(posInDir > 0)) continue;
      const closeAction = row.side === 'sell' ? 'BUY' : 'SELL';
      const stps = working.filter(o =>
        o.type === 'STP' && o.action === closeAction && rowMatchesWorking(row, o)
      );
      const tp1WorkingQty = (!row.tp1Done)
        ? working.filter(o =>
          o.type === 'LMT' && o.action === closeAction && rowMatchesWorking(row, o)
        ).reduce((s, o) => s + (Number(o.qty) || 0), 0)
        : 0;
      // Never size the stop as the original lot while a TP1 LMT is still live.
      // DHL 25 Aug: STP 157 + TP1 78 both working on a 157 long → short 78.
      const bookedTp1 = (!row.tp1Done && row.tp1Id != null && !row.tp1RoutingFailed)
        ? Math.max(Number(row.qtySold) || 0, 0) : 0;
      const tp1Qty = Math.max(tp1WorkingQty, bookedTp1);
      const lot = Math.max(boardLotHint(row.ticker, row.contract && row.contract.lotHint), 1);
      const fullTp1 = !row.tp1Done && isFullQtyTp1(posInDir, lot);
      // 50% TP1: stop covers the runner only. 100% TP1: stop stays full and
      // is OCA-linked so a TP1 fill cannot leave a live STP.
      const stopQty = (fullTp1 || row.tp1Done) ? posInDir : Math.max(0, posInDir - tp1Qty);
      const existing = (row.stopId != null ? stps.find(o => o.orderId === row.stopId) : null) || stps[0];
      if (existing) {
        const wantSl = Number(row.stopPx);
        const slack = Math.max(Math.abs(wantSl) * 0.001, 0.01);
        if (wantSl > 0 && existing.aux > 0 && Math.abs(existing.aux - wantSl) > slack) {
          // Never mint a second STP while the old one is still working.
          cancelOrder(existing.orderId, 'SL fill-rebase replace ' + key);
          log('RECONCILE: waiting to replace stop', key, 'have', existing.aux, 'want', wantSl);
          continue;
        }
        if (row.stopId !== existing.orderId) {
          row.stopId = existing.orderId;
          if (existing.aux > 0 && !(Number(row.modelSl) > 0)) row.stopPx = existing.aux;
          row.stopRoutingFailed = false;
          row.updated = new Date().toISOString();
          n++;
          log('RECONCILE: adopted working stop', key, 'orderId=' + existing.orderId, 'stp=' + existing.aux);
        }
        if (stopQty > 0 && existing.qty > stopQty + 1e-6) {
          transmitOrder(existing.orderId, row.contract, baseOrder({
            orderId: existing.orderId,
            action: closeAction,
            orderType: 'STP',
            auxPrice: existing.aux > 0 ? existing.aux : roundPx(row.stopPx, row.contract),
            totalQuantity: stopQty,
            transmit: true
          }), 'shrink stop for TP1 ' + key);
          log('RECONCILE: stop qty capped', key, existing.qty, '→', stopQty, '(TP1 working', tp1WorkingQty + ')');
        } else if (stopQty > 0 && existing.qty + 1e-6 < stopQty) {
          cancelOrder(existing.orderId, 'stop undersize replace ' + key);
          log('RECONCILE: waiting to replace undersized stop', key, existing.qty, '→', stopQty);
          continue;
        }
        for (const extra of stps) {
          if (extra.orderId === existing.orderId) continue;
          cancelOrder(extra.orderId, 'duplicate stop ' + key);
        }
        continue;
      }
      // LSE often omits GTC children from reqOpenOrders. Cap our own STP from state.
      if (row.stopId != null && stopQty > 0 && stopQty < posInDir - 1e-6) {
        transmitOrder(row.stopId, row.contract, baseOrder({
          orderId: row.stopId,
          action: closeAction,
          orderType: 'STP',
          auxPrice: roundPx(row.stopPx, row.contract),
          totalQuantity: stopQty,
          transmit: true
        }), 'shrink stop for TP1 ' + key);
        log('RECONCILE: stop qty capped (by id)', key, posInDir, '→', stopQty, '(booked TP1', bookedTp1 + ')');
        continue;
      }
      // Do not mint a second STP just because the working-order snapshot missed
      // the last one — that left dozens of 157-share DHL sell-stops at IB.
      // On-fill parks skip the 15-min cooldown so a standalone parent is not
      // left naked until the next sweep.
      if (!onFill && row.stopId != null && !row.stopRoutingFailed) {
        const lastSent = row.stopAttachAttemptAt ? Date.parse(row.stopAttachAttemptAt) : NaN;
        if (Number.isFinite(lastSent) && Date.now() - lastSent < 15 * 60 * 1000) continue;
      }
      if (!onFill && !childNotYetWorking(row.stopId, null, row.stopAttachAttemptAt, row.stopRoutingFailed)) continue;
      const wait = attachRetryWaitMs(row.stopRoutingFailed);
      const last = row.stopAttachAttemptAt ? Date.parse(row.stopAttachAttemptAt) : NaN;
      if (!onFill && Number.isFinite(last) && Date.now() - last < wait) continue;
      if (!(Number(row.contract.conId) > 0)) {
        try { row.contract = await resolveInstrument(row.contract) || row.contract; }
        catch (e) { log('stop attach resolve failed', key, e.message); continue; }
      }
      const qty = row.tp1Done ? posInDir : stopQty;
      const stp = row.tp1Done ? runnerStopPx(row, row.stopPx) : roundPx(row.stopPx, row.contract);
      if (!(stp > 0) || !(qty > 0)) {
        logOnce('stop-skip-qty-' + key, 'stop attach skip', key, 'qty', qty, 'stp', stp, 'pos', posInDir, 'tp1Working', tp1WorkingQty);
        continue;
      }
      const oid = nidForRow(row);
      row.stopId = oid;
      row.stopClientId = state.orderClients[oid] || row.placeClientId;
      row.stopPx = stp;
      row.stopRoutingFailed = false;
      row.stopAttachAttemptAt = new Date().toISOString();
      row.updated = row.stopAttachAttemptAt;
      transmitOrder(oid, row.contract, baseOrder({
        orderId: oid,
        action: closeAction,
        orderType: 'STP',
        auxPrice: stp,
        totalQuantity: qty,
        transmit: true
      }), (row.tp1Done ? 'stop attach runner ' : 'stop attach ') + key);
      n++;
      log('RECONCILE: attached stop', key, closeAction, 'STP', stp, 'x' + qty);
    }
    if (n) saveState(state);
    return n;
  }

  /** Park a live TP1 LMT: 50% on splittable names, 100% OCA with the stop on
   *  1-lot / 1-contract names (including BZ=F). HK/JP wait for cash RTH on
   *  the sweep; a parent fill parks immediately except during HK/JP lunch. */
  async function ensureWorkingTp1Children(workingOrders, opts = {}) {
    if (DRY || !ib) return 0;
    const onFill = !!(opts && opts.onFill);
    const onlyKey = opts && opts.onlyKey;
    const working = workingOrders || await listWorkingOrders();
    let n = 0;
    for (const [key, row] of Object.entries(state.byKey || {})) {
      if (onlyKey && key !== onlyKey) continue;
      if (!row || row.closed || row.errorTrade || !row.entryFilled || row.tp1Done) continue;
      if (!row.contract || (row.contract.secType && row.contract.secType !== 'STK' && row.contract.secType !== 'FUT')) continue;
      if (ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase())) continue;
      const held = heldForContract(row.contract);
      const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
      if (!(posInDir > 0)) continue;
      const lot = Math.max(boardLotHint(row.ticker, row.contract.lotHint), 1);
      row.contract.lotHint = lot;
      const closeAction = row.side === 'sell' ? 'BUY' : 'SELL';
      const isSell = row.side === 'sell';
      const spec = openIfAboveSpec(row.ticker);
      const phase = sessionPhase(row.contract);
      if (shouldDeferProtectiveChildren(row.contract, phase, opts)) continue;
      if (row.tp1SessionBlocked) row.tp1SessionBlocked = false;
      const half = spec
        ? Math.min(Number(spec.qty) || 0, tp1OrderQty(posInDir, lot) || Number(spec.qty) || 0)
        : tp1OrderQty(posInDir, lot);
      if (!(half >= lot) || half > posInDir + 1e-9) continue;
      const fullExit = Math.abs(half - posInDir) < 1e-9;
      const lmts = working.filter(o =>
        o.type === 'LMT' && o.action === closeAction && rowMatchesWorking(row, o)
      );
      const existing = lmts.find(o => Math.abs(o.qty - half) < 1e-6)
        || (row.tp1Id != null ? lmts.find(o => o.orderId === row.tp1Id) : null)
        || lmts[0];
      if (existing) {
        const wantTp1 = Number(row.tp1Px);
        const slack = Math.max(Math.abs(wantTp1) * 0.001, 0.01);
        if (wantTp1 > 0 && existing.lmt > 0 && Math.abs(existing.lmt - wantTp1) > slack) {
          cancelOrder(existing.orderId, 'TP1 fill-rebase replace ' + key);
          log('RECONCILE: waiting to replace TP1', key, 'have', existing.lmt, 'want', wantTp1);
          continue;
        }
        if (row.tp1Id !== existing.orderId || row.qtySold !== half) {
          row.tp1Id = existing.orderId;
          row.qtyTotal = posInDir;
          row.qtySold = half;
          row.qtyRunner = Math.max(0, posInDir - half);
          if (existing.lmt > 0 && !(Number(row.modelTp1) > 0)) row.tp1Px = existing.lmt;
          row.tp1RoutingFailed = false;
          row.tp1ThroughMarket = false;
          row.updated = new Date().toISOString();
          n++;
          log('RECONCILE: adopted working TP1', key, 'orderId=' + existing.orderId,
            'lmt=' + existing.lmt, 'qty=' + existing.qty, 'tif=' + existing.tif);
        }
        if (existing.qty > half + 1e-6) {
          cancelOrder(existing.orderId, 'TP1 shrink replace ' + key);
          log('RECONCILE: waiting to replace oversized TP1', key, existing.qty, '→', half);
          await waitCancel(existing.orderId, 4000);
          continue;
        }
        for (const extra of lmts) {
          if (extra.orderId === existing.orderId) continue;
          cancelOrder(extra.orderId, 'duplicate TP1 ' + key);
        }
        continue;
      }
      const stps = working.filter(o =>
        o.type === 'STP' && o.action === closeAction && rowMatchesWorking(row, o)
      );
      const stpQty = stps.reduce((s, o) => s + (Number(o.qty) || 0), 0);
      if (!fullExit && stpQty + half > posInDir + 1e-6 && stps.length > 1) {
        const keep = (row.stopId != null ? stps.find(o => o.orderId === row.stopId) : null) || stps[0];
        let cancelled = 0;
        for (const o of stps) {
          if (!keep || o.orderId === keep.orderId) continue;
          cancelOrder(o.orderId, 'free locates for TP1 ' + key);
          cancelled++;
        }
        if (cancelled) {
          log('TP1 — cancelled extra stops to free locates', key, 'n=' + cancelled);
          for (const o of stps) {
            if (!keep || o.orderId === keep.orderId) continue;
            await waitCancel(o.orderId, 4000);
          }
        }
      }
      if (!onFill && row.tp1Id != null && !row.tp1RoutingFailed) {
        const lastSent = row.tp1AttachAttemptAt ? Date.parse(row.tp1AttachAttemptAt) : NaN;
        if (Number.isFinite(lastSent) && Date.now() - lastSent < 15 * 60 * 1000) continue;
      }
      if (!onFill && !childNotYetWorking(row.tp1Id, null, row.tp1AttachAttemptAt, row.tp1RoutingFailed)) continue;
      const wait = attachRetryWaitMs(row.tp1RoutingFailed);
      const lastAttempt = row.tp1AttachAttemptAt ? Date.parse(row.tp1AttachAttemptAt) : NaN;
      if (!onFill && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < wait) continue;
      if (row.tp1Id != null && !pendingOrders.has(Number(row.tp1Id))) {
        log('TP1 id not working — treating as missed', key, 'oid=' + row.tp1Id);
        row.tp1Id = null;
      }
      let tp1Px;
      let tif = 'GTC';
      if (spec) {
        tp1Px = roundPx(spec.minPx, row.contract, isSell ? 'down' : 'up');
        tif = spec.tif || 'GTC';
      } else {
        const raw = Number(row.tp1Px) > 0
          ? Number(row.tp1Px)
          : synthesizeTp1Px(Number(row.ibAvgFill || row.entry), row.hz || 'short', isSell);
        tp1Px = roundPx(raw, row.contract, isSell ? 'down' : 'up');
        if (row.contract.market === 'HK' && tp1Px >= 49.5 && tp1Px < 50) tp1Px = 50;
      }
      const y = normalizeYahooTicker(row.ticker);
      const lastPx = Number(portfolioMarks.get(y) && portfolioMarks.get(y).price)
        || Number(portfolioMarks.get(row.ticker) && portfolioMarks.get(row.ticker).price)
        || 0;
      const parked = passiveCloseLimit(tp1Px, lastPx, isSell);
      if (parked > 0 && parked !== tp1Px) {
        log('TP1 resting (through market)', key, 'tp1=' + tp1Px, 'last=' + lastPx, 'lmt=' + parked);
        tp1Px = parked;
      }
      tp1Px = roundPx(tp1Px, row.contract, isSell ? 'down' : 'up');
      if (row.tp1ThroughMarket) {
        const tick = row.contract.market === 'HK' ? hkTickSize(tp1Px) : 0.01;
        tp1Px = roundPx(tp1Px + (isSell ? -tick : tick), row.contract, isSell ? 'down' : 'up');
      }
      if (!(tp1Px > 0)) {
        log('TP1 skip (no price)', key);
        continue;
      }
      if (fullExit) {
        for (const o of stps) {
          cancelOrder(o.orderId, '1-lot OCA rebuild stop ' + key);
        }
        for (const o of stps) await waitCancel(o.orderId, 4000);
        const group = ocaGroupForKey(key);
        const stpPx = roundPx(row.stopPx, row.contract);
        const sid = nidForRow(row);
        row.stopId = sid;
        row.stopClientId = state.orderClients[sid] || row.placeClientId;
        const oid = nidForRow(row);
        row.tp1Id = oid;
        row.tp1ClientId = state.orderClients[oid] || row.placeClientId;
        row.tp1Px = tp1Px;
        row.qtyTotal = posInDir;
        row.qtySold = half;
        row.qtyRunner = 0;
        row.ocaLinked = true;
        row.tp1AttachAttemptAt = new Date().toISOString();
        row.stopAttachAttemptAt = row.tp1AttachAttemptAt;
        row.updated = row.tp1AttachAttemptAt;
        if (stpPx > 0) {
          transmitOrder(sid, row.contract, baseOrder({
            orderId: sid, action: closeAction, orderType: 'STP',
            auxPrice: stpPx, totalQuantity: posInDir, tif: 'GTC',
            ocaGroup: group, ocaType: 1, transmit: true
          }), '1-lot OCA stop ' + key);
        }
        transmitOrder(oid, row.contract, baseOrder({
          orderId: oid, action: closeAction, orderType: 'LMT',
          lmtPrice: tp1Px, totalQuantity: half, tif,
          ocaGroup: group, ocaType: 1, transmit: true
        }), '1-lot OCA tp1 ' + key);
        n++;
        log('RECONCILE: attached 1-lot OCA TP1+SL', key, closeAction, 'LMT', tp1Px, 'x' + half,
          'STP', stpPx, 'tif=' + tif);
        continue;
      }
      const oid = nidForRow(row);
      row.tp1Id = oid;
      row.tp1ClientId = state.orderClients[oid] || row.placeClientId;
      row.tp1Px = tp1Px;
      row.qtyTotal = posInDir;
      row.qtySold = half;
      row.qtyRunner = posInDir - half;
      row.tp1AttachAttemptAt = new Date().toISOString();
      row.updated = row.tp1AttachAttemptAt;
      transmitOrder(oid, row.contract, baseOrder({
        orderId: oid,
        action: closeAction,
        orderType: 'LMT',
        lmtPrice: tp1Px,
        totalQuantity: half,
        tif,
        outsideRth: ORDER_OUTSIDE_RTH,
        transmit: true
      }), (spec ? 'tp1 open-if-above ' : 'tp1 attach ') + key);
      n++;
      log('RECONCILE: attached TP1', key, closeAction, 'LMT', tp1Px, 'x' + half,
        'tif=' + tif, 'exch=' + preferredExchange(row.contract));
    }
    if (n) saveState(state);
    return n;
  }

  /** After a parent fill, park TP1+SL now if they were not sent with the bag. */
  function scheduleProtectiveBracket(key) {
    if (!key || DRY || !ib) return;
    if (_bracketParkPending.has(key)) return;
    _bracketParkPending.add(key);
    setImmediate(() => {
      parkProtectiveBracket(key)
        .catch(e => log('on-fill bracket park failed', key, e.message))
        .finally(() => _bracketParkPending.delete(key));
    });
  }
  async function parkProtectiveBracket(key) {
    const row = state.byKey[key];
    if (!row || row.closed || !row.entryFilled) return;
    // Native 3-leg already submitted with the parent — do not mint a second bag.
    if (row.stopId != null && (row.tp1Done || row.tp1Id != null)) {
      log('on-fill bracket already submitted with parent', key,
        'stop=' + row.stopId, 'tp1=' + row.tp1Id);
      return;
    }
    const working = await listWorkingOrders();
    const nStop = await ensureWorkingStops(working, { onFill: true, onlyKey: key });
    const working2 = await listWorkingOrders();
    const nTp1 = await ensureWorkingTp1Children(working2, { onFill: true, onlyKey: key });
    log('on-fill bracket park', key, 'stops=' + nStop, 'tp1=' + nTp1);
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

    // Same incident must not re-page every reconcile sweep. Alert once until
    // the fingerprint changes (fill, cancel, new name) or an all-clear fires.
    if (!force && sameFp) return;

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
      `Today realised (fills): ${fmtUsdSigned(dayReal)}`,
      `Commissions (open lots): ${fmtUsdSigned(-(Number(tt.openCommissionUsd) || 0))}`,
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
      lines.push(`IB account MTM today: ${fmtUsdSigned(snapshot.ibDailyPnl)} (open marks; not fill PnL)`);
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
        // Chronological state machine: a confirmed corrective re-entry after an
        // exit must reopen the same-day key instead of remaining closed forever.
        if (e.type === 'entry') keyState.set(e.key, 'open');
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
        const held = heldForContract(row.contract);
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir > 0) continue; // still live long/short in thesis direction — leave alone
        if (held && held.pos && posInDir < 0) {
          log('RECONCILE: skip stale-cancel — IB flipped against thesis', key, 'ibPos=' + held.pos);
          continue;
        }
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
        const held = heldForContract(row.contract);
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir <= 0) continue;
        row.closed = false;
        row.staleCancelled = false;
        row.entryFilled = true;
        log('RECONCILE: re-opened', key, '— IB still holds', posInDir, 'shares');
        saveState(state);
      }

      // 0a2b. Never bank TP1 with a market flatten. TP1 is a resting LMT only.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || !(Number(row.pendingTp1MarketCover) > 0)) continue;
        log('RECONCILE: refusing TP1 market cover — TP1 is limit-only', key,
          'cover', row.pendingTp1MarketCover);
        delete row.pendingTp1MarketCover;
        delete row.tp1CoverSentAt;
        saveState(state);
      }

      // 0a3. Paper TSL flattened the runner on the site, but IB still holds it
      // (DSY.PA: 207 sold, 206 live, TP1 never filled). Resume runner TSL only —
      // do not place TP1 again, do not flatten the remainder.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || !row.closed || !row.contract) continue;
        if (row.errorTrade || row.preReleaseCancelled || row.holdCancelledUnfilled
          || row.staleUnfilledAbandoned) continue;
        const held = heldForContract(row.contract);
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (!(posInDir > 0)) continue;
        const total = Number(row.qtyTotal) || 0;
        const halfish = total > 0 && posInDir < total
          && posInDir >= total * 0.4 && posInDir <= total * 0.6;
        if (!(row.tp1Done || halfish)) continue;
        row.closed = false;
        row.entryFilled = true;
        row.tp1Done = true;
        row.qtyRunner = posInDir;
        row.qtySold = Math.max(0, total - posInDir);
        restoreRunnerStop(key, row, posInDir);
        log('RECONCILE: resume runner TSL', key, 'qty', posInDir, 'stp', row.stopPx);
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
          if (keepUnfilledWorking(row, key)) {
            log('RECONCILE: skip hold-cancel — unfilled must print next cash', key);
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

      // 0z0. Cancel unfilled parents that were seeded from a pre-6am SGT emit
      // (NWG.L 21 Aug: poll correctly skipped, then seed placed LMT-OPEN anyway).
      for (const [key, row] of Object.entries(state.byKey || {})) {
        if (!row || row.closed || row.entryFilled) continue;
        if (row.userReentry || row.correctiveReentry) continue;
        if (keepUnfilledWorking(row, key)) continue;
        const src = entryByKey.get(key);
        if (!src) continue;
        if (scheduledEntryReleaseAllowed(src)) continue;
        log('RECONCILE: cancelling unfilled pre-release entry', key,
          'entryDate=', src.entryDate || src.t || 'missing');
        if (row.parentId != null) cancelOrder(row.parentId, 'pre-release-cancel parent ' + key);
        if (row.stopId != null) cancelOrder(row.stopId, 'pre-release-cancel stop ' + key);
        if (row.tp1Id != null) cancelOrder(row.tp1Id, 'pre-release-cancel tp1 ' + key);
        row.closed = true;
        row.preReleaseCancelled = true;
        row.updated = new Date().toISOString();
        saveState(state);
      }

      // 0z. Seed missing state for open entry events (state loss / cursor past
      // entry / history-gate false skip). Recent entries, all markets.
      const SEED_MAX_AGE_MS = MAX_EVENT_AGE_MS; // same 24h gate as live entries
      for (const [key, stOpen] of keyState) {
        if (stOpen !== 'open') continue;
        const existing = state.byKey[key];
        // Re-seed rows that were Hold-cancelled while a live Buy/Sell event
        // was still open (NVDA 13 Aug: history fallback matched an old Hold).
        if (existing && existing.supersededByNewBoard) continue;
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
          logOnce('stale-seed-' + key, 'RECONCILE: skip seed (stale key)', key);
          continue;
        }
        if (!scheduledEntryReleaseAllowed(src)) {
          log('RECONCILE: skip seed (before configured SGT recommendation release)', key,
            'entryDate=', src.entryDate || src.t || 'missing',
            'releaseHour=', ENTRY_RELEASE_HOUR_SGT);
          continue;
        }
        try {
          const picks = await fetchJson('/api/dashboard/picks');
          if (picks && picks.dashData
            && !publishedBoardHasPick(picks.dashData, src.ticker, src.hz || 'short', src.side)) {
            log('RECONCILE: skip seed (not on published board)', key);
            continue;
          }
        } catch (e) {
          log('RECONCILE: skip seed (board check failed closed)', key, e.message);
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
            state.pendingReports.push(applyEstimatedCommission({
              kind: 'exec',
              execId: `recover-entry-${key}-q${posInDir}`,
              key, ticker: src.ticker, hz: src.hz || 'short',
              side: src.side === 'sell' ? 'sell' : 'buy', role: 'entry',
              orderId: null, qty: posInDir, price: avg,
              currency: c.currency || 'USD',
              ccyScale: c.penceQuoted ? 100 : 1,
              errorTrade: false, synthetic: true, recon: 'recover-entry',
              session: 'unknown', sessionLabel: '—',
              time: src.t || src.entryDate || new Date().toISOString()
            }));
          }
          log('RECONCILE: recovered filled row from IB position', key, 'qty', posInDir);
          saveState(state);
          continue;
        }
        if (_seedBlocked.has(key) || _seedBlocked.has(String(src.ticker || '').toUpperCase())) continue;
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
            state.pendingReports.push(applyEstimatedCommission({
              kind: 'exec', execId: execId0, key, ticker: src.ticker, hz: src.hz || 'short',
              side: src.side === 'sell' ? 'sell' : 'buy', role: 'entry',
              orderId: null, qty: posInDir0, price: avg0,
              currency: c0.currency || 'USD', ccyScale: c0.penceQuoted ? 100 : 1,
              errorTrade: false, synthetic: true, recon: 'recover-entry',
              session: 'unknown', sessionLabel: '—',
              time: src.t || src.entryDate || new Date().toISOString()
            }));
            log('RECONCILE: import missing entry fill from IB', key, 'qty', posInDir0, '@', avg0);
          }
          saveState(state);
        }
      } catch (e) { log('RECONCILE: recover-entry import failed', e.message); }

      // Corrective US exits should not wait for the opening auction once
      // extended hours are available. Modify the existing held MKT/OPG order
      // in place to a marketable LMT-EXT, then re-enter only after its fill.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || !row.errorTrade || !row.correctiveReentry || !row.ticker) continue;
        const contract = row.contract || toContract(row.ticker);
        if (!contract || !contract.usRth || sessionPhase(contract) !== 'pre') continue;
        const held = posMap.get(posKeyOf(contract));
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (!(posInDir > 0)) continue;
        const lastExtAt = Date.parse(row.correctiveExtAt || 0);
        if (Number.isFinite(lastExtAt) && Date.now() - lastExtAt < 60 * 1000) continue;
        ensureMktData(row.ticker, contract);
        const exitSide = row.side === 'sell' ? 'buy' : 'sell';
        const q = await fetchEntryQuote(row.ticker, 'pre', exitSide);
        const portfolioMark = ibQuoteForTicker(row.ticker);
        const fallbackPx = portfolioMark > 0
          ? portfolioMark * (row.side === 'sell' ? 1.02 : 0.98)
          : null;
        const quotePx = q.px > 0 ? q.px : fallbackPx;
        const spec = correctiveExtExitSpec(contract, row.side, Math.abs(posInDir), quotePx);
        if (!spec) {
          log('RECONCILE: corrective pre-market exit waiting for live quote', key);
          continue;
        }
        if (!(q.px > 0)) {
          log('RECONCILE: corrective pre-market exit using portfolio-mark limit',
            key, 'mark=' + portfolioMark, 'limit=' + spec.lmtPrice);
        }
        let exitId = row.correctiveExtOrderId;
        if (exitId == null) {
          const priorExitId = (row.closeIds || [])[row.closeIds.length - 1];
          if (priorExitId != null) {
            const cancelled = waitCancel(priorExitId, 5000);
            cancelOrder(priorExitId, 'replace corrective OPG with LMT-EXT ' + key);
            const cancelStatus = await cancelled;
            if (cancelStatus === 'timeout') {
              log('RECONCILE: corrective OPG cancel not confirmed; deferring replacement', key, priorExitId);
              continue;
            }
          }
          exitId = nidForRow(row);
          row.closeIds = [...(row.closeIds || []), exitId];
          row.correctiveExtOrderId = exitId;
        }
        transmitOrder(exitId, contract, baseOrder(spec), 'corrective LMT-EXT ' + key);
        row.correctiveExitStyle = 'LMT-EXT';
        row.correctiveExtLmt = spec.lmtPrice;
        row.correctiveExtAt = new Date().toISOString();
        row.correctiveExitQty = Math.abs(posInDir);
        row.updated = row.correctiveExtAt;
        saveState(state);
      }

      // 0. Re-arm unfilled parents still open on the model.
      //   • HK / JP: OPG before open; hold through the auction; then one
      //     LMT-THROUGH / MKT that sits until fill (do not 2-min cancel-loop).
      //   • EU / UK: OPG before open; hold through the auction; then MKT
      //   • US: OPG overnight; in pre/extended upgrade to LMT-EXT immediately
      //     when the live quote is at/better than the AlphaSignal entry; else
      //     stay OPG through 09:30. Never MKT-EXT (IB queues those until RTH).
      const listedParents = await listWorkingOrdersDetailed();
      const workingParentIds = new Set(
        (listedParents.orders || []).map(o => Number(o.orderId)).filter(n => n > 0)
      );
      const rearmJobs = [];
      async function executeUnfilledRearm(key, reason) {
        const row = state.byKey[key];
        if (!row || row.closed) return;
        const c0 = row.contract || toContract(row.ticker);
        const market = (c0 && (c0.market || (c0.usRth ? 'US' : ''))) || '';
        const asia = market === 'HK' || market === 'JP';
        try {
          const src = entryByKey.get(key) || {};
          const oldParent = row.parentId, oldStop = row.stopId, oldTp1 = row.tp1Id;
          const cancelWaits = [];
          if (oldParent != null) {
            cancelWaits.push(waitCancel(oldParent, 3500));
            cancelOrder(oldParent, 'rearm parent ' + key);
          }
          if (oldStop != null) {
            cancelWaits.push(waitCancel(oldStop, 3500));
            cancelOrder(oldStop, 'rearm stop ' + key);
          }
          if (oldTp1 != null) {
            cancelWaits.push(waitCancel(oldTp1, 3500));
            cancelOrder(oldTp1, 'rearm tp1 ' + key);
          }
          const cancelStatuses = cancelWaits.length ? await Promise.all(cancelWaits) : [];
          if (cancelStatuses.some(status => status === 'timeout')) {
            const replaceDeadAsiaBag = reason === 'asia-rth' || reason === 'asia-rth-retry'
              || reason === 'asia-to-opg' || reason === 'asia-missing-style'
              || reason === 'asia-opg-refresh';
            if (!replaceDeadAsiaBag) {
              row.lastRearmAt = new Date().toISOString();
              row.rearmBlocked = 'cancel-timeout';
              saveState(state);
              log('RECONCILE: rearm aborted — cancellation not confirmed', key, reason);
              return;
            }
            log('RECONCILE: cancel timeout — replacing dead Asia bag', key, reason,
              'oids=', oldParent, oldStop, oldTp1);
            row.parentId = null;
            row.stopId = null;
            row.tp1Id = null;
            row.rearmBlocked = null;
            saveState(state);
          }
          const placed = await placeBracket({
            key, ticker: row.ticker, hz: row.hz, side: row.side || src.side,
            entry: src.entry != null ? src.entry : row.entry,
            tp1: src.tp1 != null ? src.tp1 : row.tp1Px,
            sl: src.sl != null ? src.sl : row.stopPx,
            trailSl: src.trailSl != null ? src.trailSl : (src.sl != null ? src.sl : row.stopPx),
            entryDate: src.entryDate || src.t || row.admittedAt,
            t: src.entryDate || src.t || row.admittedAt || new Date().toISOString(),
            reason: src.reason,
            decisionId: src.decisionId || row.decisionId,
            admittedAt: row.admittedAt,
            sector: src.sector || row.sector,
            country: src.country || row.country,
            correlationCluster: src.correlationCluster || row.correlationCluster,
            forceOpg: reason === 'us-pre-handoff-opg' || reason === 'us-pre-park-opg'
              || reason === 'us-pre-unfavorable-to-opg'
              || reason === 'asia-opg-refresh' || reason === 'asia-to-opg',
            skipChase: reason === 'us-rth-after-opg' || reason === 'eu-rth-after-opg',
            carryUnfilled: (asia && !row.entryFilled) || forceCashOpenActive(row)
          });
          if (placed) {
            placed.lastRearmAt = new Date().toISOString();
            placed.rearmReason = reason;
            placed.rearmCount = (Number(row.rearmCount) || 0) + 1;
            placed.entryFilled = false;
            if (row.userReentry) placed.userReentry = true;
            state.byKey[key] = placed;
            log('RECONCILE: re-armed', key, 'reason=' + reason, '→', placed.entryStyle,
              'lot=' + (placed.contract && placed.contract.lotHint),
              'client=' + (placed.placeClientId || ''));
          } else {
            row.lastRearmAt = new Date().toISOString();
            log('RECONCILE: rearm place skipped (after cancel)', key, reason);
          }
          saveState(state);
        } catch (e) { log('RECONCILE: rearm failed', key, e.message); }
      }
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.ticker) continue;
        if (keyState.get(key) !== 'open' && !row.userReentry && !keepUnfilledWorking(row, key)) continue;
        const srcEvt = entryByKey.get(key);
        if (srcEvt && !scheduledEntryReleaseAllowed(srcEvt)) {
          logOnce('rearm-prerelease-' + key, 'RECONCILE: skip re-arm of pre-release entry', key);
          continue;
        }
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
        if (!row.userReentry && !keepUnfilledWorking(row, key)) {
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
          const minsSinceRth = minutesSinceMarketRth(market);
          reason = asiaUnfilledRearmReason({
            phase,
            entryStyle: row.entryStyle,
            stopId: row.stopId,
            tp1Id: row.tp1Id,
            rearmBlocked: row.rearmBlocked,
            contractRejected: row.contractRejected,
            deferred: row.deferred,
            parentId: row.parentId,
            parentWorking: row.parentId != null && workingParentIds.has(Number(row.parentId)),
            parentGone: row.parentId != null && unknownOrderIds.has(Number(row.parentId)),
            openOrdersComplete: listedParents.complete === true,
            lastRearmAt: row.lastRearmAt,
            orderSubmittedAt: row.orderSubmittedAt,
            now: Date.now(),
            minutesSinceRth: minsSinceRth,
            auctionHoldMin: AUCTION_HOLD_MIN
          });
          if (phase === 'rth' && isAuctionEntryStyle(row.entryStyle) && !row.contractRejected
            && Number.isFinite(minsSinceRth) && minsSinceRth < AUCTION_HOLD_MIN) {
            log('RECONCILE: hold JP/HK opening order through auction', key,
              'style=', row.entryStyle, 'minsSinceRth=', minsSinceRth);
          }
        } else if (eu && phase === 'rth' && (isAuctionEntryStyle(row.entryStyle) || row.restoreAfterFalseOrphan)) {
          if (row.restoreAfterFalseOrphan) {
            reason = 'eu-restore-after-orphan';
          } else if (minutesSinceEuRth() < AUCTION_HOLD_MIN) {
            log('RECONCILE: hold EU/UK opening order through auction', key,
              'style=', row.entryStyle, 'minsSinceRth=', minutesSinceEuRth());
          } else {
            reason = 'eu-rth-after-opg';
          }
        } else if (eu && phase === 'rth' && row.contractRejected) {
          reason = 'contract-retry';
        } else if (us) {
          if (phase === 'pre') {
            ensureMktData(row.ticker, contract);
            const sourceEntry = entryByKey.get(key) || {};
            const forceCorrectiveExt = String(sourceEntry.reason || '') === 'rearm-model-entry';
            // Last 2 minutes of US pre: park unfilled LMT-EXT into the opening
            // auction so a gap-up still fills at 09:30 even above the buy entry.
            if (phase === 'pre' && isUsExtStyle(row.entryStyle)
              && !forceCorrectiveExt && minutesUntilUsRth() <= AUCTION_HOLD_MIN) {
              reason = 'us-pre-handoff-opg';
              log('RECONCILE: US pre handoff to OPG for cash open', key, 'minsToRth=', minutesUntilUsRth());
            } else {
            const q = await fetchEntryQuote(row.ticker, phase, row.side);
            const mark = ibQuoteForTicker(row.ticker);
            const entryCap = Number(row.entry) || 0;
            const forcedPx = forceCorrectiveExt
              ? (mark > 0
                ? (row.side === 'sell'
                  ? Math.max(entryCap, mark * 0.98)
                  : Math.min(entryCap, mark * 1.02))
                : entryCap)
              : null;
            const gatePx = q.px > 0 ? q.px : forcedPx;
            const fav = premarketFavorable(row.side, row.entry, gatePx);
            if (forceCorrectiveExt && gatePx > 0 && row.entryStyle !== 'LMT-EXT') {
              reason = 'us-pre-corrective-reentry';
              log('RECONCILE: forcing confirmed corrective re-entry in extended hours',
                key, 'quote=', gatePx, '(' + (q.src || 'portfolio-cap') + ')');
            } else if (fav && row.entryStyle !== 'LMT-EXT') {
              reason = row.entryStyle === 'MKT-EXT' ? 'us-pre-mkt-to-lmt' : 'us-pre-favorable';
              log('RECONCILE: US pre/post gate OPEN', key, 'phase=' + phase, 'quote=', gatePx, '(' + (q.src || '?') + ') entry=', row.entry, 'side=', row.side, 'was=', row.entryStyle);
            } else if (fav && row.entryStyle === 'LMT-EXT') {
              const want = extendedFillLimit(row.side, row.entry, gatePx, contract);
              const have = Number(row.extLmt) || Number(row.entry) || 0;
              if (want > 0 && have > 0 && Math.abs(want - have) > 1e-6) {
                reason = 'us-pre-reprice';
                log('RECONCILE: US pre/post reprice', key, 'phase=' + phase, 'quote=', gatePx, '(' + (q.src || '?') + ') lmt', have, '→', want);
              }
            } else if (gatePx > 0 && !fav && isUsExtStyle(row.entryStyle) && !forceCorrectiveExt) {
              // Was chasing extended; quote no longer good → park at next open
              reason = 'us-pre-unfavorable-to-opg';
              log('RECONCILE: US pre/post gate CLOSED', key, 'quote=', gatePx, 'entry=', row.entry, '→ OPG');
            } else if (!reason && (row.deferred || row.parentId == null
              || String(row.entryStyle || '').startsWith('DEFER-US'))) {
              reason = fav ? 'us-pre-favorable' : 'us-pre-park-opg';
              log('RECONCILE: US pre first fire', key, 'quote=', gatePx, 'fav=', fav, '→', reason);
            }
            }
          } else if (phase === 'rth' && (row.entryStyle === 'OPG' || isUsExtStyle(row.entryStyle))) {
            if (row.entryStyle === 'OPG' && minutesSinceUsRth() < AUCTION_HOLD_MIN) {
              log('RECONCILE: hold US OPG through auction', key, 'minsSinceRth=', minutesSinceUsRth());
            } else {
              reason = 'us-rth-after-opg';
            }
          } else if (phase === 'post' || phase === 'closed') {
            // Do not submit overnight. Cancel leftover extended parents and wait for pre.
            if (row.parentId != null && (isUsExtStyle(row.entryStyle) || row.entryStyle === 'MKT')) {
              cancelOrder(row.parentId, 'US overnight wait-for-pre parent ' + key);
              if (row.stopId != null) cancelOrder(row.stopId, 'US overnight wait-for-pre stop ' + key);
              if (row.tp1Id != null) cancelOrder(row.tp1Id, 'US overnight wait-for-pre tp1 ' + key);
              row.parentId = null;
              row.stopId = null;
              row.tp1Id = null;
              row.deferred = true;
              row.entryStyle = 'DEFER-US-UNTIL-PRE';
              row.updated = new Date().toISOString();
              saveState(state);
              log('RECONCILE: US overnight — cancelled working entry, wait for pre', key);
            }
          } else if (phase === 'rth' && row.contractRejected) {
            reason = 'contract-retry';
          } else if (row.userReentry && row.parentId == null) {
            if (phase === 'rth') reason = 'contract-retry';
            else if (phase === 'pre') reason = 'us-pre-park-opg';
          }
        }
        if (!reason) continue;

        const last = row.lastRearmAt ? Date.parse(row.lastRearmAt) : 0;
        const auctionNow = reason === 'us-pre-handoff-opg' || reason === 'us-rth-after-opg'
          || reason === 'eu-restore-after-orphan' || reason === 'eu-rth-after-opg'
          || reason === 'us-pre-favorable' || reason === 'us-pre-mkt-to-lmt'
          || reason === 'us-pre-corrective-reentry'
          || reason === 'us-pre-reprice' || reason === 'us-pre-unfavorable-to-opg'
              || reason === 'us-pre-park-opg'
              || reason === 'asia-rth'
              || reason === 'asia-opg-refresh'
          || reason === 'us-overnight-to-opg' || reason === 'us-post-to-opg';
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
        rearmJobs.push({ key, reason });
      }
      if (rearmJobs.length) {
        const poolN = Math.max(1, execSlots.filter(s => s.ready).length || 1);
        log('RECONCILE: rearming', rearmJobs.length, 'name(s) on', poolN, 'client(s)');
        await runWithConcurrency(rearmJobs, poolN, job => executeUnfilledRearm(job.key, job.reason));
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
        const fid = nidForRow(row);
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
          logOnce('orphan-protect-' + y, 'RECONCILE: skip orphan flatten — alias protected', y,
            'aliases=', aliases.join(','),
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
        const oc = placeableContract(Object.assign({}, cMeta, rawOc, { conId }));
        const action = pos > 0 ? 'SELL' : 'BUY';
        // RTH → market day order. Otherwise → opening auction (next session).
        const useOpg = phase !== 'rth';
        const tif = useOpg ? 'OPG' : 'DAY';
        log('RECONCILE: flattening', isOrphanIbOnly ? 'IB-ONLY ORPHAN' : 'UNAUTHORIZED',
          pk, 'pos=' + pos, 'ticker=' + y, 'streak=' + streak,
          'exch=' + (oc && oc.exchange), 'conId=' + conId,
          useOpg ? ('OPG→next open (' + phase + ')') : 'MKT RTH');
        if (conId > 0) _orphanFlattenedConIds.add(conId);
        transmitOrder(fid, Object.assign({}, cMeta, rawOc, { conId }), baseOrder({
          orderId: fid, action,
          orderType: 'MKT', totalQuantity: qty, tif, transmit: true,
          outsideRth: ORDER_OUTSIDE_RTH
        }), (isOrphanIbOnly ? 'orphan-ib-only-flatten ' : 'unauthorized-flatten ') + pk
          + (useOpg ? ' OPG' : ' MKT'));
      }

      // No excess-qty trim — never reduce a live model lot (9988/0005/2914).

      // 1c. IB↔AS ledger sync (also runs on its own 60s timer — see postIbRecon).
      let serverTrades = null;
      await postIbRecon();
      // Prefer real IB exit prices from execution history when site is open / IB flat.
      await recoverMissingExitFills().catch(e => log('exec-history error', e.message));
      rebaseOpenLotsFromFill();

      // 2. Rows flat at IB but never closed in state (exit filled while down).
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row || !row.contract) continue;
        const yahooQty = ibSignedQtyForYahoo(row.ticker);
        const inDir = row.side === 'sell' ? -yahooQty : yahooQty;
        const siblingOwns = Object.values(state.byKey || {}).some(other =>
          other && other !== row && !other.closed && other.entryFilled
          && normalizeYahooTicker(other.ticker) === normalizeYahooTicker(row.ticker)
          && String(other.side || 'buy') === String(row.side || 'buy'));
        // Futures posKey includes expiry text that often differs from IB's
        // portfolio key. Reopen only when IB still holds THIS side and no
        // other open row already owns the lot (2914 long vs 2914 short-horizon).
        if (row.closed && row.entryFilled && inDir > 0 && !siblingOwns) {
          row.closed = false;
          row.updated = new Date().toISOString();
          saveState(state);
          log('RECONCILE: reopening', key, '(IB still holds qty=' + yahooQty + ')');
        }
        if (!row.closed && row.entryFilled && (siblingOwns || (yahooQty !== 0 && !(inDir > 0)))) {
          if (siblingOwns) {
            // Closed row must not keep working-order IDs — orphan sweep would
            // cancel the live sibling's stop/TP1 (2914 long vs short-horizon).
            row.stopId = null;
            row.tp1Id = null;
            row.parentId = null;
          } else {
            const siblingNeedsStop = Object.values(state.byKey || {}).some(other =>
              other && other !== row && !other.closed
              && normalizeYahooTicker(other.ticker) === normalizeYahooTicker(row.ticker)
              && other.stopId != null && other.stopId === row.stopId);
            if (siblingNeedsStop) row.stopId = null;
          }
          row.closed = true;
          row.updated = new Date().toISOString();
          saveState(state);
          log('RECONCILE: re-closing', key, siblingOwns ? '(sibling already owns the lot)' : ('(IB qty is the other side, yahooQty=' + yahooQty + ')'));
        }
        if (row.closed || !row.contract) continue;
        // A pending or rejected parent with no fill is not a closed trade merely
        // because IB has no position yet. Re-arm logic owns these rows.
        if (!row.entryFilled) continue;
        const held = heldForContract(row.contract);
        const flatAtIb = held ? held.pos === 0 : !held;
        if (!flatAtIb || inDir > 0) continue;
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
        const working = await listWorkingOrders();
        await ensureWorkingStops(working);
        await ensureWorkingTp1Children(working);
        const findings = collectRiskFindings(keyState, lastIbReconResp);
        await maybeSendRiskAlert(findings);
      } catch (e) { log('TELEGRAM: risk check failed', e.message); }
      // Once per US session after post-market close (≈20:00 ET / 00:00 UTC EDT).
      try { await maybeSendEodPerformanceSummary(); }
      catch (e) { log('TELEGRAM: EOD check failed', e.message); }
    } catch (e) { log('reconcile error', e.message); }
  }

  async function pollOnce() {
    if (!positionsReady) {
      log('event poll deferred — waiting for IB position/open-state snapshot');
      return;
    }
    const data = await fetchJson(`/api/ibkr/events?since=${state.since}&limit=100`);
    const events = data.events || [];
    for (const evt of events) {
      try {
        await handleEvent(evt);
        const store = getBridgeStore();
        if (store) store.appendEvent(`server-seq:${evt.seq}`, evt.type, evt);
      } catch (e) { log('event error', evt.type, evt.ticker, e.message); }
      if (evt.seq > state.since) state.since = evt.seq;
    }
    if (events.length) { saveState(state); log(`Processed ${events.length} event(s); since=${state.since}`); }
    await flushReports();
  }

  // Push captured executions to AlphaSignal so the site's IBKR tab shows
  // real paper-account PnL. Reports stay queued until the server confirms.
  async function flushReports() {
    const pending = state.pendingReports || [];
    for (const r of pending) {
      if (!r || !r.execId || r.commission != null) continue;
      const comm = commissionByExec.get(String(r.execId));
      if (!comm) continue;
      r.commission = comm.commission;
      r.commissionCcy = comm.currency;
      if (comm.realizedPNL != null) r.ibRealizedPnl = comm.realizedPNL;
    }
    const extra = [];
    for (const [execId, comm] of commissionByExec) {
      if (!comm || postedCommissionExecIds.has(execId)) continue;
      extra.push({
        kind: 'commission',
        execId,
        commission: comm.commission,
        commissionCcy: comm.currency,
        ibRealizedPnl: comm.realizedPNL,
        time: new Date().toISOString()
      });
    }
    const reports = pending.concat(extra);
    if (!reports.length) return;
    try {
      const resp = await postJson('/api/ibkr/report', { reports });
      if (resp && resp.ok) {
        const accepted = new Set(resp.acceptedExecIds || []);
        const dups = new Set(resp.dupExecIds || []);
        const patched = new Set(resp.patchedExecIds || []);
        const commOk = Number(resp.commissionsPatched) > 0;
        state.pendingReports = pending.filter((r) => {
          const id = String(r && r.execId || '');
          if (!id) return false;
          if (accepted.has(id) || dups.has(id) || patched.has(id)) return false;
          if (r.kind === 'commission' && r.estimated && commOk) return false;
          return true;
        });
        for (const r of extra.concat(pending.filter(x => x && x.kind === 'commission'))) {
          const id = String(r && r.execId || '');
          if (!id) continue;
          if (accepted.has(id) || dups.has(id) || patched.has(id) || (r.estimated && commOk)) {
            postedCommissionExecIds.add(id);
          }
        }
        saveState(state);
        log(`Reported ${reports.length} execution(s) to AlphaSignal (stored=${resp.stored}, dup=${resp.skippedDup != null ? resp.skippedDup : resp.skipped}, phantom=${resp.skippedPhantom || 0}, commPatch=${resp.commissionsPatched || 0})`);
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
      rebaseOpenLotsFromFill();
      await (async () => {
        const working = await listWorkingOrders();
        await ensureWorkingStops(working);
        await ensureWorkingTp1Children(working);
      })().catch(e => log('ensure-exits error', e.message));
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
  boardLotHint,
  parentEntrySpec,
  correctiveExtExitSpec,
  sessionPhase,
  minutesUntilUsRth,
  minutesSinceUsRth,
  shareSplit,
  scheduledEntryReleaseAllowed,
  boardPublishedAtRelease,
  publishedBoardHasPick,
  shouldAlertReconFailure,
  riskFindingsFingerprint,
  isAuctionEntryStyle,
  asiaUnfilledCarryActive,
  forceCashOpenActive,
  keepUnfilledWorking,
  minutesSinceMarketRth,
  asiaUnfilledRearmReason,
  isLiveAuthorizedServerExit: require('../lib/ibkr/live-exit-authority').isLiveAuthorizedServerExit
};
