'use strict';

const {
  sma,
  atr: mrAtr,
  signalAt: meanReversionSignalAt,
} = require('../research/mean-reversion');
const { applyCosts } = require('../research/cost-model');
const { ratchetTslFromDailyBar } = require('../ibkr/tsl-policy');

const VERSION = 'evidence-setup-book-2026-10-05';
const GO_LIVE = Object.freeze({
  step0a: 'LONG_TREND_SECTOR_OFF rejected: pooled six-market book was not profitable with PF >= 1.2 in every window',
  step0b: 'US_LONG_WAVE3 disabled: pooled result masks losing windows 1 and 4',
});

const SETUPS = Object.freeze({
  JAPAN_MEDIUM_MR: Object.freeze({
    id: 'JAPAN_MEDIUM_MR',
    testedId: 'A__Japan__medium__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t21__full',
    market: 'Japan',
    horizon: 'medium',
    kind: 'mean_reversion',
    tier: 'Tier 1',
    confidence: 80.8,
    expectedPf: 1.753,
    sampleSize: 490,
    picksPerMonth: 22.273,
    breakevenWinRate: 70.61,
    trigger: 'williams_r10_lt_minus_95',
    regime: 'vol_skip_top30',
    stopAtr: 2.5,
    timeStopBars: 21,
    partial: false,
    amendedExits: true,
  }),
  JAPAN_SHORT_MR: Object.freeze({
    id: 'JAPAN_SHORT_MR',
    testedId: 'A__Japan__short__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t5__partial',
    market: 'Japan',
    horizon: 'short',
    kind: 'mean_reversion',
    tier: 'Tier 2 — Lower confidence',
    confidence: 65.4,
    expectedPf: 1.351,
    sampleSize: 523,
    picksPerMonth: 23.773,
    breakevenWinRate: 58.301,
    trigger: 'williams_r10_lt_minus_95',
    regime: 'vol_skip_top30',
    stopAtr: 2.5,
    timeStopBars: 5,
    partial: true,
    amendedExits: true,
  }),
  COMMODITIES_MEDIUM_MR: Object.freeze({
    id: 'COMMODITIES_MEDIUM_MR',
    testedId: 'A__Commodities__medium__close_below_lower_bb20_2__none__sl2.5__t21__partial',
    market: 'Commodities',
    horizon: 'medium',
    kind: 'mean_reversion',
    tier: 'Tier 2 — Lower confidence',
    confidence: 76.3,
    expectedPf: 2.303,
    sampleSize: 38,
    picksPerMonth: 1.727,
    breakevenWinRate: 58.323,
    trigger: 'close_below_lower_bb20_2',
    regime: 'none',
    stopAtr: 2.5,
    timeStopBars: 21,
    partial: true,
    futuresSizing: 'one_lot',
  }),
  US_SHORT_MR: Object.freeze({
    id: 'US_SHORT_MR',
    testedId: 'A__US__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__partial',
    market: 'US',
    horizon: 'short',
    kind: 'mean_reversion',
    tier: 'Experimental',
    experimental: true,
    experimentalLabel: 'Experimental',
    confidence: 59.5,
    expectedPf: 1.01,
    sampleSize: 1881,
    picksPerMonth: 85.5,
    breakevenWinRate: 59.31,
    trigger: 'williams_r10_lt_minus_95',
    regime: 'vol_skip_top30_and_ma50_flat_or_up',
    stopAtr: 2,
    timeStopBars: 5,
    partial: true,
  }),
  JAPAN_LONG_ENGINE: engineCell('JAPAN_LONG_ENGINE', 'Japan', 'long', 43, 1.29, 39.5, 33.62, { amendedExits: true }),
  HK_MEDIUM_ENGINE: engineCell('HK_MEDIUM_ENGINE', 'Hong Kong', 'medium', 21, 1.85, 52.4, 37.35),
  HK_LONG_ENGINE: engineCell('HK_LONG_ENGINE', 'Hong Kong', 'long', 13, 1.41, 46.2, 37.8, { amendedExits: true }),
  GERMANY_MEDIUM_ENGINE: engineCell('GERMANY_MEDIUM_ENGINE', 'Germany', 'medium', 4, 6.31, 75, 32.24, { amendedExits: true }),
  GERMANY_LONG_ENGINE: engineCell('GERMANY_LONG_ENGINE', 'Germany', 'long', 10, 1.53, 50, 39.56, { amendedExits: true }),
  FRANCE_LONG_ENGINE: engineCell('FRANCE_LONG_ENGINE', 'France', 'long', 11, 1.52, 45.4, 35.4, { amendedExits: true }),
  INDIA_LONG_ENGINE: engineCell('INDIA_LONG_ENGINE', 'India', 'long', 21, 1.27, 47.6, 41.63, { signalsOnly: true }),
  COMMODITIES_LONG_ENGINE: engineCell('COMMODITIES_LONG_ENGINE', 'Commodities', 'long', 7, 1.51, 42.9, 33.19, { amendedExits: true }),
  UK_LONG_MOMENTUM: momentumBook('UK_LONG_MOMENTUM', 'UK', 'EWU', 596.76, 40.91, 2.55, 184),
  FRANCE_LONG_MOMENTUM: momentumBook('FRANCE_LONG_MOMENTUM', 'France', 'EWQ', 261.12, 59.13, 2.036, 184),
});

