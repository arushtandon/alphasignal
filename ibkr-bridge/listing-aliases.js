'use strict';
/**
 * Dual-list / bare-IB symbol aliases — single source of truth for server + bridge.
 * Keep Euronext/Xetra pairs and bare portfolio symbols (SU, DHL, AIR) in sync.
 */
const LISTING_ALIASES = {
  'AIR.DE': ['AIR.PA', 'AIR'],
  'AIR.PA': ['AIR.DE', 'AIR'],
  'SU.PA': ['SU.DE', 'SU'],
  'SU.DE': ['SU.PA', 'SU'],
  'DHL.PA': ['DHL.DE', 'DHL'],
  'DHL.DE': ['DHL.PA', 'DHL'],
  'HSBA.L': ['HSBA', 'HSBA.L']
};

function normalizeYahooTicker(t) {
  const y = String(t || '').toUpperCase().trim();
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
  normalizeYahooTicker,
  yahooAliases,
  setHasYahooAlias
};
