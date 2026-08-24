#!/usr/bin/env node
/**
 * Place missing live TP1s that cannot wait for the client-27 restart:
 *   0883.HK  SELL 3000 LMT OPG @ 25 (bank half at Tuesday HK open if print ≥ 25)
 *   2688.HK  SELL 800  LMT GTC @ synthesized medium TP1
 *
 *   IBKR_CLIENT_ID=29 IBKR_PORT=4002 IBKR_ACCOUNT=DU1764495 IBKR_DRY_RUN=0 node ensure-tp1-now.js
 */
const { IBApi, EventName } = require('@stoqey/ib');
const { synthesizeTp1Px } = require('../lib/ibkr/tp1-policy');

const DRY = process.env.IBKR_DRY_RUN === '1';
const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || '';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '29', 10);

function log(...a) { console.log(new Date().toISOString(), ...a); }

function hkTick(px) {
  const a = Math.abs(Number(px) || 0);
  if (a < 10) return 0.01;
  if (a < 20) return 0.02;
  if (a < 100) return 0.05;
  return 0.1;
}
function roundUp(px) {
  const tick = hkTick(px);
  const dp = (String(tick).split('.')[1] || '').length;
  return +(Math.ceil(Number(px) / tick - 1e-9) * tick).toFixed(dp);
}

async function main() {
  log('ensure-tp1-now', `IB=${HOST}:${PORT} clientId=${CLIENT_ID} dry=${DRY}`);
  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  ib.on(EventName.error, (err, code, extra) => {
    if ([2104, 2106, 2107, 2158].includes(Number(code))) return;
    log('IB msg', code, err && err.message ? err.message : err, extra != null ? JSON.stringify(extra) : '');
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('IB connect timeout')), 20000);
    ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
    ib.connect();
  });
  let nextOrderId = await new Promise(resolve => {
    ib.once(EventName.nextValidId, id => resolve(id));
    ib.reqIds();
  });
  nextOrderId = Math.max(nextOrderId, Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000));
  log('connected orderId=', nextOrderId);

  const positions = [];
  await new Promise(resolve => {
    ib.on(EventName.position, (account, contract, pos, avgCost) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      const qty = Number(pos) || 0;
      if (!qty) return;
      positions.push({ contract, qty, avgCost: Number(avgCost) || 0 });
    });
    ib.once(EventName.positionEnd, resolve);
    ib.reqPositions();
  });

  const working = [];
  await new Promise(resolve => {
    const t = setTimeout(resolve, 4000);
    ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
      const st = String((orderState && orderState.status) || '');
      if (st === 'Cancelled' || st === 'Filled' || st === 'Inactive') return;
      working.push({
        orderId,
        conId: Number(contract && contract.conId) || 0,
        symbol: String(contract && contract.symbol || ''),
        action: String(order.action || '').toUpperCase(),
        type: String(order.orderType || '').toUpperCase(),
        qty: Number(order.totalQuantity) || 0,
        lmt: Number(order.lmtPrice) || 0,
        tif: String(order.tif || '').toUpperCase()
      });
    });
    ib.once(EventName.openOrderEnd, () => { clearTimeout(t); resolve(); });
    ib.reqAllOpenOrders();
  });
  log('positions', positions.map(p => (p.contract.symbol || '') + '=' + p.qty).join(' '));
  log('working', working.map(o => o.symbol + ' ' + o.action + ' ' + o.type + ' ' + o.qty + '@' + (o.lmt || o.aux || 0) + ' ' + o.tif).join(' | '));

  function findPos(conId, symbol) {
    return positions.find(p => Number(p.contract.conId) === conId
      || String(p.contract.symbol) === String(symbol));
  }
  function hasLmt(conId, qty) {
    return working.find(o => o.conId === conId && o.type === 'LMT' && o.action === 'SELL'
      && Math.abs(o.qty - qty) < 1e-6);
  }
  function place(contract, order, label) {
    const oid = nextOrderId++;
    if (DRY) {
      log('DRY', label, JSON.stringify({ oid, contract, order }));
      return oid;
    }
    ib.placeOrder(oid, contract, order);
    log('placed', label, 'orderId=' + oid, order.action, order.orderType, order.totalQuantity, '@', order.lmtPrice, order.tif);
    return oid;
  }

  const acct = ACCOUNT ? { account: ACCOUNT } : {};

  const p883 = findPos(12150119, '883');
  if (p883 && p883.qty >= 6000) {
    if (hasLmt(12150119, 3000)) {
      log('0883 already has SELL LMT 3000 — skip');
    } else {
      log('0883 defer — SEHK rejects overnight marketable SELL as short sale; place GTC 25 at HK open');
    }
  } else {
    log('0883 skip — pos', p883 && p883.qty);
  }

  const p2688 = findPos(79403968, '2688');
  if (p2688 && p2688.qty >= 1600) {
    if (hasLmt(79403968, 800)) {
      log('2688 already has SELL LMT 800 — skip');
    } else {
      const avg = Number(p2688.avgCost) || 46.2752174;
      let px = roundUp(synthesizeTp1Px(avg > 20 && avg < 200 ? avg : 46.2752174, 'medium', false));
      if (px >= 49.5 && px < 50) px = 50;
      place({
        conId: 79403968, symbol: '2688', secType: 'STK',
        exchange: 'SEHK', currency: 'HKD', primaryExch: 'SEHK'
      }, {
        action: 'SELL', orderType: 'LMT', lmtPrice: px, totalQuantity: 800,
        tif: 'GTC', transmit: true, ...acct
      }, '2688 TP1 GTC');
    }
  } else {
    log('2688 skip — pos', p2688 && p2688.qty);
  }

  const p5 = findPos(1616390, '5');
  if (p5 && p5.qty >= 800) {
    if (hasLmt(1616390, 400)) {
      log('0005 already has SELL LMT 400 — skip');
    } else {
      place({
        conId: 1616390, symbol: '5', secType: 'STK',
        exchange: 'SEHK', currency: 'HKD', primaryExch: 'SEHK'
      }, {
        action: 'SELL', orderType: 'LMT', lmtPrice: 167.5, totalQuantity: 400,
        tif: 'GTC', transmit: true, ...acct
      }, '0005 TP1 GTC');
    }
  } else {
    log('0005 skip — pos', p5 && p5.qty);
  }

  await new Promise(r => setTimeout(r, 4000));
  ib.disconnect();
  log('done');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