function momentumBook(id, market, benchmark, fullSampleReturnPct, benchmarkReturnPct, expectedPf, sampleSize) {
  return Object.freeze({
    id,
    testedId: 'executable-k1-2026-10-06',
    market,
    horizon: 'long',
    kind: 'momentum',
    tier: 'Experimental',
    experimental: true,
    experimentalLabel: 'Experimental',
    benchmark,
    fullSampleReturnPct,
    benchmarkReturnPct,
    expectedPf,
    sampleSize,
    confidence: null,
    picksPerMonth: 1,
    breakevenWinRate: 0,
    holdMonths: 6,
    stops: false,
    partial: false,
    amendedExits: false,
    k: 1,
  });
}

function engineCell(id, market, horizon, sampleSize, expectedPf, confidence, breakevenWinRate, extra = {}) {
  return Object.freeze({
    id,
    testedId: `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_on`,
    market,
    horizon,
    kind: 'current_engine',
    source: 'Current engine',
    tier: 'Current engine — Experimental',
    experimental: true,
    experimentalLabel: 'Current engine — Experimental',
    confidence,
    expectedPf,
    sampleSize,
    picksPerMonth: null,
    breakevenWinRate,
    partial: true,
    amendedExits: extra.amendedExits === true,
    signalsOnly: extra.signalsOnly === true,
    replay: Object.freeze({
      trades: sampleSize,
      profitFactor: expectedPf,
      winRate: confidence,
      sectorOverlay: 'on',
      windows: 'all four combined',
    }),
  });
}

const CELL_SETUP = Object.freeze(Object.fromEntries(
  Object.values(SETUPS)
    .filter(setup => setup.kind !== 'momentum')
    .map(setup => [`${setup.market}|${setup.horizon}|buy`, setup.id]),
));

function dateOf(bar) {
  const value = Number(bar?.t);
  return value > 0
    ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10)
    : null;
}

const MARKET_SESSION = Object.freeze({
  US: { timeZone: 'America/New_York', closeMinutes: 16 * 60 },
  Japan: { timeZone: 'Asia/Tokyo', closeMinutes: 15 * 60 },
  'Hong Kong': { timeZone: 'Asia/Hong_Kong', closeMinutes: 16 * 60 },
  UK: { timeZone: 'Europe/London', closeMinutes: 16 * 60 + 30 },
  Germany: { timeZone: 'Europe/Berlin', closeMinutes: 17 * 60 + 30 },
  France: { timeZone: 'Europe/Paris', closeMinutes: 17 * 60 + 30 },
  India: { timeZone: 'Asia/Kolkata', closeMinutes: 15 * 60 + 30 },
  Commodities: { timeZone: 'America/New_York', closeMinutes: 17 * 60 },
});

function zonedParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

function completedDailyBars(bars, market, now = new Date()) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const session = MARKET_SESSION[market];
  if (!session) return bars.slice();
  const local = zonedParts(now, session.timeZone);
  const lastDate = dateOf(bars.at(-1));
  if (lastDate === local.date && local.minutes < session.closeMinutes) {
    return bars.slice(0, -1);
  }
  return bars.slice();
}

