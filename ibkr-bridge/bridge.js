#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge (v2)
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events (JSONL feed)
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and mirrors the AlphaSignal exit spec exactly:
 *
 *     entry        → parent LMT @ recommended entry (outsideRth for US, so the
 *                    order works pre-market / regular / post-market)
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
  if (t.endsWith('.L'))  return { symbol: t.replace(/\.L$/, ''),  secType: 'STK', exchange: 'LSE',  currency: 'GBP', penceQuoted: true };
  if (t.endsWith('.DE')) return { symbol: t.replace(/\.DE$/, ''), secType: 'STK', exchange: 'IBIS', currency: 'EUR' };
  if (t.endsWith('.PA')) return { symbol: t.replace(/\.PA$/, ''), secType: 'STK', exchange: 'SBF',  currency: 'EUR' };
  if (t.endsWith('.AS')) return { symbol: t.replace(/\.AS$/, ''), secType: 'STK', exchange: 'AEB',  currency: 'EUR' };
  if (t.endsWith('.MI')) return { symbol: t.replace(/\.MI$/, ''), secType: 'STK', exchange: 'BVME', currency: 'EUR' };
  if (t.endsWith('.HK')) return { symbol: String(parseInt(t.replace(/\.HK$/, ''), 10)), secType: 'STK', exchange: 'SEHK', currency: 'HKD', lotHint: 100 };
  if (t.endsWith('.T'))  return { symbol: t.replace(/\.T$/, ''),  secType: 'STK', exchange: 'TSEJ', currency: 'JPY', lotHint: 100 };
  if (t.includes('.'))   return null;                                 // unknown suffix
  const symbol = t === 'BRK.B' ? 'BRK B' : t;
  return { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExch: 'NASDAQ', usRth: true };
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | dryRun=${DRY} | notional=$${NOTIONAL}`);

  let ib = null;
  let EventName = null;
  let nextOrderId = 1;
  const orderFills = {}; // orderId -> filled qty (from orderStatus)

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
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('IB connect timeout — is TWS/Gateway paper running with API enabled?')), 20000);
      ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
      ib.connect();
    });
    await new Promise(resolve => {
      ib.once(EventName.nextValidId, id => { nextOrderId = id; resolve(); });
      ib.reqIds();
    });
    log('Connected to IB paper. nextValidId=', nextOrderId);
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
    const rthOk = !!contract.usRth; // outsideRth only supported/meaningful for US SMART
    const parentId = nid(), stopId = nid(), tp1Id = tp1Px > 0 && split.sold > 0 ? nid() : null;

    // Parent: LMT at the RECOMMENDED entry. With outsideRth (US) the order is
    // live pre-market / regular / post-market; DAY so an unfilled entry dies at
    // the session end and IB cancels the attached children with it (no orphans).
    const parent = baseOrder({
      orderId: parentId, action: openAction, orderType: 'LMT',
      lmtPrice: roundPx(evt.entry), totalQuantity: split.total,
      tif: 'DAY', outsideRth: rthOk, transmit: false
    });
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
      log('DRY bracket', evt.ticker, evt.side, JSON.stringify({ contract, parent, stopOrder, tp1Order, split }, null, 1));
    } else {
      ib.placeOrder(parentId, contract, parent);
      ib.placeOrder(stopId, contract, stopOrder);
      if (tp1Order) ib.placeOrder(tp1Id, contract, tp1Order);
      log('Placed bracket', evt.ticker, evt.side,
        `qty=${split.total} entryLmt=${parent.lmtPrice} stop=${stopPx}(full) tp1=${tp1Px}x${split.sold} runner=${split.runner}`);
    }
    return {
      parentId, stopId, tp1Id,
      ticker: evt.ticker, hz: evt.hz, side: evt.side,
      entry: evt.entry, stopPx, tp1Px,
      qtyTotal: split.total, qtySold: split.sold, qtyRunner: split.runner,
      contract, tp1Done: false, closed: false, updated: evt.t, dry: DRY
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
    // Flatten whatever is still held: parent filled − TP1 sold (if TP1 ran).
    const parentFilled = DRY ? row.qtyTotal : (orderFills[row.parentId] || 0);
    const soldAtTp1 = row.tp1Done ? row.qtySold : (row.tp1Id != null ? (orderFills[row.tp1Id] || 0) : 0);
    const remaining = Math.max(0, parentFilled - soldAtTp1);
    if (remaining > 0) {
      transmitOrder(nid(), row.contract, baseOrder({
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
      const age = Date.now() - Date.parse(evt.t || evt.entryDate || 0);
      if (Number.isFinite(age) && age > MAX_EVENT_AGE_MS) { log('skip stale entry', key, '(age h:', (age / 3600000).toFixed(1) + ')'); return; }
      const placed = await placeBracket(evt);
      if (placed) state.byKey[key] = placed;
      return;
    }
    const row = state.byKey[key];
    if (evt.type === 'entry_finalized') {
      // Server finalized the entry price (next-open) — retune an unfilled parent LMT.
      if (row && !row.closed && evt.entry > 0 && (orderFills[row.parentId] || 0) === 0 && !DRY && ib) {
        row.entry = evt.entry;
        transmitOrder(row.parentId, row.contract, baseOrder({
          orderId: row.parentId, action: row.side === 'sell' ? 'SELL' : 'BUY',
          orderType: 'LMT', lmtPrice: roundPx(evt.entry), totalQuantity: row.qtyTotal,
          tif: 'DAY', outsideRth: !!row.contract.usRth, transmit: true
        }), 'entry re-price ' + key);
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

  async function pollOnce() {
    const data = await fetchJson(`/api/ibkr/events?since=${state.since}&limit=100`);
    const events = data.events || [];
    for (const evt of events) {
      try { await handleEvent(evt); } catch (e) { log('event error', evt.type, evt.ticker, e.message); }
      if (evt.seq > state.since) state.since = evt.seq;
    }
    if (events.length) { saveState(state); log(`Processed ${events.length} event(s); since=${state.since}`); }
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
    if (Date.now() - lastSweep > SWEEP_MS) { lastSweep = Date.now(); sweepOrphans(); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
