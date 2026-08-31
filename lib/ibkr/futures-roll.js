'use strict';

const { rebaseExitsFromFill } = require('./fill-rebase');
const { futuresExpired, futuresStillTradable } = require('./commodity-futures');

/**
 * Roll on last-trade day or after (do not wait for cash-settlement booking).
 * Last-trade YYYYMMDD ≤ today UTC.
 */
function futuresDueForRoll(contract, now = new Date()) {
  if (!contract || String(contract.secType || '').toUpperCase() !== 'FUT') return false;
  const digits = String(contract.lastTradeDateOrContractMonth || '').replace(/\D/g, '');
  if (digits.length >= 8) {
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return digits.slice(0, 8) <= String(y) + mo + d;
  }
  return futuresExpired(contract, now);
}

/**
 * Scale TP1 / TP2 / SL off the new contract's fill using the original model
 * percentages (same math as fill-rebase).
 */
function planFuturesRoll(row, newPx) {
  const modelEntry = Number(row && (row.modelEntry || row.entry));
  const modelTp1 = Number(row && (row.modelTp1 || row.tp1Px));
  const modelSl = Number(row && (row.modelSl || row.originalSl || row.stopPx));
  const modelTp2 = Number(row && (row.modelTp2 || row.tp2Px));
  const fillPx = Number(newPx);
  const rec = rebaseExitsFromFill({ modelEntry, fillPx, modelTp1, modelSl });
  if (!rec) return null;
  return {
    scale: rec.scale,
    modelEntry,
    newEntry: fillPx,
    tp1: rec.tp1,
    sl: rec.sl,
    tp2: modelTp2 > 0 ? modelTp2 * rec.scale : 0
  };
}

function futuresStillTradableExcluding(month, now, excludeConId, excludeMonth, candConId) {
  if (!futuresStillTradable(month, now)) return false;
  if (Number(excludeConId) > 0 && Number(candConId) === Number(excludeConId)) return false;
  const have = String(month || '').replace(/\D/g, '').slice(0, 8);
  const skip = String(excludeMonth || '').replace(/\D/g, '').slice(0, 8);
  if (skip && have && have === skip) return false;
  return true;
}

function isFuturesRollFill(r) {
  if (!r) return false;
  if (String(r.recon || '') === 'futures-roll') return true;
  return String(r.execId || '').startsWith('roll-settle-');
}

function liveIbkrKey(key) {
  return String(key || '').replace(/\|cursor-err$/i, '');
}

/**
 * Keep October close + November re-entry on the model key so Realised shows
 * the expired-month PnL. Recon used to dump synthetic settle fills onto
 * |cursor-err (Error trades), which hid the profit from model PnL.
 */
function rebuildFuturesRollFills(rows, opts) {
  opts = opts || {};
  const officialPx = typeof opts.officialSettlePx === 'function' ? opts.officialSettlePx : null;
  const out = [];
  let changed = 0;
  const liveKeys = new Set();
  for (const r of rows || []) {
    if (isFuturesRollFill(r)) liveKeys.add(liveIbkrKey(r.key));
  }
  const byLive = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const lk = liveIbkrKey(r.key);
    if (!liveKeys.has(lk)) {
      out.push(r);
      continue;
    }
    if (!byLive.has(lk)) byLive.set(lk, []);
    byLive.get(lk).push(r);
  }
  for (const [liveKey, group] of byLive) {
    const rollIn = group
      .filter(r => r.role === 'entry' && isFuturesRollFill(r)
        && !String(r.execId || '').startsWith('roll-settle-'))
      .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
      .slice(-1)[0];
    const rollFlat = group
      .filter(r => r.role !== 'entry' && isFuturesRollFill(r))
      .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))[0];
    if (!rollIn || !rollFlat) {
      out.push(...group);
      continue;
    }
    const ticker = rollIn.ticker || rollFlat.ticker || String(liveKey).split('|')[0];
    const official = officialPx ? Number(officialPx(ticker)) : 0;
    const settlePx = official > 0 ? official : Number(rollFlat.price);
    const openers = group
      .filter(r => r.role === 'entry' && String(r.execId) !== String(rollIn.execId))
      .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const pad = openers.find(r => String(r.recon || '') === 'qty-pad'
      || String(r.execId || '').startsWith('recon-entry-'));
    const genuine = openers.find(r => {
      const e = String(r.execId || '');
      return /^[0-9a-f]{8}\./i.test(e);
    });
    let opener = genuine || pad || openers[0] || null;
    if (opener && pad && Number(rollIn.price) > 0) {
      const op = Number(opener.price);
      const pp = Number(pad.price);
      const np = Number(rollIn.price);
      if (pp > 0 && Math.abs(op - np) / np < 0.02 && Math.abs(pp - np) / np > 0.02) {
        opener = Object.assign({}, opener, { price: pp });
      }
    }
    const keep = [];
    if (opener) {
      const o = Object.assign({}, opener, { key: liveKey, errorTrade: false });
      if (String(o.recon) === 'avg-correct') delete o.recon;
      keep.push(o);
    }
    keep.push(Object.assign({}, rollFlat, {
      key: liveKey,
      errorTrade: false,
      role: 'flatten',
      price: settlePx,
      recon: 'futures-roll'
    }));
    keep.push(Object.assign({}, rollIn, {
      key: liveKey,
      errorTrade: false,
      recon: 'futures-roll'
    }));
    const sig = (list) => list.map(r => [r.execId, r.key, r.role, r.price, !!r.errorTrade].join('|')).sort().join(';');
    if (sig(group) !== sig(keep)) changed += 1;
    out.push(...keep);
  }
  return { rows: out, changed };
}

module.exports = {
  futuresDueForRoll,
  planFuturesRoll,
  futuresStillTradableExcluding,
  isFuturesRollFill,
  liveIbkrKey,
  rebuildFuturesRollFills
};
