'use strict';

/**
 * UK SDRT (stamp duty reserve tax) on CREST purchases of UK shares: 0.5% of
 * consideration. Sells are not stamped. IB averageCost includes this, which
 * made SHEL.L look like it filled at 3542p / £35.42 vs a 3523p tape print.
 *
 * Keep the tape as the fill. Book stamp as its own expense and take it in PnL.
 */
const UK_STAMP_PCT = 0.005;
/** Stamp + small IB fee typically lands 0.2%–1.2% above the tape. */
const STAMP_AVG_BPS_MIN = 0.002;
const STAMP_AVG_BPS_MAX = 0.012;

function isUkStampDutyFill(fill) {
  if (!fill) return false;
  const side = String(fill.side || '').toLowerCase();
  const role = String(fill.role || '').toLowerCase();
  if (side !== 'buy' || (role && role !== 'entry')) return false;
  const ticker = String(fill.ticker || '').toUpperCase();
  const ccy = String(fill.currency || fill.commissionCcy || '').toUpperCase();
  const scale = Number(fill.ccyScale) || 1;
  if (ticker.endsWith('.L') || ccy === 'GBP') {
    if (scale === 100 || ticker.endsWith('.L')) return true;
  }
  return false;
}

/** Stamp in local currency (GBP for LSE pence names). */
function stampDutyLocal(fill) {
  if (!isUkStampDutyFill(fill)) return 0;
  const qty = Math.abs(Number(fill.qty) || 0);
  const px = Number(fill.price) || 0;
  const scale = Number(fill.ccyScale) > 0 ? Number(fill.ccyScale) : 100;
  if (!(qty > 0) || !(px > 0)) return 0;
  const consideration = qty * px / scale;
  return +(consideration * UK_STAMP_PCT).toFixed(6);
}

function stampInflatedAvg(tapePx, ibAvgPx) {
  const tape = Number(tapePx);
  const avg = Number(ibAvgPx);
  if (!(tape > 0) || !(avg > 0) || avg <= tape) return false;
  const bps = (avg - tape) / tape;
  return bps >= STAMP_AVG_BPS_MIN && bps <= STAMP_AVG_BPS_MAX;
}

function shouldSkipStampInflatedAvgCorrect(tapePx, ibAvgPx, ccyScale) {
  if (Number(ccyScale) !== 100) return false;
  return stampInflatedAvg(tapePx, ibAvgPx);
}

function isStampInflatedCorrectedFill(row) {
  if (!row || row.role !== 'entry') return false;
  if (String(row.recon || '') !== 'avg-correct') return false;
  const from = Number(row.priceCorrectedFrom);
  const to = Number(row.price);
  const scale = Number(row.ccyScale) || 1;
  if (scale !== 100) return false;
  return stampInflatedAvg(from, to);
}

module.exports = {
  UK_STAMP_PCT,
  isUkStampDutyFill,
  stampDutyLocal,
  stampInflatedAvg,
  shouldSkipStampInflatedAvgCorrect,
  isStampInflatedCorrectedFill
};
