'use strict';

/**
 * Approved one-off covers. Not the bridge (client 27 stays with the supervisor).
 * Client 24. Each fill is posted to the AlphaSignal ledger and appended to
 * one-off-inbox.json so a bridge restart queues anything the post missed.
 *
 *   PH   BUY 11  at the US cash open (tonight)
 *   SNDK BUY 1   at the US cash open
 *   6758 BUY 300 at the TSE open, only after order 59148332 is gone
 *   0322 BUY 2000 at the SEHK open
 * 4519.T is not covered.
 */

const fs = require('fs');
const path = require('path');
const { IBApi, EventName } = require('@stoqey/ib');
const { usCashDue, tseCashDue, sehkCashDue } = require('../lib/ibkr/cover-schedule');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || 'DU1764495';
const CLIENT_ID = 24;
const BASE = process.env.ALPHASIGNAL_URL || 'https://alphasignal-dvg5.onrender.com';
const STATE = path.join(__dirname, 'bridge-state.json');
const INBOX = path.join(__dirname, 'one-off-inbox.json');
const PROGRESS = path.join(__dirname, '..', 'data', 'cover-approved-progress.json');
const LOG = path.join(__dirname, 'logs', 'cover-approved.log');

const JOBS = [
  {
    id: 'PH', symbol: 'PH', conId: 11094, currency: 'USD', primaryExch: 'NYSE',
    qty: 11, due: usCashDue, key: 'PH|short|Mon Aug 24 2026', ticker: 'PH',
  },
  {
    id: 'SNDK', symbol: 'SNDK', conId: 760250490, currency: 'USD', primaryExch: 'NASDAQ',
    qty: 1, due: usCashDue, key: 'SNDK|short|Tue Aug 25 2026', ticker: 'SNDK',
  },
  {
    id: '6758', symbol: '6758', conId: 13905705, currency: 'JPY', primaryExch: 'TSEJ',
    qty: 300, due: tseCashDue, key: '6758.T|short|Mon Sep 07 2026', ticker: '6758.T',
    blockIfOrder: 59148332,
  },
  {
    id: '0322', symbol: '322', conId: 3884574, currency: 'HKD', primaryExch: 'SEHK',
    qty: 2000, due: sehkCashDue, key: '0322.HK|short|Mon Aug 31 2026', ticker: '0322.HK',
  },
];

function log(...args) {
  const line = [new Date().toISOString(), ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))].join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); }
  catch (_) { return {}; }
}

function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
  fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2));
}

function readToken() {
  if (process.env.IBKR_EVENTS_TOKEN) return process.env.IBKR_EVENTS_TOKEN;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'local-secrets.ps1'), 'utf8');
    const m = raw.match(/IBKR_EVENTS_TOKEN\s*=\s*"([^"]+)"/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function appendInbox(report) {
  let body = { reports: [] };
  try { body = JSON.parse(fs.readFileSync(INBOX, 'utf8')); } catch (_) {}
  if (!Array.isArray(body.reports)) body.reports = [];
  if (body.reports.some(r => r && String(r.execId) === String(report.execId))) return;
  body.reports.push(report);
  fs.writeFileSync(INBOX, JSON.stringify(body, null, 2));
}

function postReport(report) {
  const token = readToken();
  const u = new URL(BASE + '/api/ibkr/report');
  if (token) u.searchParams.set('token', token);
  const payload = JSON.stringify({ reports: [report], account: ACCOUNT });
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' ' + raw.slice(0, 180)));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('report timeout')));
    req.end(payload);
  });
}

function connect() {
  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  ib.on(EventName.error, (err, code, reqId) => {
    const c = Number(code);
    if ([2104, 2106, 2107, 2158, 2109].includes(c)) return;
    log('IB', c, reqId || '', err && err.message ? err.message : err);
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 20000);
    ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
  });
  ib.connect();
  return ready.then(() => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('nextValidId timeout')), 15000);
    ib.once(EventName.nextValidId, id => { clearTimeout(t); resolve({ ib, nextId: Number(id) || 1 }); });
    ib.reqIds();
  }));
}

function readPosition(ib, conId) {
  return new Promise(resolve => {
    let qty = null;
    const t = setTimeout(() => resolve(qty), 5000);
    const onPos = (_a, contract, pos) => {
      if (Number(contract && contract.conId) === Number(conId)) qty = Number(pos) || 0;
    };
    ib.on(EventName.position, onPos);
    ib.reqPositions();
    ib.once(EventName.positionEnd, () => {
      clearTimeout(t);
      try { ib.cancelPositions(); } catch (_) {}
      resolve(qty);
    });
  });
}

