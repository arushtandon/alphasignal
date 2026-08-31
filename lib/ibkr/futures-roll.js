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

module.exports = {
  futuresDueForRoll,
  planFuturesRoll,
  futuresStillTradableExcluding
};
