'use strict';

const { sma, atr, williamsR, lowerBollinger } = require('../research/mean-reversion');
const { SETUPS, setupEntryPlan, passesSetupRegime } = require('./evidence-setup-book');
const { evidenceTier } = require('./setup-book-execution');

const HORIZONS = ['short', 'medium', 'long'];
const SUPER_TREND = {
  short: { period: 7, mult: 2 },
  medium: { period: 10, mult: 3 },
  long: { period: 14, mult: 4 },
};

function marketOf(ticker) {
  const symbol = String(ticker || '').toUpperCase();
  if (/=F$/i.test(symbol) || /-USD$/i.test(symbol)) return 'Commodities';
  if (/\.T$/i.test(symbol)) return 'Japan';
  if (/\.HK$/i.test(symbol)) return 'Hong Kong';
  if (/\.L$/i.test(symbol)) return 'UK';
  if (/\.DE$/i.test(symbol)) return 'Germany';
  if (/\.PA$/i.test(symbol)) return 'France';
  if (/\.(NS|BO)$/i.test(symbol)) return 'India';
  return 'US';
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function movingAverage(bars, index, length) {
  if (index < length - 1) return null;
  const closes = [];
  for (let cursor = index - length + 1; cursor <= index; cursor++) closes.push(Number(bars[cursor].c));
  return mean(closes);
}

function williamsTriggerPrice(bars, index, period = 10, threshold = -95) {
  if (index < period - 1) return null;
  let highest = -Infinity;
  let lowest = Infinity;
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    highest = Math.max(highest, Number(bars[cursor].h));
    lowest = Math.min(lowest, Number(bars[cursor].l));
  }
  const range = highest - lowest;
  if (!(range > 0)) return null;
  return highest + (threshold / 100) * range;
}

function returnOver(bars, sessions) {
  const index = bars.length - 1;
  const then = index - sessions;
  if (then < 0) return null;
  const start = Number(bars[then].c);
  const end = Number(bars[index].c);
  return start > 0 ? end / start - 1 : null;
}

function supertrend(bars, period, multiplier) {
  if (!bars || bars.length < period + 3) return null;
  const tr = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = Number(bars[i - 1].c);
    tr[i] = Math.max(
      Number(bars[i].h) - Number(bars[i].l),
      Math.abs(Number(bars[i].h) - prev),
      Math.abs(Number(bars[i].l) - prev),
    );
  }
  let trSum = 0;
  for (let i = 1; i <= period && i < bars.length; i++) trSum += tr[i];
  let finalUpper = null;
  let finalLower = null;
  let direction = 1;
  for (let i = period; i < bars.length; i++) {
    if (i > period) trSum += tr[i] - tr[i - period];
    const atrValue = trSum / period;
    if (!(atrValue > 0)) continue;
    const hl2 = (Number(bars[i].h) + Number(bars[i].l)) / 2;
    const basicUpper = hl2 + multiplier * atrValue;
    const basicLower = hl2 - multiplier * atrValue;
    if (finalUpper == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = Number(bars[i].c) >= basicLower ? 1 : -1;
      continue;
    }
    finalUpper = (basicUpper < finalUpper || Number(bars[i - 1].c) > finalUpper) ? basicUpper : finalUpper;
    finalLower = (basicLower > finalLower || Number(bars[i - 1].c) < finalLower) ? basicLower : finalLower;
    if (direction === 1 && Number(bars[i].c) < finalLower) direction = -1;
    else if (direction === -1 && Number(bars[i].c) > finalUpper) direction = 1;
  }
  return {
    period,
    multiplier,
    direction: direction === 1 ? 'bull' : 'bear',
    value: direction === 1 ? finalLower : finalUpper,
  };
}

function nearestResistance(bars) {
  const index = bars.length - 1;
  const close = Number(bars[index].c);
  let nearest = null;
  const start = Math.max(0, index - 59);
  for (let cursor = start; cursor < index; cursor++) {
    const high = Number(bars[cursor].h);
    if (high > close && (nearest == null || high < nearest)) nearest = high;
  }
  return nearest;
}

function high52(bars) {
  const slice = bars.slice(-252);
  return slice.reduce((max, bar) => Math.max(max, Number(bar.h)), -Infinity);
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}

