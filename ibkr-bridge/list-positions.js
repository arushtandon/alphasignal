#!/usr/bin/env node
/**
 * Read-only: dump open IBKR positions (paper) for reconciliation.
 *   set IBKR_PORT=4002 && node list-positions.js
 */
const { IBApi, EventName } = require('@stoqey/ib');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '4002', 10);
const ACCOUNT = process.env.IBKR_ACCOUNT || 'DU1764495';
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '19', 10);

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function main() {
  log(`list-positions | IB=${HOST}:${PORT} account=${ACCOUNT} clientId=${CLIENT_ID}`);
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
  log('Connected');

  const positions = [];
  await new Promise(resolve => {
    const onPos = (account, contract, pos, avgCost) => {
      if (ACCOUNT && account !== ACCOUNT) return;
      const qty = Number(pos) || 0;
      if (!qty) return;
      positions.push({
        account,
        symbol: contract.symbol,
        localSymbol: contract.localSymbol,
        currency: contract.currency,
        conId: contract.conId,
        primaryExch: contract.primaryExch,
        qty,
        avgCost: Number(avgCost) || null
      });
    };
    ib.on(EventName.position, onPos);
    ib.once(EventName.positionEnd, () => { ib.off(EventName.position, onPos); resolve(); });
    ib.reqPositions();
  });

  positions.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  console.log(JSON.stringify({ ok: true, count: positions.length, positions }, null, 2));
  try { ib.disconnect(); } catch (_) {}
  process.exit(0);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
