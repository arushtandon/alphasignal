'use strict';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function dateKey(bar) {
  const raw = bar?.date ?? bar?.d ?? bar?.t ?? bar?.time;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return new Date(raw > 1e12 ? raw : raw * 1000).toISOString().slice(0, 10);
  }
  return String(raw).slice(0, 10);
}

function indexByDate(bars = []) {
  const result = new Map();
  bars.forEach((bar, index) => {
    const date = dateKey(bar);
    if (date) result.set(date, index);
  });
  return result;
}

function smaAt(bars, index, length, field = 'c') {
  if (!Array.isArray(bars) || index - length + 1 < 0) return null;
  return mean(bars.slice(index - length + 1, index + 1).map(bar => number(bar[field])));
}

function returnAt(bars, index, lookback) {
  const current = number(bars?.[index]?.c);
  const prior = number(bars?.[index - lookback]?.c);
  return current > 0 && prior > 0 ? current / prior - 1 : null;
}

function trueRangeAt(bars, index) {
  const bar = bars?.[index];
  const high = number(bar?.h);
  const low = number(bar?.l);
  const priorClose = number(bars?.[index - 1]?.c);
  if (high == null || low == null) return null;
  return priorClose == null
    ? high - low
    : Math.max(high - low, Math.abs(high - priorClose), Math.abs(low - priorClose));
}

function atrAt(bars, index, length = 14) {
  if (index - length + 1 < 1) return null;
  return mean(Array.from({ length }, (_, offset) => trueRangeAt(bars, index - offset)));
}

function percentileRank(values, value) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  const below = finite.filter(candidate => candidate < value).length;
  const equal = finite.filter(candidate => candidate === value).length;
  return (below + 0.5 * equal) / finite.length;
}

