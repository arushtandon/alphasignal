'use strict';

const { applyCosts } = require('./cost-model');

function closeAt(bar) { return Number(bar?.c); }
function highAt(bar) { return Number(bar?.h); }
function lowAt(bar) { return Number(bar?.l); }

function sma(bars, index, period, field = closeAt) {
  if (index < period - 1) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const value = field(bars[i]);
    if (!Number.isFinite(value)) return null;
    total += value;
  }
  return total / period;
}

function atr(bars, index, period = 14) {
  if (index < period) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const high = highAt(bars[i]);
    const low = lowAt(bars[i]);
    const previous = closeAt(bars[i - 1]);
    if (![high, low, previous].every(Number.isFinite)) return null;
    total += Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
  }
  return total / period;
}

function rsi(bars, index, period = 2) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const delta = closeAt(bars[i]) - closeAt(bars[i - 1]);
    if (!Number.isFinite(delta)) return null;
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function lowerBollinger(bars, index, period = 20, deviations = 2) {
  const mean = sma(bars, index, period);
  if (mean == null) return null;
  let variance = 0;
  for (let i = index - period + 1; i <= index; i++) variance += (closeAt(bars[i]) - mean) ** 2;
  return mean - deviations * Math.sqrt(variance / period);
}

function williamsR(bars, index, period = 10) {
  if (index < period - 1) return null;
  let highest = -Infinity;
  let lowest = Infinity;
  for (let i = index - period + 1; i <= index; i++) {
    highest = Math.max(highest, highAt(bars[i]));
    lowest = Math.min(lowest, lowAt(bars[i]));
  }
  const close = closeAt(bars[index]);
  return highest > lowest && Number.isFinite(close) ? -100 * (highest - close) / (highest - lowest) : null;
}

function indexForDate(bars, date, index) {
  const target = new Date(date).toISOString().slice(0, 10);
  if (index instanceof Map) return index.get(target) ?? null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (new Date(bars[i].t * 1000).toISOString().slice(0, 10) === target) return i;
  }
  return null;
}

function sectorNotDown(sectorBars, date, index) {
  const i = indexForDate(sectorBars, date, index);
  if (i == null) return false;
  const close = closeAt(sectorBars[i]);
  const ma200 = sma(sectorBars, i, 200);
  const ma50 = sma(sectorBars, i, 50);
  const ma50Prior = sma(sectorBars, i - 10, 50);
  return !(close < ma200 && ma50 != null && ma50Prior != null && ma50 < ma50Prior);
}

function triggerAt(bars, index, trigger) {
  const close = closeAt(bars[index]);
  if (trigger === 'rsi2_lt_5') return rsi(bars, index, 2) < 5;
  if (trigger === 'close_below_lower_bb20_2') return close < lowerBollinger(bars, index, 20, 2);
  if (trigger === 'williams_r10_lt_minus_95') return williamsR(bars, index, 10) < -95;
  return false;
}

function signalAt(bars, index, candidate, marketRegime, sectorBars, sectorIndex) {
  const close = closeAt(bars[index]);
  const ma200 = sma(bars, index, 200);
  const date = new Date(bars[index].t * 1000).toISOString().slice(0, 10);
  const tide = marketRegime?.get(date);
  return Boolean(
    Number.isFinite(close) && ma200 != null && close > ma200
    && tide && tide.trend !== 'down' && !tide.riskOff
    && sectorNotDown(sectorBars, date, sectorIndex)
    && triggerAt(bars, index, candidate.trigger),
  );
}

function targetFor(bars, signalIndex, entry, atrValue, candidate) {
  if (candidate.target === 'prior_close') return closeAt(bars[signalIndex]);
  if (candidate.target === 'one_atr') return entry + atrValue;
  return sma(bars, signalIndex, 20);
}

function simulateTrade(bars, signalIndex, candidate, options = {}) {
  const entryIndex = signalIndex + 1;
  const entry = Number(bars[entryIndex]?.o);
  const atrValue = atr(bars, signalIndex, 14);
  if (!Number.isFinite(entry) || !Number.isFinite(atrValue) || atrValue <= 0) return null;
  const target = targetFor(bars, signalIndex, entry, atrValue, candidate);
  if (!Number.isFinite(target) || target <= entry) return null;
  const stop = entry - candidate.stopAtr * atrValue;
  const runnerTarget = entry + 2 * atrValue;
  let realised = 0;
  let remaining = 1;
  let tp1Hit = false;
  const finalIndex = Math.min(bars.length - 1, entryIndex + candidate.timeStopBars - 1);
  for (let i = entryIndex; i <= finalIndex; i++) {
    const bar = bars[i];
    const high = highAt(bar);
    const low = lowAt(bar);
    const activeStop = tp1Hit ? entry : stop;
    // Prespecified conservative convention for an unobservable intraday order.
    if (low <= activeStop) {
      realised += remaining * (activeStop / entry - 1);
      const cost = applyCosts(realised, { market: options.market, symbol: options.symbol, side: 'buy', holdDays: i - entryIndex });
      return { ret: cost.netReturn, grossRet: realised, entryIndex, exitIndex: i, status: tp1Hit ? 'runner_stop' : 'stop' };
    }
    const activeTarget = candidate.partial && tp1Hit ? runnerTarget : target;
    if (high >= activeTarget) {
      if (candidate.partial && !tp1Hit) {
        realised += 0.5 * (target / entry - 1);
        remaining = 0.5;
        tp1Hit = true;
        continue;
      }
      realised += remaining * (activeTarget / entry - 1);
      const cost = applyCosts(realised, { market: options.market, symbol: options.symbol, side: 'buy', holdDays: i - entryIndex });
      return { ret: cost.netReturn, grossRet: realised, entryIndex, exitIndex: i, status: tp1Hit ? 'runner_target' : 'target' };
    }
  }
  const exit = closeAt(bars[finalIndex]);
  realised += remaining * (exit / entry - 1);
  const cost = applyCosts(realised, { market: options.market, symbol: options.symbol, side: 'buy', holdDays: finalIndex - entryIndex });
  return { ret: cost.netReturn, grossRet: realised, entryIndex, exitIndex: finalIndex, status: tp1Hit ? 'time_after_tp1' : 'time' };
}

module.exports = { sma, atr, rsi, lowerBollinger, williamsR, signalAt, simulateTrade };
