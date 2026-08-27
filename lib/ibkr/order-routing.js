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

/** First exchange to try. Native cash venue for Asia/UK; SMART elsewhere. */
function preferredExchange(contract) {
  const venue = listingVenue(contract);
  if (venue === 'SEHK' || venue === 'TSEJ' || venue === 'LSE') return venue;
  return 'SMART';
}

/** Other exchange to try after IB error 200. */
function fallbackExchange(tried, contract) {
  const t = String(tried || '').toUpperCase();
  const venue = listingVenue(contract);
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
  isRoutingError,
  isSessionBlockedError,
  isShortSaleReject,
  asiaCashBlocksRestingOrders,
  ibLocalSymbol,
  placeableStkContract
};
