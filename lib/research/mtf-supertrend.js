'use strict';

const PARAMS = Object.freeze({
  short: Object.freeze({ period: 10, multiplier: 3 }),
  medium: Object.freeze({ period: 10, multiplier: 3 }),
  long: Object.freeze({ period: 10, multiplier: 3 })
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function aggregateByCount(bars, count) {
  const size = Math.max(1, Math.floor(Number(count) || 1));
  const out = [];
  for (let start = 0; start < (bars || []).length; start += size) {
    const group = bars.slice(start, start + size);
    if (!group.length) continue;
    const valid = group.filter(bar => finite(bar && bar.c) != null);
    if (!valid.length) continue;
    out.push({
      t: valid[valid.length - 1].t,
      o: finite(valid[0].o) ?? finite(valid[0].c),
      h: Math.max(...valid.map(bar => finite(bar.h) ?? finite(bar.c))),
      l: Math.min(...valid.map(bar => finite(bar.l) ?? finite(bar.c))),
      c: finite(valid[valid.length - 1].c),
      v: valid.reduce((sum, bar) => sum + (finite(bar.v) || 0), 0)
    });
  }
  return out;
}

function aggregateByWeek(bars) {
  const groups = new Map();
  for (const bar of bars || []) {
    const ts = Number(bar && bar.t);
    if (!(ts > 0)) continue;
    const date = new Date((ts < 1e12 ? ts * 1000 : ts));
    const day = (date.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
    const key = monday.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return [...groups.values()].map(group => aggregateByCount(group, group.length)[0]).filter(Boolean);
}

function calcSupertrend(bars, period, multiplier) {
  if (!Array.isArray(bars) || bars.length < period + 3) return null;
  const tr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const prev = finite(bars[i - 1].c);
    const high = finite(bars[i].h);
    const low = finite(bars[i].l);
    if (prev == null || high == null || low == null) return null;
    tr[i] = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let upper = null;
  let lower = null;
  let direction = 1;
  let previousDirection = 1;
  for (let i = period; i < bars.length; i++) {
    if (i > period) sum += tr[i] - tr[i - period];
    const atr = sum / period;
    const high = finite(bars[i].h);
    const low = finite(bars[i].l);
    const close = finite(bars[i].c);
    const previousClose = finite(bars[i - 1].c);
    const midpoint = (high + low) / 2;
    const basicUpper = midpoint + multiplier * atr;
    const basicLower = midpoint - multiplier * atr;
    if (upper == null) {
      upper = basicUpper;
      lower = basicLower;
      direction = close >= basicLower ? 1 : -1;
      previousDirection = direction;
      continue;
    }
    upper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
    lower = basicLower > lower || previousClose < lower ? basicLower : lower;
    previousDirection = direction;
    if (direction === 1 && close < lower) direction = -1;
    else if (direction === -1 && close > upper) direction = 1;
  }
  return {
    direction: direction === 1 ? 'bull' : 'bear',
    value: direction === 1 ? lower : upper,
    flippedBull: direction === 1 && previousDirection === -1,
    flippedBear: direction === -1 && previousDirection === 1
  };
}

function atr(bars, length = 14) {
  if (!Array.isArray(bars) || bars.length < length + 1) return null;
  const values = [];
  for (let i = bars.length - length; i < bars.length; i++) {
    const prev = finite(bars[i - 1].c);
    const high = finite(bars[i].h);
    const low = finite(bars[i].l);
    values.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function structure40(bars) {
  if (!Array.isArray(bars) || bars.length < 42) return null;
  const latest = bars[bars.length - 1];
  const prior = bars.slice(-41, -1);
  const high = Math.max(...prior.map(bar => finite(bar.h)));
  const low = Math.min(...prior.map(bar => finite(bar.l)));
  const range = high - low;
  if (!(range > 0)) return null;
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786].map(ratio => ({
    ratio,
    price: low + ratio * range
  }));
  return {
    close: finite(latest.c),
    open: finite(latest.o) ?? finite(latest.c),
    high,
    low,
    midpoint: low + range * 0.5,
    atr: atr(bars),
    fibonacci: levels
  };
}

function momentum(bars) {
  if (!Array.isArray(bars) || bars.length < 22) return null;
  const closes = bars.map(bar => finite(bar.c));
  if (closes.some(value => value == null || value <= 0)) return null;
  const n = closes.length;
  const roc5 = closes[n - 1] / closes[n - 6] - 1;
  const roc20 = closes[n - 1] / closes[n - 21] - 1;
  const previousRoc5 = closes[n - 2] / closes[n - 7] - 1;
  const acceleration = roc5 - previousRoc5;
  const recent = closes.slice(-10);
  const xMean = (recent.length - 1) / 2;
  const yMean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < recent.length; i++) {
    numerator += (i - xMean) * (recent[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  const slopePctPerBar = denominator > 0 && yMean > 0
    ? (numerator / denominator) / yMean : 0;
  return { roc5, roc20, acceleration, slopePctPerBar };
}

function dailyHlc(dailyBars) {
  if (!Array.isArray(dailyBars) || dailyBars.length < 7) return null;
  const latest = dailyBars[dailyBars.length - 1];
  const previous = dailyBars[dailyBars.length - 2];
  const high = finite(latest.h);
  const low = finite(latest.l);
  const close = finite(latest.c);
  const rangePosition = high > low ? (close - low) / (high - low) : 0.5;
  const prior5 = dailyBars.slice(-6, -1);
  return {
    high,
    low,
    close,
    rangePosition,
    higherHighHigherLow: high > finite(previous.h) && low > finite(previous.l),
    lowerHighLowerLow: high < finite(previous.h) && low < finite(previous.l),
    breaksPrior5High: close > Math.max(...prior5.map(bar => finite(bar.h))),
    breaksPrior5Low: close < Math.min(...prior5.map(bar => finite(bar.l)))
  };
}

function frameScore(frame, side) {
  const sell = side === 'sell';
  const stAligned = frame.supertrend && frame.supertrend.direction === (sell ? 'bear' : 'bull');
  const momentumAligned = frame.momentum && (sell
    ? frame.momentum.roc5 < 0 && frame.momentum.roc20 < 0 && frame.momentum.slopePctPerBar < 0
    : frame.momentum.roc5 > 0 && frame.momentum.roc20 > 0 && frame.momentum.slopePctPerBar > 0);
  const accelerationAligned = frame.momentum && (sell
    ? frame.momentum.acceleration < 0 : frame.momentum.acceleration > 0);
  return { stAligned, momentumAligned, accelerationAligned };
}

function evaluateMtf(primaryBars, higherBars, horizon, side, dailyBars = primaryBars, paramsOverride = null) {
  const params = paramsOverride || PARAMS[horizon] || PARAMS.medium;
  const primaryStructure = structure40(primaryBars);
  const higherStructure = structure40(higherBars);
  if (!primaryStructure || !higherStructure) return null;
  const primary = {
    supertrend: calcSupertrend(primaryBars, params.period, params.multiplier),
    structure: primaryStructure,
    momentum: momentum(primaryBars)
  };
  const higher = {
    supertrend: calcSupertrend(higherBars, params.period, params.multiplier),
    structure: higherStructure,
    momentum: momentum(higherBars)
  };
  const hlc = dailyHlc(dailyBars);
  if (!primary.supertrend || !higher.supertrend || !primary.momentum || !higher.momentum || !hlc) return null;
  const sell = side === 'sell';
  const p = frameScore(primary, side);
  const h = frameScore(higher, side);
  const allLevels = [
    primaryStructure.low,
    primaryStructure.high,
    ...primaryStructure.fibonacci.map(level => level.price),
    higherStructure.low,
    higherStructure.high,
    ...higherStructure.fibonacci.map(level => level.price)
  ].filter(Number.isFinite);
  const supports = allLevels.filter(level => level <= hlc.close).sort((a, b) => b - a);
  const resistances = allLevels.filter(level => level >= hlc.close).sort((a, b) => a - b);
  const support = supports[0] ?? null;
  const resistance = resistances[0] ?? null;
  const dailyAtr = atr(dailyBars);
  const levelReaction = sell
    ? resistance != null && dailyAtr > 0 && hlc.high >= resistance - dailyAtr * 0.2
      && hlc.close < resistance && hlc.rangePosition <= 0.45
    : support != null && dailyAtr > 0 && hlc.low <= support + dailyAtr * 0.2
      && hlc.close > support && hlc.rangePosition >= 0.55;
  const hlcRangeAligned = sell ? hlc.rangePosition <= 0.35 : hlc.rangePosition >= 0.65;
  const hlcTrendAligned = sell ? hlc.lowerHighLowerLow : hlc.higherHighHigherLow;
  const hlcBreakout = sell ? hlc.breaksPrior5Low : hlc.breaksPrior5High;
  const score = (p.stAligned ? 20 : 0)
    + (h.stAligned ? 20 : 0)
    + (p.momentumAligned ? 10 : 0)
    + (h.momentumAligned ? 10 : 0)
    + (p.accelerationAligned ? 5 : 0)
    + (h.accelerationAligned ? 5 : 0)
    + (hlcRangeAligned ? 8 : 0)
    + (hlcTrendAligned ? 7 : 0)
    + (hlcBreakout ? 5 : 0)
    + (levelReaction ? 10 : 0);
  return {
    score,
    dualSupertrend: p.stAligned && h.stAligned,
    primaryDirection: primary.supertrend.direction,
    higherDirection: higher.supertrend.direction,
    primarySupport: primaryStructure.low,
    primaryResistance: primaryStructure.high,
    higherSupport: higherStructure.low,
    higherResistance: higherStructure.high,
    support,
    resistance,
    primaryMomentum: primary.momentum,
    higherMomentum: higher.momentum,
    dailyHlc: hlc,
    levelReaction
  };
}

function blendSignal(signal, mtf, side, baseWeight = 0.6) {
  const out = { ...signal };
  const key = side === 'sell' ? 'sellScore' : 'buyScore';
  const base = Number(out[key]) || 0;
  if (!mtf || !mtf.dualSupertrend) {
    out[key] = Math.min(base, 61);
  } else {
    out[key] = Math.max(0, Math.min(95,
      Math.round(base * baseWeight + mtf.score * (1 - baseWeight))));
  }
  out.mtf = mtf;
  return out;
}

module.exports = {
  PARAMS,
  aggregateByCount,
  aggregateByWeek,
  calcSupertrend,
  structure40,
  momentum,
  dailyHlc,
  evaluateMtf,
  blendSignal
};
