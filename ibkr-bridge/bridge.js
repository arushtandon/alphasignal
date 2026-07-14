#!/usr/bin/env node
/**
 * AlphaSignal → IBKR paper bridge
 *
 * Architecture:
 *   AlphaSignal (Render / local) emits trade lifecycle events
 *   This process runs NEXT TO IB Gateway or TWS (cannot run on Render)
 *   Polls GET /api/ibkr/events and places:
 *     entry  → parent MKT/LMT + TP1 LMT (partial) + STP/TRAIL (runner)
 *     tp1_partial → (informational; bracket already has TP1 child)
 *     tsl_update  → modify trailing stop auxPrice / trail amount
 *     exit        → cancel open children / flatten runner if needed
 *
 * Env:
 *   ALPHASIGNAL_URL      e.g. https://your-app.onrender.com
 *   IBKR_EVENTS_TOKEN    same as AlphaSignal IBKR_EVENTS_TOKEN (optional)
 *   IBKR_HOST            default 127.0.0.1
 *   IBKR_PORT            7497 (TWS paper) or 4002 (Gateway paper)
 *   IBKR_CLIENT_ID       default 17
 *   IBKR_ACCOUNT         paper account id (optional; IB uses default if unset)
 *   IBKR_DRY_RUN         1 = log only, no placeOrder (default 1)
 *   IBKR_POLL_MS         default 15000
 *   IBKR_NOTIONAL        default 10000 (matches AlphaSignal $10k sizing)
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
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'bridge-state.json');

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
  });
}

/** Map Yahoo-style ticker to IB SMART stock contract (US-first; extend as needed). */
function toContract(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (t.includes('.')) {
    // International — require SMART + local currency; start conservative
    if (t.endsWith('.L')) return { symbol: t.replace(/\.L$/, ''), secType: 'STK', exchange: 'LSE', currency: 'GBP' };
    if (t.endsWith('.DE')) return { symbol: t.replace(/\.DE$/, ''), secType: 'STK', exchange: 'IBIS', currency: 'EUR' };
    if (t.endsWith('.PA')) return { symbol: t.replace(/\.PA$/, ''), secType: 'STK', exchange: 'SBF', currency: 'EUR' };
    if (t.endsWith('.HK')) return { symbol: t.replace(/\.HK$/, ''), secType: 'STK', exchange: 'SEHK', currency: 'HKD' };
    if (t.endsWith('.NS')) return { symbol: t.replace(/\.NS$/, ''), secType: 'STK', exchange: 'NSE', currency: 'INR' };
    if (t.endsWith('.T')) return { symbol: t.replace(/\.T$/, ''), secType: 'STK', exchange: 'TSEJ', currency: 'JPY' };
  }
  const symbol = t === 'BRK.B' ? 'BRK B' : t;
  return { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExch: 'NASDAQ' };
}

