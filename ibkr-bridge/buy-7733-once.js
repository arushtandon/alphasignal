#!/usr/bin/env node
/**
 * One-shot today's Japan rec: 7733.T BUY 800 TSEJ LMT-THROUGH.
 * Live pool parents at 2110/2155/2200 never printed while TSE last is ~2065.
 * Side client 26 (never 27). Skip if IB already has the lot.
 */
const fs = require('fs');
const path = require('path');
const { IBApi, EventName } = require('@stoqey/ib');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || 'DU1764495';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '26', 10);
const QTY = 800;
const CON_ID = 14017549;
const KEY = '7733.T|short|Fri Sep 04 2026';
const STATE = path.join(__dirname, 'bridge-state.json');
const LMT = 2210;

function log(...a) { console.log(new Date().toISOString(), ...a); }

function patchState(parentId, filled) {
  const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const row = j.byKey && j.byKey[KEY];
  if (!row) { log('state row missing', KEY); return; }
  row.parentId = parentId;
  row.stopId = null;
  row.tp1Id = null;
  row.entryStyle = 'LMT-THROUGH';
  row.extLmt = LMT;
  row.entryFilled = !!filled;
  row.closed = false;
  row.deferred = false;
  row.rearmBlocked = null;
  row.parentClientId = CLIENT_ID;
  row.placeClientId = CLIENT_ID;
  row.lastRearmAt = new Date().toISOString();
  row.rearmReason = 'side-client-26';
  row.orderSubmittedAt = row.lastRearmAt;
  row.updated = row.lastRearmAt;
  fs.writeFileSync(STATE, JSON.stringify(j, null, 2) + '\n');
  log('state patched', KEY, 'parentId=' + parentId, 'lmt=' + LMT, 'filled=' + !!filled);
}

async function main() {
  if (CLIENT_ID === 27) throw new Error('refusing client 27');
  log('buy-7733', `IB=${HOST}:${PORT} client=${CLIENT_ID} lmt=${LMT} qty=${QTY}`);

  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  let filled = 0;
  let avg = null;
  ib.on(EventName.error, (err, code, extra) => {
    log('IB msg', code, err && err.message ? err.message : err, extra != null ? extra : '');
  });
  ib.on(EventName.execDetails, (_req, contract, exec) => {
    if (Number(contract && contract.conId) !== CON_ID && String(contract && contract.symbol) !== '7733') return;
    log('exec', exec.side, exec.shares, '@', exec.price, 'oid=' + exec.orderId);
  });
  ib.on(EventName.orderStatus, (orderId, status, filledQty, remaining, avgFillPrice) => {
    filled = Number(filledQty) || filled;
    if (Number(avgFillPrice) > 0) avg = Number(avgFillPrice);
    log('status', orderId, status, 'filled=' + filledQty, 'left=' + remaining, 'avg=' + avgFillPrice);
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('IB connect timeout')), 15000);
    ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
    ib.connect();
  });
  log('connected');

  const pos = await new Promise(resolve => {
    let qty = 0;
    const t = setTimeout(() => resolve(qty), 4000);
    ib.on(EventName.position, (_acct, contract, position) => {
      if (Number(contract && contract.conId) === CON_ID || String(contract && contract.symbol) === '7733') {
        qty = Number(position) || 0;
      }
    });
    ib.once(EventName.positionEnd, () => { clearTimeout(t); resolve(qty); });
    try { ib.reqPositions(); } catch (_) { clearTimeout(t); resolve(qty); }
  });
  log('IB position 7733=', pos);
  if (pos >= QTY) {
    log('ALREADY FILLED — not placing another lot');
    try { patchState(null, true); } catch (e) { log('state patch failed', e.message); }
    ib.disconnect();
    return;
  }

  const open = await new Promise(resolve => {
    const orders = [];
    const t = setTimeout(() => resolve(orders), 4000);
    ib.on(EventName.openOrder, (orderId, contract, order) => {
      const conId = Number(contract && contract.conId) || 0;
      const symbol = String(contract && contract.symbol || '');
      if (conId !== CON_ID && symbol !== '7733') return;
      orders.push({
        orderId,
        action: String(order.action || '').toUpperCase(),
        type: String(order.orderType || ''),
        lmt: order.lmtPrice,
        qty: order.totalQuantity,
        tif: String(order.tif || ''),
        clientId: order.clientId != null ? order.clientId : order.clientID
      });
    });
    ib.once(EventName.openOrderEnd, () => { clearTimeout(t); resolve(orders); });
    try { ib.reqAllOpenOrders(); } catch (_) { clearTimeout(t); resolve(orders); }
  });
  log('open 7733', JSON.stringify(open));

  let oid = await new Promise(resolve => {
    ib.once(EventName.nextValidId, id => resolve(id));
    ib.reqIds();
  });
  oid = Number(oid);
  if (!(oid > 0)) oid = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000);
  oid += 7;
  const contract = {
    conId: CON_ID, symbol: '7733', secType: 'STK',
    exchange: 'SMART', primaryExch: 'TSEJ', currency: 'JPY'
  };
  const order = {
    action: 'BUY', orderType: 'LMT', lmtPrice: LMT, totalQuantity: QTY,
    tif: 'DAY', transmit: true, account: ACCOUNT, outsideRth: true,
    eTradeOnly: false, firmQuoteOnly: false
  };
  ib.placeOrder(oid, contract, order);
  log('placed', 'orderId=' + oid, 'BUY LMT', LMT, 'x' + QTY, 'SMART/TSEJ');
  try { patchState(oid, false); } catch (e) { log('state patch failed', e.message); }

  const until = Date.now() + 45000;
  while (Date.now() < until && filled < QTY) await new Promise(r => setTimeout(r, 250));

  if (filled >= QTY) {
    try { patchState(oid, true); } catch (e) { log('state patch failed', e.message); }
    log('FILLED ' + filled + (avg ? ' avg=' + avg : ''));
  } else {
    log('WORKING parent=' + oid + ' filled=' + filled + ' lmt=' + LMT);
  }
  ib.disconnect();
}

main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