function adxAt(bars, index, length = 14) {
  if (index < length * 2) return null;
  const tr = [];
  const plus = [];
  const minus = [];
  for (let cursor = index - length * 2 + 1; cursor <= index; cursor++) {
    const bar = bars[cursor];
    const prior = bars[cursor - 1];
    if (!bar || !prior) return null;
    const up = number(bar.h) - number(prior.h);
    const down = number(prior.l) - number(bar.l);
    tr.push(trueRangeAt(bars, cursor));
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const directional = [];
  for (let start = 0; start <= length; start++) {
    const averageRange = mean(tr.slice(start, start + length));
    const positive = averageRange > 0 ? 100 * mean(plus.slice(start, start + length)) / averageRange : 0;
    const negative = averageRange > 0 ? 100 * mean(minus.slice(start, start + length)) / averageRange : 0;
    directional.push(positive + negative > 0
      ? 100 * Math.abs(positive - negative) / (positive + negative)
      : 0);
  }
  return mean(directional.slice(-length));
}

function atrPercentileAt(bars, index, options = {}) {
  const length = options.length || 14;
  const window = options.window || 126;
  const currentAtr = atrAt(bars, index, length);
  const currentClose = number(bars?.[index]?.c);
  if (!(currentAtr > 0) || !(currentClose > 0) || index < window + length) return null;
  const history = [];
  for (let cursor = index - window; cursor <= index; cursor += options.step || 1) {
    const value = atrAt(bars, cursor, length);
    const close = number(bars[cursor]?.c);
    if (value > 0 && close > 0) history.push(value / close);
  }
  return percentileRank(history, currentAtr / currentClose);
}

function priorExtreme(bars, index, length, field, mode) {
  const values = bars.slice(Math.max(0, index - length), index)
    .map(bar => number(bar[field]))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return mode === 'max' ? Math.max(...values) : Math.min(...values);
}

function breakoutRetestAt(bars, index, side, options = {}) {
  const sell = side === 'sell';
  const lookback = options.lookback || 20;
  const retestWindow = options.retestWindow || 6;
  const tolerance = options.tolerance == null ? 0.012 : options.tolerance;
  for (let breakout = Math.max(lookback, index - retestWindow); breakout < index; breakout++) {
    const level = priorExtreme(bars, breakout, lookback, sell ? 'l' : 'h', sell ? 'min' : 'max');
    if (!(level > 0)) continue;
    const broke = sell ? number(bars[breakout].c) < level : number(bars[breakout].c) > level;
    if (!broke) continue;
    const touched = bars.slice(breakout + 1, index + 1).some(bar => sell
      ? number(bar.h) >= level * (1 - tolerance)
      : number(bar.l) <= level * (1 + tolerance));
    const confirmed = sell
      ? number(bars[index].c) < level && number(bars[index].c) < number(bars[index].o)
      : number(bars[index].c) > level && number(bars[index].c) > number(bars[index].o);
    if (touched && confirmed) return { pass: true, level, breakoutIndex: breakout };
  }
  return { pass: false, level: null, breakoutIndex: null };
}

function executionQualityAt(bars, index, options = {}) {
  const close = number(bars?.[index]?.c);
  const priorClose = number(bars?.[index - 1]?.c);
  const currentAtr = atrAt(bars, index, 14);
  if (!(close > 0) || !(priorClose > 0) || !(currentAtr > 0)) return { pass: false };
  const window = bars.slice(Math.max(0, index - 19), index + 1);
  const gapAtr = Math.abs(number(bars[index].o) - priorClose) / currentAtr;
  const dollarVolume = mean(window.map(bar => number(bar.c) * number(bar.v)));
  const spreadProxy = mean(window.map(bar => (number(bar.h) - number(bar.l)) / number(bar.c)));
  const pass = gapAtr <= (options.maxGapAtr ?? 1)
    && dollarVolume >= (options.minDollarVolume ?? 1e7)
    && spreadProxy <= (options.maxSpreadProxy ?? 0.08);
  return { pass, gapAtr, dollarVolume, spreadProxy };
}

function buildCrossSectionalSnapshots(contexts, options = {}) {
  const lookbacks = options.lookbacks || [20, 60, 120];
  const rowsByDate = new Map();
  for (const context of contexts || []) {
    for (let index = Math.max(200, ...lookbacks); index < context.bars.length; index++) {
      const date = dateKey(context.bars[index]);
      if (!date) continue;
      if (!rowsByDate.has(date)) rowsByDate.set(date, []);
      rowsByDate.get(date).push({
        symbol: context.symbol,
        returns: lookbacks.map(lookback => returnAt(context.bars, index, lookback)),
        above50: number(context.bars[index].c) > smaAt(context.bars, index, 50),
        above200: number(context.bars[index].c) > smaAt(context.bars, index, 200),
      });
    }
  }
  const snapshots = new Map();
  for (const [date, rows] of rowsByDate) {
    const columns = lookbacks.map((_, column) => rows.map(row => row.returns[column]));
    const breadth50 = rows.filter(row => row.above50).length / rows.length;
    const breadth200 = rows.filter(row => row.above200).length / rows.length;
    for (const row of rows) {
      const ranks = row.returns.map((value, column) => percentileRank(columns[column], value));
      snapshots.set(`${row.symbol}|${date}`, {
        date,
        symbol: row.symbol,
        returnPercentiles: Object.fromEntries(lookbacks.map((lookback, column) => [lookback, ranks[column]])),
        rsPercentile: mean(ranks),
        breadth50,
        breadth200,
        constituentCount: rows.length,
      });
    }
  }
  return snapshots;
}

function alignedValue(contextBars, index, proxy, operation) {
  if (!proxy?.bars) return null;
  const proxyIndex = proxy.index || indexByDate(proxy.bars);
  const aligned = proxyIndex.get(dateKey(contextBars[index]));
  return aligned == null ? null : operation(proxy.bars, aligned);
}

function commodityProxyAt(context, index, side, proxies = new Map()) {
  if (context.market !== 'Commodities') {
    return { applicable: false, pass: true, label: 'not-applicable' };
  }
  const sell = side === 'sell';
  const own20 = returnAt(context.bars, index, 20);
  const cl20 = alignedValue(context.bars, index, proxies.get('CL=F'), (bars, i) => returnAt(bars, i, 20));
  const bz20 = alignedValue(context.bars, index, proxies.get('BZ=F'), (bars, i) => returnAt(bars, i, 20));
  const dbc20 = alignedValue(context.bars, index, proxies.get('DBC'), (bars, i) => returnAt(bars, i, 20));
  const pairedEtf = context.symbol === 'CL=F' ? 'USO' : context.symbol === 'BZ=F' ? 'BNO' : null;
  const etf20 = pairedEtf
    ? alignedValue(context.bars, index, proxies.get(pairedEtf), (bars, i) => returnAt(bars, i, 20))
    : null;
  const brentWtiSpreadMomentum = Number.isFinite(cl20) && Number.isFinite(bz20) ? bz20 - cl20 : null;
  const rollYieldProxy = Number.isFinite(own20) && Number.isFinite(etf20) ? own20 - etf20 : null;
  const volatilityPercentile = atrPercentileAt(context.bars, index);
  const volume = number(context.bars[index]?.v);
  const averageVolume = smaAt(context.bars, index, 20, 'v');
  const volumeShock = volume > 0 && averageVolume > 0 ? volume / averageVolume : null;
  const rawTime = context.bars[index]?.t ?? context.bars[index]?.date;
  const weekday = new Date(typeof rawTime === 'number' && rawTime < 1e12 ? rawTime * 1000 : rawTime).getUTCDay();
  const inventoryReleaseRisk = weekday === 3 && volatilityPercentile >= 0.85;
  const directionPass = Number.isFinite(own20) && Number.isFinite(dbc20)
    && (sell ? own20 < 0 && dbc20 < 0 : own20 > 0 && dbc20 > 0);
  const rollPass = rollYieldProxy == null || (sell ? rollYieldProxy < 0 : rollYieldProxy > 0);
  return {
    applicable: true,
    pass: directionPass && rollPass && !inventoryReleaseRisk,
    label: 'price-etf-calendar-proxies-not-inventory-or-futures-curve',
    own20,
    dbc20,
    brentWtiSpreadMomentum,
    rollYieldProxy,
    volatilityPercentile,
    volumeShock,
    inventoryReleaseRisk,
  };
}

function snapshotAt(context, index, side, horizon, crossSectional, proxies, options = {}) {
  const bars = context.bars;
  const close = number(bars[index]?.c);
  const ma20 = smaAt(bars, index, 20);
  const ma50 = smaAt(bars, index, 50);
  const cross = crossSectional.get(`${context.symbol}|${dateKey(bars[index])}`) || {};
  const execution = executionQualityAt(bars, index, options.execution);
  const retestLookback = horizon === 'short' ? 20 : horizon === 'medium' ? 55 : 120;
  return {
    date: dateKey(bars[index]),
    rsPercentile: cross.rsPercentile,
    returnPercentiles: cross.returnPercentiles,
    breadth50: cross.breadth50,
    breadth200: cross.breadth200,
    constituentCount: cross.constituentCount,
    adx: adxAt(bars, index),
    atrPercentile: atrPercentileAt(bars, index),
    retest: breakoutRetestAt(bars, index, side, { lookback: retestLookback }),
    ma20Distance: ma20 > 0 ? close / ma20 - 1 : null,
    ma50Distance: ma50 > 0 ? close / ma50 - 1 : null,
    execution,
    commodity: commodityProxyAt(context, index, side, proxies),
  };
}

module.exports = {
  dateKey,
  indexByDate,
  smaAt,
  returnAt,
  trueRangeAt,
  atrAt,
  percentileRank,
  adxAt,
  atrPercentileAt,
  breakoutRetestAt,
  executionQualityAt,
  buildCrossSectionalSnapshots,
  commodityProxyAt,
  snapshotAt,
};
