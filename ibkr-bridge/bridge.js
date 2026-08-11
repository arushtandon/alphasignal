#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge (v2)
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events (JSONL feed)
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and mirrors the AlphaSignal exit spec exactly:
 *
 *     entry        → parent MARKET entry (recommended price sizes shares + gates US pre):
 *                      • US pre/extended: MKT outsideRth ONLY if live quote is at
 *                        or better than the AlphaSignal entry (buy: quote≤entry,
 *                        sell: quote≥entry); otherwise MOO (OPG) for the cash open
 *                      • US RTH: MKT; US fully closed: MOO for next open
 *                      • JP / HK / EU / UK: MOO before the open; MKT in RTH
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
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

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
const SWEEP_MS = 5 * 60 * 1000;
/** Optional kill-switch only (default EMPTY). Authorization is by provenance
 *  (open emitted entry key), not ticker identity — see Claude audit Fix 1. */
const ERROR_TRADE_TICKERS = new Set(
  String(process.env.IBKR_ERROR_TICKERS || '')
    .split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase())
);
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

/** Normalize Yahoo tickers so 5.HK ≡ 0005.HK for open-lot / orphan matching. */
function normalizeYahooTicker(t) {
  const s = String(t || '').toUpperCase();
  const m = s.match(/^(\d+)\.HK$/);
  if (m) return m[1].padStart(4, '0') + '.HK';
  return s;
}

/** Dual-list aliases — same conId identity; authorize by provenance not name. */
const LISTING_ALIASES = {
  'AIR.DE': ['AIR.PA'],
  'AIR.PA': ['AIR.DE']
};
function yahooAliases(t) {
  const y = normalizeYahooTicker(t);
  const out = new Set([y]);
  for (const a of (LISTING_ALIASES[y] || [])) out.add(normalizeYahooTicker(a));
  return out;
}
function setHasYahooAlias(set, t) {
  for (const a of yahooAliases(t)) {
    if (set.has(a)) return true;
  }
  return false;
}

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
  if (TOKEN) u.searchParams.set('token', TOKEN);
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
/** Yahoo-style ticker → IB stock contract. Returns null for unsupported
 *  instruments (futures, crypto, NSE unless enabled) — those are LOGGED and
 *  skipped, never half-placed. */
