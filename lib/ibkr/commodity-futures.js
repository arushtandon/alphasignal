'use strict';

/**
 * Yahoo continuous commodities (=F) → IB mini/micro futures that can sit near
 * the $10k per-instrument notional cap. Full-size roots are last-resort only.
 *
 * Selection: among contracts whose 1-lot notional is ≤ $12.5k, pick the most
 * liquid; if none fit, pick the smallest listed mini so integer lots can
 * approach $10k. Index futures (ES/NQ/…) stay on their current E-mini roots.
 */

const INSTRUMENT_NOTIONAL_USD = 10000;
const NOTIONAL_SLACK = 1.25;

const TYPICAL_PX = {
  'GC=F': 3400, 'SI=F': 38, 'HG=F': 4.5, 'PL=F': 950, 'PA=F': 1000,
  'CL=F': 75, 'BZ=F': 87, 'NG=F': 3
};

/** liquidity: 1 = most liquid in that commodity family. */
const COMMODITY_FUTURE_LADDER = {
  'GC=F': [
    { symbol: '1OZ', exchange: 'COMEX', multiplier: 1, tick: 0.25, liquidity: 2 },
    { symbol: 'MGC', exchange: 'COMEX', multiplier: 10, tick: 0.1, liquidity: 1 },
    { symbol: 'GC', exchange: 'COMEX', multiplier: 100, tick: 0.1, liquidity: 3 }
  ],
  'SI=F': [
    { symbol: 'SIC', exchange: 'COMEX', multiplier: 100, tick: 0.005, liquidity: 2 },
    { symbol: 'SI', exchange: 'COMEX', multiplier: 100, tick: 0.005, tradingClass: 'SIC', liquidity: 2 },
    { symbol: 'SIL', exchange: 'COMEX', multiplier: 1000, tick: 0.005, liquidity: 1 },
    { symbol: 'QI', exchange: 'COMEX', multiplier: 1000, tick: 0.005, liquidity: 3 },
    { symbol: 'SI', exchange: 'COMEX', multiplier: 5000, tick: 0.005, liquidity: 4 }
  ],
  'HG=F': [
    { symbol: 'MHG', exchange: 'COMEX', multiplier: 2500, tick: 0.0005, liquidity: 1 },
    { symbol: 'HG', exchange: 'COMEX', multiplier: 25000, tick: 0.0005, liquidity: 2 }
  ],
  'PL=F': [
    { symbol: 'PLM', exchange: 'NYMEX', multiplier: 10, tick: 0.1, liquidity: 1 },
    { symbol: 'PL', exchange: 'NYMEX', multiplier: 50, tick: 0.1, liquidity: 2 }
  ],
  'PA=F': [
    { symbol: 'PAM', exchange: 'NYMEX', multiplier: 10, tick: 0.5, liquidity: 1 },
    { symbol: 'PA', exchange: 'NYMEX', multiplier: 100, tick: 0.05, liquidity: 2 }
  ],
  'CL=F': [
    { symbol: 'MCL', exchange: 'NYMEX', multiplier: 100, tick: 0.01, liquidity: 1 },
    { symbol: 'QM', exchange: 'NYMEX', multiplier: 500, tick: 0.025, liquidity: 2 },
    { symbol: 'CL', exchange: 'NYMEX', multiplier: 1000, tick: 0.01, liquidity: 3 }
  ],
  'BZ=F': [
    { symbol: 'G', exchange: 'ICEEU', multiplier: 100, tick: 0.01, liquidity: 1 },
    { symbol: 'G', exchange: 'IPE', multiplier: 100, tick: 0.01, liquidity: 1 },
    { symbol: 'BM', exchange: 'ICESG', multiplier: 100, tick: 0.01, liquidity: 2 },
    { symbol: 'BM', exchange: 'NYBOT', multiplier: 100, tick: 0.01, liquidity: 2 },
    { symbol: 'BZ', exchange: 'NYMEX', multiplier: 1000, tick: 0.01, liquidity: 3 }
  ],
  'NG=F': [
    { symbol: 'QG', exchange: 'NYMEX', multiplier: 2500, tick: 0.005, liquidity: 1 },
    { symbol: 'MNG', exchange: 'NYMEX', multiplier: 1000, tick: 0.001, liquidity: 2 },
    { symbol: 'NG', exchange: 'NYMEX', multiplier: 10000, tick: 0.001, liquidity: 3 }
  ]
};