function distanceForSetup(setup, bars, benchmarkBars) {
  const index = bars.length - 1;
  const close = Number(bars[index].c);
  const ma200 = sma(bars, index, 200);
  const williams = williamsR(bars, index, 10);
  const rules = [];
  if (setup.trigger === 'williams_r10_lt_minus_95') {
    rules.push({
      name: 'Williams %R(10) < -95',
      value: round(williams),
      pass: williams != null && williams < -95,
      triggerPrice: round(williamsTriggerPrice(bars, index, 10, -95)),
    });
  }
  if (setup.trigger === 'close_below_lower_bb20_2') {
    const band = lowerBollinger(bars, index, 20, 2);
    rules.push({
      name: 'Close below lower Bollinger(20, 2)',
      value: round(close),
      pass: band != null && close < band,
      triggerPrice: round(band),
    });
  }
  if (setup.kind === 'mean_reversion') {
    rules.push({
      name: 'Close above MA200',
      value: round(close),
      pass: ma200 != null && close > ma200,
      triggerPrice: round(ma200),
    });
    const regimePass = benchmarkBars && benchmarkBars.length
      ? passesSetupRegime(setup, benchmarkBars, dateOf(bars[index]))
      : null;
    rules.push({
      name: setup.regime === 'none' ? 'No vol filter' : `Vol filter ${setup.regime}`,
      value: regimePass,
      pass: regimePass !== false,
      triggerPrice: null,
      note: 'Benchmark filter, not a price on this ticker',
    });
  }
  if (setup.kind === 'current_engine') {
    const range = atr(bars, index, 14);
    const stop = close - 2.5 * range;
    const risk = close - stop;
    const rr = risk > 0 ? range / risk : null;
    rules.push({
      name: 'R:R gate >= 1.1',
      value: round(rr),
      pass: rr != null && rr >= 1.1,
      triggerPrice: round(close + 1.1 * risk),
    });
  }
  return rules;
}

function dateOf(bar) {
  const value = Number(bar && bar.t);
  return value > 0 ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}

function informationalLong(bars, earningsDate) {
  const index = bars.length - 1;
  const entry = Number(bars[index].c);
  const range = atr(bars, index, 14);
  const out = {};
  for (const horizon of HORIZONS) {
    const stopAtr = horizon === 'short' ? 2 : 2.5;
    const stop = entry - stopAtr * range;
    const target1 = entry + range;
    const target2 = entry + 2 * range;
    const risk = entry - stop;
    out[horizon] = {
      entry: round(entry),
      stop: round(stop),
      target1: round(target1),
      target2: round(target2),
      rewardRisk: risk > 0 ? round((target1 - entry) / risk) : null,
      earningsDate: earningsDate || null,
      label: 'informational, not a validated setup',
    };
  }
  return out;
}

function splitReasons(conditions) {
  const buy = [];
  const notBuy = [];
  for (const condition of conditions || []) {
    if (/block|falling|extended|below MA|not a break/i.test(condition)) notBuy.push(condition);
    else buy.push(condition);
  }
  return { buy, notBuy };
}

