'use strict';
/**
 * Dual-list / bare-IB symbol aliases — single source of truth for server + bridge.
 *
 * Yahoo suffix is the listing venue (not a nickname):
 *   .DE = Germany / Xetra     = Bloomberg GY  = IB primaryExch IBIS
 *   .PA = France / Euronext   = Bloomberg FP  = IB primaryExch SBF
 * Orders must stay on that venue. LISTING_ALIASES only means IB may report
 * the same ISIN under the other suffix (one paper position) — never send a
 * .PA (FP) order to IBIS or a .DE (GY) order to SBF.
 */
const LISTING_ALIASES = {
  'AIR.DE': ['AIR.PA', 'AIR'],
  'AIR.PA': ['AIR.DE', 'AIR'],
  'SU.PA': ['SU.DE', 'SU'],
  'SU.DE': ['SU.PA', 'SU'],
  'DHL.PA': ['DHL.DE', 'DHL'],
  'DHL.DE': ['DHL.PA', 'DHL'],
  'DSY.PA': ['DSY.DE', 'DSY'],
  'DSY.DE': ['DSY.PA', 'DSY'],
  'HSBA.L': ['HSBA', 'HSBA.L']
};

/** Yahoo suffix → Bloomberg yellow-key + IB listing. */
const YAHOO_LISTING = {
  '.DE': { bloomberg: 'GY', venue: 'Xetra', country: 'Germany', ibPrimary: 'IBIS', market: 'XETRA' },
  '.PA': { bloomberg: 'FP', venue: 'Euronext Paris', country: 'France', ibPrimary: 'SBF', market: 'EURONEXT' },
  '.AS': { bloomberg: 'NA', venue: 'Euronext Amsterdam', country: 'Netherlands', ibPrimary: 'AEB', market: 'EURONEXT' },
  '.MI': { bloomberg: 'IM', venue: 'Borsa Italiana', country: 'Italy', ibPrimary: 'BVME', market: 'EURONEXT' },
  '.L':  { bloomberg: 'LN', venue: 'LSE', country: 'United Kingdom', ibPrimary: 'LSE', market: 'LSE' },
  '.HK': { bloomberg: 'HK', venue: 'SEHK', country: 'Hong Kong', ibPrimary: 'SEHK', market: 'HK' },
  '.T':  { bloomberg: 'JT', venue: 'TSE', country: 'Japan', ibPrimary: 'TSEJ', market: 'JP' }
};

function listingMeta(yahoo) {
  const y = String(yahoo || '').toUpperCase().trim();
  const i = y.lastIndexOf('.');
  if (i < 0) return null;
  return YAHOO_LISTING[y.slice(i)] || null;
}

/** SAP.DE → "SAP GY"; DSY.PA → "DSY FP". */
function bloombergTicker(yahoo) {
  const y = String(yahoo || '').toUpperCase().trim();
  const i = y.lastIndexOf('.');
  if (i < 0) return y;
  const meta = YAHOO_LISTING[y.slice(i)];
  if (!meta) return y;
  return y.slice(0, i) + ' ' + meta.bloomberg;
}

/** IB primaryExch → Yahoo suffix. IBIS = GY/.DE, SBF = FP/.PA. */
function yahooSuffixFromIbPrimary(primaryExch) {
  const e = String(primaryExch || '').toUpperCase();
  if (e === 'SBF' || e === 'SBF.SBF') return '.PA';
  if (e === 'IBIS' || e === 'IBIS-EUREX' || e === 'FWB' || e === 'XETRA') return '.DE';
  if (e === 'AEB') return '.AS';
  if (e === 'BVME') return '.MI';
  if (e === 'LSE') return '.L';
  if (e === 'SEHK') return '.HK';
  if (e === 'TSEJ') return '.T';
  return null;
}

function normalizeYahooTicker(t) {
  const y = String(t || '').toUpperCase().trim();
  // IB uses a space in US share-class symbols, Yahoo uses a hyphen. Keep one
  // canonical identity everywhere so a valid model position is never treated
  // as an IB-only orphan (for example BRK B vs BRK-B).
  const usShareClass = {
    'BRK B': 'BRK-B', 'BRK.B': 'BRK-B', BRKB: 'BRK-B',
    'BRK A': 'BRK-A', 'BRK.A': 'BRK-A', BRKA: 'BRK-A',
    'BF B': 'BF-B', 'BF.B': 'BF-B', BFB: 'BF-B'
  };
  if (usShareClass[y]) return usShareClass[y];
  const hk = y.match(/^0*([1-9]\d*)\.HK$/);
  if (hk) return hk[1].padStart(4, '0') + '.HK';
  return y;
}

function yahooAliases(t) {
  const y = normalizeYahooTicker(t);
  const out = new Set([y]);
  for (const a of (LISTING_ALIASES[y] || [])) out.add(normalizeYahooTicker(a));
  // Bare IB portfolio symbol ("SU") ↔ Yahoo "SU.PA" / "SU.DE"
  if (y.includes('.')) out.add(y.split('.')[0]);
  else {
    for (const k of Object.keys(LISTING_ALIASES)) {
      if (k.split('.')[0] === y) out.add(k);
    }
  }
  return out;
}

function setHasYahooAlias(set, t) {
  for (const a of yahooAliases(t)) {
    if (set.has(a)) return true;
  }
  return false;
}

module.exports = {
  LISTING_ALIASES,
  YAHOO_LISTING,
  normalizeYahooTicker,
  yahooAliases,
  setHasYahooAlias,
  listingMeta,
  bloombergTicker,
  yahooSuffixFromIbPrimary
};
