#!/usr/bin/env node
/**
 * One-shot today's ETH-USD long. Overnight MKT was rejected 10289
 * (PAXOS BUY MKT requires cashQty + tif IOC; no STP child).
 */
const fs = require('fs');
const path = require('path');
const { IBApi, EventName } = require('@stoqey/ib');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || 'DU1764495';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '28', 10);
const CON_ID = 495759171;
const KEY = 'ETH-USD|long|Fri Sep 04 2026';
const STATE = path.join(__dirname, 'bridge-state.json');
const CASH_QTY = Number(process.env.ETH_CASH_QTY || '10000');

function log(...a) { console.log(new Date().toISOString(), ...a); }

function patchState(parentId, filled, fillQty, avg) {
  const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const row = j.byKey && j.byKey[KEY];
  if (!row) { log('state row missing', KEY); return; }
  row.parentId = parentId;
  row.stopId = null;
  row.tp1Id = null;
  row.entryStyle = 'MKT-GLOBE';
  row.entryFilled = !!filled;
  row.closed = false;
  row.deferred = false;
  row.contractRejected = false;
  row.cryptoCashQtyRejected = false;
  row.parentClientId = CLIENT_ID;
  row.placeClientId = CLIENT_ID;
  if (fillQty > 0) {
    row.qtyTotal = fillQty;
    row.ibAvgFill = avg || row.ibAvgFill;
  }
  row.lastRearmAt = new Date().toISOString();
  row.rearmReason = 'side-client-28-cashqty';
  row.orderSubmittedAt = row.lastRearmAt;
  row.updated = row.lastRearmAt;
  fs.writeFileSync(STATE, JSON.stringify(j, null, 2) + '\n');
  log('state patched', KEY, 'parentId=' + parentId, 'filled=' + !!filled, 'qty=' + (fillQty || ''));
}

async function main() {
  if (CLIENT_ID === 27) throw new Error('refusing client 27');
  log('buy-eth', `IB=${HOST}:${PORT} client=${CLIENT_ID} cashQty=${CASH_QTY}`);

  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  let filled = 0;
  let avg = null;
  ib.on(EventName.error, (err, code, extra) => {
    log('IB msg', code, err && err.message ? err.message : err, extra != null ? extra : '');
  });
  ib.on(EventName.execDetails, (_req, contract, exec) => {
    const sym = String(contract && contract.symbol || '');
    if (Number(contract && contract.conId) !== CON_ID && sym !== 'ETH') return;
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
      if (Number(contract && contract.conId) === CON_ID || String(contract && contract.symbol) === 'ETH') {
        qty = Number(position) || 0;
      }
    });
    ib.once(EventName.positionEnd, () => { clearTimeout(t); resolve(qty); });
    try { ib.reqPositions(); } catch (_) { clearTimeout(t); resolve(qty); }
  });
  log('IB position ETH=', pos);
  if (pos > 0.01) {
    log('ALREADY FILLED — not placing another lot');
    try { patchState(null, true, pos, null); } catch (e) { log('state patch failed', e.message); }
    ib.disconnect();
    return;
  }

  let oid = await new Promise(resolve => {
    ib.once(EventName.nextValidId, id => resolve(id));
    ib.reqIds();
  });
  oid = Number(oid) + 3;
  if (!(oid > 0)) oid = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000);
  const contract = {
    conId: CON_ID, symbol: 'ETH', secType: 'CRYPTO',
    exchange: 'PAXOS', currency: 'USD'
  };
  const order = {
    action: 'BUY', orderType: 'MKT', cashQty: CASH_QTY,
    totalQuantity: 0,
    tif: 'IOC', transmit: true, account: ACCOUNT, outsideRth: false,
    eTradeOnly: false, firmQuoteOnly: false
  };
  ib.placeOrder(oid, contract, order);
  log('placed', 'orderId=' + oid, 'BUY MKT cashQty=' + CASH_QTY, 'IOC PAXOS');
  try { patchState(oid, false, 0, null); } catch (e) { log('state patch failed', e.message); }

  const until = Date.now() + 20000;
  while (Date.now() < until && filled <= 0) await new Promise(r => setTimeout(r, 250));

  if (filled > 0) {
    try { patchState(oid, true, filled, avg); } catch (e) { log('state patch failed', e.message); }
    log('FILLED ' + filled + (avg ? ' avg=' + avg : ''));
  } else {
    log('NO FILL parent=' + oid + ' filled=' + filled + ' cashQty=' + CASH_QTY);
  }
  ib.disconnect();
}

main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
