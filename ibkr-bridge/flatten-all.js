#!/usr/bin/env node
/**
 * One-off account cleanup: cancel ALL open orders and close ALL positions
 * in the connected IBKR (paper) account. Use before starting fresh tracking.
 *
 *   node flatten-all.js
 *
 * Env (same as bridge.js): IBKR_HOST, IBKR_PORT, IBKR_ACCOUNT,
 *   IBKR_DRY_RUN (1 = log only). Uses clientId 18 so it can run while the
 *   bridge is stopped without id clashes.
 *
 * Notes:
 * - reqGlobalCancel kills open orders from ALL client ids (incl. manual TWS ones).
 * - Positions are closed with MKT DAY orders. Closed markets (HK/Japan evening,
 *   US overnight) queue the close for their next session open — that's expected.
 */
const { IBApi, EventName } = require('@stoqey/ib');

const DRY = process.env.IBKR_DRY_RUN === '1';
const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '7497', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || '';

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function main() {
  log(`flatten-all | IB=${HOST}:${PORT} | dryRun=${DRY}`);
  const ib = new IBApi({ host: HOST, port: PORT, clientId: 18 });
  ib.on(EventName.error, (err, code, reqId) => {
    if ([2104, 2106, 2107, 2158].includes(Number(code))) return;
    log('IB msg', code, err && err.message ? err.message : err);
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
  log('Connected. nextValidId=', nextOrderId);

  // 1) Cancel every open order, across all API client ids and manual orders.
  if (DRY) log('DRY: would send global cancel for all open orders');
  else { ib.reqGlobalCancel(); log('Global cancel sent — all open orders cancelling.'); }

  // 2) Enumerate positions and close each one at market.
  const positions = [];
  await new Promise(resolve => {
    const onPos = (account, contract, pos) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      const qty = Number(pos) || 0;
      if (qty !== 0) positions.push({ account, contract, qty });
    };
    ib.on(EventName.position, onPos);
    ib.once(EventName.positionEnd, () => { ib.off(EventName.position, onPos); resolve(); });
    ib.reqPositions();
  });

  if (!positions.length) {
    log('No open positions found. Account is clean.');
  }
  // Give the global cancel a moment so closes don't race protective stops.
  await new Promise(r => setTimeout(r, 3000));

  for (const p of positions) {
    const c = p.contract;
    const contract = {
      conId: c.conId,
      symbol: c.symbol,
      secType: c.secType || 'STK',
      exchange: c.exchange || c.primaryExch || 'SMART',
      currency: c.currency
    };
    const order = {
      action: p.qty > 0 ? 'SELL' : 'BUY',
      orderType: 'MKT',
      totalQuantity: Math.abs(p.qty),
      tif: 'DAY',
      transmit: true,
      ...(ACCOUNT ? { account: ACCOUNT } : {})
    };
    if (DRY) {
      log('DRY: would close', c.symbol, c.currency, 'qty', p.qty, '→', order.action, order.totalQuantity);
    } else {
      const oid = nextOrderId++;
      ib.placeOrder(oid, contract, order);
      log('Close order sent:', order.action, order.totalQuantity, c.symbol, `(${c.currency})`, 'orderId=' + oid);
    }
  }

  log(`Done. Orders cancelled globally; ${positions.length} position close order(s) sent.`);
  log('Closed markets fill at their next session open — check the Orders tab.');
  setTimeout(() => { try { ib.disconnect(); } catch (_) {} process.exit(0); }, 5000);
}

main().catch(e => { console.error(e); process.exit(1); });