function completedSignalIndex(bars, market, now = new Date()) {
  return completedDailyBars(bars, market, now).length - 1;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function volatilityRegimeAt(bars, index) {
  if (!Array.isArray(bars) || index < 270) return null;
  const closes = bars.map(bar => Number(bar.c));
  const realised = cursor => {
    const returns = [];
    for (let point = cursor - 19; point <= cursor; point++) {
      const previous = closes[point - 1];
      if (!(previous > 0) || !Number.isFinite(closes[point])) return null;
      returns.push(closes[point] / previous - 1);
    }
    const average = mean(returns);
    return Math.sqrt(mean(returns.map(value => (value - average) ** 2)));
  };
  const current = realised(index);
  const history = [];
  for (let cursor = index - 251; cursor <= index; cursor++) history.push(realised(cursor));
  const sorted = history.filter(Number.isFinite).sort((a, b) => a - b);
  if (!Number.isFinite(current) || sorted.length !== 252) return null;
  const ma50 = mean(closes.slice(index - 49, index + 1));
  const priorMa50 = mean(closes.slice(index - 59, index - 9));
  return {
    volatility: current,
    q70: sorted[Math.floor((sorted.length - 1) * 0.7)],
    ma50FlatOrUp: ma50 >= priorMa50,
  };
}

function alignedIndex(bars, date) {
  for (let index = bars.length - 1; index >= 0; index--) {
    if (dateOf(bars[index]) === date) return index;
  }
  return -1;
}

function passesSetupRegime(setup, marketBars, signalDate) {
  if (setup.regime === 'none') return true;
  const index = alignedIndex(marketBars || [], signalDate);
  const regime = volatilityRegimeAt(marketBars, index);
  if (!regime || !(regime.volatility < regime.q70)) return false;
  return setup.regime !== 'vol_skip_top30_and_ma50_flat_or_up' || regime.ma50FlatOrUp;
}

function setupForCell(market, horizon, side = 'buy') {
  const id = CELL_SETUP[`${market}|${horizon}|${String(side).toLowerCase()}`];
  return id ? SETUPS[id] : null;
}

function wave3SignalAt(bars, index) {
  if (index < 252) return false;
  const close = Number(bars[index]?.c);
  const start = Number(bars[index - 252]?.c);
  const skip = Number(bars[index - 21]?.c);
  const ma200 = sma(bars, index, 200);
  return close > 0 && start > 0 && skip > 0 && ma200 > 0
    && skip / start - 1 > 0
    && close > ma200;
}

function setupSignalAt(setupId, context, signalIndex) {
  const setup = SETUPS[setupId];
  const bars = context?.bars || [];
  if (!setup || setup.kind === 'current_engine' || signalIndex < 0 || signalIndex >= bars.length) return false;
  if (setup.kind === 'wave3') {
    return wave3SignalAt(bars, signalIndex);
  }
  const signalDate = dateOf(bars[signalIndex]);
  if (!passesSetupRegime(setup, context.marketBars || [], signalDate)) return false;
  const marketRegime = context.marketRegime;
  const sectorBars = context.sectorBars || context.marketBars || [];
  const sectorIndex = context.sectorIndex
    || new Map(sectorBars.map((bar, index) => [dateOf(bar), index]));
  return meanReversionSignalAt(
    bars,
    signalIndex,
    { trigger: setup.trigger },
    marketRegime,
    sectorBars,
    sectorIndex,
  );
}

function evidenceMissGate(setupId, context, signalIndex) {
  const setup = SETUPS[setupId];
  const bars = context?.bars || [];
  if (!setup || signalIndex < 0 || signalIndex >= bars.length) return 'no completed bar';
  if (setup.kind === 'wave3') {
    if (!wave3SignalAt(bars, signalIndex)) return 'trigger';
    return 'entry or atr';
  }
  const signalDate = dateOf(bars[signalIndex]);
  if (!passesSetupRegime(setup, context.marketBars || [], signalDate)) return 'regime';
  const sectorBars = context.sectorBars || context.marketBars || [];
  const sectorIndex = context.sectorIndex
    || new Map(sectorBars.map((bar, index) => [dateOf(bar), index]));
  if (!meanReversionSignalAt(
    bars,
    signalIndex,
    { trigger: setup.trigger },
    context.marketRegime,
    sectorBars,
    sectorIndex,
  )) return 'trigger';
  return 'entry or atr';
}

function setupEntryPlan(setupId, context, signalIndex, entryOverride = null) {
  const setup = SETUPS[setupId];
  const bars = context?.bars || [];
  if (!setup || !setupSignalAt(setupId, context, signalIndex)) return null;
  const entry = Number(entryOverride ?? bars[signalIndex + 1]?.o ?? bars[signalIndex]?.c);
  const atrValue = setup.kind === 'wave3'
    ? mrAtr(bars, signalIndex, 20)
    : mrAtr(bars, signalIndex, 14);
  if (!(entry > 0) || !(atrValue > 0)) return null;
  const levels = setup.kind === 'wave3'
    ? {
      entry,
      stop: entry - setup.stopAtr * atrValue,
      target1: null,
      target2: null,
      atr: atrValue,
    }
    : {
      entry,
      stop: entry - setup.stopAtr * atrValue,
      target1: entry + atrValue,
      target2: setup.partial ? entry + 2 * atrValue : null,
      atr: atrValue,
    };
  return {
    setupId,
    testedId: setup.testedId,
    tier: setup.tier,
    experimental: setup.experimental === true,
    experimentalLabel: setup.experimental ? 'Experimental' : null,
    market: setup.market,
    horizon: setup.horizon,
    side: 'buy',
    score: 100,
    confidence: setup.confidence,
    expectedPf: setup.expectedPf,
    sampleSize: setup.sampleSize,
    picksPerMonth: setup.picksPerMonth,
    breakevenWinRate: setup.breakevenWinRate,
    signalDate: dateOf(bars[signalIndex]),
    entryTiming: 'next_session_open',
    levels,
    inputs: {
      trigger: setup.trigger || 'wave3_12_to_1_momentum_above_ma200',
      regime: setup.regime || 'wave3_baseline',
      signalClose: Number(bars[signalIndex]?.c),
      atr: atrValue,
    },
    exits: setup.kind === 'wave3'
      ? {
        initialStopAtr: setup.stopAtr,
        trailingStopAtr: setup.trailAtr,
        maExit: 200,
        timeStopBars: setup.timeStopBars,
        stopFirst: true,
      }
      : {
        targetAtr: 1,
        runnerTargetAtr: setup.partial ? 2 : null,
        stopAtr: setup.stopAtr,
        timeStopBars: setup.timeStopBars,
        partial: setup.partial,
        stopFirst: true,
      },
  };
}

function rebaseSetupLevels(setupId, fill, atrValue) {
  const setup = SETUPS[setupId];
  const entry = Number(fill);
  const atrValueNumber = Number(atrValue);
  if (!setup || setup.kind !== 'mean_reversion' || !(entry > 0) || !(atrValueNumber > 0)) return null;
  return {
    entry,
    atr: atrValueNumber,
    stop: entry - setup.stopAtr * atrValueNumber,
    target1: entry + atrValueNumber,
    target2: setup.partial ? entry + 2 * atrValueNumber : null,
  };
}

function setupExitDecision(setupId, position, bars, barIndex) {
  const setup = SETUPS[setupId];
  const bar = bars?.[barIndex];
  if (!setup || !position || !bar) return { action: 'hold', reason: 'insufficient_input' };
  const entry = Number(position.entry);
  const heldBars = Math.max(0, barIndex - Number(position.entryIndex));
  const high = Number(bar.h);
  const low = Number(bar.l);
  const close = Number(bar.c);
  if (setup.kind === 'mean_reversion') {
    const oneLot = position.oneLot === true && setup.amendedExits === true;
    if (oneLot && position.tp1Hit && barIndex > Number(position.entryIndex)) {
      position.stop = Math.max(entry, ratchetTslFromDailyBar(
        Number(position.stop) || entry, bars[barIndex - 1], bar, false, entry,
      ));
    }
    const stop = position.tp1Hit
      ? (oneLot ? Number(position.stop) : entry)
      : Number(position.stop);
    if (low <= stop) return { action: 'exit', price: stop, reason: position.tp1Hit ? 'runner_stop' : 'stop' };
    const target = position.tp1Hit ? Number(position.target2 || entry + 2 * Number(position.atr)) : Number(position.target1);
    if (high >= target) {
      if (oneLot && !position.tp1Hit) {
        return { action: 'arm', price: target, reason: 'target1_trigger' };
      }
      if (setup.partial && !position.tp1Hit) {
        return { action: 'partial', fraction: 0.5, price: target, reason: 'target1' };
      }
      return { action: 'exit', price: target, reason: position.tp1Hit ? 'runner_target' : 'target' };
    }
    if (!setup.amendedExits && heldBars >= setup.timeStopBars - 1) {
      return { action: 'exit', price: close, reason: position.tp1Hit ? 'time_after_tp1' : 'time' };
    }
    return { action: 'hold', reason: 'open' };
  }

  if (setup.kind === 'momentum') {
    const holdSessions = Math.max(1, Number(setup.holdMonths) || 6) * 21;
    if (heldBars >= holdSessions) {
      return { action: 'exit', price: close, reason: 'hold_complete' };
    }
    return { action: 'hold', reason: 'open' };
  }

  const currentAtr = mrAtr(bars, barIndex, 20) || Number(position.atr);
  const favorable = Math.max(Number(position.favorable ?? entry), high);
  const trailingStop = favorable - setup.trailAtr * currentAtr;
  const stop = Math.max(Number(position.stop), trailingStop);
  if (low <= stop) {
    const open = Number(bar.o) || close;
    return { action: 'exit', price: Math.min(open, stop), reason: 'stop', favorable, stop };
  }
  const ma200 = sma(bars, barIndex, 200);
  if (ma200 > 0 && close < ma200) {
    return { action: 'exit', price: close, reason: 'trend_exit', favorable, stop };
  }
  if (heldBars >= setup.timeStopBars - 1) {
    return { action: 'exit', price: close, reason: 'time_exit', favorable, stop };
  }
  return { action: 'hold', reason: 'open', favorable, stop };
}

function simulateSetupTrade(setupId, context, signalIndex, entryOverride = null, options = {}) {
  const plan = setupEntryPlan(setupId, context, signalIndex, entryOverride);
  if (!plan) return null;
  const bars = context.bars || [];
  const entryIndex = signalIndex + 1;
  const state = {
    entry: plan.levels.entry,
    entryIndex,
    atr: plan.levels.atr,
    stop: plan.levels.stop,
    target1: plan.levels.target1,
    target2: plan.levels.target2 || (options.oneLot ? plan.levels.entry + 2 * plan.levels.atr : null),
    favorable: plan.levels.entry,
    tp1Hit: false,
    oneLot: options.oneLot === true,
  };
  const setup = SETUPS[setupId];
  const lastIndex = setup.amendedExits
    ? bars.length - 1
    : Math.min(bars.length - 1, entryIndex + setup.timeStopBars - 1);
  const decisions = [];
  let realised = 0;
  let remaining = 1;
  for (let index = entryIndex; index <= lastIndex; index++) {
    const decision = setupExitDecision(setupId, state, bars, index);
    decisions.push({ index, ...decision });
    if (decision.favorable != null) state.favorable = decision.favorable;
    if (decision.stop != null) state.stop = decision.stop;
    if (decision.action === 'arm') {
      state.tp1Hit = true;
      state.stop = state.entry;
      continue;
    }
    if (decision.action === 'partial') {
      realised += 0.5 * (decision.price / state.entry - 1);
      remaining = 0.5;
      state.tp1Hit = true;
      continue;
    }
    if (decision.action === 'exit') {
      realised += remaining * (decision.price / state.entry - 1);
      const cost = applyCosts(realised, {
        market: setup.market,
        symbol: context.symbol,
        side: 'buy',
        holdDays: index - entryIndex,
      });
      return {
        plan,
        entryIndex,
        exitIndex: index,
        exit: decision,
        decisions,
        grossRet: realised,
        ret: cost.netReturn,
        status: decision.reason,
      };
    }
  }
  return null;
}

module.exports = {
  VERSION,
  GO_LIVE,
  SETUPS,
  CELL_SETUP,
  setupForCell,
  volatilityRegimeAt,
  passesSetupRegime,
  MARKET_SESSION,
  completedDailyBars,
  completedSignalIndex,
  wave3SignalAt,
  setupSignalAt,
  evidenceMissGate,
  setupEntryPlan,
  rebaseSetupLevels,
  setupExitDecision,
  simulateSetupTrade,
};
