'use strict';

/**
 * MA200 is a buy only on:
 *   1) a confirmed break above, held and not already extended, or
 *   2) a bounce expected from the MA200 level.
 * Being already well above MA200 is not an entry reason.
 */

function smaAt(closes, i, n) {
  if (!Array.isArray(closes) || i + 1 < n || n <= 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = +closes[k];
    if (!Number.isFinite(v)) return null;
    s += v;
  }
  return s / n;
}

function ma200StretchPct(price, ma200) {
  if (!(Number(price) > 0) || !(Number(ma200) > 0)) return null;
  return (Number(price) - Number(ma200)) / Number(ma200);
}

function ma200CrossStats(closes, period) {
  const nPeriod = period > 0 ? period : 200;
  const out = {
    barsSinceCrossUp: null,
    consecutiveAbove: 0,
    ma200SlopeUp: null,
    stretchPct: null,
    ma200: null
  };
  if (!Array.isArray(closes) || closes.length < nPeriod + 5) return out;
  const i = closes.length - 1;
  const maNow = smaAt(closes, i, nPeriod);
  const maPrev = smaAt(closes, i - 10, nPeriod);
  out.ma200 = maNow;
  out.ma200SlopeUp = maNow != null && maPrev != null ? maNow >= maPrev : null;
  out.stretchPct = ma200StretchPct(closes[i], maNow);
  if (!(maNow > 0) || !(closes[i] > maNow)) return out;
  let consec = 0;
  for (let k = i; k >= nPeriod - 1; k--) {
    const m = smaAt(closes, k, nPeriod);
    if (m != null && closes[k] > m) consec++;
    else break;
  }
  out.consecutiveAbove = consec;
  for (let k = i - consec; k >= nPeriod - 1; k--) {
    const m = smaAt(closes, k, nPeriod);
    if (m != null && closes[k] <= m) {
      out.barsSinceCrossUp = i - k;
      return out;
    }
  }
  out.barsSinceCrossUp = consec;
  return out;
}

function ma200BreakConfirmed(input) {
  const price = Number(input && input.price);
  const ma200 = Number(input && input.ma200);
  const stretch = ma200StretchPct(price, ma200);
  const barsSince = input && input.barsSinceCrossUp;
  const consec = Number(input && input.consecutiveAbove) || 0;
  const slopeUp = input && input.ma200SlopeUp;
  if (!(price > 0) || !(ma200 > 0) || price <= ma200) return false;
  if (stretch != null && stretch > 0.08) return false;
  if (barsSince == null || barsSince < 2 || barsSince > 18) return false;
  if (consec < 2) return false;
  if (slopeUp === false) return false;
  return true;
}

/** Bounce expected from MA200: tagging/sitting on the line, not already extended. */
function ma200BounceSetup(input) {
  const price = Number(input && input.price);
  const ma200 = Number(input && input.ma200);
  if (!(price > 0) || !(ma200 > 0)) return false;
  const dist = (price - ma200) / ma200;
  if (dist < -0.015 || dist > 0.02) return false;
  const low = Number(input && input.low);
  const tagged = Number.isFinite(low) && low <= ma200 * 1.01 && low >= ma200 * 0.97;
  const sitting = Math.abs(dist) <= 0.015;
  if (!tagged && !sitting) return false;
  const prevClose = Number(input && input.prevClose);
  const bounceTape = !!(input && input.rsiRising)
    || !!(input && input.macdTurnUp)
    || (Number(input && input.consecutiveHigherCloses) >= 1)
    || (prevClose > 0 && price > prevClose);
  return bounceTape;
}

function attachMa200Entry(tech, daily) {
  const t = tech && typeof tech === 'object' ? tech : {};
  const closes = Array.isArray(daily)
    ? daily.map((b) => Number(b && b.c)).filter((n) => n > 0)
    : [];
  const last = Array.isArray(daily) && daily.length ? daily[daily.length - 1] : null;
  const prev = Array.isArray(daily) && daily.length > 1 ? daily[daily.length - 2] : null;
  const stats = ma200CrossStats(closes, 200);
  const price = Number(t.currentPrice);
  const ma200 = Number(t.ma200) > 0 ? Number(t.ma200) : stats.ma200;
  const stretch = ma200StretchPct(price, ma200);
  const brk = ma200BreakConfirmed({
    price,
    ma200,
    barsSinceCrossUp: stats.barsSinceCrossUp,
    consecutiveAbove: stats.consecutiveAbove,
    ma200SlopeUp: stats.ma200SlopeUp
  });
  const bounce = ma200BounceSetup({
    price,
    ma200,
    low: last && last.l,
    prevClose: prev && prev.c,
    rsiRising: t.rsiRising,
    macdTurnUp: t.macdTurningUp,
    consecutiveHigherCloses: t.consecutiveHigherCloses
  });
  t.ma200StretchPct = stretch;
  t.ma200BarsSinceCrossUp = stats.barsSinceCrossUp;
  t.ma200ConsecutiveAbove = stats.consecutiveAbove;
  t.ma200SlopeUp = stats.ma200SlopeUp;
  t.ma200BreakConfirmed = brk;
  t.ma200BounceSetup = bounce;
  t.ma200BuySetup = brk || bounce;
  t.extendedAboveMa200 = stretch != null && stretch > 0.08;
  return t;
}

module.exports = {
  smaAt,
  ma200StretchPct,
  ma200CrossStats,
  ma200BreakConfirmed,
  ma200BounceSetup,
  attachMa200Entry
};