/** Index / rates — not resized; listed so yahooFromContract still maps them. */
const INDEX_FUTURES = {
  'ES=F': { symbol: 'ES', exchange: 'CME', multiplier: 50, tick: 0.25, liquidity: 1 },
  'NQ=F': { symbol: 'NQ', exchange: 'CME', multiplier: 20, tick: 0.25, liquidity: 1 },
  'YM=F': { symbol: 'YM', exchange: 'CBOT', multiplier: 5, tick: 1, liquidity: 1 },
  'RTY=F': { symbol: 'RTY', exchange: 'CME', multiplier: 50, tick: 0.1, liquidity: 1 },
  'ZN=F': { symbol: 'ZN', exchange: 'CBOT', multiplier: 1000, tick: 0.015625, liquidity: 1 }
};

const IB_FUT_TO_YAHOO = {
  '1OZ': 'GC=F', MGC: 'GC=F', QO: 'GC=F', GC: 'GC=F',
  SIC: 'SI=F', SIL: 'SI=F', QI: 'SI=F', SI: 'SI=F',
  MHG: 'HG=F', HG: 'HG=F',
  PLM: 'PL=F', PL: 'PL=F',
  PAM: 'PA=F', PA: 'PA=F',
  MCL: 'CL=F', QM: 'CL=F', CL: 'CL=F',
  G: 'BZ=F', BM: 'BZ=F', COIL: 'BZ=F', BZ: 'BZ=F',
  QG: 'NG=F', MNG: 'NG=F', NG: 'NG=F',
  ES: 'ES=F', MES: 'ES=F',
  NQ: 'NQ=F', MNQ: 'NQ=F',
  YM: 'YM=F', MYM: 'YM=F',
  RTY: 'RTY=F', M2K: 'RTY=F',
  ZN: 'ZN=F'
};

const IB_FUT_MULTIPLIER = {
  '1OZ': 1, MGC: 10, QO: 50, GC: 100,
  SIC: 100, SIL: 1000, QI: 1000, SI: 5000,
  MHG: 2500, HG: 25000,
  PLM: 10, PL: 50,
  PAM: 10, PA: 100,
  MCL: 100, QM: 500, CL: 1000,
  G: 100, BM: 100, BZ: 1000,
  QG: 2500, MNG: 1000, NG: 10000,
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, ZN: 1000
};

function specFields(spec) {
  if (!spec) return null;
  return {
    symbol: spec.symbol,
    exchange: spec.exchange,
    currency: spec.currency || 'USD',
    multiplier: spec.multiplier,
    tick: spec.tick,
    tradingClass: spec.tradingClass,
    market: 'GLOBE',
    lotHint: 1,
    needsFrontMonth: true
  };
}

function ladderFor(yahoo) {
  const y = String(yahoo || '').toUpperCase();
  if (COMMODITY_FUTURE_LADDER[y]) return COMMODITY_FUTURE_LADDER[y];
  if (INDEX_FUTURES[y]) return [INDEX_FUTURES[y]];
  return [];
}

function orderedCommoditySpecs(yahoo, entryPx) {
  const y = String(yahoo || '').toUpperCase();
  const ladder = ladderFor(y).map(s => Object.assign({ currency: 'USD', market: 'GLOBE' }, s));
  if (!ladder.length) return [];
  const px = Number(entryPx) > 0 ? Number(entryPx) : (TYPICAL_PX[y] || 0);
  if (!(px > 0) || !COMMODITY_FUTURE_LADDER[y]) return ladder;
  const cap = INSTRUMENT_NOTIONAL_USD * NOTIONAL_SLACK;
  const scored = ladder.map(s => Object.assign({}, s, { lotNotional: px * Number(s.multiplier) }));
  const fit = scored.filter(s => s.lotNotional <= cap).sort((a, b) => a.liquidity - b.liquidity);
  const rest = scored.filter(s => s.lotNotional > cap).sort((a, b) => a.lotNotional - b.lotNotional);
  return fit.concat(rest);
}

