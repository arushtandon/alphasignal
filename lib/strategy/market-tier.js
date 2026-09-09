'use strict';

/**
 * Market scoring tiers. Danelfin is retired — it inflated US/UK/EU scores and
 * confidence (winRateHint ≥70) onto the board. All equities now use FMP quality
 * + the same technical engine as HK/JP.
 *
 * US + UK (the weak live book) use a stricter entry policy on top of that.
 */

const ANGLO_MIN_RR = 1.4;

function classifyMarket(symbol) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) {
    return {
      tier: 'fmp_quality', label: 'FMP Quality Score', region: 'us',
      danelfin: false, fmp: true, note: 'Technical + FMP + fundamentals (horizon-weighted)'
    };
  }
  if (sym.includes('=F') || sym.endsWith('-USD') || sym.endsWith('-EUR')) {
    return {
      tier: 'technical_only', label: 'Technical Only', region: 'commodity',
      danelfin: false, fmp: false,
      note: 'No fundamental scoring for commodities — SD channel + momentum'
    };
  }
  const eu = ['.L', '.DE', '.PA', '.AS', '.AMS', '.BR', '.MI', '.MC', '.ST', '.CO', '.OL', '.HE', '.VI'];
  if (eu.some((sfx) => sym.endsWith(sfx))) {
    const uk = sym.endsWith('.L');
    return {
      tier: 'fmp_quality',
      label: 'FMP Quality Score',
      region: uk ? 'uk' : 'europe',
      danelfin: false,
      fmp: true,
      note: uk
        ? 'Technical + FMP + fundamentals (UK, horizon-weighted)'
        : 'Technical + FMP + fundamentals (Europe, horizon-weighted)'
    };
  }
  const asia = ['.T', '.HK', '.NS', '.BO', '.KS', '.KQ', '.TW', '.SI', '.AX', '.NZ', '.BK'];
  if (asia.some((sfx) => sym.endsWith(sfx))) {
    return {
      tier: 'fmp_quality', label: 'FMP Quality Score', region: 'asia',
      danelfin: false, fmp: true,
      note: 'Technical + FMP + fundamentals (Asia, horizon-weighted)'
    };
  }
  return {
    tier: 'fmp_quality', label: 'FMP Quality Score', region: 'us',
    danelfin: false, fmp: true,
    note: 'Technical + FMP + fundamentals (US, horizon-weighted)'
  };
}

/** US listings (no venue suffix) and UK .L — the weak live book. */
function isAngloSymbol(symbol) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return false;
  if (sym.includes('=F') || sym.endsWith('-USD') || sym.endsWith('-EUR')) return false;
  if (sym.endsWith('.L') || sym.endsWith('.US')) return true;
  return sym.indexOf('.') < 0;
}

function angloPickAllowed(symbol, opts) {
  opts = opts || {};
  if (!isAngloSymbol(symbol)) return { ok: true, minRR: null, reason: null };
  const hz = String(opts.hz || 'short');
  const side = String(opts.side || opts.action || '').toLowerCase();
  const isSell = side === 'sell';
  const rating = String(opts.rating || '');
  if (hz === 'short' && !isSell) {
    return {
      ok: false,
      minRR: ANGLO_MIN_RR,
      reason: 'US/UK short-horizon buys paused (poor live hit-rate)'
    };
  }
  const strong = isSell ? /strong\s*sell/i.test(rating) : /strong\s*buy/i.test(rating);
  if (!strong) {
    return {
      ok: false,
      minRR: ANGLO_MIN_RR,
      reason: 'US/UK requires Strong Buy / Strong Sell'
    };
  }
  return { ok: true, minRR: ANGLO_MIN_RR, reason: null };
}

function minRrForSymbol(symbol, defaultRr) {
  const base = Number(defaultRr);
  const floor = Number.isFinite(base) ? base : 1.1;
  return isAngloSymbol(symbol) ? Math.max(floor, ANGLO_MIN_RR) : floor;
}

/** US/UK must have a real FMP quality snapshot or they are not recommendable. */
function fmpSnapshotUsable(fmp) {
  if (!fmp || typeof fmp !== 'object') return false;
  const n = (v) => (v == null || v === '' ? null : Number(v));
  return n(fmp.piotroski) != null || n(fmp.qualityScore) != null || n(fmp.altmanZ) != null;
}

function angloNeedsFmp(symbol) {
  return isAngloSymbol(symbol);
}

/** Cap US/UK at Hold when FMP was not fetched. Returns true if it blocked. */
function applyMissingFmpHold(symbol, quantSignal) {
  if (!angloNeedsFmp(symbol) || !quantSignal) return false;
  ['short', 'medium', 'long'].forEach((hz) => {
    const q = quantSignal[hz];
    if (!q) return;
    q.buyScore = Math.min(Number(q.buyScore) || 0, 61);
    q.sellScore = Math.min(Number(q.sellScore) || 0, 61);
    q.action = 'Hold';
    q.rating = 'Hold';
    q.fmpMissing = true;
    q.tierLabel = 'No FMP quality numbers for this US/UK listing';
    q.conditions = q.conditions || [];
    if (!q.conditions.some((c) => /no company-quality numbers/i.test(c))) {
      q.conditions.push('This US/UK listing returned no company-quality numbers from FMP, so no buy/sell is recommended');
    }
  });
  return true;
}

module.exports = {
  ANGLO_MIN_RR,
  classifyMarket,
  isAngloSymbol,
  angloPickAllowed,
  minRrForSymbol,
  fmpSnapshotUsable,
  angloNeedsFmp,
  applyMissingFmpHold
};
