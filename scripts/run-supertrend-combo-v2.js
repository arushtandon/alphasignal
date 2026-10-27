'use strict';

// Stage 1 only. Rules: docs/supertrend-combo-preregistration-2026-10-08.md
// No bar after 2019-12-31 is loaded. Stage 2 is not run.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { deflatedSharpe, sharpe } = require('../lib/research/strategy-gaps');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');

const ROOT = path.join(__dirname, '..');
const PRICE_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const VOL_DIR = path.join(ROOT, 'data', 'research', 'supertrend-volume');
const AMEND = process.argv.includes('--amend');
const AMENDMENT = '164792d01a49fab19d848aba60354fc804a19b98';
const CUTOFF = '2019-12-31';
const START = '2010-01-01';
const PREREG = 'e552e85700d5049beb8b4299b46dee088ed7c9dc';
const volumeBySymbol = new Map();
const FILTERS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
const BASES = [
  { id: 'SHORT', horizon: 'SHORT', period: 7, mult: 2, maxHold: 10, weekly: false, higher: 'MEDIUM' },
  { id: 'MEDIUM', horizon: 'MEDIUM', period: 10, mult: 3, maxHold: 63, weekly: false, higher: 'LONG' },
  { id: 'LONG', horizon: 'LONG', period: 14, mult: 4, maxHold: 126, weekly: false, higher: 'WEEKLY' },
  { id: 'WEEKLY', horizon: 'LONG', period: 10, mult: 3, maxHold: 126, weekly: true, higher: 'LONG' },
];
const MIN_TRADES = { SHORT: 300, MEDIUM: 150, LONG: 100 };

