#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge (v2)
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events (JSONL feed)
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and mirrors the AlphaSignal exit spec exactly:
 *
 *     entry        → parent MARKET entry — never a limit chase of the model price:
 *                      • US: MKT with outsideRth (premarket / RTH / post)
 *                        or MOO if the US cash session is fully closed
 *                      • JP / HK / EU / UK: MOO before the open; MKT if already
 *                        in regular hours (late board). Recommended price is
 *                        used only for share sizing.
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
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '17', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || '';
const POLL_MS = Math.max(5000, parseInt(process.env.IBKR_POLL_MS || '15000', 10));
const NOTIONAL = Math.max(1000, parseInt(process.env.IBKR_NOTIONAL || '10000', 10));
const MAX_EVENT_AGE_MS = Math.max(1, parseFloat(process.env.IBKR_MAX_EVENT_AGE_H || '24')) * 3600 * 1000;
const ALLOW_NSE = process.env.IBKR_ALLOW_NSE === '1';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'bridge-state.json');
const SWEEP_MS = 5 * 60 * 1000;

function log(...a) { console.log(new Date().toISOString(), ...a); }

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
 * used only to choose MOO vs MKT (never to place a limit chase).
 * Returns 'pre' | 'rth' | 'closed'.
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
    US:       { open: 13 * 60 + 30, close: 20 * 60, preOpen: 8 * 60 },   // 4am–4pm ET (UTC-4 DST)
    JP:       { open: 0 * 60,       close: 6 * 60 },                     // 09:00–15:00 JST
    HK:       { open: 1 * 60 + 30,  close: 8 * 60 },                     // 09:30–16:00 HKT
    XETRA:    { open: 7 * 60,       close: 15 * 60 + 30 },               // 09:00–17:30 CEST
    EURONEXT: { open: 7 * 60,       close: 15 * 60 + 30 },
    LSE:      { open: 7 * 60,       close: 15 * 60 + 30 }                // 08:00–16:30 BST
  };
  const w = windows[m] || windows.XETRA;
  if (m === 'US') {
    if (utcMin >= w.open && utcMin < w.close) return 'rth';
    if (utcMin >= (w.preOpen || 0) && utcMin < w.open) return 'pre';
    // US post-market (until 20:00 ET = 00:00 UTC DST) still outsideRth-tradable
    if (utcMin >= w.close && utcMin < 24 * 60) return 'pre'; // treat as extended
    return 'closed';
  }
  if (utcMin >= w.open && utcMin < w.close) return 'rth';
  // Before open same calendar day → pre (MOO queues for today's auction)
  if (utcMin < w.open) return 'pre';
  return 'closed'; // after close → MOO for tomorrow's open
}

/**
 * Parent entry order: market-on-open / outside-RTH market ONLY.
 * Recommended model price is NEVER used as a limit — only for sizing.
 */
function parentEntrySpec(contract, action, qty) {
  const phase = sessionPhase(contract);
  // IB SMART often rejects orderType 'MOO' (error 321). The portable form is
  // MKT + tif OPG (submit to the opening auction).
  if (contract.usRth) {
    if (phase === 'closed') {
      return { orderType: 'MKT', action, totalQuantity: qty, tif: 'OPG', outsideRth: false, transmit: false, entryStyle: 'OPG' };
    }
    // Premarket / RTH / post: marketable with outsideRth so IB accepts extended hours
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: true, transmit: false, entryStyle: 'MKT-EXT' };
  }
  if (phase === 'rth') {
    // Late board after the cash open — take market now, don't wait for tomorrow
    return { orderType: 'MKT', action, totalQuantity: qty, tif: 'DAY', outsideRth: false, transmit: false, entryStyle: 'MKT' };
  }
  // Pre-open or after previous close → opening auction
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
async function shareSplit(entry, contract) {
  const e = Number(entry);
  if (!(e > 0)) return { total: 0, sold: 0, runner: 0 };
  let localNotional = NOTIONAL * await usdToCurrency(contract.currency);
  if (contract.penceQuoted) localNotional *= 100; // LSE quotes in pence
  const lot = contract.lotHint || 1;
  let total = Math.floor(localNotional / e);
  total = Math.floor(total / lot) * lot;
  if (total < lot) return { total: 0, sold: 0, runner: 0 };
  let sold = Math.floor(total / 2 / lot) * lot;
  if (sold < lot) sold = 0; // too small to split — runner carries everything
  return { total, sold, runner: total - sold };
}

function roundPx(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return n;
  return n >= 1000 ? +n.toFixed(0) : n >= 100 ? +n.toFixed(1) : +n.toFixed(2);
}