function orderStillWorking(ib, orderId) {
  return new Promise(resolve => {
    let live = false;
    const t = setTimeout(() => resolve(live), 5000);
    ib.on(EventName.openOrder, (id, _c, _o, st) => {
      if (Number(id) !== Number(orderId)) return;
      const s = String(st && st.status || '');
      if (s && !['Cancelled', 'Filled', 'Inactive', 'ApiCancelled'].includes(s)) live = true;
    });
    ib.once(EventName.openOrderEnd, () => { clearTimeout(t); resolve(live); });
    ib.reqAllOpenOrders();
  });
}

async function recordFill(job, exec) {
  const report = {
    kind: 'exec',
    execId: String(exec.execId),
    key: job.key,
    ticker: job.ticker,
    hz: 'short',
    side: 'buy',
    role: 'flatten',
    orderId: Number(exec.orderId) || null,
    qty: Number(exec.shares),
    price: Number(exec.price),
    currency: job.currency,
    ccyScale: 1,
    fillOrderType: 'MKT',
    orderType: 'MKT',
    recon: 'approved-cover',
    account: ACCOUNT,
    time: new Date().toISOString(),
  };
  appendInbox(report);
  try {
    const resp = await postReport(report);
    log('ledger', job.id, report.execId, report.qty + '@' + report.price, JSON.stringify({
      stored: resp && resp.stored, dup: resp && (resp.skippedDup != null ? resp.skippedDup : resp.skipped),
    }));
  } catch (e) {
    log('ledger post failed (inbox kept)', job.id, e.message);
  }
}

async function runJob(job, progress) {
  const row = progress[job.id] || {};
  if (row.done) return;
  const { ib, nextId } = await connect();
  const fills = [];
  ib.on(EventName.execDetails, (_req, contract, exec) => {
    if (Number(contract && contract.conId) !== job.conId) return;
    if (String(exec.side || '').toUpperCase() !== 'BOT') return;
    fills.push(exec);
    log('exec', job.id, exec.execId, exec.shares + '@' + exec.price, 'oid=' + exec.orderId);
  });
  try {
    const pos = await readPosition(ib, job.conId);
    log('position', job.id, pos);
    if (!(Number(pos) < 0)) {
      log('skip', job.id, 'not short');
      progress[job.id] = { done: true, reason: 'not-short', pos, at: new Date().toISOString() };
      saveProgress(progress);
      return;
    }
    if (job.blockIfOrder) {
      const live = await orderStillWorking(ib, job.blockIfOrder);
      if (live) {
        log('hold', job.id, 'order', job.blockIfOrder, 'still working — not buying');
        return;
      }
      log('clear', job.id, 'order', job.blockIfOrder, 'is not working');
    }
    const qty = Math.min(job.qty, Math.abs(Number(pos)));
    const orderId = row.orderId || nextId;
    if (!row.orderId) {
      ib.placeOrder(orderId, {
        symbol: job.symbol,
        secType: 'STK',
        exchange: 'SMART',
        primaryExch: job.primaryExch,
        currency: job.currency,
        conId: job.conId,
      }, {
        orderId,
        action: 'BUY',
        orderType: 'MKT',
        totalQuantity: qty,
        tif: 'DAY',
        outsideRth: false,
        transmit: true,
      });
      progress[job.id] = { orderId, qty, sentAt: new Date().toISOString(), done: false };
      saveProgress(progress);
      log('sent', job.id, 'BUY', qty, 'MKT', 'oid=' + orderId, 'client=' + CLIENT_ID);
    } else {
      log('already sent', job.id, 'oid=' + row.orderId);
    }
    await sleep(20000);
    for (const exec of fills) await recordFill(job, exec);
    const filledQty = fills.reduce((s, e) => s + (Number(e.shares) || 0), 0);
    if (filledQty + 1e-9 >= qty) {
      progress[job.id].done = true;
      progress[job.id].filledQty = filledQty;
      saveProgress(progress);
      log('filled', job.id, filledQty);
    } else {
      log('partial or waiting', job.id, 'filled=' + filledQty, 'want=' + qty);
    }
  } finally {
    try { ib.disconnect(); } catch (_) {}
  }
}

async function main() {
  if (CLIENT_ID === 27) throw new Error('refusing client 27');
  log('cover-approved armed', 'client=' + CLIENT_ID, 'account=' + ACCOUNT);
  const progress = loadProgress();
  for (;;) {
    let pending = false;
    for (const job of JOBS) {
      if (progress[job.id] && progress[job.id].done) continue;
      pending = true;
      if (!job.due(new Date())) continue;
      try {
        await runJob(job, progress);
      } catch (e) {
        log('job failed', job.id, e && e.stack ? e.stack : e);
      }
      await sleep(2000);
    }
    if (!pending) {
      log('all covers done');
      return;
    }
    await sleep(15000);
  }
}

main().catch(e => {
  log('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
