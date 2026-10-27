'use strict';

const { sma, atr, rsi, williamsR } = require('./mean-reversion');
const { applyCosts } = require('./cost-model');

const STUDY_ID = 'regime-sell-hedge-v1';
const EXPECTED_BH_FAMILY_SIZE = 1954;
const MARKETS = Object.freeze([
  'US', 'Japan', 'Hong Kong', 'UK', 'Germany', 'France',
  'India', 'Commodities', 'Crypto',
]);
const HORIZONS = Object.freeze(['short', 'medium']);
const TRIGGERS = Object.freeze([
  'rsi2_gt_95', 'close_above_upper_bb20_2', 'williams_r10_gt_minus_5',
]);
const REGIMES = Object.freeze([
  'none', 'vol_skip_top30', 'vol_skip_top30_and_ma50_flat_or_up',
]);
const STOPS = Object.freeze([1.5, 2, 2.5]);
const TIME_STOPS = Object.freeze({ short: [5, 10], medium: [10, 21] });
const HEDGE_ETFS = Object.freeze({
  US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH',
  UK: 'EWU', Germany: 'EWG', France: 'EWQ',
});
// Frozen before the research run; retain the then-active Wave 3 cell in this
// historical BH family even though it is now disabled for paper go-live.
const HEDGE_SETUP_IDS = Object.freeze([
  'JAPAN_MEDIUM_MR',
  'JAPAN_SHORT_MR',
  'COMMODITIES_MEDIUM_MR',
  'US_LONG_WAVE3',
  'US_SHORT_MR',
]);

function upperBollinger(bars, index, period = 20, deviations = 2) {
  const mean = sma(bars, index, period);
  if (mean == null) return null;
  let variance = 0;
  for (let i = index - period + 1; i <= index; i++) variance += (Number(bars[i].c) - mean) ** 2;
  return mean + deviations * Math.sqrt(variance / period);
}

function confirmedDowntrend(bars, index) {
  const close = Number(bars[index]?.c);
  const ma200 = sma(bars, index, 200);
  const ma50 = sma(bars, index, 50);
  const priorMa50 = sma(bars, index - 10, 50);
  return close > 0 && ma200 > 0 && ma50 > 0 && priorMa50 > 0
    && close < ma200 && ma50 < priorMa50;
}

function sellTriggerAt(bars, index, trigger) {
  const close = Number(bars[index]?.c);
  if (trigger === 'rsi2_gt_95') return rsi(bars, index, 2) > 95;
  if (trigger === 'close_above_upper_bb20_2') return close > upperBollinger(bars, index, 20, 2);
  if (trigger === 'williams_r10_gt_minus_5') return williamsR(bars, index, 10) > -5;
  return false;
}

function sellSignalAt(bars, index, candidate, benchmarkBars, benchmarkIndex) {
  if (!confirmedDowntrend(benchmarkBars, benchmarkIndex)) return false;
  const close = Number(bars[index]?.c);
  const ma200 = sma(bars, index, 200);
  return close > 0 && ma200 > 0 && close < ma200
    && sellTriggerAt(bars, index, candidate.trigger);
}

function simulateSellTrade(bars, signalIndex, candidate, options = {}) {
  const entryIndex = signalIndex + 1;
  const entry = Number(bars[entryIndex]?.o);
  const atrValue = atr(bars, signalIndex, 14);
  if (!(entry > 0) || !(atrValue > 0)) return null;
  const target = entry - atrValue;
  const stop = entry + candidate.stopAtr * atrValue;
  const runnerTarget = entry - 2 * atrValue;
  let realised = 0;
  let remaining = 1;
  let tp1Hit = false;
  const finalIndex = Math.min(bars.length - 1, entryIndex + candidate.timeStopBars - 1);
  for (let i = entryIndex; i <= finalIndex; i++) {
    const high = Number(bars[i].h);
    const low = Number(bars[i].l);
    const activeStop = tp1Hit ? entry : stop;
    if (high >= activeStop) {
      realised += remaining * (entry - activeStop) / entry;
      const cost = applyCosts(realised, {
        market: options.market, symbol: options.symbol, side: 'sell', holdDays: i - entryIndex,
      });
      return { ret: cost.netReturn, entryIndex, exitIndex: i, status: tp1Hit ? 'runner_stop' : 'stop' };
    }
    const activeTarget = candidate.partial && tp1Hit ? runnerTarget : target;
    if (low <= activeTarget) {
      if (candidate.partial && !tp1Hit) {
        realised += 0.5 * (entry - target) / entry;
        remaining = 0.5;
        tp1Hit = true;
        continue;
      }
      realised += remaining * (entry - activeTarget) / entry;
      const cost = applyCosts(realised, {
        market: options.market, symbol: options.symbol, side: 'sell', holdDays: i - entryIndex,
      });
      return { ret: cost.netReturn, entryIndex, exitIndex: i, status: tp1Hit ? 'runner_target' : 'target' };
    }
  }
  const exit = Number(bars[finalIndex].c);
  realised += remaining * (entry - exit) / entry;
  const cost = applyCosts(realised, {
    market: options.market, symbol: options.symbol, side: 'sell',
    holdDays: finalIndex - entryIndex,
  });
  return { ret: cost.netReturn, entryIndex, exitIndex: finalIndex, status: tp1Hit ? 'time_after_tp1' : 'time' };
}

function registry() {
  const rows = [];
  for (const market of MARKETS) {
    for (const horizon of HORIZONS) {
      for (const trigger of TRIGGERS) {
        for (const regime of REGIMES) {
          for (const stopAtr of STOPS) {
            for (const timeStopBars of TIME_STOPS[horizon]) {
              for (const partial of [false, true]) {
                rows.push({
                  id: [
                    'SELL', market, horizon, trigger, regime,
                    `sl${stopAtr}`, `t${timeStopBars}`, partial ? 'partial' : 'full',
                  ].join('__').replace(/\s+/g, '_'),
                  part: 'A', market, horizon, trigger, regime, stopAtr, timeStopBars, partial,
                });
              }
            }
          }
        }
      }
    }
  }
  for (const setupId of HEDGE_SETUP_IDS) {
    for (const hedge of [false, true]) {
      rows.push({
        id: `HEDGE__${setupId}__${hedge ? 'on' : 'off'}`,
        part: 'B', setupId, hedge,
      });
    }
  }
  if (rows.length !== EXPECTED_BH_FAMILY_SIZE) {
    throw new Error(`Family drift: expected ${EXPECTED_BH_FAMILY_SIZE}, found ${rows.length}.`);
  }
  return rows;
}

module.exports = {
  STUDY_ID,
  EXPECTED_BH_FAMILY_SIZE,
  MARKETS,
  HORIZONS,
  TRIGGERS,
  REGIMES,
  STOPS,
  TIME_STOPS,
  HEDGE_ETFS,
  HEDGE_SETUP_IDS,
  confirmedDowntrend,
  sellTriggerAt,
  sellSignalAt,
  simulateSellTrade,
  registry,
};
