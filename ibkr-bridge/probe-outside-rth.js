#!/usr/bin/env node
/**
 * Side-client whatIf probe: send far LMTs with outsideRth=true and print IB's
 * accept / ignore (2109) / reject per venue. Never client 27. Does not patch
 * bridge-state. Cancels anything that somehow goes working.
 */
const { IBApi, EventName } = require('@stoqey/ib');
const { placeableStkContract } = require('../lib/ibkr/order-routing');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || 'DU1764495';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '29', 10);

const INFO = new Set([2104, 2106, 2107, 2108, 2119, 2158, 10311]);

function log(...a) { console.log(new Date().toISOString(), ...a); }

const CASES = [
  {
    name: 'US IBM SMART LMT',
    contract: { symbol: 'IBM', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExch: 'NYSE', market: 'US' },
    qty: 1, lmt: 1, tif: 'DAY'
  },
  {
    name: 'JP 6098 TSEJ LMT',
    contract: { conId: 166623148, symbol: '6098', secType: 'STK', exchange: 'TSEJ', primaryExch: 'TSEJ', currency: 'JPY', market: 'JP' },
    qty: 100, lmt: 1, tif: 'DAY'
  },
  {
    name: 'JP 6098 TSEJ OPG',
    contract: { conId: 166623148, symbol: '6098', secType: 'STK', exchange: 'TSEJ', primaryExch: 'TSEJ', currency: 'JPY', market: 'JP' },
    qty: 100, lmt: null, tif: 'OPG', orderType: 'MKT'
  },
  {
    name: 'HK 0941 SEHK LMT',
    contract: { symbol: '941', secType: 'STK', exchange: 'SEHK', primaryExch: 'SEHK', currency: 'HKD', market: 'HK' },
    qty: 500, lmt: 0.01, tif: 'DAY'
  },
  {
    name: 'LSE VOD LMT',
    contract: { symbol: 'VOD', secType: 'STK', exchange: 'LSE', primaryExch: 'LSE', currency: 'GBP', market: 'LSE' },
    qty: 1, lmt: 1, tif: 'DAY'
  },
  {
    name: 'EU MC SBF LMT',
    contract: { symbol: 'MC', secType: 'STK', exchange: 'SMART', primaryExch: 'SBF', currency: 'EUR', market: 'EURONEXT' },
    qty: 1, lmt: 1, tif: 'DAY'
  }
];

async function main() {
  if (CLIENT_ID === 27) throw new Error('refusing client 27');
  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  const byOid = new Map();

  ib.on(EventName.error, (err, code, extra) => {
    const msg = err && err.message ? err.message : String(err);
    const oid = Number(extra);
    if (INFO.has(Number(code))) return;
    log('IB', code, msg, extra != null ? extra : '');
    if (oid > 0 && byOid.has(oid)) {
      byOid.get(oid).errors.push({ code: Number(code), msg });
    }
  });
  ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
    const row = byOid.get(Number(orderId));
    if (!row) return;
    row.status.push({ status, filled: Number(filled), remaining: Number(remaining), avg: Number(avgFillPrice) });
    log('status', row.name, orderId, status, 'filled=' + filled, 'left=' + remaining);
  });
  ib.on(EventName.openOrder, (orderId, contract, order) => {
    const row = byOid.get(Number(orderId));
    if (!row) return;
    row.echo = {
      outsideRth: order.outsideRth,
      whatIf: order.whatIf,
      tif: order.tif,
      type: order.orderType,
      lmt: order.lmtPrice,
      exch: contract && contract.exchange,
      symbol: contract && contract.symbol
    };
    log('openOrder echo', row.name, JSON.stringify(row.echo));
  });
  ib.on(EventName.execDetails, (_req, contract, exec) => {
    log('EXEC UNEXPECTED', contract && contract.symbol, exec.side, exec.shares, '@', exec.price, 'oid=' + exec.orderId);
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('IB connect timeout')), 15000);
    ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
    ib.connect();
  });
  log('connected', `IB=${HOST}:${PORT} client=${CLIENT_ID} whatIf=1 outsideRth=1`);

  let oid = await new Promise(resolve => {
    ib.once(EventName.nextValidId, id => resolve(Number(id)));
    ib.reqIds();
  });
  if (!(oid > 0)) oid = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000);

  for (const c of CASES) {
    const oc = placeableStkContract(c.contract);
    const order = {
      action: 'BUY',
      orderType: c.orderType || 'LMT',
      totalQuantity: c.qty,
      tif: c.tif,
      transmit: true,
      whatIf: true,
      outsideRth: true,
      eTradeOnly: false,
      firmQuoteOnly: false,
      account: ACCOUNT
    };
    if (c.lmt != null) order.lmtPrice = c.lmt;
    oid += 1;
    byOid.set(oid, { name: c.name, errors: [], status: [], echo: null, oid, oc, order });
    ib.placeOrder(oid, oc, order);
    log('placed whatIf', c.name, 'oid=' + oid, JSON.stringify({ ...order, contract: oc }));
    await new Promise(r => setTimeout(r, 2500));
  }

  await new Promise(r => setTimeout(r, 2000));

  const working = [];
  await new Promise(resolve => {
    const t = setTimeout(() => resolve(), 3000);
    const onOpen = (id, contract, order) => {
      if (order && order.whatIf) return;
      working.push({
        id,
        symbol: contract && contract.symbol,
        type: order && order.orderType,
        tif: order && order.tif,
        outsideRth: order && order.outsideRth
      });
    };
    ib.on(EventName.openOrder, onOpen);
    ib.once(EventName.openOrderEnd, () => { clearTimeout(t); resolve(); });
    try { ib.reqOpenOrders(); } catch (_) { clearTimeout(t); resolve(); }
  });
  for (const w of working) {
    try { ib.cancelOrder(w.id); log('cancel leftover', w.id, w.symbol); } catch (e) {
      log('cancel failed', w.id, e.message);
    }
  }

  console.log('\n=== outsideRth=true whatIf results ===');
  for (const row of byOid.values()) {
    const ignore = row.errors.filter(e => e.code === 2109 || /outside.*regular.*hours.*ignor/i.test(e.msg));
    const rejects = row.errors.filter(e => !ignore.includes(e));
    console.log(JSON.stringify({
      name: row.name,
      oid: row.oid,
      sentOutsideRth: true,
      echoOutsideRth: row.echo && row.echo.outsideRth,
      statuses: row.status.map(s => s.status),
      ignoredAttr: ignore.map(e => e.code + ' ' + e.msg),
      otherIb: rejects.map(e => e.code + ' ' + e.msg)
    }));
  }

  ib.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
