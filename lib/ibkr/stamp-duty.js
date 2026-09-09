'use strict';

/**
 * Market taxes booked beside IB commission — never baked into the tape print.
 *
 *   UK  .L     SDRT 0.5% on buys (CREST). IB averageCost includes this, which
 *              made SHEL.L look like 3542p vs a 3523p tape print.
 *   HK  .HK    Stamp 0.1% on buys AND sells (Nov 2023+).
 *   FR  .PA    FTT 0.4% on buys (CAC large-caps, rate from Apr 2025).
 *   IT  .MI    FTT 0.2% on buys (regulated markets, Jan 2026+).
 *   ES  .MC    FTT 0.2% on buys (IBEX large-caps, if we ever fill one).
 *   IN  .NS    STT 0.1% on buys AND sells (delivery).
 *
 * US / JP / DE / NL: no material stamp on these books. US SEC §31 on sells is
 * tiny and already sits inside IB commissionReport.
 */

const UK_STAMP_PCT = 0.005;
/** Stamp + small IB fee typically lands 0.2%–1.2% above the LSE tape. */
const STAMP_AVG_BPS_MIN = 0.002;
const STAMP_AVG_BPS_MAX = 0.012;

const EXIT_ROLES = new Set(['tp1', 'tp2', 'stop', 'flatten', 'tsl']);

const TAX_RULES = Object.freeze([
  {
    id: 'uk-sdrt',
    label: 'UK SDRT 0.5%',
    feeType: 'UK SDRT 0.5% on purchase',
    suffix: '.L',
    sides: ['buy'],
    pct: UK_STAMP_PCT,
    currency: 'GBP',
    defaultScale: 100
  },
  {
    id: 'hk-stamp',
    label: 'HK stamp 0.1%',
    feeType: 'HK stamp duty 0.1%',
    suffix: '.HK',
    sides: ['buy', 'sell'],
    pct: 0.001,
    currency: 'HKD',
    defaultScale: 1
  },
  {
    id: 'fr-ftt',
    label: 'France FTT 0.4%',
    feeType: 'France FTT 0.4% on purchase',
    suffix: '.PA',
    sides: ['buy'],
    pct: 0.004,
    currency: 'EUR',
    defaultScale: 1
  },
  {
    id: 'it-ftt',
    label: 'Italy FTT 0.2%',
    feeType: 'Italy FTT 0.2% on purchase',
    suffix: '.MI',
    sides: ['buy'],
    pct: 0.002,
    currency: 'EUR',
    defaultScale: 1
  },
  {
    id: 'es-ftt',
    label: 'Spain FTT 0.2%',
    feeType: 'Spain FTT 0.2% on purchase',
    suffix: '.MC',
    sides: ['buy'],
    pct: 0.002,
    currency: 'EUR',
    defaultScale: 1
  },
  {
    id: 'in-stt',
    label: 'India STT 0.1%',
    feeType: 'India STT 0.1% (delivery)',
    suffixes: ['.NS', '.BO'],
    sides: ['buy', 'sell'],
    pct: 0.001,
    currency: 'INR',
    defaultScale: 1
  }
]);

function tickerOf(fill) {
  return String((fill && fill.ticker) || '').toUpperCase();
}

function sideOf(fill) {
  return String((fill && fill.side) || '').toLowerCase();
}

function roleOf(fill) {
  return String((fill && fill.role) || '').toLowerCase();
}

function ruleMatchesTicker(rule, ticker) {
  if (rule.suffix && ticker.endsWith(rule.suffix)) return true;
  if (rule.suffixes && rule.suffixes.some((s) => ticker.endsWith(s))) return true;
  return false;
}

function taxRuleForFill(fill) {
  if (!fill) return null;
  if (Number(fill.multiplier) > 1) return null;
  const ticker = tickerOf(fill);
  if (!ticker || ticker.indexOf('.') < 0) return null;
  const side = sideOf(fill);
  const role = roleOf(fill);
  for (const rule of TAX_RULES) {
    if (!ruleMatchesTicker(rule, ticker)) continue;
    if (side && rule.sides.indexOf(side) < 0) continue;
    if (rule.sides.length === 1 && rule.sides[0] === 'buy' && EXIT_ROLES.has(role)) continue;
    if (rule.sides.length === 1 && rule.sides[0] === 'buy' && role && role !== 'entry' && role !== 'buy') continue;
    return rule;
  }
  return null;
}

function fillScale(fill, rule) {
  const n = Number(fill && fill.ccyScale);
  if (n > 0) return n;
  return (rule && rule.defaultScale) || 1;
}

function tapePriceForTax(fill) {
  if (!fill) return 0;
  const recon = String(fill.recon || '');
  const from = Number(fill.priceCorrectedFrom);
  // avg-correct sometimes baked stamp into IB averageCost — use the tape.
  if (from > 0 && recon === 'avg-correct') return from;
  return Number(fill.price) || 0;
}

function fillConsideration(fill, rule) {
  const qty = Math.abs(Number(fill && fill.qty) || 0);
  const px = tapePriceForTax(fill);
  const scale = fillScale(fill, rule);
  if (!(qty > 0) || !(px > 0)) return 0;
  return qty * px / scale;
}

function fillTax(fill) {
  const rule = taxRuleForFill(fill);
  if (!rule) return null;
  const consideration = fillConsideration(fill, rule);
  if (!(consideration > 0)) return null;
  const amount = +(consideration * rule.pct).toFixed(6);
  if (!(amount > 0)) return null;
  const ccy = String((fill && (fill.currency || fill.commissionCcy)) || rule.currency || 'USD').toUpperCase();
  return {
    amount,
    currency: ccy,
    pct: rule.pct,
    id: rule.id,
    label: rule.label,
    feeType: rule.feeType,
    sides: rule.sides
  };
}

function isUkStampDutyFill(fill) {
  const rule = taxRuleForFill(fill);
  return !!(rule && rule.id === 'uk-sdrt');
}

function isStampDutyFill(fill) {
  return !!taxRuleForFill(fill);
}

/** Stamp in local currency (GBP for LSE pence names). */
function stampDutyLocal(fill) {
  const tax = fillTax(fill);
  return tax ? tax.amount : 0;
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
  TAX_RULES,
  isUkStampDutyFill,
  isStampDutyFill,
  taxRuleForFill,
  fillTax,
  tapePriceForTax,
  stampDutyLocal,
  stampInflatedAvg,
  shouldSkipStampInflatedAvgCorrect,
  isStampInflatedCorrectedFill
};
