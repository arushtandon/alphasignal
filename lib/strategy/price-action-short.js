'use strict';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function avg(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function trueRange(bars, index) {
  const bar = bars[index];
  if (!bar) return null;
  const high = n(bar.h);
  const low = n(bar.l);
  const prevClose = n(bars[index - 1] && bars[index - 1].c);
  if (high == null || low == null) return null;
  if (prevClose == null) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function sliceNums(bars, from, to, field) {
  return bars.slice(Math.max(0, from), Math.max(0, to))
    .map(bar => n(bar && bar[field]))
    .filter(Number.isFinite);
}

/**
 * Causal short-horizon setup measured at the signal close.
 * No future bars and no RSI/MACD are used.
 */
function priceActionSetup(bars, index, side) {
  if (!Array.isArray(bars) || index < 25 || !bars[index]) return null;
  const sell = String(side).toLowerCase() === 'sell';
  const bar = bars[index];
  const close = n(bar.c);
  const high = n(bar.h);
  const low = n(bar.l);
  if (!(close > 0) || high == null || low == null || high < low) return null;

  const priorHigh20 = Math.max(...sliceNums(bars, index - 20, index, 'h'));
  const priorLow20 = Math.min(...sliceNums(bars, index - 20, index, 'l'));
  const priorHigh10 = Math.max(...sliceNums(bars, index - 10, index, 'h'));
  const priorLow10 = Math.min(...sliceNums(bars, index - 10, index, 'l'));
  const recentHigh = Math.max(...sliceNums(bars, index - 5, index, 'h'));
  const recentLow = Math.min(...sliceNums(bars, index - 5, index, 'l'));
  const previousHigh = Math.max(...sliceNums(bars, index - 10, index - 5, 'h'));
  const previousLow = Math.min(...sliceNums(bars, index - 10, index - 5, 'l'));
  const tr20 = avg(Array.from({ length: 20 }, (_, k) => trueRange(bars, index - k)));
  const tr5 = avg(Array.from({ length: 5 }, (_, k) => trueRange(bars, index - k)));
  if (!(tr20 > 0) || !(priorHigh20 > priorLow20)) return null;

  const range = Math.max(high - low, tr20 * 0.05);
  const closeLocation = (close - low) / range;
  const rangeLocation = (close - priorLow20) / (priorHigh20 - priorLow20);
  const compressionRatio = tr5 / tr20;
  const volumes20 = sliceNums(bars, index - 20, index, 'v');
  const volumes3 = sliceNums(bars, index - 3, index, 'v');
  const avgVolume20 = avg(volumes20);
  const avgVolume3 = avg(volumes3);
  const volume = n(bar.v);
  const dryUp = avgVolume20 > 0 && avgVolume3 != null && avgVolume3 <= avgVolume20 * 0.9;
  const expansion = avgVolume20 > 0 && volume != null && volume >= avgVolume20 * 1.15;

  const sweepReclaim = !sell
    ? low < priorLow10 && close > priorLow10 && closeLocation >= 0.65
    : high > priorHigh10 && close < priorHigh10 && closeLocation <= 0.35;
  const structure = !sell
    ? recentLow >= previousLow + tr20 * 0.1
    : recentHigh <= previousHigh - tr20 * 0.1;
  const pressure = !sell
    ? rangeLocation >= 0.72 && priorHigh20 - close <= tr20 * 0.65 && closeLocation >= 0.58
    : rangeLocation <= 0.28 && close - priorLow20 <= tr20 * 0.65 && closeLocation <= 0.42;
  const breakout = !sell ? close > priorHigh20 : close < priorLow20;
  const compressionBreak = compressionRatio <= 0.88 && structure && pressure
    && (dryUp || (breakout && expansion));
  const eligible = sweepReclaim || compressionBreak;

  return {
    eligible,
    pattern: sweepReclaim ? 'liquidity-sweep-reclaim'
      : compressionBreak ? 'compression-break-pressure' : null,
    atr: tr20,
    closeLocation: +closeLocation.toFixed(3),
    rangeLocation: +rangeLocation.toFixed(3),
    compressionRatio: +compressionRatio.toFixed(3),
    structure,
    pressure,
    sweepReclaim,
    breakout,
    dryUp,
    expansion,
    invalidation: !sell ? Math.min(low, recentLow, priorLow10) : Math.max(high, recentHigh, priorHigh10)
  };
}

/**
 * Place the stop beyond observed structure plus an ATR buffer, while ensuring
 * ordinary daily noise has at least 1.15 ATR of room. Reject excessively wide
 * structures instead of shrinking the stop into noise.
 */
function structuralBracket(entry, setup, side, opts = {}) {
  const sell = String(side).toLowerCase() === 'sell';
  const e = n(entry);
  const atr = n(setup && setup.atr);
  const invalidation = n(setup && setup.invalidation);
  if (!(e > 0) || !(atr > 0) || !(invalidation > 0)) return null;
  const bufferAtr = n(opts.bufferAtr) ?? 0.15;
  const minRiskAtr = n(opts.minRiskAtr) ?? 1.15;
  const maxRiskAtr = n(opts.maxRiskAtr) ?? 2.75;
  const rr1 = n(opts.rr1) ?? 1.6;
  const rr2 = n(opts.rr2) ?? 2.6;
  const rawStop = sell ? invalidation + bufferAtr * atr : invalidation - bufferAtr * atr;
  const rawRisk = sell ? rawStop - e : e - rawStop;
  const risk = Math.max(rawRisk, minRiskAtr * atr);
  if (!(risk > 0) || risk > maxRiskAtr * atr) return null;
  return {
    stop: sell ? e + risk : e - risk,
    tp1: sell ? e - rr1 * risk : e + rr1 * risk,
    tp2: sell ? e - rr2 * risk : e + rr2 * risk,
    risk,
    riskAtr: +(risk / atr).toFixed(3),
    rr1,
    rr2
  };
}

function simulatePriceActionExit(bars, entryIndex, entry, side, bracket, holdDays = 15) {
  const sell = String(side).toLowerCase() === 'sell';
  const stop0 = n(bracket && bracket.stop);
  const tp1 = n(bracket && bracket.tp1);
  const tp2 = n(bracket && bracket.tp2);
  if (!(entry > 0) || !(stop0 > 0) || !(tp1 > 0) || !(tp2 > 0)) return null;
  const end = Math.min(entryIndex + holdDays, bars.length - 1);
  const heldFull = entryIndex + holdDays <= bars.length - 1;
  const ret = price => sell ? (entry - price) / entry : (price - entry) / entry;
  let stop = stop0;
  let partial = 0;
  let remaining = 1;
  let tp1Hit = false;
  const finish = (status, exitIdx, price) => ({
    ret: partial + remaining * ret(price),
    status,
    exitIdx,
    exitPrice: price,
    stopLoss: stop,
    tp1Hit,
    tp2Ref: tp2
  });

  for (let i = entryIndex; i <= end; i++) {
    const bar = bars[i];
    const open = n(bar.o) ?? n(bar.c);
    const high = n(bar.h);
    const low = n(bar.l);
    if (high == null || low == null) continue;
    const stopHit = !sell ? low <= stop : high >= stop;
    if (stopHit) {
      const fill = !sell ? (open < stop ? open : stop) : (open > stop ? open : stop);
      return finish(tp1Hit ? 'tp1_then_sl' : 'sl_hit', i, fill);
    }
    if (!tp1Hit && ((!sell && high >= tp1) || (sell && low <= tp1))) {
      partial = 0.5 * ret(tp1);
      remaining = 0.5;
      tp1Hit = true;
      stop = entry;
    }
    if (tp1Hit && ((!sell && high >= tp2) || (sell && low <= tp2))) {
      partial += remaining * ret(tp2);
      remaining = 0;
      return finish('tp2_hit', i, tp2);
    }
  }
  const last = bars[end];
  return finish(heldFull ? (tp1Hit ? 'tp1_then_time' : 'time_limit') : (tp1Hit ? 'tp1_open' : 'open'),
    end, n(last && last.c) || entry);
}

module.exports = {
  priceActionSetup,
  structuralBracket,
  simulatePriceActionExit
};