function toContract(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (t.includes('=F') || t.endsWith('-USD')) return null;           // futures / crypto
  if (t.endsWith('.NS') || t.endsWith('.BO')) {
    if (!ALLOW_NSE) return null;                                      // IB NSE restriction
    return { symbol: t.replace(/\.(NS|BO)$/, ''), secType: 'STK', exchange: 'NSE', currency: 'INR' };
  }
  // SMART routing everywhere (primaryExch pins the listing) — direct routing
  // trips TWS's "higher trade fees" API precaution and orders get discarded.
  if (t.endsWith('.L'))  return { symbol: t.replace(/\.L$/, ''),  secType: 'STK', exchange: 'SMART', primaryExch: 'LSE',  currency: 'GBP', penceQuoted: true, market: 'LSE' };
  if (t.endsWith('.DE')) return { symbol: t.replace(/\.DE$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'IBIS', currency: 'EUR', market: 'XETRA' };
  if (t.endsWith('.PA')) return { symbol: t.replace(/\.PA$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'SBF',  currency: 'EUR', market: 'EURONEXT' };
  if (t.endsWith('.AS')) return { symbol: t.replace(/\.AS$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'AEB',  currency: 'EUR', market: 'EURONEXT' };
  if (t.endsWith('.MI')) return { symbol: t.replace(/\.MI$/, ''), secType: 'STK', exchange: 'SMART', primaryExch: 'BVME', currency: 'EUR', market: 'EURONEXT' };
  if (t.endsWith('.HK')) return { symbol: String(parseInt(t.replace(/\.HK$/, ''), 10)), secType: 'STK', exchange: 'SMART', primaryExch: 'SEHK', currency: 'HKD', lotHint: 100, market: 'HK' };
  if (t.endsWith('.T'))  return { symbol: t.replace(/\.T$/, ''),  secType: 'STK', exchange: 'SMART', primaryExch: 'TSEJ', currency: 'JPY', lotHint: 100, market: 'JP' };
  if (t.includes('.'))   return null;                                 // unknown suffix
  const symbol = t === 'BRK.B' ? 'BRK B' : t;
  return { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExch: 'NASDAQ', usRth: true, market: 'US' };
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
    LSE:      { open: 7 * 60,       close: 15 * 60 + 30 }                // 08:00–16:30 BST
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
  // Before open same calendar day → pre (MOO queues for today's auction)
  if (utcMin < w.open) return 'pre';
  return 'closed'; // after close → MOO for tomorrow's open
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

/**
 * Parent entry order: MOO / RTH MKT / US extended MKT (price-gated).
 * opts: { side, entryPx, quotePx } — quotePx gates US pre/extended only.
 */
function parentEntrySpec(contract, action, qty, opts = {}) {
  const phase = sessionPhase(contract);
  const side = opts.side || (String(action).toUpperCase() === 'SELL' ? 'sell' : 'buy');
  const entryPx = Number(opts.entryPx);
  const quotePx = Number(opts.quotePx);
  // IB SMART often rejects orderType 'MOO' (error 321). The portable form is
  // MKT + tif OPG (submit to the opening auction).
  if (contract.usRth) {
    if (phase === 'rth') {
      // Never chase a stale model entry more than US_RTH_MAX_CHASE_BPS adverse
      // (FSLR bought 248 vs entry 236.8 after a late Hold→Buy emit).
      if (entryPx > 0 && quotePx > 0) {
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
      // Premarket / post: only lift if quote is at or better than recommendation
      if (premarketFavorable(side, entryPx, quotePx)) {
        return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: true, transmit: false, entryStyle: 'MKT-EXT' };
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

/** Whole-share split of the FX-adjusted notional; respects exchange lot hints. */
async function shareSplit(entry, contract, lotOverride) {
  const e = Number(entry);
  if (!(e > 0)) return { total: 0, sold: 0, runner: 0 };
  let localNotional = NOTIONAL * await usdToCurrency(contract.currency);
  if (contract.penceQuoted) localNotional *= 100; // LSE quotes in pence
  const lot = Math.max(1, Number(lotOverride || contract.lotHint) || 1);
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
  const ccy = String(c.currency || '');
  if (ccy === 'USD' || c.usRth) {
    c.usRth = true;
    c.market = 'US';
  } else if (ccy === 'HKD') c.market = 'HK';
  else if (ccy === 'JPY') c.market = 'JP';
  else if (ccy === 'GBP') c.market = 'LSE';
  else if (ccy === 'EUR') {
    c.market = (String(c.primaryExch || '') === 'SBF') ? 'EURONEXT' : 'XETRA';
  }
  return c;
}

function orderContractFromPos(c) {
  if (!c) return null;
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
    // IB often wants the numeric code as-is; keep symbol from the position
  } else if (out.currency === 'JPY') {
    out.primaryExch = 'TSEJ';
  } else if (out.currency === 'EUR') {
    out.primaryExch = 'IBIS';
  } else if (out.currency === 'GBP') {
    out.primaryExch = 'LSE';
  } else if (out.currency === 'USD') {
    out.primaryExch = 'NASDAQ';
  }
  return enrichSessionMeta(out);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | dryRun=${DRY} | notional=$${NOTIONAL}`);

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
  const posKeyOf = c => `${String(c.symbol).toUpperCase()}|${c.currency}`;
  const _flattenTried = new Map(); // pk -> last reconcile-flatten attempt ts
  // Persist debounce across restarts (in-memory Map was resetting to 1/2 every boot).
  if (!state.unauthStreak || typeof state.unauthStreak !== 'object') state.unauthStreak = {};
  const _cancelWaiters = new Map(); // orderId -> { resolve, timer }
  const portfolioAvgCost = new Map(); // normalized yahoo -> averageCost from IB
  const lotCache = new Map(); // posKey -> board lot
  let nextDetailsId = 900000;
  // Live IBKR market data for MTM (posted to AlphaSignal every ~10s).
  const mktById = new Map(); // reqId -> { ticker, last, bid, ask, close }
  const mktSubscribed = new Set(); // AlphaSignal ticker already subscribed
  // Account portfolio marks from IB (same marks TWS shows) — does NOT need a
  // separate live market-data stream (avoids error 10197 competing session).
  const portfolioMarks = new Map(); // yahooTicker -> { price, at, unrealizedPNL }
  let nextMktId = 1;

  function nid() { return nextOrderId++; }

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
          state.pendingReports.push({
            kind: 'exec', execId: exec.execId, key,
            ticker: row.ticker, hz: row.hz, side: row.side, role,
            orderId, qty: Number(exec.shares), price: px,
            currency: row.contract && row.contract.currency || 'USD',
            ccyScale: row.contract && row.contract.penceQuoted ? 100 : 1,
            errorTrade: !!(row.errorTrade || ERROR_TRADE_TICKERS.has(String(row.ticker || '').toUpperCase())),
            session: phase,
            sessionLabel: sessionLabel(phase),
            time: fillAt
          });
          saveState(state);
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
      // Bare EUR "AIR" → also try .DE / .PA spellings used on the site.
      if (contract.currency === 'EUR' && contract.symbol) {
        aliases.add(String(contract.symbol) + '.DE');
        aliases.add(String(contract.symbol) + '.PA');
      }
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
    const sym = String(c.symbol || '');
    const ccy = c.currency;
    if (ccy === 'HKD') {
      // Pad numeric HK codes so IB "5" matches AlphaSignal "0005.HK"
      if (/^\d+$/.test(sym)) return sym.padStart(4, '0') + '.HK';
      return sym + '.HK';
    }
    if (ccy === 'JPY') return sym + '.T';
    if (ccy === 'GBP') return sym + '.L';
    if (ccy === 'EUR') {
      if (c.primaryExch === 'SBF') return sym + '.PA';
      if (c.primaryExch === 'AEB') return sym + '.AS';
      if (c.primaryExch === 'BVME') return sym + '.MI';
      return sym + '.DE';
    }
    return sym;
  }

  /** Board lot from IB contract details (critical for HK — 0005 is 400, not 100). */
  function resolveLot(contract) {
    if (!contract) return Promise.resolve(1);
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

  /** Subscribe to IB market data for an AlphaSignal ticker (idempotent). */
  function ensureMktData(ticker, contract) {
    if (DRY || !ib || !ticker || !contract || mktSubscribed.has(ticker)) return;
    const id = nextMktId++;
    mktById.set(id, {
      ticker, last: null, bid: null, ask: null, close: null,
      lastTickAt: null, lastAt: null, contract
    });
    mktSubscribed.add(ticker);
    const oc = orderContractFromPos(contract) || {
      symbol: contract.symbol, secType: contract.secType || 'STK',
      exchange: 'SMART', currency: contract.currency,
      primaryExch: contract.primaryExch, conId: contract.conId
    };
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
    if (!marks.length) return;
    try {
      const resp = await postJson('/api/ibkr/marks', { marks });
      if (resp && resp.ok) log('marks posted', marks.length, '→', marks.map(m => m.ticker + '=' + m.price).join(' '));
    } catch (e) { log('marks flush failed:', e.message); }
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

  /** Live/pre quote for US premarket gate (IB ticks, else AlphaSignal /api/prices). */
  async function fetchEntryQuote(ticker) {
    const ibPx = ibQuoteForTicker(ticker);
    if (ibPx > 0) return { px: ibPx, src: 'ibkr' };
    try {
      const j = await fetchJson('/api/prices?symbols=' + encodeURIComponent(ticker));
      const v = j && j[ticker];
      if (v == null) return { px: null, src: null };
      const pre = Number(v.preMarketPrice ?? v.preMarket ?? 0);
      if (pre > 0) return { px: pre, src: 'pre' };
      const px = Number(v.price ?? v.regularMarketPrice ?? v.last ?? v);
      if (px > 0) return { px, src: 'last' };
    } catch (e) { log('entry quote fetch failed', ticker, e.message); }
    return { px: null, src: null };
  }

  // ── Entry: full bracket ────────────────────────────────────────────────────
  async function placeBracket(evt) {
    const contract = toContract(evt.ticker);
    if (!contract) {
      log('skip entry (unsupported instrument for IB paper):', evt.ticker);
      return null;
    }
    const isSell = evt.side === 'sell';
    const lot = await resolveLot(contract);
    contract.lotHint = lot;
    const split = await shareSplit(evt.entry, contract, lot);
    if (split.total < 1) { log('skip entry — zero shares for', evt.ticker, 'entry', evt.entry, 'lot', lot); return null; }
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
    const rthOk = !!contract.usRth; // outsideRth only meaningful for US SMART
    const parentId = nid(), stopId = nid(), tp1Id = tp1Px > 0 && split.sold > 0 ? nid() : null;

    // US pre/extended + RTH chase: gate on live quote vs recommended entry.
    let quotePx = null;
    let quoteSrc = null;
    const usPhase = contract.usRth ? sessionPhase(contract) : null;
    if (contract.usRth && (usPhase === 'pre' || usPhase === 'post' || usPhase === 'rth')) {
      ensureMktData(evt.ticker, contract);
      const q = await fetchEntryQuote(evt.ticker);
      quotePx = q.px;
      quoteSrc = q.src;
    }
    const parentSpec = parentEntrySpec(contract, openAction, split.total, {
      side: evt.side, entryPx: evt.entry, quotePx
    });
    if (parentSpec.defer) {
      log('defer entry', evt.ticker, parentSpec.entryStyle, 'phase=', sessionPhase(contract));
      return null;
    }
    const { entryStyle, defer, ...parentFields } = parentSpec;
    const parent = baseOrder({ orderId: parentId, ...parentFields });
    // Stop child: FULL quantity — pre-TP1 an SL hit closes the whole position
    // (identical to the simulator's sl_hit). GTC so it survives sessions.
    const stopOrder = baseOrder({
      orderId: stopId, action: closeAction, orderType: 'STP',
      auxPrice: stopPx, totalQuantity: split.total,
      parentId, transmit: tp1Id == null
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
      // Prefer conId when resolved — HK SMART+symbol alone often hits error 200.
      // Pin SEHK for Hong Kong; SMART for everything else.
      const oc = (contract.conId > 0)
        ? {
            conId: Number(contract.conId),
            symbol: contract.symbol != null ? String(contract.symbol) : undefined,
            localSymbol: contract.localSymbol || undefined,
            secType: 'STK',
            exchange: contract.market === 'HK' ? 'SEHK' : 'SMART',
            primaryExch: contract.primaryExch,
            currency: contract.currency
          }
        : (orderContractFromPos(contract) || contract);
      ib.placeOrder(parentId, oc, parent);
      ib.placeOrder(stopId, oc, stopOrder);
      if (tp1Order) ib.placeOrder(tp1Id, oc, tp1Order);
      const gateNote = contract.usRth && sessionPhase(contract) === 'pre'
        ? ` quote=${quotePx != null ? quotePx : 'n/a'}(${quoteSrc || 'none'}) vs entry=${roundPx(evt.entry)} → ${entryStyle}`
        : '';
      log('Placed bracket', evt.ticker, evt.side,
        `style=${entryStyle} phase=${sessionPhase(contract)} qty=${split.total} sizePx=${roundPx(evt.entry)} stop=${stopPx}(full) tp1=${tp1Px}x${split.sold} runner=${split.runner}${gateNote}`);
    }
    return {
      parentId, stopId, tp1Id,
      ticker: evt.ticker, hz: evt.hz, side: evt.side,
      entry: evt.entry, stopPx, tp1Px, entryStyle,
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
      transmitOrder(fid, row.contract, baseOrder({
        orderId: fid,
        action: row.side === 'sell' ? 'BUY' : 'SELL',
        orderType: 'MKT', totalQuantity: remaining, tif: 'DAY', transmit: true
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
      if (state.byKey[key] && state.byKey[key].parentId) { log('skip duplicate entry', key); return; }
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
      if (!(Number(evt.entry) > 0) || !(Number(evt.trailSl != null ? evt.trailSl : evt.sl) > 0)) {
        log('skip entry (missing entry/SL):', key);
        return;
      }
      // Defense in depth: re-check live history is still Buy/Sell for this key.
      try {
        const hist = await fetchJson('/api/history');
        const rows = Array.isArray(hist) ? hist : [];
        const hz = evt.hz || 'short';
        const keyDay = String(key.split('|')[2] || '');
        const keyDayMs = Date.parse(keyDay);
        // Same trading-day key as server; ±2h clock-skew only (no multi-day fuzzy).
        const h = rows.find(x => {
          if (!x || x.ticker !== evt.ticker) return false;
          if (String(x.hz || 'short') !== String(hz)) return false;
          const ms = Date.parse(x.entryDate || x.timestamp || 0);
          if (!Number.isFinite(ms)) return false;
          if (singaporeToDateString(ms) === keyDay) return true;
          return Number.isFinite(keyDayMs) && Math.abs(ms - keyDayMs) <= 2 * 3600 * 1000
            && singaporeToDateString(ms) === singaporeToDateString(keyDayMs);
        });
        const act = String((h && (h[hz + 'Action'] || h.action)) || '').toLowerCase();
        if (act !== 'buy' && act !== 'sell') {
          log('skip entry (history not Buy/Sell):', key, 'action=', act || 'missing');
          return;
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

  // ── IB ↔ AlphaSignal ledger sync ───────────────────────────────────────────
  // Posts paper positions + avgCost so the site open qty / entry avg / ghost
  // opens match DU1764495. Untracked IB leftovers are reported, not invented.
  let lastIbReconAt = 0;
  async function postIbRecon() {
    if (DRY || !ib || !positionsReady) return;
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
    try {
      const resp = await postJson('/api/ibkr/recon', { positions, marks, account: ACCOUNT || '' });
      lastIbReconAt = Date.now();
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
    } catch (e) { log('RECONCILE: IB↔AS recon failed', e.message); }
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
          const h = rows.find(x => {
            if (!x || x.ticker !== row.ticker) return false;
            if (String(x.hz || 'short') !== String(hz)) return false;
            const ms = Date.parse(x.entryDate || x.timestamp || 0);
            if (!Number.isFinite(ms)) return false;
            if (singaporeToDateString(ms) === keyDay) return true;
            return Number.isFinite(keyDayMs) && Math.abs(ms - keyDayMs) <= 2 * 3600 * 1000
              && singaporeToDateString(ms) === singaporeToDateString(keyDayMs);
          });
          if (!h) continue;
          const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
          if (act === 'buy' || act === 'sell') continue;
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

      // 0z. Seed missing HK/JP state rows still open on the model (state loss /
      // cursor past the original entry event). Only recent entries — never
      // revive multi-day-old Asia keys (e.g. Wed Aug 05) that still lack an exit.
      const SEED_MAX_AGE_MS = MAX_EVENT_AGE_MS; // same 24h gate as live entries
      for (const [key, stOpen] of keyState) {
        if (stOpen !== 'open' || state.byKey[key]) continue;
        const src = entryByKey.get(key);
        if (!src || !src.ticker) continue;
        const c = toContract(src.ticker);
        if (!c || (c.market !== 'HK' && c.market !== 'JP')) continue;
        const tradeTs = Date.parse(src.entryDate || src.t || 0);
        const keyDayTs = Date.parse(String(key.split('|')[2] || ''));
        const oldest = Math.min(
          Number.isFinite(tradeTs) ? tradeTs : Infinity,
          Number.isFinite(keyDayTs) ? keyDayTs : Infinity
        );
        if (!Number.isFinite(oldest) || oldest === Infinity || (Date.now() - oldest) > SEED_MAX_AGE_MS) {
          log('RECONCILE: skip seed (stale Asia key)', key);
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
          log('RECONCILE: recovered filled Asia row from IB position', key, 'qty', posInDir);
          saveState(state);
          continue;
        }
        state.byKey[key] = {
          ticker: src.ticker, hz: src.hz, side: src.side,
          entry: src.entry, stopPx: src.sl || src.trailSl, tp1Px: src.tp1 || 0,
          entryStyle: null, entryFilled: false, closed: false,
          contract: c, updated: new Date().toISOString()
        };
        log('RECONCILE: seeded missing Asia state row', key);
        saveState(state);
      }

      // 0. Re-arm unfilled parents still open on the model.
      //   • HK / JP: chase while model open (missed OPG must not stay dead)
      //   • EU / UK: OPG before open; if still unfilled once RTH starts → MKT
      //   • US: OPG overnight; in pre/extended upgrade to MKT-EXT only when the
      //     live quote is at/better than the AlphaSignal entry; else stay OPG
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.ticker) continue;
        if (keyState.get(key) !== 'open') continue;
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
        if (row.entryFilled || parentFilledQty > 0) {
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
        // Never chase Asia keys older than the event-age gate (prevents Aug 05
        // shorts being MKT-bought on Aug 07 just because model status is still open).
        if (asia) {
          const srcAge = entryByKey.get(key);
          const tradeTs = Date.parse((srcAge && (srcAge.entryDate || srcAge.t)) || 0);
          const keyDayTs = Date.parse(String(key.split('|')[2] || ''));
          const oldest = Math.min(
            Number.isFinite(tradeTs) ? tradeTs : Infinity,
            Number.isFinite(keyDayTs) ? keyDayTs : Infinity
          );
          if (Number.isFinite(oldest) && oldest !== Infinity && (Date.now() - oldest) > MAX_EVENT_AGE_MS) {
            log('RECONCILE: skip re-arm (stale Asia key)', key);
            continue;
          }
        }
        const eu = market === 'XETRA' || market === 'EURONEXT' || market === 'LSE';
        const us = !!contract.usRth;

        let reason = null;
        if (asia) {
          if (phase === 'lunch') {
            // Wait for 13:00 HKT reopen — do not cancel/replace during the break
          } else if (phase === 'rth' && row.entryStyle !== 'MKT') reason = 'asia-rth';
          else if (phase === 'rth' && row.entryStyle === 'MKT' && row.lastRearmAt
            && (Date.now() - Date.parse(row.lastRearmAt)) > 2 * 60 * 1000) {
            // Prior MKT place rejected (lot/tick/contract/lunch) — retry
            reason = 'asia-rth-retry';
          } else if (phase !== 'rth' && phase !== 'lunch' && row.entryStyle === 'MKT') reason = 'asia-to-opg';
          else if (!row.entryStyle) reason = 'asia-missing-style';
        } else if (eu && phase === 'rth' && row.entryStyle === 'OPG') {
          reason = 'eu-rth-after-opg';
        } else if (us) {
          if (phase === 'pre' || phase === 'post') {
            ensureMktData(row.ticker, contract);
            const q = await fetchEntryQuote(row.ticker);
            const fav = premarketFavorable(row.side, row.entry, q.px);
            if (fav && row.entryStyle !== 'MKT-EXT') {
              reason = 'us-pre-favorable';
              log('RECONCILE: US pre/post gate OPEN', key, 'phase=' + phase, 'quote=', q.px, '(' + (q.src || '?') + ') entry=', row.entry, 'side=', row.side);
            } else if (!fav && row.entryStyle === 'MKT-EXT') {
              // Was chasing extended; quote no longer good → park at next open
              reason = 'us-pre-unfavorable-to-opg';
              log('RECONCILE: US pre/post gate CLOSED', key, 'quote=', q.px, 'entry=', row.entry, '→ OPG');
            }
          } else if (phase === 'rth' && row.entryStyle === 'OPG') {
            reason = 'us-rth-after-opg';
          } else if (phase === 'closed' && row.entryStyle === 'MKT-EXT') {
            // Overnight leftover extended order — convert to next-open OPG
            reason = 'us-overnight-to-opg';
          }
        }
        if (!reason) continue;

        const last = row.lastRearmAt ? Date.parse(row.lastRearmAt) : 0;
        const minGap = reason === 'asia-rth-retry' ? 2 * 60 * 1000 : 15 * 60 * 1000;
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
            t: new Date().toISOString()
          });
          if (placed) {
            placed.lastRearmAt = new Date().toISOString();
            placed.rearmReason = reason;
            placed.rearmCount = (Number(row.rearmCount) || 0) + 1;
            placed.entryFilled = false;
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

      // 0e. Clear error-flatten tags when provenance says the name is authorized
      // (open emitted entry / alias). Never flatten by ticker identity lists.
      for (const k of Object.keys(state.byKey)) {
        const row = state.byKey[k];
        if (!row) continue;
        const yClear = normalizeYahooTicker(row.ticker || '');
        if (setHasYahooAlias(openYahoo, yClear)
          && (row.errorTrade || row.flatReason === 'unauthorized-non-recommendation' || /\|error\|/.test(k))) {
          log('RECONCILE: clearing error-flatten state (provenance-authorized)', k);
          delete state.byKey[k];
          saveState(state);
        }
      }

      // 0e2. Resume flattens for rows already tagged unauthorized in local state
      // (Hold→Buy episode). Never flatten a ticker that still has an open MODEL entry.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (!row) continue;
        if (!row.errorTrade && row.flatReason !== 'unauthorized-non-recommendation'
          && row.flatReason !== 'dual-list-duplicate-accounting') continue;
        const yProt = normalizeYahooTicker(row.ticker || '');
        if (yProt && setHasYahooAlias(openYahoo, yProt)) {
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
        let qty = Math.abs(held.pos);
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

      // 0e3. Optional env kill-switch (IBKR_ERROR_TICKERS). Default empty.
      if (ERROR_TRADE_TICKERS.size) {
        for (const [pk, { pos, contract }] of posMap) {
          if (!pos) continue;
          const y = yahooFromContract(contract);
          const yU = String(y || '').toUpperCase();
          if (y && setHasYahooAlias(openYahoo, y)) {
            log('RECONCILE: skip ENV error-flatten — open MODEL entry', y);
            continue;
          }
          const symU = String(contract.symbol || '').toUpperCase();
          const isErr = ERROR_TRADE_TICKERS.has(yU) || ERROR_TRADE_TICKERS.has(symU)
            || [...ERROR_TRADE_TICKERS].some(t => t.replace(/\.(DE|PA|L|HK|T)$/i, '') === symU);
          if (!isErr) continue;
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
      try {
        const hist = await fetchJson('/api/history');
        for (const h of (Array.isArray(hist) ? hist : [])) {
          if (!h || !h.ticker) continue;
          const y = normalizeYahooTicker(h.ticker);
          if (setHasYahooAlias(unauthorizedYahoo, y)) continue;
          const hz = h.hz || 'short';
          const st = String(h[hz + 'Status'] || h.status || '').toLowerCase();
          if (st && st !== 'open' && st !== 'tp1_open') continue;
          const act = String(h[hz + 'Action'] || h.action || '').toLowerCase();
          if (act !== 'buy' && act !== 'sell') continue;
          protectedYahoo.add(y);
        }
      } catch (_) { /* event/state protection still applies */ }

      for (const [pk, { pos, contract }] of posMap) {
        if (!pos) {
          if (state.unauthStreak[pk]) { delete state.unauthStreak[pk]; saveState(state); }
          continue;
        }
        const cMeta = enrichSessionMeta(contract);
        const y = normalizeYahooTicker(yahooFromContract(cMeta) || '');
        if (!y) continue;
        if (setHasYahooAlias(protectedYahoo, y) || setHasYahooAlias(openYahoo, y)
          || setHasYahooAlias(recentEntryYahoo, y)) {
          if (state.unauthStreak[pk]) { delete state.unauthStreak[pk]; saveState(state); }
          continue;
        }
        // Model-only book: IB position with no open model entry / history /
        // recent emit is an orphan (shows as "IB-only" on the site recon).
        // Flatten error-tagged names AND unprotected orphans — never 9988-style
        // protected model lots.
        const isErrorTagged = setHasYahooAlias(unauthorizedYahoo, y);
        const isOrphanIbOnly = !isErrorTagged;
        const phase = sessionPhase(cMeta);
        if (phase !== 'rth') {
          log('RECONCILE: unauthorized/orphan wait session', pk, 'ticker=' + y, 'phase=' + phase,
            isOrphanIbOnly ? 'orphan' : 'error');
          continue;
        }
        // Debounce: require TWO consecutive sweeps agreeing + audit before flatten.
        const streak = (Number(state.unauthStreak[pk]) || 0) + 1;
        state.unauthStreak[pk] = streak;
        saveState(state);
        if (streak < 2) {
          log('RECONCILE: unauthorized/orphan candidate (debounce 1/2)', pk, 'pos=' + pos,
            'ticker=' + y, isOrphanIbOnly ? 'IB-only orphan' : 'error-tagged');
          continue;
        }
        const lastTry = _flattenTried.get(pk) || 0;
        if (Date.now() - lastTry < 15 * 60 * 1000) continue;
        _flattenTried.set(pk, Date.now());
        const qty = Math.abs(pos);
        const fid = nid();
        const oc = orderContractFromPos(cMeta);
        log('RECONCILE: flattening', isOrphanIbOnly ? 'IB-ONLY ORPHAN' : 'UNAUTHORIZED',
          pk, 'pos=' + pos, 'ticker=' + y, 'streak=' + streak);
        if (!oc || (!oc.conId && !oc.symbol)) continue;
        transmitOrder(fid, oc, baseOrder({
          orderId: fid, action: pos > 0 ? 'SELL' : 'BUY',
          orderType: 'MKT', totalQuantity: qty, tif: 'DAY', transmit: true
        }), (isOrphanIbOnly ? 'orphan-ib-only-flatten ' : 'unauthorized-flatten ') + pk);
      }

      // No excess-qty trim — never reduce a live model lot (9988/0005/2914).

      // 1c. IB↔AS ledger sync (also runs on its own 60s timer — see postIbRecon).
      let serverTrades = null;
      await postIbRecon();

      // 2. Rows flat at IB but never closed in state (exit filled while down).
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.contract) continue;
        const held = posMap.get(posKeyOf(row.contract));
        const flatAtIb = held ? held.pos === 0 : !posMap.has(posKeyOf(row.contract));
        if (!flatAtIb) continue;
        // Model still open + IB flat → leave for the re-arm loop above (Asia
        // chase / EU-RTH / US pre gate). Do not mark closed while the signal lives.
        if (keyState.get(key) === 'open') continue;
        row.closed = true;
        row.updated = new Date().toISOString();
        log('RECONCILE: marking', key, 'closed (flat at IB, model exited)');
        try {
          if (!serverTrades) serverTrades = await fetchJson('/api/ibkr/trades');
          const t = (serverTrades.trades || []).find(x => x.key === key);
          if (t && t.openQty > 0) {
            state.pendingReports = state.pendingReports || [];
            const fillAt = new Date().toISOString();
            const cMeta = enrichSessionMeta(row.contract || toContract(row.ticker));
            const phase = sessionPhase(cMeta || {}, Date.parse(fillAt));
            state.pendingReports.push({
              kind: 'exec', execId: `synth-${key}-${row.stopId}`, key,
              ticker: row.ticker, hz: row.hz, side: row.side, role: 'stop',
              orderId: row.stopId, qty: t.openQty, price: row.stopPx,
              currency: row.contract.currency || 'USD',
              ccyScale: row.contract.penceQuoted ? 100 : 1,
              session: phase,
              sessionLabel: sessionLabel(phase),
              synthetic: true, time: fillAt
            });
            log('RECONCILE: synthetic stop exec reported for', key, t.openQty + '@' + row.stopPx, '(fill was missed while bridge was down)');
          }
        } catch (e) { log('reconcile trades fetch failed:', e.message); }
        saveState(state);
      }
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
    }
    // HK afternoon reopen: chase rows that are not on a live RTH MKT yet
    if (!forceReconcile && positionsReady) {
      for (const row of Object.values(state.byKey)) {
        if (row.closed || row.entryFilled || !row.contract || row.contract.market !== 'HK') continue;
        if (sessionPhase(row.contract) === 'rth' && row.entryStyle !== 'MKT') {
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
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
