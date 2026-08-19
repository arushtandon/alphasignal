#!/usr/bin/env node
/**
 * AlphaSignal recommendation-lifecycle invariants (T1–T21).
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
process.env.AUTH_TEST_BYPASS = '1';
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

  // ── T7 Live model-only fills → not Error, realised 0 ───────────────────────
  (function t7() {
    const day = 'Wed Aug 12 2026';
    const key = 'MODEL.X|long|' + day;
    fs.appendFileSync(S.TRADE_EVENTS_FILE, JSON.stringify({
      seq: 910001, t: new Date().toISOString(), type: 'entry',
      key, ticker: 'MODEL.X', hz: 'long', side: 'buy', entry: 100, sl: 90, tp1: 120
    }) + '\n');
    S.mutateFillLedger('t7_seed', (rows) => {
      rows.push({
        execId: 't7-live-entry', key, ticker: 'MODEL.X', hz: 'long', side: 'buy',
        role: 'entry', qty: 10, price: 100, currency: 'USD', ccyScale: 1,
        time: new Date().toISOString(), errorTrade: false
      });
      return rows;
    });
    const opens = S.aggregateIbkrOpenFromFills(S.readIbkrFillRows());
    const o = opens.find(x => String(x.key) === key);
    const t = {
      key, ticker: 'MODEL.X', openQty: o ? o.openQty : 0,
      fills: S.readIbkrFillRows().filter(r => r.key === key),
      errorTrade: false
    };
    t.errorTrade = S.isIbkrErrorTrade(t);
    ok('T7 open qty 10', o && o.openQty === 10, o && o.openQty);
    ok('T7 not Error trade', t.errorTrade === false, t.errorTrade);
  })();

  // ── T8 Unauthorized/synthetic ingest on model key → auto |cursor-err ───────
  (function t8() {
    const day = 'Wed Aug 12 2026';
    const key = 'ORPH.X|short|' + day;
    S.mutateFillLedger('t8_seed', (rows) => {
      rows.push({
        execId: 't8-ghost', key, ticker: 'ORPH.X', hz: 'short', side: 'buy',
        role: 'flatten', qty: 5, price: 50, currency: 'USD', ccyScale: 1,
        time: new Date().toISOString(), errorTrade: true, synthetic: true, recon: 'ghost-flat'
      });
      return rows;
    });
    const rows = S.readIbkrFillRows().filter(r => r.execId === 't8-ghost');
    ok('T8 re-keyed to cursor-err', rows.length === 1 && S.isCursorErrIbkrKey(rows[0].key),
      rows[0] && rows[0].key);
    ok('T8 stamped errorTrade', rows[0] && rows[0].errorTrade === true);
  })();

  // ── T9 Error realised isolated from model totals (bucket closure) ──────────
  (function t9() {
    const liveKey = 'BUCK.X|long|Wed Aug 12 2026';
    const errKey = liveKey + '|cursor-err';
    S.mutateFillLedger('t9_seed', (rows) => {
      rows.push(
        {
          execId: 't9-model-e', key: liveKey, ticker: 'BUCK.X', hz: 'long', side: 'buy',
          role: 'entry', qty: 2, price: 100, currency: 'USD', ccyScale: 1,
          time: new Date().toISOString()
        },
        {
          execId: 't9-err-e', key: errKey, ticker: 'BUCK.X', hz: 'long', side: 'buy',
          role: 'entry', qty: 8, price: 100, currency: 'USD', ccyScale: 1,
          time: new Date().toISOString(), errorTrade: true
        },
        {
          execId: 't9-err-x', key: errKey, ticker: 'BUCK.X', hz: 'long', side: 'buy',
          role: 'flatten', qty: 8, price: 99, currency: 'USD', ccyScale: 1,
          time: new Date().toISOString(), errorTrade: true, synthetic: true, recon: 'ghost-flat'
        }
      );
      return rows;
    });
    const byKey = new Map();
    for (const r of S.readIbkrFillRows()) {
      if (!String(r.key || '').includes('BUCK.X')) continue;
      if (!byKey.has(r.key)) byKey.set(r.key, []);
      byKey.get(r.key).push(r);
    }
    let modelReal = 0, errReal = 0;
    for (const [key, fills] of byKey) {
      const entries = fills.filter(f => f.role === 'entry');
      const exits = fills.filter(f => f.role !== 'entry');
      const entryQty = entries.reduce((s, f) => s + f.qty, 0);
      if (!entryQty) continue;
      const avgEntry = entries.reduce((s, f) => s + f.price * f.qty, 0) / entryQty;
      const realized = exits.reduce((s, f) => s + (f.price - avgEntry) * f.qty, 0);
      const t = { key, ticker: 'BUCK.X', openQty: Math.max(0, entryQty - exits.reduce((s, f) => s + f.qty, 0)), fills, realizedUsd: realized };
      t.errorTrade = S.isIbkrErrorTrade(t);
      if (t.errorTrade) errReal += realized;
      else modelReal += realized;
    }
    ok('T9 model realised 0 (no exits on live)', Math.abs(modelReal) < 1e-9, modelReal);
    ok('T9 error realised negative', errReal < 0, errReal);
  })();

  // ── T10 Alias SU / SU.DE authorized while SU.PA entry open ─────────────────
  (function t10() {
    const day = 'Wed Aug 12 2026';
    const key = 'SU.PA|long|' + day;
    fs.appendFileSync(S.TRADE_EVENTS_FILE, JSON.stringify({
      seq: 910010, t: new Date().toISOString(), type: 'entry',
      key, ticker: 'SU.PA', hz: 'long', side: 'buy', entry: 309, sl: 250, tp1: 370
    }) + '\n');
    ok('T10 SU.PA authorized', S.isPositionAuthorizedByProvenance('SU.PA'));
    ok('T10 bare SU authorized via alias', S.isPositionAuthorizedByProvenance('SU'));
    ok('T10 SU.DE authorized via alias', S.isPositionAuthorizedByProvenance('SU.DE'));
    const aliases = S.ibkrYahooAliases('SU');
    ok('T10 aliases include SU.PA', aliases.has('SU.PA'), [...aliases].join(','));
  })();

  // ── T11 Boot: isNewEntryRiskBlocked null-safe / riskState ready ────────────
  (function t11() {
    ok('T11 riskState ready', S.assertRiskStateReady('t11') === true);
    const blocked = S.isNewEntryRiskBlocked();
    ok('T11 isNewEntryRiskBlocked returns boolean', typeof blocked === 'boolean', blocked);
  })();

  // ── T12 Recon normalize twice → byte-identical after quarantine ────────────
  (function t12() {
    const before = Buffer.from(JSON.stringify(S.readIbkrFillRows()));
    S.quarantineErrorFillsOffModelKeys();
    const mid = Buffer.from(JSON.stringify(S.readIbkrFillRows()));
    S.quarantineErrorFillsOffModelKeys();
    const after = Buffer.from(JSON.stringify(S.readIbkrFillRows()));
    ok('T12 second quarantine idempotent', Buffer.compare(mid, after) === 0,
      'len ' + mid.length + ' vs ' + after.length);
    void before;
  })();

  // ── T13 GET /api/ibkr/trades does not mutate ledger ─────────────────────────
  (async function t13() {
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
      const r = await getTrades();
      const after = fs.existsSync(S.IBKR_FILLS_FILE)
        ? fs.readFileSync(S.IBKR_FILLS_FILE) : Buffer.alloc(0);
      ok('T13 GET ok', r.status === 200, 'status ' + r.status);
      ok('T13 GET read-only ledger', Buffer.compare(before, after) === 0,
        'len ' + before.length + '→' + after.length);
    } catch (e) {
      ok('T13 GET read-only', false, e.message);
    }

    // ── T14 Real bridge fill before entry event → NOT quarantined ────────────
    (function t14() {
      const key = 'RACE.X|short|Wed Aug 12 2026';
      S.mutateFillLedger('t14_seed', (rows) => {
        rows.push({
          execId: 't14-real-early', key, ticker: 'RACE.X', hz: 'short', side: 'buy',
          role: 'entry', qty: 3, price: 40, currency: 'USD', ccyScale: 1,
          time: new Date().toISOString()
          // no synthetic, no errorTrade, no recon — real bridge fill
        });
        return rows;
      });
      const row = S.readIbkrFillRows().find(r => r.execId === 't14-real-early');
      ok('T14 real fill stays on model key', row && row.key === key && !row.errorTrade,
        row && row.key);
    })();

    // ── T15 Same-day re-arm / entry emit quarantines prior cycle fills ───────
    (function t15() {
      const day = 'Wed Aug 12 2026';
      const key = 'REARM.X|long|' + day;
      S.mutateFillLedger('t15_seed', (rows) => {
        rows.push({
          execId: 't15-old-entry', key, ticker: 'REARM.X', hz: 'long', side: 'buy',
          role: 'entry', qty: 5, price: 100, currency: 'USD', ccyScale: 1,
          time: '2026-08-12T08:00:00.000Z'
        });
        return rows;
      });
      // Simulate entry emit hygiene (same as emitTradeEvent path).
      const moved = S.quarantineKeyFillsToCursorErr(key, 'entry-prior-cycle');
      const live = S.readIbkrFillRows().filter(r => r.key === key);
      const err = S.readIbkrFillRows().filter(r => r.execId === 't15-old-entry');
      ok('T15 prior fills moved', moved >= 1 && live.length === 0, 'moved=' + moved);
      ok('T15 on cursor-err', err[0] && S.isCursorErrIbkrKey(err[0].key) && err[0].errorTrade,
        err[0] && err[0].key);
    })();

    // ── T16 Recon pairing shape: synthetic flat key is cursor-err helper ─────
    (function t16() {
      const live = 'PAIR.X|long|Wed Aug 12 2026';
      const errKey = S.toCursorErrIbkrKey(live);
      ok('T16 err key form', errKey === live + '|cursor-err', errKey);
      ok('T16 isCursorErr', S.isCursorErrIbkrKey(errKey));
      // Predicate: real fill must not quarantine; synthetic must.
      const real = S.quarantineFillForLedger({
        execId: 't16-real', key: live, ticker: 'PAIR.X', role: 'entry', qty: 1, price: 1
      });
      const synth = S.quarantineFillForLedger({
        execId: 't16-synth', key: live, ticker: 'PAIR.X', role: 'flatten', qty: 1, price: 1,
        synthetic: true, recon: 'ghost-flat', errorTrade: true
      });
      ok('T16 real stays live', real.key === live, real.key);
      ok('T16 synth → cursor-err', S.isCursorErrIbkrKey(synth.key), synth.key);
    })();

    // ── T17 IB overlay: model lot claims shares before newer |cursor-err| dups ─
    (function t17() {
      const live = {
        key: '0883.HK|medium|Thu Aug 06 2026',
        openQty: 3000, errorTrade: false,
        lastTime: '2026-08-07T05:05:03.538Z'
      };
      const err = {
        key: '0883.HK|medium|Thu Aug 06 2026|cursor-err',
        openQty: 6000, errorTrade: true,
        lastTime: '2026-08-11T06:00:29.910Z'
      };
      ok('T17 err is overlay error lot', S.isIbkrOverlayErrorLot(err));
      ok('T17 live is not overlay error lot', !S.isIbkrOverlayErrorLot(live));
      const ordered = [err, live].sort(S.ibkrOverlayClaimOrder);
      ok('T17 model claims before cursor-err', ordered[0] === live && ordered[1] === err,
        ordered.map(t => t.key).join(' > '));
      // IB abs=6000: model takes fill 3000, Error claims 0, pad leftover → 6000.
      const hasModelLot = ordered.some(t => !S.isIbkrOverlayErrorLot(t));
      let remaining = 6000;
      for (const t of ordered) {
        const fillOpen = Math.max(0, Number(t.openQty) || 0);
        let take = 0;
        if (!(S.isIbkrOverlayErrorLot(t) && hasModelLot)) {
          take = fillOpen > 0 ? Math.min(fillOpen, remaining) : 0;
        }
        remaining -= take;
        t.openQty = take;
        t.status = take > 0 ? 'open' : 'closed';
      }
      if (remaining > 0) {
        const host = S.ibkrOverlayPadHost(ordered);
        host.openQty = (Number(host.openQty) || 0) + remaining;
        host.status = 'open';
        remaining = 0;
      }
      ok('T17 live gets full IB qty', live.openQty === 6000 && live.status === 'open', live.openQty);
      ok('T17 err starved closed', err.openQty === 0 && err.status === 'closed', err.openQty);
      const host = S.ibkrOverlayPadHost([err, live]);
      ok('T17 pad host prefers model', host === live, host && host.key);
    })();

    // ── T18 Abandon must not kill live Buy whose fills sit on |cursor-err ─────
    (function t18() {
      const liveKey = 'KHC|short|Thu Aug 06 2026';
      const errKey = liveKey + '|cursor-err';
      const keys = S.ibkrAbandonFillKeySet([{
        key: errKey, role: 'entry', qty: 400, ticker: 'KHC'
      }]);
      ok('T18 cursor-err fill covers live key', keys.has(liveKey) && keys.has(errKey),
        [...keys].join(','));
      ok('T18 stillLive no-fill not abandoned',
        S.shouldAbandonUnfilledEntry({ force: false, stillLive: true, hasFill: false }) === false);
      ok('T18 stillLive with fill not abandoned',
        S.shouldAbandonUnfilledEntry({ force: false, stillLive: true, hasFill: true }) === false);
      ok('T18 Hold no-fill is abandoned',
        S.shouldAbandonUnfilledEntry({ force: false, stillLive: false, hasFill: false }) === true);
      ok('T18 FORCE abandons even if live',
        S.shouldAbandonUnfilledEntry({ force: true, stillLive: true, hasFill: false }) === true);
    })();

    // ── T19 Excess model entries vs IB → orphan to cursor-err (SU.PA 28+27) ───
    (function t19() {
      const liveKey = 'SU.PA|long|Wed Aug 12 2026';
      S.mutateFillLedger('t19_seed', (rows) => {
        rows.push(
          {
            execId: 't19-orphan-28', key: liveKey, ticker: 'SU.PA', hz: 'long', side: 'buy',
            role: 'entry', qty: 28, price: 309.9, currency: 'EUR', ccyScale: 1,
            time: '2026-08-12T08:53:25.407Z'
          },
          {
            execId: 't19-live-27', key: liveKey, ticker: 'SU.PA', hz: 'long', side: 'buy',
            role: 'entry', qty: 27, price: 309.9, currency: 'EUR', ccyScale: 1,
            time: '2026-08-12T11:18:33.971Z'
          }
        );
        return rows;
      });
      fs.writeFileSync(path.join(process.env.DATA_DIR, 'ibkr_recon.json'), JSON.stringify({
        at: new Date().toISOString(),
        positions: [{ ticker: 'SU.PA', qty: 27, avgCost: 309.9, currency: 'EUR' }]
      }));
      const moved = S.quarantineExcessModelEntriesVsIb();
      const live = S.readIbkrFillRows().filter(r => r.key === liveKey && r.role === 'entry');
      const err = S.readIbkrFillRows().filter(r => String(r.key || '').startsWith(liveKey + '|cursor-err'));
      const liveQty = live.reduce((s, r) => s + Number(r.qty || 0), 0);
      ok('T19 moved excess orphan', moved >= 1, 'moved=' + moved);
      ok('T19 live entry qty 27', liveQty === 27 && live.length === 1, 'qty=' + liveQty + ' n=' + live.length);
      ok('T19 orphan on cursor-err', err.some(r => Number(r.qty) === 28 && r.errorTrade),
        'errN=' + err.length);
    })();

    // ── T20 IB qty-pad stays on the model key (not auto-quarantined) ──────────
    (function t20() {
      const live = '0883.HK|medium|Thu Aug 06 2026';
      const pad = S.quarantineFillForLedger({
        execId: 'recon-entry-' + live + '-pad3000',
        key: live, ticker: '0883.HK', hz: 'medium', side: 'buy',
        role: 'entry', qty: 3000, price: 23.19, currency: 'HKD', ccyScale: 1,
        synthetic: true, recon: 'qty-pad', errorTrade: false
      });
      ok('T20 qty-pad stays live', pad.key === live && !pad.errorTrade, pad.key);
      ok('T20 isModelIbSyncFill', S.isModelIbSyncFill(pad));
      const recover = S.quarantineFillForLedger({
        execId: 'recover-entry-' + live + '-q3000',
        key: live, ticker: '0883.HK', role: 'entry', qty: 3000, price: 23.19,
        synthetic: true, recon: 'recover-entry'
      });
      ok('T20 recover-entry still quarantined', S.isCursorErrIbkrKey(recover.key) && recover.errorTrade,
        recover.key);
    })();

    // ── T21 Authorized IB lot with no live fills → qty-pad (AFL / KHC) ────────
    (function t21() {
      const liveKey = 'AFL|short|Wed Aug 12 2026';
      fs.appendFileSync(S.TRADE_EVENTS_FILE, JSON.stringify({
        seq: 920001, t: '2026-08-12T11:07:56.530Z', type: 'entry',
        key: liveKey, ticker: 'AFL', hz: 'short', side: 'buy',
        entry: 121.07, sl: 115, tp1: 128, status: 'open'
      }) + '\n');
      const moved = S.restoreOpenModelFillsFromCursorErr([
        { ticker: 'AFL', qty: 82, avgCost: 121.10, currency: 'USD' }
      ]);
      const live = S.readIbkrFillRows().filter(r => r.key === liveKey && r.role === 'entry');
      const qty = live.reduce((s, r) => s + Number(r.qty || 0), 0);
      ok('T21 AFL pad moved', moved >= 1, 'moved=' + moved);
      ok('T21 AFL live qty 82', qty === 82 && live.some(r => r.recon === 'qty-pad' && !r.errorTrade),
        'qty=' + qty + ' n=' + live.length);
    })();

    // ── T22 Corrective flatten must finish before board re-entry ─────────────
    (function t22() {
      const key = 'CORR.X|short|Wed Aug 19 2026';
      const base = {
        key, ticker: 'CORR.X', hz: 'short', side: 'buy',
        entry: 100, sl: 90, tp1: 112, status: 'open'
      };
      S.emitTradeEvent('entry', base);
      S.emitTradeEvent('exit', {
        key, ticker: 'CORR.X', hz: 'short', side: 'buy',
        errorTrade: true, correctiveReentry: true
      });
      const blocked = S.emitTradeEvent('entry', base);
      ok('T22 corrective cycle pending', S.isCorrectiveCyclePending(key));
      ok('T22 ordinary board re-entry blocked', blocked === null);
      const rearmed = S.emitTradeEvent('entry', { ...base, reason: 'rearm-model-entry' });
      ok('T22 confirmed re-entry allowed', !!rearmed && !S.isCorrectiveCyclePending(key));
    })();

    if (failed) {
      console.error('\n' + failed + ' invariant(s) failed. DATA_DIR=' + tmp);
      process.exit(1);
    }
    console.log('\nAll T1–T22 invariants passed. DATA_DIR=' + tmp);
    process.exit(0);
  })();
})();
