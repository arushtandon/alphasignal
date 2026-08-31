'use strict';

/**
 * Listing geography from Yahoo / IBKR ticker. Used by Performance geo PnL.
 * Keep labels in sync with public/index.html geoOfTicker.
 */

const GEO_ORDER = Object.freeze([
  'United States',
  'Hong Kong',
  'Japan',
  'United Kingdom',
  'Germany',
  'France',
  'Europe',
  'India',
  'Commodities',
  'Crypto',
  'Other'
]);

function geoOfTicker(sym) {
  const up = String(sym || '').trim().toUpperCase();
  if (!up) return 'Other';
  if (up.includes('=F') || up.endsWith('.FUT')) return 'Commodities';
  if (up.endsWith('-USD') || up.endsWith('USD') && (up.startsWith('BTC') || up.startsWith('ETH'))) {
    return 'Crypto';
  }
  const dot = up.lastIndexOf('.');
  const suf = dot >= 0 ? up.slice(dot) : '';
  switch (suf) {
    case '.NS':
    case '.BO':
      return 'India';
    case '.T':
      return 'Japan';
    case '.HK':
      return 'Hong Kong';
    case '.DE':
    case '.F':
    case '.DU':
    case '.MU':
    case '.SG':
    case '.BE':
      return 'Germany';
    case '.PA':
      return 'France';
    case '.L':
      return 'United Kingdom';
    case '.AS':
    case '.BR':
    case '.MI':
    case '.MC':
    case '.SW':
    case '.LS':
    case '.VI':
    case '.ST':
    case '.HE':
    case '.CO':
    case '.OL':
    case '.IR':
      return 'Europe';
    case '.KS':
    case '.KQ':
      return 'Korea';
    case '.TW':
    case '.TWO':
      return 'Taiwan';
    default:
      return 'United States';
  }
}

module.exports = { GEO_ORDER, geoOfTicker };
