#!/usr/bin/env node
/**
 * AlphaSignal recommendation-lifecycle invariants (T1–T6).
 * Uses an isolated DATA_DIR so production disk is untouched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-lifecycle-'));
process.env.DATA_DIR = tmp;
process.env.IBKR_EVENTS_ENABLED = '1';
process.env.PORT = '0'; // unused — we never listen

const S = require('../server.js');
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('PASS', name);
  else {
    failed++;
    console.error('FAIL', name, detail || '');
  }
}

// ── T1 SU.PA: open long Buy survives low-Conf demote ─────────────────────────
(function t1() {
  const row = {
    ticker: 'SU.PA', hz: 'long', action: 'Buy',
    longAction: 'Buy', longStatus: 'open',
    longEntry: 302.25, longTarget1: 368.39, longTarget2: 400, longStopLoss: 247.87,
    longConf: 40, conf: 40, entryDate: '2026-08-10T20:48:00.000Z'
  };
  row._freezeOpenAction = true;
  const refused = !S.writeOpenRowAction(row, 'long', 'Hold');
  S.applyServerPriceLevels(row, 302.25, { atr: 12 }, null);
  ok('T1 action stays Buy', row.longAction === 'Buy' && refused, row.longAction);
  ok('T1 levels non-blank', Number(row.longEntry) === 302.25
    && Number(row.longTarget1) > 0 && Number(row.longStopLoss) > 0,
    JSON.stringify({ e: row.longEntry, t1: row.longTarget1, sl: row.longStopLoss }));
})();

// ── T2 Flip-flop: recon synthetic survives phantom purge ─────────────────────
(function t2() {
  const key = 'TEST.HK|short|Mon Jan 01 2024'; // ancient key day
  const synth = {
    execId: 'recon-flat-' + key + '-q100',
    key, ticker: 'TEST.HK', hz: 'short', side: 'buy', role: 'flatten',
    qty: 100, price: 10, currency: 'HKD', ccyScale: 1,
    time: new Date().toISOString(), synthetic: true, recon: 'ghost-flat'
  };
  S.mutateFillLedger('t2_seed', () => [synth]);
  // Phantom purge filter (same predicate recon uses)
  S.mutateFillLedger('recon_phantom_purge', (rows) =>
    rows.filter(r => !S.isPhantomIbkrKey(r.key, r.time, r)));
  const after = S.readIbkrFillRows();
  ok('T2 synthetic survives purge', after.some(r => r.execId === synth.execId)
    && !S.isPhantomIbkrKey(synth.key, synth.time, synth),
    'rows=' + after.length);
})();

// ── T3 Hold→Buy: Hold snapshot has side null; emit entry returns null ────────
(function t3() {
  const hold = {
    ticker: 'HOLD.X', hz: 'short', action: 'Hold', shortAction: 'Hold',
    shortEntry: 10, shortTarget1: 12, shortStopLoss: 9, shortConf: 70,
    entryDate: new Date().toISOString()
  };
  const snap = S.tradeEventSnapshot(hold, 'short');
  ok('T3 side null on Hold', snap.side === null, snap.side);
  const evt = S.emitTradeEvent('entry', snap);
  ok('T3 emit entry returns null', evt === null, evt);
})();

// ── T4 Orphan: open emitted entry ⇒ authorized (not flattenable) ─────────────
(function t4() {
  const day = 'Tue Aug 11 2026';
  const key = '9988.HK|short|' + day;
  fs.appendFileSync(S.TRADE_EVENTS_FILE, JSON.stringify({
    seq: 900001, t: new Date().toISOString(), type: 'entry',
    key, ticker: '9988.HK', hz: 'short', side: 'sell',
    entry: 123.8, sl: 140, tp1: 110
  }) + '\n');
  ok('T4 authorized by provenance', S.isPositionAuthorizedByProvenance('9988.HK'), 'not authorized');
  ok('T4 open emitted entry present', S.hasOpenEmittedEntryForTicker('9988.HK'));
  // Flatten set = unauthorized only; authorized tickers excluded.
  const flattenSet = new Set();
  if (!S.isPositionAuthorizedByProvenance('9988.HK')) flattenSet.add('9988.HK');
  ok('T4 not in flatten set', !flattenSet.has('9988.HK'));
})();

// ── T5 GET /api/ibkr/trades idempotent (no ledger write) ─────────────────────
(async function t5() {
  const before = fs.existsSync(S.IBKR_FILLS_FILE)
    ? fs.readFileSync(S.IBKR_FILLS_FILE) : Buffer.alloc(0);
  function getTrades() {
    return new Promise((resolve, reject) => {
      const server = http.createServer(S.app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        http.get({ host: '127.0.0.1', port, path: '/api/ibkr/trades' }, (res) => {
          let b = '';
          res.on('data', c => b += c);
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: b });
          });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
  }
  try {
    const r1 = await getTrades();
    const mid = fs.existsSync(S.IBKR_FILLS_FILE)
      ? fs.readFileSync(S.IBKR_FILLS_FILE) : Buffer.alloc(0);
    const r2 = await getTrades();
    const after = fs.existsSync(S.IBKR_FILLS_FILE)
      ? fs.readFileSync(S.IBKR_FILLS_FILE) : Buffer.alloc(0);
    ok('T5 GET ok', r1.status === 200 && r2.status === 200, 'status ' + r1.status + '/' + r2.status);
    ok('T5 fills byte-identical', Buffer.compare(before, mid) === 0 && Buffer.compare(mid, after) === 0,
      'len ' + before.length + '→' + mid.length + '→' + after.length);
  } catch (e) {
    ok('T5 GET idempotency', false, e.message);
  }

  // ── T6 Qty match: tracked ticker site open ≈ IB lot ────────────────────────
  (function t6() {
    const key = '0005.HK|short|Tue Aug 11 2026';
    S.mutateFillLedger('t6_seed', (rows) => {
      rows.push({
        execId: 't6-entry-1', key, ticker: '0005.HK', hz: 'short', side: 'buy',
        role: 'entry', qty: 800, price: 70, currency: 'HKD', ccyScale: 1,
        time: new Date().toISOString()
      });
      return rows;
    });
    const opens = S.aggregateIbkrOpenFromFills(S.readIbkrFillRows());
    const o = opens.find(x => x.ticker === '0005.HK' || x.ticker === '5.HK');
    const siteOpenQty = o ? o.openQty : 0;
    const ibQty = 800;
    const lot = 100;
    ok('T6 qty within lot', Math.abs(siteOpenQty - ibQty) <= lot,
      'site=' + siteOpenQty + ' ib=' + ibQty);
  })();

  if (failed) {
    console.error('\n' + failed + ' invariant(s) failed. DATA_DIR=' + tmp);
    process.exit(1);
  }
  console.log('\nAll T1–T6 invariants passed. DATA_DIR=' + tmp);
  process.exit(0);
})();