function preferredCommoditySpec(yahoo, entryPx) {
  return orderedCommoditySpecs(yahoo, entryPx)[0] || null;
}

/** Preferred IB stub per Yahoo ticker (mini when one exists). */
const YAHOO_FUTURES = {};
for (const y of Object.keys(COMMODITY_FUTURE_LADDER)) {
  YAHOO_FUTURES[y] = specFields(preferredCommoditySpec(y, TYPICAL_PX[y]));
}
for (const [y, spec] of Object.entries(INDEX_FUTURES)) {
  YAHOO_FUTURES[y] = specFields(spec);
}

function ibFutSymbolToYahoo(symbol) {
  const s = String(symbol || '').toUpperCase();
  return IB_FUT_TO_YAHOO[s] || (s ? s + '=F' : null);
}

function ibFutMultiplier(symbol, explicit) {
  const n = Number(explicit);
  if (n > 1 || n === 1) return n;
  const s = String(symbol || '').toUpperCase();
  if (IB_FUT_MULTIPLIER[s] != null) return IB_FUT_MULTIPLIER[s];
  return 1;
}

function isCommodityYahoo(ticker) {
  return Object.prototype.hasOwnProperty.call(COMMODITY_FUTURE_LADDER, String(ticker || '').toUpperCase());
}

/** CME/ICE month letter in a local symbol (BZV6, GV6, MCLX6). */
const CME_MONTH_CODE = {
  F: 'Jan', G: 'Feb', H: 'Mar', J: 'Apr', K: 'May', M: 'Jun',
  N: 'Jul', Q: 'Aug', U: 'Sep', V: 'Oct', X: 'Nov', Z: 'Dec'
};

/** "BZV6" / "BZV26" → "Oct 2026". */
function futuresLocalMonthLabel(localSymbol) {
  const s = String(localSymbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!m) return null;
  const month = CME_MONTH_CODE[m[1]];
  if (!month) return null;
  const yy = parseInt(m[2], 10);
  const year = m[2].length === 1 ? 2020 + yy : (yy < 100 ? 2000 + yy : yy);
  return month + ' ' + year;
}

/**
 * True while IB still lists the contract for trading.
 * `lastTradeDateOrContractMonth` is "20260828 14:30:00 US/Eastern" or "202610".
 * Date-only: expired the calendar day after last trade (UTC).
 */
function futuresStillTradable(lastTradeDateOrContractMonth, now = new Date()) {
  const digits = String(lastTradeDateOrContractMonth || '').replace(/\D/g, '');
  if (!digits) return true;
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const today = String(y) + mo + d;
  if (digits.length >= 8) return digits.slice(0, 8) >= today;
  if (digits.length === 6) return digits >= String(y) + mo;
  return true;
}

function futuresExpired(contract, now = new Date()) {
  if (!contract || String(contract.secType || '').toUpperCase() !== 'FUT') return false;
  return !futuresStillTradable(contract.lastTradeDateOrContractMonth, now);
}

module.exports = {
  INSTRUMENT_NOTIONAL_USD,
  TYPICAL_PX,
  COMMODITY_FUTURE_LADDER,
  INDEX_FUTURES,
  YAHOO_FUTURES,
  IB_FUT_TO_YAHOO,
  CME_MONTH_CODE,
  orderedCommoditySpecs,
  preferredCommoditySpec,
  specFields,
  ibFutSymbolToYahoo,
  ibFutMultiplier,
  isCommodityYahoo,
  futuresLocalMonthLabel,
  futuresStillTradable,
  futuresExpired
};
