#!/usr/bin/env node
/**
 * Flatten specific Yahoo tickers in the IB paper account (cancel matching
 * working orders via global cancel is NOT used — only closes listed symbols).
 *
 *   IBKR_DRY_RUN=0 IBKR_PORT=4002 IBKR_ACCOUNT=DU1764495 node flatten-tickers.js FSLR BMY CVX MPC HSBA.L AIR.DE AIR.PA
 */
const { IBApi, EventName } = require('@stoqey/ib');

const DRY = process.env.IBKR_DRY_RUN === '1';
const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || '';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '19', 10);

function log(...a) { console.log(new Date().toISOString(), ...a); }

const { yahooSuffixFromIbPrimary } = require('./listing-aliases.js');

function yahooFromContract(c) {
  if (!c) return null;
  const sym = String(c.symbol || '');
  const ccy = c.currency;
  if (ccy === 'HKD') return String(parseInt(sym, 10)) + '.HK';
  if (ccy === 'JPY') return sym + '.T';
  if (ccy === 'GBP') return sym + '.L';
  if (ccy === 'EUR') {
    const suf = yahooSuffixFromIbPrimary(c.primaryExch)
      || yahooSuffixFromIbPrimary(c.exchange);
    if (suf) return String(sym).toUpperCase() + suf;
    return String(sym || '').toUpperCase();
  }
  return sym;
}

function matchesWanted(contract, wanted) {
  const y = yahooFromContract(contract);
  const sym = String(contract.symbol || '').toUpperCase();
  for (const w of wanted) {
    const W = String(w).toUpperCase();
    if (y && y.toUpperCase() === W) return true;
    if (W.replace(/\.(DE|PA|L|HK|T)$/i, '') === sym) {
      // AIR matches AIR.DE and AIR.PA
      if (W.startsWith(sym + '.') || W === sym) return true;
    }
  }
  return false;
}

async function main() {
  const wanted = process.argv.slice(2);
  if (!wanted.length) {
    console.error('Usage: node flatten-tickers.js TICKER [TICKER...]');
    process.exit(1);
  }
  log('flatten-tickers', wanted.join(', '), `| IB=${HOST}:${PORT} clientId=${CLIENT_ID} dry=${DRY}`);
  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  ib.on(EventName.error, (err, code) => {
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
  nextOrderId = Math.max(nextOrderId, Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 1000));
  log('Connected. starting orderId=', nextOrderId);

  const positions = [];
  await new Promise(resolve => {
    const onPos = (account, contract, pos) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      const qty = Number(pos) || 0;
      if (!qty) return;
      if (!matchesWanted(contract, wanted)) return;
      positions.push({ contract, qty });
    };
    ib.on(EventName.position, onPos);
    ib.once(EventName.positionEnd, () => { ib.off(EventName.position, onPos); resolve(); });
    ib.reqPositions();
  });

  if (!positions.length) {
    log('No matching positions found for', wanted.join(', '));
  }

  for (const p of positions) {
    const c = p.contract;
    const contract = {
      conId: c.conId,
      symbol: c.symbol,
      secType: c.secType || 'STK',
      exchange: c.currency === 'HKD' ? 'SEHK' : 'SMART',
      currency: c.currency,
      primaryExch: c.primaryExch
    };
    const order = {
      action: p.qty > 0 ? 'SELL' : 'BUY',
      orderType: 'MKT',
      totalQuantity: Math.abs(p.qty),
      tif: 'DAY',
      transmit: true,
      ...(ACCOUNT ? { account: ACCOUNT } : {})
    };
    const y = yahooFromContract(c);
    if (DRY) {
      log('DRY close', y || c.symbol, p.qty, '→', order.action, order.totalQuantity);
    } else {
      const oid = nextOrderId++;
      ib.placeOrder(oid, contract, order);
      log('Close sent', y || c.symbol, order.action, order.totalQuantity, 'orderId=' + oid);
    }
  }

  await new Promise(r => setTimeout(r, 3000));
  ib.disconnect();
  log('Done.', positions.length, 'close(s).');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