function buildTickerView(input) {
  const ticker = String(input.ticker || '').toUpperCase();
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const market = input.market || marketOf(ticker);
  const commodity = market === 'Commodities';
  const index = bars.length - 1;
  const close = index >= 0 ? Number(bars[index].c) : null;
  const ma50 = index >= 0 ? movingAverage(bars, index, 50) : null;
  const ma200 = index >= 0 ? movingAverage(bars, index, 200) : null;
  const ma50Prev = index >= 21 ? movingAverage(bars, index - 21, 50) : null;
  const ma200Prev = index >= 21 ? movingAverage(bars, index - 21, 200) : null;
  const range = index >= 0 ? atr(bars, index, 14) : null;
  const stock6m = returnOver(bars, 126);
  const bench6m = returnOver(input.benchmarkBars || [], 126);
  const paused = input.paused || (() => false);
  const setups = Object.values(SETUPS).filter(setup => setup.market === market && !paused(setup.id));
  let active = null;
  const distance = [];
  if (index >= 0 && input.benchmarkBars && input.marketRegime) {
    const context = {
      bars,
      marketBars: input.benchmarkBars,
      sectorBars: input.sectorBars || input.benchmarkBars,
      marketRegime: input.marketRegime,
    };
    for (const setup of setups) {
      const plan = setupEntryPlan(setup.id, context, index);
      if (plan && (!active || evidenceTier(setup.id) < evidenceTier(active.setupId))) {
        active = { setupId: setup.id, tier: setup.tier };
      }
      distance.push({
        setupId: setup.id,
        tier: setup.tier,
        horizon: setup.horizon,
        rules: distanceForSetup(setup, bars, input.benchmarkBars),
      });
    }
  }
  const reasons = {};
  for (const horizon of HORIZONS) {
    const raw = input.quant && input.quant[horizon];
    reasons[horizon] = splitReasons(raw && raw.conditions);
  }
  const lists = input.danelfinLists || {};
  let danelfin;
  if (lists.ai10 && lists.ai10.has(ticker)) danelfin = { score: 10, side: 'buy', text: 'AI 10' };
  else if (lists.ai1 && lists.ai1.has(ticker)) danelfin = { score: 1, side: 'sell', text: 'AI 1' };
  else danelfin = { score: null, side: null, text: "not in today's lists" };

  return {
    ticker,
    market,
    informational: true,
    writes: [],
    status: active
      ? { label: active.setupId, setupId: active.setupId, tier: active.tier }
      : { label: 'No active setup', setupId: null, tier: null },
    distance,
    trend: {
      close: round(close),
      ma50: round(ma50),
      ma200: round(ma200),
      ma50Slope: ma50 != null && ma50Prev != null ? round(ma50 - ma50Prev) : null,
      ma200Slope: ma200 != null && ma200Prev != null ? round(ma200 - ma200Prev) : null,
      supertrend: Object.fromEntries(HORIZONS.map(horizon => [horizon, supertrend(bars, SUPER_TREND[horizon].period, SUPER_TREND[horizon].mult)])),
      momentum12_1: round((() => {
        if (index < 252) return null;
        const monthAgo = Number(bars[index - 21].c);
        const yearAgo = Number(bars[index - 252].c);
        return yearAgo > 0 && monthAgo > 0 ? monthAgo / yearAgo - 1 : null;
      })()),
      rs6m: stock6m != null && bench6m != null ? round(stock6m - bench6m) : null,
      atrPct: close > 0 && range > 0 ? round(range / close) : null,
    },
    reasons,
    structuralCaps: input.structuralCaps || [],
    ifLong: index >= 0 ? informationalLong(bars, input.earningsDate) : {},
    targets: {
      oneAtr: close != null && range > 0 ? round(close + range) : null,
      twoAtr: close != null && range > 0 ? round(close + 2 * range) : null,
      nearestResistance: index >= 0 ? round(nearestResistance(bars)) : null,
      high52: index >= 0 ? round(high52(bars)) : null,
      analystConsensus: input.analystConsensus == null ? null : {
        price: input.analystConsensus,
        label: 'analyst consensus',
      },
    },
    fundamentals: commodity ? null : (input.fundamentals || { piotroski: null, valuation: null, quality: null }),
    danelfin,
  };
}

async function assembleTickerView(ticker, deps) {
  const symbol = String(ticker || '').toUpperCase();
  const market = marketOf(symbol);
  const bars = await deps.loadBars(symbol);
  const benchmarkSymbol = market === 'Japan' ? 'EWJ' : (market === 'Commodities' ? 'DBC' : 'SPY');
  const benchmarkBars = await deps.loadBars(benchmarkSymbol);
  const quant = await deps.rawQuant(symbol, bars);
  const structuralCaps = await deps.structuralCaps(symbol, quant);
  const fundamentals = market === 'Commodities' ? null : await deps.fundamentals(symbol);
  return buildTickerView({
    ticker: symbol,
    market,
    bars,
    benchmarkBars,
    marketRegime: await deps.marketRegime(benchmarkBars),
    quant,
    structuralCaps,
    earningsDate: await deps.earningsDate(symbol),
    analystConsensus: await deps.analystConsensus(symbol),
    fundamentals,
    danelfinLists: await deps.danelfinLists(),
    paused: deps.paused,
  });
}

module.exports = { marketOf, buildTickerView, assembleTickerView, SUPER_TREND };
