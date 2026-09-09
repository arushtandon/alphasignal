'use strict';

/**
 * IBKR Pro commissions (same schedule the paper account uses).
 * Used when a fill is IB-matched but commissionReport never arrived
 * (qty-pad / recover-entry). Real commissionReport always wins.
 */

function round6(n) {
  return +Number(n).toFixed(6);
}

function notional(qty, price, ccyScale) {
  const scale = Number(ccyScale) > 0 ? Number(ccyScale) : 1;
  return Math.abs(Number(qty) * Number(price) / scale);
}

function fillNeedsEstimatedCommission(r) {
  if (!r) return false;
  if (Number(r.commission) > 0) return false;
  const exec = String(r.execId || '');
  const recon = String(r.recon || '');
  if (r.synthetic === true) return true;
  if (recon === 'qty-pad' || recon === 'recover-entry') return true;
  return /^(recon-entry-|recover-entry-|recon-trim-)/.test(exec);
}

function estimateIbkrCommission(input) {
  const qty = Math.abs(Number(input && input.qty) || 0);
  const price = Number(input && input.price) || 0;
  const ccy = String((input && (input.currency || input.commissionCcy)) || 'USD').toUpperCase();
  const ticker = String((input && input.ticker) || '').toUpperCase();
  const scale = Number(input && input.ccyScale) || 1;
  if (!(qty > 0) || !(price > 0)) return null;
  const n = notional(qty, price, scale);
  let commission = 0;
  if (ccy === 'USD' && !/\.(HK|L|T|PA|DE|AS|SW|MI)$/.test(ticker)) {
    // IBKR Pro tiered US: $0.0035/sh, min $0.35, plus ~$0.0002/sh clearing.
    commission = Math.max(0.35, 0.0035 * qty) + 0.0002 * qty;
  } else if (ccy === 'HKD' || ticker.endsWith('.HK')) {
    // HK stamp 0.1% is booked as tax in stamp-duty.js — do not mix it into IB commission.
    const ib = Math.max(18, 0.0008 * n);
    const levies = 0.0001365 * n;
    commission = ib + levies;
  } else if (ccy === 'EUR' || /\.(PA|DE|AS|MI)$/.test(ticker)) {
    commission = Math.max(1.25, 0.0005 * n);
  } else if (ccy === 'GBP' || ticker.endsWith('.L')) {
    commission = Math.max(3, 0.0005 * n);
  } else if (ccy === 'JPY' || ticker.endsWith('.T')) {
    commission = Math.max(80, 0.0005 * n);
  } else if (ccy === 'CHF' || ticker.endsWith('.SW')) {
    commission = Math.max(1.25, 0.0005 * n);
  } else {
    commission = Math.max(0.35, 0.0005 * n);
  }
  return {
    commission: round6(commission),
    commissionCcy: ccy,
    estimated: true,
    commissionSrc: 'ibkr-pro-schedule'
  };
}

/** Qty-pad / recover-entry prices are IB averageCost (commission already in). */
function rebasePadPriceExCommission(row, commission) {
  const qty = Math.abs(Number(row && row.qty) || 0);
  const px = Number(row && row.price) || 0;
  const comm = Number(commission);
  if (!(qty > 0) || !(px > 0) || !(comm > 0)) return row;
  const scale = Number(row.ccyScale) > 0 ? Number(row.ccyScale) : 1;
  const next = round6(px - (comm * scale / qty));
  if (!(next > 0) || next >= px) return row;
  row.price = next;
  return row;
}

function applyEstimatedCommission(fill) {
  if (!fillNeedsEstimatedCommission(fill)) return fill;
  const est = estimateIbkrCommission(fill);
  if (!est) return fill;
  const next = Object.assign({}, fill, {
    commission: est.commission,
    commissionCcy: est.commissionCcy,
    commissionSrc: est.commissionSrc
  });
  rebasePadPriceExCommission(next, est.commission);
  return next;
}

/** Drop HK stamp that older estimates baked into commission. */
function stripEstimatedHkStamp(fill) {
  if (!fill || String(fill.commissionSrc || '') !== 'ibkr-pro-schedule') return fill;
  const ticker = String(fill.ticker || '').toUpperCase();
  const ccy = String(fill.currency || fill.commissionCcy || '').toUpperCase();
  if (!ticker.endsWith('.HK') && ccy !== 'HKD') return fill;
  const est = estimateIbkrCommission(fill);
  if (!est) return fill;
  const cur = Number(fill.commission);
  if (!(cur > 0) || cur <= est.commission + 0.01) return fill;
  return Object.assign({}, fill, { commission: est.commission, commissionCcy: est.commissionCcy });
}

module.exports = {
  estimateIbkrCommission,
  applyEstimatedCommission,
  fillNeedsEstimatedCommission,
  rebasePadPriceExCommission,
  stripEstimatedHkStamp
};
