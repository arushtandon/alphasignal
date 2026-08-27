'use strict';

/**
 * IB Gateway `averageCost` is not always the same unit as AlphaSignal fills.
 * LSE: pounds vs pence. Futures: unitPrice × multiplier (notional per 1 contract).
 * Brent example: fill 87.44, multiplier 1000 → IB averageCost 87442.
 */

const FUTURES_MULTIPLIER = {
  'GC=F': 100,
  'SI=F': 5000,
  'HG=F': 25000,
  'PL=F': 50,
  'PA=F': 100,
  'CL=F': 1000,
  'BZ=F': 1000,
  'NG=F': 10000,
  'ES=F': 50,
  'NQ=F': 20,
  'YM=F': 5,
  'RTY=F': 50,
  'ZN=F': 1000
};

/** Plausible unit-price bands so we can tell notional 87442 from already-unit 87.44. */
const FUTURES_UNIT_RANGE = {
  'GC=F': [800, 5000],
  'SI=F': [5, 100],
  'HG=F': [1, 15],
  'PL=F': [400, 3000],
  'PA=F': [400, 4000],
  'CL=F': [20, 200],
  'BZ=F': [20, 200],
  'NG=F': [0.5, 50],
  'ES=F': [2000, 12000],
  'NQ=F': [5000, 40000],
  'YM=F': [15000, 80000],
  'RTY=F': [800, 5000],
  'ZN=F': [80, 150]
};

function futuresMultiplierFor(ticker, explicit) {
  const n = Number(explicit);
  if (n > 1) return n;
  const t = String(ticker || '').toUpperCase();
  if (FUTURES_MULTIPLIER[t]) return FUTURES_MULTIPLIER[t];
  return 1;
}

function inRange(x, range) {
  return Array.isArray(range) && range.length >= 2
    && Number.isFinite(x) && x >= range[0] && x <= range[1];
}

/**
 * Convert IB averageCost (or a poisoned fill price) into AlphaSignal fill units.
 * opts.ticker / opts.multiplier identify futures notional.
 */
function ibkrAvgToFillUnit(avgCost, ccyScale, sampleEntryPx, opts) {
  let avg = Number(avgCost);
  if (!(avg > 0)) return null;
  opts = opts || {};
  const sample = Number(sampleEntryPx);
  const ticker = String(opts.ticker || '').toUpperCase();
  const mult = futuresMultiplierFor(ticker, opts.multiplier);
  if (mult > 1) {
    const unit = avg / mult;
    const range = FUTURES_UNIT_RANGE[ticker];
    if (range) {
      const rawOk = inRange(avg, range);
      const unitOk = inRange(unit, range);
      if (unitOk && !rawOk) avg = unit;
      else if (unitOk && rawOk && sample > 0 && Math.abs(unit - sample) < Math.abs(avg - sample)) {
        avg = unit;
      }
    } else if (sample > 0) {
      if (Math.abs(unit - sample) <= Math.abs(avg - sample)) avg = unit;
    } else if (unit > 0) {
      avg = unit;
    }
  }
  // LSE: IB often reports pounds while fills are pence (ccyScale=100).
  if ((Number(ccyScale) || 1) === 100 && sample > 50 && avg * 10 < sample) avg *= 100;
  return avg;
}

module.exports = {
  ibkrAvgToFillUnit,
  futuresMultiplierFor,
  FUTURES_MULTIPLIER
};