/**
 * Build a placeable IB contract from a position snapshot.
 * Position events often omit primaryExch; SMART + bare "6690" then returns
 * error 200 (no security definition). Pin the listing exchange from currency.
 */
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
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | dryRun=${DRY} | notional=$${NOTIONAL}`);

  let ib = null;
  let EventName = null;
  let nextOrderId = 1;
  const orderFills = {}; // orderId -> filled qty (from orderStatus) — LOST on restart
  // Live positions from IB (survives restarts, unlike orderFills). Keyed
  // "SYMBOL|CCY" -> { pos, contract }. Populated by the reqPositions subscription.
  const posMap = new Map();
  let positionsReady = false; // set once IB's initial position snapshot lands
  const posKeyOf = c => `${String(c.symbol).toUpperCase()}|${c.currency}`;
  const _flattenTried = new Map(); // pk -> last reconcile-flatten attempt ts

  function nid() { return nextOrderId++; }

  if (!DRY) {
    const stoqey = require('@stoqey/ib');
    EventName = stoqey.EventName;
    ib = new stoqey.IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
    ib.on(EventName.error, (err, code, reqId) => {
      // 2104/2106/2158 are benign "market data farm OK" notices
      if ([2104, 2106, 2107, 2158].includes(Number(code))) return;
      log('IB error', code, 'reqId=' + reqId, err && err.message ? err.message : err);
    });
    ib.on(EventName.orderStatus, (orderId, status, filled) => {
      orderFills[orderId] = Number(filled) || 0;
      onOrderStatus(orderId, status, Number(filled) || 0);
    });
    // Real executions → queue a report for the AlphaSignal site (IBKR tab).
    ib.on(EventName.execDetails, (reqId, contract, exec) => {
      try {
        const orderId = Number(exec.orderId);
        for (const [key, row] of Object.entries(state.byKey)) {
          let role = null;
          if (row.parentId === orderId) role = 'entry';
          else if (row.tp1Id === orderId) role = 'tp1';
          else if (row.stopId === orderId) role = 'stop';
          else if ((row.closeIds || []).includes(orderId)) role = 'flatten';
          if (!role) continue;
          if (role === 'entry') row.entryFilled = true; // persisted below with the report
          state.pendingReports = state.pendingReports || [];
          state.pendingReports.push({
            kind: 'exec', execId: exec.execId, key,
            ticker: row.ticker, hz: row.hz, side: row.side, role,
            orderId, qty: Number(exec.shares), price: Number(exec.price),
            currency: row.contract && row.contract.currency || 'USD',
            ccyScale: row.contract && row.contract.penceQuoted ? 100 : 1,
            time: new Date().toISOString()
          });
          saveState(state);
          log('exec captured', role, key, exec.shares + '@' + exec.price);
          break;
        }
      } catch (e) { log('execDetails error', e.message); }
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('IB connect timeout — is TWS/Gateway paper running with API enabled?')), 20000);
      ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
      ib.connect();
    });
    await new Promise(resolve => {
      ib.once(EventName.nextValidId, id => { nextOrderId = id; resolve(); });
      ib.reqIds();
    });
    // TWS's nextValidId can lag behind ids burned by other API clients in the
    // same TWS session (e.g. flatten-all), causing "Duplicate order id" (103).
    // Floor the counter to seconds-since-2025 so every run starts above any
    // previous session's range.
    const timeFloor = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000);
    nextOrderId = Math.max(nextOrderId, timeFloor);
    log('Connected to IB paper. starting orderId=', nextOrderId);
    // Subscribe to positions — the source of truth for how many shares are
    // actually held (orderFills is in-memory only and dies with each restart).
    ib.on(EventName.position, (account, contract, pos) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      posMap.set(posKeyOf(contract), { pos: Number(pos) || 0, contract });
    });
    ib.on(EventName.positionEnd, () => { positionsReady = true; log('IB position snapshot ready —', posMap.size, 'symbol(s)'); });
    ib.reqPositions();
  } else {
    log('DRY RUN — orders are logged only. Set IBKR_DRY_RUN=0 to place paper orders.');
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

  // ── Entry: full bracket ────────────────────────────────────────────────────
  async function placeBracket(evt) {
    const contract = toContract(evt.ticker);
    if (!contract) {
      log('skip entry (unsupported instrument for IB paper):', evt.ticker);
      return null;
    }
    const isSell = evt.side === 'sell';
    const split = await shareSplit(evt.entry, contract);
    if (split.total < 1) { log('skip entry — zero shares for', evt.ticker, 'entry', evt.entry); return null; }
    const stopPx = roundPx(evt.trailSl != null ? evt.trailSl : evt.sl);
    const tp1Px = roundPx(evt.tp1);
    if (!(stopPx > 0)) { log('skip entry — no stop level for', evt.ticker); return null; }

    const openAction = isSell ? 'SELL' : 'BUY';
    const closeAction = isSell ? 'BUY' : 'SELL';
    const rthOk = !!contract.usRth; // outsideRth only meaningful for US SMART
    const parentId = nid(), stopId = nid(), tp1Id = tp1Px > 0 && split.sold > 0 ? nid() : null;

    // Parent: MARKET at open / outside RTH — never a limit at the model price.
    // evt.entry is used only above for share sizing.
    const parentSpec = parentEntrySpec(contract, openAction, split.total);
    const { entryStyle, ...parentFields } = parentSpec;
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
      log('DRY bracket', evt.ticker, evt.side, JSON.stringify({ contract, parent, stopOrder, tp1Order, split, entryStyle, phase: sessionPhase(contract) }, null, 1));
    } else {
      ib.placeOrder(parentId, contract, parent);
      ib.placeOrder(stopId, contract, stopOrder);
      if (tp1Order) ib.placeOrder(tp1Id, contract, tp1Order);
      log('Placed bracket', evt.ticker, evt.side,
        `style=${entryStyle} phase=${sessionPhase(contract)} qty=${split.total} sizePx=${roundPx(evt.entry)} stop=${stopPx}(full) tp1=${tp1Px}x${split.sold} runner=${split.runner}`);
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
      ? Math.min(row.stopPx, roundPx(row.entry))
      : Math.max(row.stopPx, roundPx(row.entry));
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

  function onOrderStatus(orderId, status, filled) {
    for (const [key, row] of Object.entries(state.byKey)) {
      if (row.closed) continue;
      // Persist the parent-fill fact — entry_finalized's safety guard reads it
      // after restarts, when the in-memory orderFills counters are gone.
      if (row.parentId === orderId && filled > 0 && !row.entryFilled) {
        row.entryFilled = true;
        saveState(state);
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
      const newStop = roundPx(evt.trailSl);
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

  // ── Position reconciliation ─────────────────────────────────────────────────
  // The account is the source of truth for SHARES; AlphaSignal's event log is
  // the source of truth for which trades should be open. Every sweep:
  //   1. Any IB position in a ticker AlphaSignal has traded but no longer holds
  //      open (entry followed by exit, or never tracked after a state reset)
  //      is flattened at market. This catches positions orphaned by bridge
  //      restarts, lost state files, and the old flatten-zero bug.
  //   2. Any state row that is flat at IB with no working orders is marked
  //      closed; if the server still counts an open quantity for it (its exit
  //      filled while the bridge was down — e.g. a GTC stop), a synthetic
  //      stop-price execution is reported so the IBKR tab closes the trade.
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
      const everTraded = new Set();   // "SYM|CCY" AlphaSignal ever traded
      const openTickers = new Set();  // "SYM|CCY" with at least one open key
      for (const [key, st] of keyState) {
        const c = toContract(key.split('|')[0]);
        if (!c) continue;
        everTraded.add(posKeyOf(c));
        if (st === 'open') openTickers.add(posKeyOf(c));
      }

      // 0a. Cancel working orders for STALE keys still in state (e.g. AAPL Jun-09
      // brackets queued for the next US open after a bad re-emit). Never let them fill.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || row.staleCancelled) continue;
        const dayPart = key.split('|')[2];
        const keyTs = Date.parse(dayPart || row.updated || 0);
        if (!Number.isFinite(keyTs) || (Date.now() - keyTs) <= MAX_EVENT_AGE_MS) continue;
        log('RECONCILE: cancelling STALE trade orders', key, '(key age h:', ((Date.now() - keyTs) / 3600000).toFixed(1) + ')');
        cancelOrder(row.parentId, 'stale parent ' + key);
        cancelOrder(row.stopId, 'stale stop ' + key);
        if (row.tp1Id != null) cancelOrder(row.tp1Id, 'stale tp1 ' + key);
        row.closed = true;
        row.staleCancelled = true;
        row.updated = new Date().toISOString();
        saveState(state);
      }

      // 0. Upgrade legacy unfilled LMT parents to MOO/MKT — ONLY for same-session
      // recommendations. A missed entry from a prior day stays missed (user policy).
      // Window: placed < 12h ago, model still open, flat at IB, no fill recorded.
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || row.entryFilled || row.entryStyle || row.upgradedToMkt) continue;
        if (keyState.get(key) !== 'open') continue;
        const ageH = (Date.now() - Date.parse(row.updated || 0)) / 3600000;
        if (!(ageH >= 0) || ageH > 12) {
          row.upgradedToMkt = true; // mark so we never chase a stale miss
          log('RECONCILE: skip legacy upgrade (stale/missed entry)', key, 'ageH=', ageH.toFixed(1));
          saveState(state);
          continue;
        }
        const held = row.contract ? posMap.get(posKeyOf(row.contract)) : null;
        const posInDir = held ? (row.side === 'sell' ? -held.pos : held.pos) : 0;
        if (posInDir > 0) continue; // already filled — leave alone
        row.upgradedToMkt = true; // one-shot even if re-place fails
        cancelOrder(row.parentId, 'legacy-LMT parent ' + key);
        cancelOrder(row.stopId, 'legacy-LMT stop ' + key);
        if (row.tp1Id != null) cancelOrder(row.tp1Id, 'legacy-LMT tp1 ' + key);
        try {
          const placed = await placeBracket({
            key, ticker: row.ticker, hz: row.hz, side: row.side,
            entry: row.entry, tp1: row.tp1Px, sl: row.stopPx, trailSl: row.stopPx,
            t: new Date().toISOString()
          });
          if (placed) {
            placed.upgradedToMkt = true;
            state.byKey[key] = placed;
            log('RECONCILE: upgraded same-session LMT →', placed.entryStyle, key);
          } else {
            log('RECONCILE: legacy LMT cancelled but re-place skipped', key);
          }
          saveState(state);
        } catch (e) { log('RECONCILE: legacy upgrade failed', key, e.message); }
      }

      // 1. Orphan POSITIONS — held at IB, closed (or unknown) per AlphaSignal.
      // Retry window (not a one-shot): a MKT DAY order placed while that
      // exchange is closed expires unfilled, so re-attempt after 30 min if the
      // position subscription still shows shares held.
      for (const [pk, { pos, contract }] of posMap) {
        if (!pos || !everTraded.has(pk) || openTickers.has(pk)) continue;
        const lastTry = _flattenTried.get(pk) || 0;
        if (Date.now() - lastTry < 30 * 60 * 1000) continue;
        _flattenTried.set(pk, Date.now());
        const qty = Math.abs(pos);
        const fid = nid();
        const oc = orderContractFromPos(contract);
        log('RECONCILE: flattening orphan position', pk, 'pos=' + pos,
          'contract=' + JSON.stringify(oc), '(AlphaSignal has no open trade for it)');
        if (!oc || (!oc.conId && !oc.symbol)) {
          log('RECONCILE: skip flatten — incomplete contract for', pk);
          continue;
        }
        transmitOrder(fid, oc, baseOrder({
          orderId: fid, action: pos > 0 ? 'SELL' : 'BUY',
          orderType: 'MKT', totalQuantity: qty, tif: 'DAY', transmit: true
        }), 'reconcile-flatten ' + pk);
      }

      // 2. Rows flat at IB but never closed in state (exit filled while down).
      let serverTrades = null;
      for (const [key, row] of Object.entries(state.byKey)) {
        if (row.closed || !row.contract) continue;
        const held = posMap.get(posKeyOf(row.contract));
        const flatAtIb = held ? held.pos === 0 : !posMap.has(posKeyOf(row.contract));
        if (!flatAtIb) continue;
        // Model open + IB flat = the DAY entry LMT expired unfilled. By design
        // the trade is MISSED, permanently: entry timing is part of the signal,
        // so we never re-place an expired entry just because the price comes
        // back to the level. A new position requires a fresh entry event from
        // the model under current market conditions.
        if (keyState.get(key) === 'open') continue;
        row.closed = true;
        row.updated = new Date().toISOString();
        log('RECONCILE: marking', key, 'closed (flat at IB, model exited)');
        try {
          if (!serverTrades) serverTrades = await fetchJson('/api/ibkr/trades');
          const t = (serverTrades.trades || []).find(x => x.key === key);
          if (t && t.openQty > 0) {
            state.pendingReports = state.pendingReports || [];
            state.pendingReports.push({
              kind: 'exec', execId: `synth-${key}-${row.stopId}`, key,
              ticker: row.ticker, hz: row.hz, side: row.side, role: 'stop',
              orderId: row.stopId, qty: t.openQty, price: row.stopPx,
              currency: row.contract.currency || 'USD',
              ccyScale: row.contract.penceQuoted ? 100 : 1,
              synthetic: true, time: new Date().toISOString()
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
  for (;;) {
    try { await pollOnce(); }
    catch (e) { log('poll error', e.message); }
    if (Date.now() - lastSweep > SWEEP_MS) {
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
