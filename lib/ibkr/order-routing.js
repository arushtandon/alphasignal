'use strict';

/**
 * Choose the IB exchange that will actually accept the order.
 * SMART is fine for US; HK/JP/LSE listings often return error 200 on SMART
 * ("no security definition") unless routed to the cash venue.
 */

function listingVenue(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const m = String(contract.market || '').toUpperCase();
  const ccy = String(contract.currency || '').toUpperCase();
  const primary = String(contract.primaryExch || '').toUpperCase();
  const exch = String(contract.exchange || '').toUpperCase();
  if (m === 'HK' || ccy === 'HKD' || primary === 'SEHK' || exch === 'SEHK') return 'SEHK';
  if (m === 'JP' || ccy === 'JPY' || primary === 'TSEJ' || exch === 'TSEJ') return 'TSEJ';
  if (m === 'LSE' || ccy === 'GBP' || primary === 'LSE' || exch === 'LSE') return 'LSE';
  if (primary === 'IBIS' || primary === 'SBF' || primary === 'AEB' || primary === 'BVME' || primary === 'SMART') {
    if (primary !== 'SMART') return primary;
  }
  if (ccy === 'EUR') return primary || null;
  if (ccy === 'USD' || m === 'US') return primary || 'NYSE';
  return primary || null;
}

/** First exchange to try. Native cash venue for HK; SMART elsewhere. */
function preferredExchange(contract) {
  const venue = listingVenue(contract);
  if (venue === 'SEHK') return venue;
  // TSEJ direct-route trips TWS API precaution 10311 and the parent is discarded
  // (7733.T 4 Sep: 2110/2155/2200 never appeared in open orders). SMART+TSEJ works.
  // LSE direct accepted SHEL then dropped it (8 Sep: BUY 744 LMT 3658 never in
  // open orders). Working BA/MNDI/SGRO children are SMART + pence.
  return 'SMART';
}

/**
 * Transmit the parent alone (no 3-leg bag). A child 110/201 leaves
 * `transmit:false` parents dead — SGRO.L 4 Sep never printed because the
 * 868.5 STP was rejected and the MKT parent stayed untransmitted.
 */
function parentStandalone(contract) {
  if (!contract || typeof contract !== 'object') return false;
  const m = String(contract.market || '').toUpperCase();
  const st = String(contract.secType || '').toUpperCase();
  return m === 'JP' || m === 'HK' || m === 'LSE' || st === 'CRYPTO' || m === 'CRYPTO';
}

/**
 * LSE cash + MTFs (SHEL.L 8 Sep: LSE-direct vanished; SMART filled).
 * Rotate through these within ~2 minutes if the parent has not printed.
 */
const LSE_VENUE_CHAIN = ['SMART', 'CHIXUK', 'TRQXUK', 'BATEUK', 'LSE'];
/** Keep LSE through-limits close to last. Walking 2% tripped IB 2161 (cap to last). */
const LSE_THROUGH_PCT = 0.005;

function lseVenueChain(contract) {
  const valid = String((contract && contract.validExchanges) || '')
    .toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!valid.length) return LSE_VENUE_CHAIN.slice();
  const filtered = LSE_VENUE_CHAIN.filter((v) => valid.includes(v));
  return filtered.length ? filtered : LSE_VENUE_CHAIN.slice();
}

/** Next LSE venue after `tried` (wraps). */
function nextLseVenue(tried, contract) {
  const chain = lseVenueChain(contract);
  const t = String(tried || '').toUpperCase();
  const i = chain.indexOf(t);
  if (i < 0) return chain[0];
  return chain[(i + 1) % chain.length];
}

/** Other exchange to try after IB error 200, or after an unfilled LSE sit. */
function fallbackExchange(tried, contract) {
  const t = String(tried || '').toUpperCase();
  const venue = listingVenue(contract);
  if (venue === 'LSE') return nextLseVenue(t, contract);
  if (!t) return preferredExchange(contract);
  if (t === 'SMART') return venue && venue !== 'SMART' ? venue : null;
  if (venue && t === venue) return 'SMART';
  if (t !== 'SMART') return 'SMART';
  return venue || null;
}

function isRoutingError(code) {
  return Number(code) === 200;
}

function isSessionBlockedError(code, message) {
  if (Number(code) !== 201 && Number(code) !== 399) return false;
  const msg = String(message || '').toLowerCase();
  // 201 "not available for short sale" during cash RTH is a marketable-close
  // reject, not a session block. Lunch/overnight still match the closed/hours tests.
  return /exchange is closed|order held|pre-open|outside.*hours|trading halt|not currently available/.test(msg);
}

function isShortSaleReject(code, message) {
  if (Number(code) !== 201) return false;
  return /short sale/i.test(String(message || ''));
}

/** HK/JP cash books reject marketable sells in lunch / overnight as short-sale (201). */
function asiaCashBlocksRestingOrders(contract, phase) {
  const m = String((contract && contract.market) || '').toUpperCase();
  const ccy = String((contract && contract.currency) || '').toUpperCase();
  const asia = m === 'HK' || m === 'JP' || ccy === 'HKD' || ccy === 'JPY';
  if (!asia) return false;
  const p = String(phase || '').toLowerCase();
  return p === 'lunch' || p === 'closed';
}

/**
 * Sweep vs on-fill policy for parking TP1 LMT + SL STP.
 * Sweep: never send while the cash book is shut (HK/JP lunch+closed, any
 * `closed` phase). On parent fill: skip only HK/JP lunch — try GTC otherwise
 * so a just-filled lot is not left naked until the next cash open.
 */
function shouldDeferProtectiveChildren(contract, phase, opts = {}) {
  const p = String(phase || '').toLowerCase();
  if (asiaCashBlocksRestingOrders(contract, phase) && p === 'lunch') return true;
  if (opts && opts.onFill) return false;
  if (p === 'closed') return true;
  return asiaCashBlocksRestingOrders(contract, phase);
}

/** Yahoo listing suffixes are not IB localSymbols (6098.T, 0005.HK, BA.L). */
function ibLocalSymbol(ls) {
  const s = String(ls || '').trim();
  if (!s) return undefined;
  if (/\.(T|HK|L|DE|PA|AS|MI|NS)$/i.test(s)) return undefined;
  return s;
}

function placeableStkContract(contract, exchangeOverride) {
  if (!contract) return null;
  const exch = String(exchangeOverride || preferredExchange(contract) || 'SMART').toUpperCase();
  const oc = {
    secType: contract.secType || 'STK',
    exchange: exch,
    currency: contract.currency || 'USD'
  };
  const conId = Number(contract.conId);
  if (conId > 0) oc.conId = conId;
  if (contract.symbol != null && contract.symbol !== '') oc.symbol = String(contract.symbol);
  const ls = ibLocalSymbol(contract.localSymbol);
  if (ls) oc.localSymbol = ls;
  const venue = listingVenue(contract);
  oc.primaryExch = contract.primaryExch || venue || undefined;
  return oc;
}

module.exports = {
  listingVenue,
  preferredExchange,
  fallbackExchange,
  lseVenueChain,
  nextLseVenue,
  LSE_VENUE_CHAIN,
  LSE_THROUGH_PCT,
  parentStandalone,
  isRoutingError,
  isSessionBlockedError,
  isShortSaleReject,
  asiaCashBlocksRestingOrders,
  shouldDeferProtectiveChildren,
  ibLocalSymbol,
  placeableStkContract
};