function shareSplit(entry) {
  const e = Number(entry);
  if (!(e > 0)) return { total: 0, sold: 0, runner: 0 };
  const total = Math.floor(NOTIONAL / e);
  const sold = Math.floor(total / 2);
  return { total, sold, runner: total - sold };
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function main() {
  const state = loadState();
  log(`Bridge start | AlphaSignal=${BASE} | IB=${HOST}:${PORT} clientId=${CLIENT_ID} | dryRun=${DRY}`);

  let ib = null;
  let nextOrderId = 1;

  if (!DRY) {
    const { IBApi, EventName } = require('@stoqey/ib');
    ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
    ib.on(EventName.error, (err, code, reqId) => {
      log('IB error', code, reqId, err && err.message ? err.message : err);
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('IB connect timeout — is TWS/Gateway paper running with API enabled?')), 20000);
      ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
      ib.once(EventName.error, (err) => { /* keep waiting for connected unless fatal */ });
      ib.connect();
    });
    await new Promise(resolve => {
      ib.once(EventName.nextValidId, id => { nextOrderId = id; resolve(); });
      ib.reqIds();
    });
    log('Connected to IB. nextValidId=', nextOrderId);
  } else {
    log('DRY RUN — orders will be logged only. Set IBKR_DRY_RUN=0 to place paper orders.');
  }

  function placeBracket(evt) {
    const { ticker, side, entry, tp1, sl, trailSl, key } = evt;
    const split = {
      total: evt.sharesTotal || shareSplit(entry).total,
      sold: evt.sharesSoldTp1 || shareSplit(entry).sold,
      runner: evt.sharesRunner || shareSplit(entry).runner
    };
    if (split.total < 1) {
      log('skip entry — zero shares for', ticker, 'entry', entry);
      return null;
    }
    const contract = toContract(ticker);
    const parentAction = side === 'sell' ? 'SELL' : 'BUY';
    const closeAction = side === 'sell' ? 'BUY' : 'SELL';
    const parentId = nextOrderId++;
    const tp1Id = nextOrderId++;
    const trailId = nextOrderId++;

    const parent = {
      orderId: parentId,
      action: parentAction,
      orderType: 'MKT',
      totalQuantity: split.total,
      transmit: false,
      tif: 'DAY',
      ...(ACCOUNT ? { account: ACCOUNT } : {})
    };
    const tp1Order = {
      orderId: tp1Id,
      action: closeAction,
      orderType: 'LMT',
      lmtPrice: Number(tp1),
      totalQuantity: split.sold,
      parentId,
      transmit: false,
      tif: 'GTC',
      ...(ACCOUNT ? { account: ACCOUNT } : {})
    };
    // Runner: IB server-side trailing stop (maps to AlphaSignal ratchet after TP1).
    // Until TP1, trail amount approximates distance to initial SL.
    const trailAmt = (() => {
      const e = Number(entry), s = Number(trailSl || sl);
      if (!(e > 0) || !(s > 0)) return Math.max(0.01, +(e * 0.03).toFixed(2));
      return Math.max(0.01, +Math.abs(e - s).toFixed(2));
    })();
    const trailOrder = {
      orderId: trailId,
      action: closeAction,
      orderType: 'TRAIL',
      auxPrice: trailAmt, // trailing amount
      totalQuantity: split.runner,
      parentId,
      transmit: true, // last child transmits the whole bracket
      tif: 'GTC',
      ...(ACCOUNT ? { account: ACCOUNT } : {})
    };

    const plan = { key, ticker, side, contract, parent, tp1Order, trailOrder, split };
    if (DRY || !ib) {
      log('DRY bracket', JSON.stringify(plan, null, 2));
      return { parentId, tp1Id, trailId, dry: true };
    }
    ib.placeOrder(parentId, contract, parent);
    ib.placeOrder(tp1Id, contract, tp1Order);
    ib.placeOrder(trailId, contract, trailOrder);
    log('Placed bracket', ticker, side, `qty=${split.total} tp1=${split.sold}@${tp1} trail=${split.runner} amt=${trailAmt}`);
    return { parentId, tp1Id, trailId, dry: false };
  }

  function handleEvent(evt) {
    const key = evt.key || `${evt.ticker}|${evt.hz}|${evt.entryDate}`;
    if (evt.type === 'entry') {
      if (state.byKey[key] && state.byKey[key].parentId) {
        log('skip duplicate entry', key);
        return;
      }
      const placed = placeBracket(evt);
      if (placed) state.byKey[key] = { ...placed, ticker: evt.ticker, hz: evt.hz, side: evt.side, updated: evt.t };
      return;
    }
    if (evt.type === 'tsl_update') {
      const row = state.byKey[key];
      if (!row || !row.trailId || DRY || !ib) {
        log('tsl_update', key, 'trailSl=', evt.trailSl, row ? '(no live modify in dry/missing)' : '(unknown key)');
        return;
      }
      // Best-effort: cancel+replace trail is safer than mutate; keep simple for v1 —
      // log for operator; full modifyOrder can be added once paper fills are validated.
      log('tsl_update noted — verify TWS trail for', key, 'newTrailSl=', evt.trailSl);
      row.trailSl = evt.trailSl;
      row.updated = evt.t;
      return;
    }
    if (evt.type === 'tp1_partial') {
      log('tp1_partial', key, 'sold=', evt.sharesSoldTp1, 'runner=', evt.sharesRunner);
      return;
    }
    if (evt.type === 'exit') {
      log('exit', key, 'status=', evt.status, 'pnl=', evt.pnlDollar, 'exit=', evt.exitPrice);
      // Paper: if runner still open in IB, operator can flatten; auto-flatten in v1.1
      if (state.byKey[key]) state.byKey[key].closed = true;
      return;
    }
    log('event', evt.type, key);
  }

  async function pollOnce() {
    const data = await fetchJson(`/api/ibkr/events?since=${state.since}&limit=100`);
    const events = data.events || [];
    for (const evt of events) {
      handleEvent(evt);
      if (evt.seq > state.since) state.since = evt.seq;
    }
    saveState(state);
    if (events.length) log(`Processed ${events.length} event(s); since=${state.since}`);
  }

  // Health check first
  try {
    const st = await fetchJson('/api/ibkr/status');
    log('AlphaSignal IBKR feed OK', JSON.stringify(st));
  } catch (e) {
    log('WARN: cannot reach AlphaSignal feed:', e.message);
    log('Bridge will keep retrying. Set ALPHASIGNAL_URL to your deployed app.');
  }

  for (;;) {
    try { await pollOnce(); }
    catch (e) { log('poll error', e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
