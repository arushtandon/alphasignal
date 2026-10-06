'use strict';

const { atr } = require('./mean-reversion');
const { applyCosts } = require('./cost-model');
const { ratchetTslFromDailyBar } = require('../ibkr/tsl-policy');

const TICKET_USD = 30_000;
const MICRO_FUTURES = Object.freeze({
  'GC=F': Object.freeze({ symbol: 'MGC', multiplier: 10 }),
  'SI=F': Object.freeze({ symbol: 'SIL', multiplier: 1000 }),
  'CL=F': Object.freeze({ symbol: 'MCL', multiplier: 100 }),
  'HG=F': Object.freeze({ symbol: 'MHG', multiplier: 2500 }),
  'PL=F': Object.freeze({ symbol: 'PLM', multiplier: 10 }),
  'PA=F': Object.freeze({ symbol: 'PAM', multiplier: 10 }),
  'NG=F': Object.freeze({ symbol: 'MNG', multiplier: 1000 }),
});
const FUTURE_ETF = Object.freeze({
  'ZW=F': 'WEAT',
  'ZC=F': 'CORN',
  'ZS=F': 'SOYB',
  'BZ=F': 'BNO',
  'LE=F': 'COW',
  'HE=F': 'COW',
  'GF=F': 'COW',
  'CC=F': 'NIB',
  'KC=F': 'JO',
  'CT=F': 'BAL',
  'SB=F': 'CANE',
});

function instrumentFor(symbol, price) {
  const yahoo = String(symbol || '').toUpperCase();
  const px = Number(price);
  if (MICRO_FUTURES[yahoo]) {
    const mapped = MICRO_FUTURES[yahoo];
    return {
      yahoo,
      instrument: mapped.symbol,
      kind: 'micro_future',
      multiplier: mapped.multiplier,
      lotNotionalUsd: px > 0 ? px * mapped.multiplier : null,
    };
  }
  if (yahoo.endsWith('=F')) {
    const etf = FUTURE_ETF[yahoo] || null;
    return {
      yahoo,
      instrument: etf,
      kind: etf ? 'etf' : 'unmapped_future',
      multiplier: 1,
      lotNotionalUsd: null,
    };
  }
  return { yahoo, instrument: yahoo, kind: 'equity', multiplier: 1, lotNotionalUsd: null };
}

function boardLot(symbol) {
  const yahoo = String(symbol || '').toUpperCase();
  if (yahoo.endsWith('.T') || yahoo.endsWith('.HK')) return 100;
  return 1;
}

function listingScale(symbol, market) {
  if (String(symbol || '').toUpperCase().endsWith('.L') || market === 'UK') return 0.01;
  return 1;
}

function positionSize(input) {
  const price = Number(input.price);
  const fx = Number(input.fx) > 0 ? Number(input.fx) : 1;
  const mapped = instrumentFor(input.symbol, price * fx);
  if (mapped.kind === 'micro_future') {
    const lotUsd = mapped.lotNotionalUsd;
    const lots = lotUsd > TICKET_USD ? 1 : Math.max(1, Math.floor(TICKET_USD / lotUsd));
    return {
      ...mapped,
      lots,
      oneLot: lots === 1,
      minimumLot: true,
      exceedsTicket: lotUsd > TICKET_USD,
      ticketUsd: TICKET_USD,
    };
  }
  const lotShares = Math.max(1, Number(input.lot) || boardLot(input.symbol));
  const scale = listingScale(input.symbol, input.market);
  const lotUsd = price * scale * fx * lotShares;
  if (!(lotUsd > 0)) return null;
  const lots = lotUsd > TICKET_USD ? 1 : Math.max(1, Math.floor(TICKET_USD / lotUsd));
  return {
    ...mapped,
    lots,
    shares: lots * lotShares,
    oneLot: lots === 1,
    minimumLot: lots === 1,
    exceedsTicket: lotUsd > TICKET_USD,
    lotUsd,
    ticketUsd: TICKET_USD,
  };
}

function finish(realised, entry, exitIndex, entryIndex, status, options) {
  const cost = applyCosts(realised, {
    market: options.market,
    symbol: options.symbol,
    side: 'buy',
    holdDays: Math.max(0, exitIndex - entryIndex),
  });
  return {
    ret: cost.netReturn,
    grossRet: realised,
    entryIndex,
    exitIndex,
    status,
    holdBars: Math.max(0, exitIndex - entryIndex),
    closed: true,
  };
}

function simulateAmendedMeanReversion(bars, signalIndex, candidate, options = {}) {
  const entryIndex = signalIndex + 1;
  const entry = Number(bars[entryIndex]?.o);
  const atrValue = atr(bars, signalIndex, 14);
  if (!(entry > 0) || !(atrValue > 0)) return null;
  const target = entry + atrValue;
  const runnerTarget = entry + 2 * atrValue;
  const stop = entry - candidate.stopAtr * atrValue;
  const oneLot = options.oneLot === true;
  const partial = candidate.partial === true && !oneLot;
  let realised = 0;
  let remaining = 1;
  let tp1Hit = false;
  let trailing = stop;
  for (let index = entryIndex; index < bars.length; index++) {
    const bar = bars[index];
    if (oneLot && tp1Hit && index > entryIndex) {
      trailing = Math.max(entry, ratchetTslFromDailyBar(trailing, bars[index - 1], bar, false, entry));
    }
    const activeStop = !tp1Hit ? stop : (oneLot ? trailing : entry);
    if (Number(bar.l) <= activeStop) {
      return finish(realised + remaining * (activeStop / entry - 1), entry, index, entryIndex,
        tp1Hit ? 'runner_stop' : 'stop', options);
    }
    const activeTarget = tp1Hit ? runnerTarget : target;
    if (Number(bar.h) >= activeTarget) {
      if (!tp1Hit && (partial || oneLot)) {
        if (partial) {
          realised += 0.5 * (target / entry - 1);
          remaining = 0.5;
        }
        tp1Hit = true;
        trailing = entry;
        continue;
      }
      return finish(realised + remaining * (activeTarget / entry - 1), entry, index, entryIndex,
        tp1Hit ? 'runner_target' : 'target', options);
    }
  }
  return {
    ret: null,
    entryIndex,
    exitIndex: null,
    status: 'open',
    holdBars: null,
    closed: false,
  };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

function holdDistribution(trades) {
  const days = (trades || []).map(trade => Number(trade.holdBars)).filter(Number.isFinite);
  return {
    median: percentile(days, 0.5),
    p90: percentile(days, 0.9),
    max: days.reduce((best, value) => best == null ? value : Math.max(best, value), null),
  };
}

function maxConcurrent(trades) {
  const events = [];
  for (const trade of trades || []) {
    if (!trade.entryDate) continue;
    events.push({ date: trade.entryDate, change: 1 });
    events.push({ date: trade.exitDate || '9999-12-31', change: -1 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.change - b.change);
  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.change;
    peak = Math.max(peak, open);
  }
  return peak;
}

function approveAmendment(baselineWindows, variantWindows) {
  const variantPnl = variantWindows.reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
  const extraLosing = baselineWindows.some((row, index) =>
    Number(row.pnlUsd) >= 0 && Number(variantWindows[index]?.pnlUsd) < 0);
  return variantPnl > 0 && !extraLosing;
}

module.exports = {
  TICKET_USD,
  MICRO_FUTURES,
  FUTURE_ETF,
  instrumentFor,
  boardLot,
  positionSize,
  simulateAmendedMeanReversion,
  holdDistribution,
  maxConcurrent,
  approveAmendment,
};
