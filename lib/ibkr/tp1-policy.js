'use strict';

/**
 * Live TP1 policy: every equity lot of 2+ board lots parks a 50% limit;
 * the other 50% stays as the runner and only then accepts daily TSL ratchets.
 * 1-lot names (and 1-contract futures) cannot split — sell the whole lot at
 * TP1 (OCA with the stop). Sizing still bumps equities to 2 lots when the
 * notional cap allows so they can take the 50% path.
 */

const TP1_PCT = Object.freeze({ short: 0.035, medium: 0.07, long: 0.12 });

/** Operator overrides: bank half at the next open if the auction/print is above minPx. */
const OPEN_IF_ABOVE = Object.freeze({
  // SEHK rejects LMT+OPG (error 201). A GTC sell limit at 25 fills at the
  // Tuesday open if the print is ≥ 25, otherwise rests until it is.
  '0883.HK': Object.freeze({ qty: 3000, minPx: 25, tif: 'GTC' })
});

function normalizeYahoo(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function tp1SoldQty(total, lot) {
  const step = Math.max(Number(lot) || 1, 1e-8);
  const qty = Math.max(0, Number(total) || 0);
  const sold = Math.floor(qty / 2 / step + 1e-12) * step;
  return sold >= step ? sold : 0;
}

/** Qty for the live TP1 LMT: 50% when splittable, else 100% (no runner). */
function tp1OrderQty(total, lot) {
  const half = tp1SoldQty(total, lot);
  const step = Math.max(Number(lot) || 1, 1e-8);
  const qty = Math.max(0, Number(total) || 0);
  if (half >= step) return half;
  return qty >= step ? qty : 0;
}

function isFullQtyTp1(total, lot) {
  const q = tp1OrderQty(total, lot);
  return q > 0 && Math.abs(q - Number(total)) < 1e-9;
}

function synthesizeTp1Px(entry, hz, isSell) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const pct = TP1_PCT[hz] || TP1_PCT.short;
  return isSell ? e * (1 - pct) : e * (1 + pct);
}

function openIfAboveSpec(ticker) {
  return OPEN_IF_ABOVE[normalizeYahoo(ticker)] || null;
}

/**
 * IB HK/JP paper rejects a marketable long SELL as a short (error 201).
 * If last is already through TP1, park at last so the order rests on the offer
 * and still prints at/through TP1.
 */
function passiveCloseLimit(tp1Px, lastPx, isSellPosition) {
  const lim = Number(tp1Px);
  const last = Number(lastPx);
  if (!(lim > 0)) return 0;
  if (!(last > 0)) return lim;
  if (!isSellPosition && last + 1e-12 >= lim) return last;
  if (isSellPosition && last - 1e-12 <= lim) return last;
  return lim;
}

function fillHonorsTp1Limit(fillPx, tp1Px, isSellPosition) {
  const px = Number(fillPx);
  const lim = Number(tp1Px);
  if (!(px > 0) || !(lim > 0)) return false;
  const slack = Math.max(Math.abs(lim) * 0.002, 1e-8);
  // Long TP1 = sell limit (fill at limit or better / higher).
  // Short TP1 = buy limit (fill at limit or better / lower).
  return isSellPosition ? px <= lim + slack : px >= lim - slack;
}

function isMarketLikeExit(orderType) {
  const t = String(orderType || '').toUpperCase().replace(/[_-]/g, ' ').trim();
  return t === 'MKT' || t === 'MOO' || t === 'MOC' || t === 'MIT'
    || t === 'STP' || t === 'STP LMT' || t === 'TRAIL' || t === 'TRAIL LIMIT';
}

/** True only for a resting TP1 limit that actually printed at/through TP1. */
function isLimitTp1Fill(input) {
  if (!input || input.isFlattenOrder) return false;
  if (isMarketLikeExit(input.orderType)) return false;
  return fillHonorsTp1Limit(input.fillPx, input.tp1Px, input.isSellPosition);
}

/**
 * If half-lot TP1 is impossible at the sized qty, take 2 board lots when that
 * still fits max position notional. Equities only.
 */
function maybeTwoLotTotal(input) {
  const lot = Math.max(Number(input && input.lot) || 1, 1e-8);
  const total = Math.max(0, Number(input && input.total) || 0);
  const secType = String((input && input.secType) || 'STK').toUpperCase();
  if (secType !== 'STK') return total;
  if (!(total >= lot) || tp1SoldQty(total, lot) >= lot) return total;
  const two = lot * 2;
  const entry = Number(input && input.entry) || 0;
  const nlv = Number(input && input.nlv) || 0;
  const fxToUsd = Number(input && input.fxToUsd) > 0 ? Number(input.fxToUsd) : 1;
  const multiplier = Math.max(1, Number(input && input.multiplier) || 1);
  const maxPositionPct = Number(input && input.maxPositionPct) > 0
    ? Number(input.maxPositionPct) : 0.025;
  const notional = two * entry * multiplier * fxToUsd;
  const cap = nlv * maxPositionPct;
  if (!(nlv > 0) || !(entry > 0) || !(notional > 0) || notional > cap + 1e-6) return total;
  return two;
}

module.exports = {
  TP1_PCT,
  OPEN_IF_ABOVE,
  tp1SoldQty,
  tp1OrderQty,
  isFullQtyTp1,
  synthesizeTp1Px,
  openIfAboveSpec,
  passiveCloseLimit,
  fillHonorsTp1Limit,
  isMarketLikeExit,
  isLimitTp1Fill,
  maybeTwoLotTotal
};