function dateOf(bar) {
  if (bar.date) return String(bar.date).slice(0, 10);
  const stamp = Number(bar.t);
  if (!(stamp > 0)) return null;
  return new Date(stamp < 1e12 ? stamp * 1000 : stamp).toISOString().slice(0, 10);
}
function everMembers(snapshot) {
  const ever = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
  }
  return [...ever];
}
function timeline(snapshot) {
  const changes = [...(snapshot.historicalMembership?.changes || [])]
    .filter(change => change.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const initial = new Set(snapshot.currentSymbols || []);
  if (snapshot.historicalMembership?.available) {
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      if (changes[index].added) initial.delete(changes[index].added);
      if (changes[index].removed) initial.add(changes[index].removed);
    }
  }
  const events = new Map();
  for (const change of changes) {
    if (change.added) {
      if (!events.has(change.added)) events.set(change.added, []);
      events.get(change.added).push({ date: change.date, member: true });
    }
    if (change.removed) {
      if (!events.has(change.removed)) events.set(change.removed, []);
      events.get(change.removed).push({ date: change.date, member: false });
    }
  }
  return { initial, events, dated: snapshot.historicalMembership?.available === true };
}
function memberOn(clock, symbol, date) {
  if (!clock.dated) return clock.initial.has(symbol);
  let on = clock.initial.has(symbol);
  for (const event of clock.events.get(symbol) || []) {
    if (event.date > date) break;
    on = event.member;
  }
  return on;
}
function wilderAtr(high, low, close, period) {
  const atr = new Float64Array(close.length);
  const tr = new Float64Array(close.length);
  for (let index = 1; index < close.length; index += 1) {
    tr[index] = Math.max(
      high[index] - low[index],
      Math.abs(high[index] - close[index - 1]),
      Math.abs(low[index] - close[index - 1]),
    );
  }
  let seed = 0;
  for (let index = 1; index <= period && index < close.length; index += 1) seed += tr[index];
  if (close.length <= period) return { atr, tr };
  atr[period] = seed / period;
  for (let index = period + 1; index < close.length; index += 1) {
    atr[index] = (atr[index - 1] * (period - 1) + tr[index]) / period;
  }
  return { atr, tr };
}
function supertrend(high, low, close, period, multiplier) {
  const { atr, tr } = wilderAtr(high, low, close, period);
  const direction = new Int8Array(close.length);
  const line = new Float64Array(close.length);
  let upper = NaN;
  let lower = NaN;
  for (let index = 0; index < close.length; index += 1) {
    if (!(atr[index] > 0)) continue;
    const mid = (high[index] + low[index]) / 2;
    const basicUpper = mid + multiplier * atr[index];
    const basicLower = mid - multiplier * atr[index];
    const priorClose = index > 0 ? close[index - 1] : close[index];
    upper = !Number.isFinite(upper) || basicUpper < upper || priorClose > upper ? basicUpper : upper;
    lower = !Number.isFinite(lower) || basicLower > lower || priorClose < lower ? basicLower : lower;
    const previous = index > 0 && direction[index - 1] !== 0 ? direction[index - 1] : 0;
    if (previous === 0) direction[index] = close[index] > upper ? 1 : (close[index] < lower ? -1 : 0);
    else if (previous < 0 && close[index] > upper) direction[index] = 1;
    else if (previous > 0 && close[index] < lower) direction[index] = -1;
    else direction[index] = previous;
    line[index] = direction[index] > 0 ? lower : upper;
  }
  return { direction, line, atr, tr };
}
function rollingMean(values, length) {
  const out = new Float64Array(values.length);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= length) sum -= values[index - length];
    out[index] = index >= length - 1 ? sum / length : NaN;
  }
  return out;
}
function ema(values, length) {
  const out = new Float64Array(values.length);
  const k = 2 / (length + 1);
  if (values.length < length) return out;
  let seed = 0;
  let seeded = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) continue;
    if (seeded < length) {
      seed += values[index];
      seeded += 1;
      if (seeded === length) out[index] = seed / length;
      continue;
    }
    out[index] = values[index] * k + out[index - 1] * (1 - k);
  }
  return out;
}
function rsi(close, period) {
  const out = new Float64Array(close.length);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period && index < close.length; index += 1) {
    const change = close[index] - close[index - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  if (close.length <= period) return out;
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let index = period + 1; index < close.length; index += 1) {
    const change = close[index] - close[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function adx(high, low, close, period) {
  const { tr } = wilderAtr(high, low, close, period);
  const plus = new Float64Array(close.length);
  const minus = new Float64Array(close.length);
  for (let index = 1; index < close.length; index += 1) {
    const up = high[index] - high[index - 1];
    const down = low[index - 1] - low[index];
    plus[index] = up > down && up > 0 ? up : 0;
    minus[index] = down > up && down > 0 ? down : 0;
  }
  const smooth = values => {
    const out = new Float64Array(values.length);
    let seed = 0;
    for (let index = 1; index <= period && index < values.length; index += 1) seed += values[index];
    if (values.length <= period) return out;
    out[period] = seed;
    for (let index = period + 1; index < values.length; index += 1) {
      out[index] = out[index - 1] - out[index - 1] / period + values[index];
    }
    return out;
  };
  const trS = smooth(tr);
  const plusS = smooth(plus);
  const minusS = smooth(minus);
  const dx = new Float64Array(close.length);
  for (let index = period; index < close.length; index += 1) {
    if (!(trS[index] > 0)) continue;
    const pdi = 100 * plusS[index] / trS[index];
    const mdi = 100 * minusS[index] / trS[index];
    dx[index] = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  const out = new Float64Array(close.length);
  const start = period * 2;
  if (close.length <= start) return out;
  let seed = 0;
  for (let index = period; index < start; index += 1) seed += dx[index];
  out[start - 1] = seed / period;
  for (let index = start; index < close.length; index += 1) {
    out[index] = (out[index - 1] * (period - 1) + dx[index]) / period;
  }
  return out;
}
function mondayOf(date) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return value.toISOString().slice(0, 10);
}
function weeklyOf(dates, open, high, low, close) {
  const weeks = [];
  for (let index = 0; index < dates.length; index += 1) {
    const week = mondayOf(dates[index]);
    const last = weeks[weeks.length - 1];
    if (!last || last.week !== week) {
      weeks.push({ week, end: index, h: high[index], l: low[index], c: close[index], o: open[index] });
    } else {
      last.end = index;
      last.h = Math.max(last.h, high[index]);
      last.l = Math.min(last.l, low[index]);
      last.c = close[index];
    }
  }
  const st = weeks.length
    ? supertrend(weeks.map(row => row.h), weeks.map(row => row.l), weeks.map(row => row.c), 10, 3)
    : { direction: new Int8Array(), line: new Float64Array(), atr: new Float64Array() };
  const direction = new Int8Array(dates.length);
  const atr = new Float64Array(dates.length);
  const line = new Float64Array(dates.length);
  const flip = new Uint8Array(dates.length);
  let weekIndex = -1;
  for (let index = 0; index < dates.length; index += 1) {
    while (weekIndex + 1 < weeks.length && weeks[weekIndex + 1].end <= index) weekIndex += 1;
    if (weekIndex >= 0 && weeks[weekIndex].end <= index) {
      direction[index] = st.direction[weekIndex];
      atr[index] = st.atr[weekIndex];
      line[index] = st.line[weekIndex];
    }
  }
  for (let index = 1; index < weeks.length; index += 1) {
    if (st.direction[index] > 0 && st.direction[index - 1] < 0) flip[weeks[index].end] = 1;
    if (st.direction[index] < 0 && st.direction[index - 1] > 0) flip[weeks[index].end] = 2;
  }
  return { direction, atr, line, flip, st };
}
function loadCut(symbol) {
  const file = path.join(PRICE_DIR, `${String(symbol).replace(/[\\/]/g, '_')}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dates = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  let volumeBars = 0;
  for (const bar of raw.bars || []) {
    const date = dateOf(bar);
    if (!date || date > CUTOFF || !(Number(bar.c) > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) > 0 ? Number(bar.o) : Number(bar.c));
    high.push(Number(bar.h) > 0 ? Number(bar.h) : Number(bar.c));
    low.push(Number(bar.l) > 0 ? Number(bar.l) : Number(bar.c));
    close.push(Number(bar.c));
    const joined = volumeBySymbol.get(symbol);
    const vol = joined ? Number(joined[date]) : Number(bar.v);
    volume.push(Number.isFinite(vol) && vol > 0 ? vol : NaN);
    if (Number.isFinite(vol)) volumeBars += 1;
  }
  if (dates.length < 260 || dates[dates.length - 1] > CUTOFF) return null;
  const trends = {
    SHORT: supertrend(high, low, close, 7, 2),
    MEDIUM: supertrend(high, low, close, 10, 3),
    LONG: supertrend(high, low, close, 14, 4),
    WEEKLY: weeklyOf(dates, open, high, low, close),
  };
  const macdFast = ema(close, 12);
  const macdSlow = ema(close, 26);
  const macd = new Float64Array(close.length);
  for (let index = 0; index < close.length; index += 1) {
    macd[index] = Number.isFinite(macdFast[index]) && Number.isFinite(macdSlow[index])
      ? macdFast[index] - macdSlow[index] : NaN;
  }
  const macdSignal = ema(macd, 9);
  return {
    symbol, dates, open, high, low, close, volume, volumeBars,
    ma200: rollingMean(close, 200),
    ma50: rollingMean(close, 50),
    rsi: rsi(close, 14),
    adx: adx(high, low, close, 14),
    macd, macdSignal, trends,
  };
}
function indexOn(series, date) {
  let lo = 0;
  let hi = series.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] <= date) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}
function exitX1(direction, signal, side, maxHold, length) {
  const entry = signal + 1;
  const maxIdx = Math.min(length - 1, entry + maxHold - 1);
  if (maxIdx < entry) return null;
  for (let index = signal + 1; index < length; index += 1) {
    const flipped = side > 0
      ? direction[index] < 0 && direction[index - 1] > 0
      : direction[index] > 0 && direction[index - 1] < 0;
    if (!flipped) continue;
    if (index + 1 <= maxIdx) return { exit: index + 1, fill: 'open' };
    break;
  }
  return { exit: maxIdx, fill: 'close' };
}
function exitX2(stock, signal, side, atr, maxHold) {
  const entry = signal + 1;
  const maxIdx = Math.min(stock.dates.length - 1, entry + maxHold - 1);
  if (maxIdx < entry) return null;
  let best = stock.close[entry];
  for (let index = entry + 1; index <= maxIdx; index += 1) {
    const width = atr[index - 1];
    if (width > 0) {
      const stop = side > 0 ? best - 3 * width : best + 3 * width;
      const hit = side > 0 ? stock.low[index] <= stop : stock.high[index] >= stop;
      if (hit) {
        const gap = side > 0 ? stock.open[index] < stop : stock.open[index] > stop;
        return { exit: index, fill: gap ? 'open' : 'stop', fillPrice: gap ? stock.open[index] : stop };
      }
    }
    best = side > 0 ? Math.max(best, stock.close[index]) : Math.min(best, stock.close[index]);
  }
  return { exit: maxIdx, fill: 'close' };
}
function tradeExcess(stock, benchmark, signal, exitSpec, side) {
  const entry = signal + 1;
  const exit = exitSpec.exit;
  if (!(exit >= entry) || !(stock.open[entry] > 0)) return null;
  const benchEntry = indexOn(benchmark, stock.dates[entry]);
  if (benchEntry < 0 || benchmark.dates[benchEntry] !== stock.dates[entry] || !(benchmark.open[benchEntry] > 0)) return null;
  const days = [];
  const push = (date, stockRet, indexRet) => {
    days.push({ date, excess: side > 0 ? stockRet - indexRet : -stockRet + indexRet });
  };
  push(stock.dates[entry], stock.close[entry] / stock.open[entry] - 1, benchmark.close[benchEntry] / benchmark.open[benchEntry] - 1);
  let prevBench = benchEntry;
  for (let index = entry + 1; index <= exit; index += 1) {
    const bench = indexOn(benchmark, stock.dates[index]);
    if (bench < 0) return null;
    let stockRet;
    if (index === exit && exitSpec.fill === 'open') stockRet = stock.open[index] / stock.close[index - 1] - 1;
    else if (index === exit && exitSpec.fill === 'stop') stockRet = exitSpec.fillPrice / stock.close[index - 1] - 1;
    else stockRet = stock.close[index] / stock.close[index - 1] - 1;
    let indexRet = 0;
    if (index === exit && exitSpec.fill === 'open' && benchmark.dates[bench] === stock.dates[index] && benchmark.open[bench] > 0) {
      indexRet = benchmark.open[bench] / benchmark.close[prevBench] - 1;
    } else if (bench !== prevBench && benchmark.close[prevBench] > 0) {
      indexRet = benchmark.close[bench] / benchmark.close[prevBench] - 1;
    }
    push(stock.dates[index], stockRet, indexRet);
    prevBench = bench;
  }
  if (side < 0) {
    const rate = stock.open[entry] < 5 ? 0.03 : 0.01;
    days[days.length - 1].excess -= days.length * (rate / 252);
  }
  return {
    ret: days.reduce((equity, day) => equity * (1 + day.excess), 1) - 1,
    year: stock.dates[exit].slice(0, 4),
    exit,
    days,
  };
}
function tStat(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / (sd / Math.sqrt(values.length)) : null;
}
function summarise(trades) {
  const values = trades.map(row => row.ret).filter(Number.isFinite);
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value <= 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const years = {};
  for (const row of trades) {
    if (!Number.isFinite(row.ret)) continue;
    if (!years[row.year]) years[row.year] = [];
    years[row.year].push(row.ret);
  }
  return {
    trades: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    win: values.length ? wins.length / values.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    t: tStat(values),
    years: Object.keys(years).sort().map(year => {
      const rows = years[year];
      const up = rows.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
      const down = Math.abs(rows.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
      return {
        year,
        trades: rows.length,
        mean: rows.reduce((sum, value) => sum + value, 0) / rows.length,
        win: rows.filter(value => value > 0).length / rows.length,
        pf: down > 0 ? up / down : (up > 0 ? Infinity : 0),
      };
    }),
  };
}
function selectTrades(signals, required, exitName) {
  const bit = required.reduce((mask, index) => mask | (1 << index), 0);
  const trades = [];
  let openUntil = -1;
  for (const signal of signals) {
    if (signal.index < openUntil) continue;
    if ((signal.mask & bit) !== bit) continue;
    const chosen = signal[exitName];
    if (!chosen || !Number.isFinite(chosen.ret)) continue;
    trades.push(chosen);
    openUntil = chosen.exit;
  }
  return trades;
}
function ols(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 3) return { alpha: null, beta: null, alphaT: null, annualized: null };
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < n; index += 1) {
    meanX += x[index];
    meanY += y[index];
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = x[index] - meanX;
    sxx += dx * dx;
    sxy += dx * (y[index] - meanY);
  }
  if (!(sxx > 0)) return { alpha: null, beta: null, alphaT: null, annualized: null };
  const beta = sxy / sxx;
  const alpha = meanY - beta * meanX;
  let sse = 0;
  for (let index = 0; index < n; index += 1) {
    const error = y[index] - alpha - beta * x[index];
    sse += error * error;
  }
  const variance = (sse / (n - 2)) * (1 / n + (meanX * meanX) / sxx);
  return {
    alpha,
    beta,
    alphaT: variance > 0 ? alpha / Math.sqrt(variance) : null,
    annualized: alpha * 12,
  };
}
function monthPack(trades, benchmark) {
  const byDate = new Map();
  for (const trade of trades) {
    for (const day of trade.days || []) {
      if (!byDate.has(day.date)) byDate.set(day.date, []);
      byDate.get(day.date).push(day.excess);
    }
  }
  const book = [];
  const index = [];
  let bookBucket = [];
  let indexBucket = [];
  let stamp = null;
  let previousClose = null;
  const flush = () => {
    if (!stamp) return;
    book.push(bookBucket.reduce((equity, value) => equity * (1 + value), 1) - 1);
    index.push(indexBucket.reduce((equity, value) => equity * (1 + value), 1) - 1);
  };
  for (let cursor = 0; cursor < benchmark.dates.length; cursor += 1) {
    const date = benchmark.dates[cursor];
    const close = benchmark.close[cursor];
    const indexRet = previousClose > 0 && close > 0 ? close / previousClose - 1 : 0;
    if (close > 0) previousClose = close;
    if (date < START || date > CUTOFF) continue;
    if (stamp && date.slice(0, 7) !== stamp) {
      flush();
      bookBucket = [];
      indexBucket = [];
    }
    const rows = byDate.get(date) || [];
    bookBucket.push(rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0);
    indexBucket.push(indexRet);
    stamp = date.slice(0, 7);
  }
  flush();
  return { book, index, ...ols(book, index) };
}
function monthlyOf(trades, dates) {
  const byDate = new Map();
  for (const trade of trades) {
    for (const day of trade.days || []) {
      if (!byDate.has(day.date)) byDate.set(day.date, []);
      byDate.get(day.date).push(day.excess);
    }
  }
  const monthly = [];
  let bucket = [];
  let stamp = null;
  for (const date of dates) {
    if (date < START || date > CUTOFF) continue;
    if (stamp && date.slice(0, 7) !== stamp) {
      monthly.push(bucket.reduce((equity, value) => equity * (1 + value), 1) - 1);
      bucket = [];
    }
    const rows = byDate.get(date) || [];
    bucket.push(rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0);
    stamp = date.slice(0, 7);
  }
  if (bucket.length) monthly.push(bucket.reduce((equity, value) => equity * (1 + value), 1) - 1);
  return monthly;
}
function fmt(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}
function flagsFor(stock, benchmark, bench, index, base, side, threshold) {
  const trend = stock.trends[base.id];
  const close = stock.close[index];
  const higher = stock.trends[base.higher];
  const indexTrend = benchmark.trends[base.id];
  const six = stock.six[index];
  const priorVol = [];
  for (let cursor = index - 20; cursor < index; cursor += 1) {
    if (cursor >= 0 && Number.isFinite(stock.volume[cursor])) priorVol.push(stock.volume[cursor]);
  }
  const avgVol = priorVol.length === 20 ? priorVol.reduce((sum, value) => sum + value, 0) / 20 : NaN;
  let high55 = true;
  let extreme = close;
  for (let cursor = Math.max(0, index - 54); cursor <= index; cursor += 1) {
    if (side > 0) extreme = Math.max(extreme, stock.close[cursor]);
    else extreme = Math.min(extreme, stock.close[cursor]);
  }
  high55 = close === extreme;
  const line = trend.line[index];
  const width = trend.atr[index];
  const near = width > 0 && (side > 0
    ? close >= line && close - line <= width
    : close <= line && line - close <= width);
  const long = side > 0;
  return [
    long ? close > stock.ma200[index] : close < stock.ma200[index],
    long ? stock.ma50[index] > stock.ma200[index] : stock.ma50[index] < stock.ma200[index],
    bench >= 0 && (long ? benchmark.close[bench] > benchmark.ma200[bench] : benchmark.close[bench] < benchmark.ma200[bench]),
    bench >= 0 && (long ? indexTrend.direction[bench] > 0 : indexTrend.direction[bench] < 0),
    stock.adx[index] > 25,
    Number.isFinite(stock.macd[index]) && Number.isFinite(stock.macdSignal[index]) && (
      long ? stock.macd[index] > stock.macdSignal[index] : stock.macd[index] < stock.macdSignal[index]
    ),
    long ? stock.rsi[index] >= 50 && stock.rsi[index] <= 70 : stock.rsi[index] >= 30 && stock.rsi[index] <= 50,
    Number.isFinite(stock.volume[index]) && avgVol > 0 && stock.volume[index] > 1.5 * avgVol,
    Number.isFinite(six) && (long ? six >= threshold.top : six <= threshold.bottom),
    long ? higher.direction[index] > 0 : higher.direction[index] < 0,
    high55,
    near,
  ];
}

function hasStage1History(symbol) {
  const file = path.join(PRICE_DIR, `${String(symbol).replace(/[\\/]/g, '_')}.json`);
  if (!fs.existsSync(file)) return false;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let count = 0;
  for (const bar of raw.bars || []) {
    const stamp = Number(bar.t);
    const date = new Date(stamp < 1e12 ? stamp * 1000 : stamp).toISOString().slice(0, 10);
    if (date <= CUTOFF && Number(bar.c) > 0) count += 1;
    if (count >= 260) return true;
  }
  return false;
}
function volFile(symbol) {
  return path.join(VOL_DIR, `${String(symbol).replace(/[\\/]/g, '_')}.json`);
}
function yahooVolume(symbol) {
  const period1 = Math.floor(Date.parse('2009-01-01T00:00:00Z') / 1000);
  const period2 = Math.floor(Date.parse('2020-01-03T00:00:00Z') / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  return new Promise(resolve => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body)?.chart?.result?.[0];
          const stamps = result?.timestamp || [];
          const volumes = result?.indicators?.quote?.[0]?.volume || [];
          const out = {};
          for (let index = 0; index < stamps.length; index += 1) {
            const date = new Date(stamps[index] * 1000).toISOString().slice(0, 10);
            if (date > CUTOFF) continue;
            const value = Number(volumes[index]);
            if (Number.isFinite(value) && value > 0) out[date] = value;
          }
          resolve(out);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.setTimeout(20000, () => { request.destroy(); resolve(null); });
  });
}
async function ensureVolumes(symbols) {
  fs.mkdirSync(VOL_DIR, { recursive: true });
  let fetched = 0;
  let failed = 0;
  const pending = symbols.slice();
  async function one(symbol) {
    const file = volFile(symbol);
    if (fs.existsSync(file)) {
      volumeBySymbol.set(symbol, JSON.parse(fs.readFileSync(file, 'utf8')));
      return;
    }
    if (!hasStage1History(symbol)) {
      volumeBySymbol.set(symbol, {});
      return;
    }
    let volume = null;
    for (let attempt = 0; attempt < 3 && !volume; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      const fetchedVolume = await yahooVolume(symbol);
      if (fetchedVolume && Object.keys(fetchedVolume).length) volume = fetchedVolume;
    }
    if (!volume) {
      failed += 1;
      volumeBySymbol.set(symbol, {});
      return;
    }
    fs.writeFileSync(file, JSON.stringify(volume));
    volumeBySymbol.set(symbol, volume);
    fetched += 1;
  }
  const workers = Array.from({ length: 2 }, async () => {
    while (pending.length) {
      const symbol = pending.pop();
      if (!symbol) return;
      await one(symbol);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  });
  await Promise.all(workers);
  console.log('volume joined', volumeBySymbol.size, 'fetched', fetched, 'failed', failed);
}
async function main() {
  const snapshot = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
  if (!snapshot.historicalMembership?.available) throw new Error('US membership history is not available');
  const members = everMembers(snapshot);
  if (AMEND) await ensureVolumes(members);
  const memberCache = new Map();
  function membersOn(date) {
    let set = memberCache.get(date);
    if (!set) {
      set = membershipAt(snapshot, date);
      memberCache.set(date, set);
    }
    return set;
  }
  const benchmark = loadCut('SPY');
  if (!benchmark) throw new Error('SPY cache missing');
  const benchByDate = new Map(benchmark.dates.map((date, index) => [date, index]));
  const books = [];
  let volumeSymbols = 0;
  for (const symbol of members) {
    if (symbol === 'SPY') continue;
    const series = loadCut(symbol);
    if (!series) continue;
    if (series.volumeBars > 0) volumeSymbols += 1;
    const six = new Float64Array(series.dates.length);
    six.fill(NaN);
    for (let index = 126; index < series.dates.length; index += 1) {
      const bench = benchByDate.get(series.dates[index]);
      const benchThen = benchByDate.get(series.dates[index - 126]);
      if (bench == null || benchThen == null) continue;
      if (!(series.close[index - 126] > 0) || !(benchmark.close[benchThen] > 0)) continue;
      six[index] = (series.close[index] / series.close[index - 126] - 1)
        - (benchmark.close[bench] / benchmark.close[benchThen] - 1);
    }
    series.six = six;
    series.signals = [];
    books.push(series);
  }
  const pools = new Map();
  for (const series of books) {
    for (let index = 126; index < series.dates.length; index += 1) {
      if (!Number.isFinite(series.six[index]) || !membersOn(series.dates[index]).has(series.symbol)) continue;
      if (!pools.has(series.dates[index])) pools.set(series.dates[index], []);
      pools.get(series.dates[index]).push(series.six[index]);
    }
  }
  const thresholds = new Map();
  for (const [date, values] of pools) {
    const sorted = values.slice().sort((a, b) => a - b);
    const keep = Math.max(1, Math.ceil(sorted.length * 0.3));
    thresholds.set(date, { bottom: sorted[keep - 1], top: sorted[sorted.length - keep] });
  }
  const counts = { SHORT: 0, MEDIUM: 0, LONG: 0, WEEKLY: 0 };
  for (const series of books) {
    for (const base of BASES) {
      const trend = series.trends[base.id];
      for (let index = 1; index < series.dates.length - 1; index += 1) {
        if (series.dates[index] < START) continue;
        if (!membersOn(series.dates[index]).has(series.symbol)) continue;
        const bull = base.weekly
          ? trend.flip[index] === 1
          : trend.direction[index] > 0 && trend.direction[index - 1] < 0;
        const bear = base.weekly
          ? trend.flip[index] === 2
          : trend.direction[index] < 0 && trend.direction[index - 1] > 0;
        if (!bull && !bear) continue;
        const side = bull ? 1 : -1;
        const bench = benchByDate.get(series.dates[index]);
        const threshold = thresholds.get(series.dates[index]) || { top: Infinity, bottom: -Infinity };
        const bits = flagsFor(series, benchmark, bench == null ? -1 : bench, index, base, side, threshold);
        const direction = trend.direction;
        const atr = base.weekly ? trend.atr : trend.atr;
        const x1 = exitX1(direction, index, side, base.maxHold, series.dates.length);
        const x2 = exitX2(series, index, side, atr, base.maxHold);
        const signal = {
          index,
          base: base.id,
          side: side > 0 ? 'long' : 'short',
          mask: bits.reduce((mask, flag, bit) => mask | (flag ? (1 << bit) : 0), 0),
          x1: x1 ? tradeExcess(series, benchmark, index, x1, side) : null,
          x2: x2 ? tradeExcess(series, benchmark, index, x2, side) : null,
        };
        series.signals.push(signal);
        counts[base.id] += 1;
      }
    }
    series.signals.sort((a, b) => a.index - b.index || a.base.localeCompare(b.base) || a.side.localeCompare(b.side));
  }
  console.log('priced', books.length, 'of', members.length, 'signals', counts, 'volume', volumeSymbols);
  const sets = [];
  for (let index = 0; index < 12; index += 1) sets.push([index]);
  for (let left = 0; left < 12; left += 1) {
    for (let right = left + 1; right < 12; right += 1) sets.push([left, right]);
  }
  const streams = new Map();
  for (const base of BASES) {
    for (const side of ['long', 'short']) {
      streams.set(`${base.id}|${side}`, books.map(book => (
        book.signals.filter(signal => signal.base === base.id && signal.side === side)
      )));
    }
  }
  const analysis = [];
  for (const base of BASES) {
    for (const side of ['long', 'short']) {
      const grouped = streams.get(`${base.id}|${side}`);
      for (let bit = 0; bit < 12; bit += 1) {
        for (const state of [true, false]) {
          const row = { base: base.id, side, filter: FILTERS[bit], state };
          for (const exitName of ['x1', 'x2']) {
            const trades = [];
            for (const signals of grouped) {
              const filtered = signals.filter(signal => ((signal.mask >> bit) & 1) === (state ? 1 : 0));
              trades.push(...selectTrades(filtered, [], exitName));
            }
            row[exitName] = summarise(trades);
          }
          analysis.push(row);
        }
      }
    }
  }
  const trials = [];
  for (const base of BASES) {
    for (const side of ['long', 'short']) {
      const grouped = streams.get(`${base.id}|${side}`);
      for (const required of sets) {
        for (const exitName of ['x1', 'x2']) {
          const trades = [];
          for (const signals of grouped) trades.push(...selectTrades(signals, required, exitName));
          const summary = summarise(trades);
          const packed = AMEND ? monthPack(trades, benchmark) : null;
          const fit = packed || {};
          trials.push({
            base: base.id,
            horizon: base.horizon,
            side,
            exit: exitName.toUpperCase(),
            filters: required.map(index => FILTERS[index]).join('+'),
            ...summary,
            monthly: packed ? packed.book : monthlyOf(trades, benchmark.dates),
            monthlyT: packed ? tStat(packed.book) : null,
            beta: side === 'short' ? fit.beta : null,
            alphaAnn: side === 'short' ? fit.annualized : null,
            alphaT: side === 'short' ? fit.alphaT : null,
          });
        }
      }
    }
  }
  if (sets.length !== 78 || trials.length !== 1248) {
    throw new Error(`expected 78 sets and 1248 trials, got ${sets.length} and ${trials.length}`);
  }
  if (AMEND) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'supertrend-combo-stage1-2026-10-08.json'), 'utf8'));
    const priorByKey = new Map(prior.trials.map(row => [`${row.base}|${row.side}|${row.filters}|${row.exit}`, row]));
    let f8Trials = 0;
    let mismatches = 0;
    for (const row of trials) {
      const key = `${row.base}|${row.side}|${row.filters}|${row.exit}`;
      if (row.filters.split('+').includes('F8')) {
        f8Trials += 1;
        continue;
      }
      const old = priorByKey.get(key);
      if (!old || old.trades !== row.trades || Math.abs((old.t || 0) - (row.t || 0)) > 0.02) mismatches += 1;
    }
    if (mismatches) throw new Error(`non-F8 results drifted on ${mismatches} rows`);
    const registered = 1248 + 312 + f8Trials;
    const frozen = [];
    for (const horizon of ['SHORT', 'MEDIUM', 'LONG']) {
      for (const side of ['long', 'short']) {
        const picked = trials
          .filter(row => row.horizon === horizon && row.side === side
            && !row.filters.split('+').includes('F12')
            && row.trades >= MIN_TRADES[horizon]
            && row.pf >= 1.2
            && row.monthlyT >= 2.5
            && (side !== 'short' || row.alphaT >= 2))
          .sort((a, b) => (b.t ?? -999) - (a.t ?? -999))
          .slice(0, 3);
        frozen.push(...picked.map(row => ({ ...row, group: `${horizon} ${side}` })));
      }
    }
    const lines = [
      '# Frozen Supertrend combinations — 2026-10-08',
      '',
      'Tighter freeze under the 2026-10-08 amendment. Stage 2 has not been run.',
      `Pre-registration \`${PREREG}\`. Amendment \`${AMENDMENT}\`.`,
      '',
      'A row qualifies with PF at least 1.2, the horizon minimum trades, monthly book t at least 2.5, and, for a short, alpha t at least 2. F12 cannot qualify. Rank is per-trade excess t. LONG pools the daily (14, 4) base and the weekly (10, 3) base.',
      '',
      `F8 trials re-scored with volume: ${f8Trials}.`,
      `Registered trial count: 1248 + 312 + ${f8Trials} = ${registered}.`,
      `Symbols with joined volume: ${volumeSymbols} of ${books.length} priced names.`,
      '',
    ];
    if (!frozen.length) lines.push('None qualified.');
    lines.push('', '## Closest rows that still fail the tighter gate', '');
    for (const horizon of ['SHORT', 'MEDIUM', 'LONG']) {
      for (const side of ['long', 'short']) {
        const pool = trials.filter(row => row.horizon === horizon && row.side === side
          && !row.filters.split('+').includes('F12')
          && row.trades >= MIN_TRADES[horizon]);
        const bestMonthly = pool.slice().sort((a, b) => (b.monthlyT ?? -999) - (a.monthlyT ?? -999))[0];
        const bestAlpha = side === 'short'
          ? pool.slice().sort((a, b) => (b.alphaT ?? -999) - (a.alphaT ?? -999))[0]
          : null;
        const describe = row => row
          ? `${row.base} ${row.filters} ${row.exit} n=${row.trades} per-trade t=${fmt(row.t)} PF=${fmt(row.pf)} monthly t=${fmt(row.monthlyT)}${side === 'short' ? ` beta=${fmt(row.beta, 3)} alpha t=${fmt(row.alphaT)}` : ''}`
          : 'none';
        lines.push(`- ${horizon} ${side} best monthly t: ${describe(bestMonthly)}`);
        if (bestAlpha) lines.push(`- ${horizon} ${side} best alpha t: ${describe(bestAlpha)}`);
      }
    }
    const f8True = analysis.filter(row => row.filter === 'F8' && row.state === true);
    lines.push('', '## F8 true after volume', '');
    for (const row of f8True) {
      lines.push(`- ${row.base} ${row.side}: X1 n=${row.x1.trades} mean=${fmt(row.x1.mean == null ? null : row.x1.mean * 100)}% PF=${fmt(row.x1.pf)}; X2 n=${row.x2.trades} mean=${fmt(row.x2.mean == null ? null : row.x2.mean * 100)}% PF=${fmt(row.x2.pf)}`);
    }
    frozen.forEach((row, index) => {
      lines.push(`## ${index + 1}. ${row.group} — ${row.base} / ${row.side} / ${row.filters} / ${row.exit}`);
      lines.push('');
      lines.push(`- Horizon: ${row.horizon}. Base: ${row.base}. Side: ${row.side}.`);
      lines.push(`- Filters, all required: ${row.filters}.`);
      lines.push(`- Exit: ${row.exit}.`);
      lines.push(`- Trades: ${row.trades}. Per-trade excess t: ${fmt(row.t)}. PF: ${fmt(row.pf)}. Win: ${fmt(row.win * 100)}%. Mean excess: ${fmt(row.mean * 100)}%.`);
      lines.push(`- Monthly book t: ${fmt(row.monthlyT)}.`);
      if (row.side === 'short') {
        lines.push(`- Short spread on SPY: beta ${fmt(row.beta, 3)}, annualized alpha ${fmt(row.alphaAnn == null ? null : row.alphaAnn * 100)}%, alpha t ${fmt(row.alphaT)}.`);
      }
      lines.push('');
      lines.push('| Year | Trades | Mean | Win | PF |');
      lines.push('| --- | ---: | ---: | ---: | ---: |');
      for (const year of row.years) {
        lines.push(`| ${year.year} | ${year.trades} | ${fmt(year.mean * 100)}% | ${fmt(year.win * 100)}% | ${fmt(year.pf)} |`);
      }
      lines.push('');
    });
    fs.writeFileSync(path.join(ROOT, 'docs', 'supertrend-combo-frozen-2026-10-08.md'), `${lines.join('\n')}\n`);
    console.log('F8 re-scored', f8Trials, 'registered', registered, 'frozen', frozen.length, 'volume symbols', volumeSymbols);
    console.log(frozen.map(row => `${row.group} ${row.base} ${row.filters} ${row.exit} t=${fmt(row.t)} monthlyT=${fmt(row.monthlyT)} alphaT=${fmt(row.alphaT)} n=${row.trades}`).join('\n') || 'none');
    return;
  }
  const frozen = [];
  for (const horizon of ['SHORT', 'MEDIUM', 'LONG']) {
    for (const side of ['long', 'short']) {
      const picked = trials
        .filter(row => row.horizon === horizon && row.side === side && row.trades >= MIN_TRADES[horizon] && row.pf >= 1.2)
        .sort((a, b) => (b.t ?? -999) - (a.t ?? -999))
        .slice(0, 3);
      frozen.push(...picked.map(row => ({ ...row, group: `${horizon} ${side}` })));
    }
  }
  const best = trials.slice().sort((a, b) => (b.t ?? -999) - (a.t ?? -999))[0];
  const dsr = deflatedSharpe(
    trials.map(row => ({ sharpe: sharpe(row.monthly).sharpe })),
    best ? best.monthly : [],
  );
  const lines = [
    '# F11 Stage 1 — replacement Supertrend combinations',
    '',
    'Research only. Stage 2 was not run.',
    `Pre-registration \`${PREREG}\`.`,
    '',
    `US ever-members priced ${books.length} of ${members.length}. A signal requires membership that day. No bar after ${CUTOFF} was loaded.`,
    `Signals: SHORT ${counts.SHORT}, MEDIUM ${counts.MEDIUM}, LONG ${counts.LONG}, WEEKLY ${counts.WEEKLY}.`,
    'US 2010-2013 caveat: the membership file is mostly Nasdaq-100 in those years.',
    `Volume fields on the cached bars: ${volumeSymbols} symbols. F8 is false where volume is missing.`,
    '',
    `Trials scored: ${trials.length} of 1248.`,
    `Deflated Sharpe over those trials, on ${best ? `${best.base} ${best.side} ${best.filters} ${best.exit}` : 'none'}: probability ${fmt(dsr.probability, 3)}, annualized Sharpe ${fmt(dsr.annualized, 2)}.`,
    '',
    '## Filter true versus false',
    '',
    '| Base | Side | Filter | State | X1 n | X1 mean | X1 win | X1 PF | X2 n | X2 mean | X2 win | X2 PF |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of analysis) {
    const cell = (exitName) => {
      const stats = row[exitName];
      return `${stats.trades} | ${fmt(stats.mean == null ? null : stats.mean * 100)}% | ${fmt(stats.win == null ? null : stats.win * 100)}% | ${fmt(stats.pf)}`;
    };
    lines.push(`| ${row.base} | ${row.side} | ${row.filter} | ${row.state} | ${cell('x1')} | ${cell('x2')} |`);
  }
  lines.push('', '## Frozen', '');
  if (!frozen.length) lines.push('No row met the trade minimum and PF of 1.2.');
  for (const row of frozen) {
    lines.push(`- ${row.group}: ${row.base} ${row.filters} ${row.exit}, n=${row.trades}, t=${fmt(row.t)}, PF=${fmt(row.pf)}, win=${fmt(row.win == null ? null : row.win * 100)}%, mean=${fmt(row.mean == null ? null : row.mean * 100)}%`);
    lines.push('');
    lines.push('| Year | Trades | Mean | Win | PF |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const year of row.years) {
      lines.push(`| ${year.year} | ${year.trades} | ${fmt(year.mean * 100)}% | ${fmt(year.win * 100)}% | ${fmt(year.pf)} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'supertrend-combo-stage1-2026-10-08.md'), `${lines.join('\n')}\n`);
  const freeze = [
    '# Frozen Supertrend combinations — 2026-10-07',
    '',
    'Replacement Stage 1 freeze. The 2026-10-07 long-only freeze is void.',
    'These rules are not to be changed before Stage 2. Stage 2 has not been run.',
    `Pre-registration \`${PREREG}\`.`,
    '',
    'Top 3 by per-trade excess t inside each horizon and side, among rows with PF at least 1.2 and the horizon minimum trades (SHORT 300, MEDIUM 150, LONG 100). LONG includes the daily (14, 4) base and the weekly (10, 3) base.',
    '',
  ];
  if (!frozen.length) freeze.push('None qualified.');
  frozen.forEach((row, index) => {
    freeze.push(`## ${index + 1}. ${row.group} — ${row.base} / ${row.side} / ${row.filters} / ${row.exit}`);
    freeze.push('');
    freeze.push(`- Horizon: ${row.horizon}. Base: ${row.base}. Side: ${row.side}.`);
    freeze.push(`- Filters, all required: ${row.filters}.`);
    freeze.push(`- Exit: ${row.exit}.`);
    freeze.push(`- Stage 1: ${row.trades} trades, excess t ${fmt(row.t)}, PF ${fmt(row.pf)}, win ${fmt(row.win * 100)}%, mean excess ${fmt(row.mean * 100)}%.`);
    freeze.push('');
  });
  fs.writeFileSync(path.join(ROOT, 'docs', 'supertrend-combo-frozen-2026-10-07.md'), `${freeze.join('\n')}\n`);
  fs.writeFileSync(path.join(ROOT, 'scripts', 'supertrend-combo-stage1-2026-10-08.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    preregistration: PREREG,
    priced: books.length,
    members: members.length,
    volumeSymbols,
    signals: counts,
    trialsScored: trials.length,
    dsr,
    frozen: frozen.map(row => ({
      group: row.group, base: row.base, side: row.side, filters: row.filters, exit: row.exit,
      trades: row.trades, t: row.t, pf: row.pf, win: row.win, mean: row.mean, years: row.years,
    })),
    trials: trials.map(row => ({
      base: row.base, horizon: row.horizon, side: row.side, filters: row.filters, exit: row.exit,
      trades: row.trades, t: row.t, pf: row.pf, win: row.win, mean: row.mean,
    })),
  }));
  console.log('scored', trials.length, 'frozen', frozen.length);
  console.log(frozen.map(row => `${row.group} ${row.base} ${row.filters} ${row.exit} t=${fmt(row.t)} n=${row.trades}`).join('\n') || 'none');
  console.log('dsr', dsr.probability, dsr.annualized);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
