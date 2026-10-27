'use strict';

// Stage 1 only. Rules: docs/supertrend-combo-preregistration-2026-10-07.md
// No bar after 2019-12-31 is loaded. Stage 2 is not run.
const fs = require('fs');
const path = require('path');
const { applyCosts } = require('../lib/research/cost-model');
const { deflatedSharpe, sharpe } = require('../lib/research/strategy-gaps');

const ROOT = path.join(__dirname, '..');
const PRICE_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const CUTOFF = '2019-12-31';
const START = '2010-01-01';
const FILTERS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

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
function wilderAtr(high, low, close, period) {
  const atr = new Float64Array(close.length);
  const tr = new Float64Array(close.length);
  for (let index = 1; index < close.length; index += 1) {
    tr[index] = Math.max(high[index] - low[index], Math.abs(high[index] - close[index - 1]), Math.abs(low[index] - close[index - 1]));
  }
  let seed = 0;
  for (let index = 1; index <= period && index < close.length; index += 1) seed += tr[index];
  if (close.length <= period) return { atr, tr };
  atr[period] = seed / period;
  for (let index = period + 1; index < close.length; index += 1) atr[index] = (atr[index - 1] * (period - 1) + tr[index]) / period;
  return { atr, tr };
}
function supertrend(high, low, close, period, multiplier) {
  const { atr } = wilderAtr(high, low, close, period);
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
    if (!Number.isFinite(upper)) upper = basicUpper;
    else upper = basicUpper < upper || priorClose > upper ? basicUpper : upper;
    if (!Number.isFinite(lower)) lower = basicLower;
    else lower = basicLower > lower || priorClose < lower ? basicLower : lower;
    const previous = index > 0 && direction[index - 1] !== 0 ? direction[index - 1] : 1;
    if (previous < 0 && close[index] > upper) direction[index] = 1;
    else if (previous > 0 && close[index] < lower) direction[index] = -1;
    else direction[index] = previous;
    line[index] = direction[index] > 0 ? lower : upper;
  }
  return { direction, line, atr };
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
  let seed = 0;
  if (values.length < length) return out;
  for (let index = 0; index < length; index += 1) seed += values[index];
  out[length - 1] = seed / length;
  for (let index = length; index < values.length; index += 1) out[index] = values[index] * k + out[index - 1] * (1 - k);
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
  const smooth = (values) => {
    const out = new Float64Array(values.length);
    let seed = 0;
    for (let index = 1; index <= period && index < values.length; index += 1) seed += values[index];
    if (values.length <= period) return out;
    out[period] = seed;
    for (let index = period + 1; index < values.length; index += 1) out[index] = out[index - 1] - out[index - 1] / period + values[index];
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
    const denom = pdi + mdi;
    dx[index] = denom > 0 ? 100 * Math.abs(pdi - mdi) / denom : 0;
  }
  const out = new Float64Array(close.length);
  const start = period * 2;
  if (close.length <= start) return out;
  let seed = 0;
  for (let index = period; index < start; index += 1) seed += dx[index];
  out[start - 1] = seed / period;
  for (let index = start; index < close.length; index += 1) out[index] = (out[index - 1] * (period - 1) + dx[index]) / period;
  return out;
}
function mondayOf(date) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return value.toISOString().slice(0, 10);
}
function loadCut(symbol) {
  const file = path.join(PRICE_DIR, `${String(symbol).replace(/[\\/]/g, '_')}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bars = raw.bars || [];
  const dates = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  let volumeBars = 0;
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || date > CUTOFF || !(bar.c > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) || Number(bar.c));
    high.push(Number(bar.h) || Number(bar.c));
    low.push(Number(bar.l) || Number(bar.c));
    close.push(Number(bar.c));
    const vol = Number(bar.v);
    volume.push(Number.isFinite(vol) ? vol : NaN);
    if (Number.isFinite(vol)) volumeBars += 1;
  }
  if (dates.length < 260) return null;
  if (dates.some(date => date > CUTOFF)) throw new Error(`bar after cutoff loaded for ${symbol}`);
  const st = supertrend(high, low, close, 10, 3);
  const weeks = [];
  for (let index = 0; index < dates.length; index += 1) {
    const week = mondayOf(dates[index]);
    const last = weeks[weeks.length - 1];
    if (!last || last.week !== week) {
      weeks.push({ week, end: index, o: open[index], h: high[index], l: low[index], c: close[index] });
    } else {
      last.end = index;
      last.h = Math.max(last.h, high[index]);
      last.l = Math.min(last.l, low[index]);
      last.c = close[index];
    }
  }
  const weekly = supertrend(weeks.map(row => row.h), weeks.map(row => row.l), weeks.map(row => row.c), 10, 3);
  const weeklyDir = new Int8Array(dates.length);
  let weekIndex = 0;
  for (let index = 0; index < dates.length; index += 1) {
    while (weekIndex + 1 < weeks.length && weeks[weekIndex + 1].end <= index) weekIndex += 1;
    weeklyDir[index] = weeks[weekIndex].end <= index ? weekly.direction[weekIndex] : (weekIndex > 0 ? weekly.direction[weekIndex - 1] : 0);
  }
  const fast = ema(close, 12);
  const slow = ema(close, 26);
  const macd = new Float64Array(close.length);
  for (let index = 0; index < close.length; index += 1) macd[index] = fast[index] && slow[index] ? fast[index] - slow[index] : NaN;
  const macdSignal = new Float64Array(close.length);
  const macdReady = [];
  for (let index = 0; index < close.length; index += 1) if (Number.isFinite(macd[index])) macdReady.push(macd[index]);
  const signalOnly = ema(macdReady, 9);
  let ready = 0;
  for (let index = 0; index < close.length; index += 1) {
    if (!Number.isFinite(macd[index])) continue;
    macdSignal[index] = signalOnly[ready];
    ready += 1;
  }
  const weekFlip = new Uint8Array(dates.length);
  for (let index = 1; index < weeks.length; index += 1) {
    if (weekly.direction[index] > 0 && weekly.direction[index - 1] < 0) weekFlip[weeks[index].end] = 1;
  }
  return {
    symbol, dates, open, high, low, close, volume, volumeBars,
    ma200: rollingMean(close, 200),
    ma50: rollingMean(close, 50),
    rsi: rsi(close, 14),
    adx: adx(high, low, close, 14),
    macd,
    macdSignal,
    st, weeklyDir, weeks, weekly, weekFlip,
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
function costFrac(symbol, holdDays) {
  return applyCosts(0, { market: 'US', symbol, side: 'buy', holdDays: holdDays }).costPct / 100;
}
function tradeReturn(stock, benchmark, signal, exit, fill, fillPrice) {
  const entry = signal + 1;
  if (exit <= entry) return null;
  const days = [];
  const entryDate = stock.dates[entry];
  const benchEntry = indexOn(benchmark, entryDate);
  if (benchEntry < 0 || benchmark.dates[benchEntry] !== entryDate || !(benchmark.open[benchEntry] > 0)) return null;
  days.push({ date: entryDate, stock: stock.close[entry] / stock.open[entry] - 1, index: benchmark.close[benchEntry] / benchmark.open[benchEntry] - 1 });
  let prevBench = benchEntry;
  for (let index = entry + 1; index <= exit; index += 1) {
    const bench = indexOn(benchmark, stock.dates[index]);
    if (bench < 0) return null;
    let stockRet;
    let indexRet;
    if (index === exit && fill === 'open') {
      stockRet = stock.open[index] / stock.close[index - 1] - 1;
      indexRet = benchmark.dates[bench] === stock.dates[index] && benchmark.open[bench] > 0
        ? benchmark.open[bench] / benchmark.close[prevBench] - 1
        : 0;
    } else if (index === exit && fill === 'stop') {
      stockRet = fillPrice / stock.close[index - 1] - 1;
      indexRet = benchmark.close[bench] / benchmark.close[prevBench] - 1;
    } else {
      stockRet = stock.close[index] / stock.close[index - 1] - 1;
      indexRet = bench === prevBench ? 0 : benchmark.close[bench] / benchmark.close[prevBench] - 1;
    }
    days.push({ date: stock.dates[index], stock: stockRet, index: indexRet });
    prevBench = bench;
  }
  const holdDays = exit - entry;
  const cost = costFrac(stock.symbol, holdDays) + costFrac(benchmark.symbol, holdDays);
  days[days.length - 1].stock -= cost;
  const excess = days.reduce((equity, row) => equity * (1 + row.stock - row.index), 1) - 1;
  return { ret: excess, exit, year: stock.dates[exit].slice(0, 4), days };
}
function exitX1(stock, signal) {
  let flip = -1;
  for (let index = signal + 1; index < stock.dates.length; index += 1) {
    if (stock.st.direction[index] < 0 && stock.st.direction[index - 1] > 0) { flip = index; break; }
  }
  if (flip >= 0 && flip + 1 < stock.dates.length) return { exit: flip + 1, fill: 'open' };
  return { exit: stock.dates.length - 1, fill: 'close' };
}
function exitX2(stock, signal) {
  const entry = signal + 1;
  const last = Math.min(stock.dates.length - 1, entry + 62);
  let highest = stock.close[entry];
  for (let index = entry + 1; index <= last; index += 1) {
    const atr = stock.st.atr[index - 1];
    const stop = highest - 3 * atr;
    if (atr > 0 && stock.low[index] <= stop) {
      const price = stock.open[index] < stop ? stock.open[index] : stop;
      return { exit: index, fill: stock.open[index] < stop ? 'open' : 'stop', fillPrice: price };
    }
    highest = Math.max(highest, stock.close[index]);
  }
  return { exit: last, fill: 'close', fillPrice: stock.close[last] };
}
function tStat(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return mean / (sd / Math.sqrt(n));
}
function summarise(trades) {
  const values = trades.map(row => row.ret);
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value <= 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const years = {};
  for (const row of trades) {
    if (!years[row.year]) years[row.year] = [];
    years[row.year].push(row.ret);
  }
  return {
    trades: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    win: values.length ? wins.length / values.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    t: tStat(values),
    years: Object.entries(years).sort(([a], [b]) => a.localeCompare(b)).map(([year, rows]) => ({
      year,
      trades: rows.length,
      mean: rows.reduce((sum, value) => sum + value, 0) / rows.length,
      win: rows.filter(value => value > 0).length / rows.length,
      pf: (() => {
        const up = rows.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
        const down = Math.abs(rows.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
        return down > 0 ? up / down : (up > 0 ? Infinity : 0);
      })(),
    })),
  };
}
function selectTrades(books, required, exitName) {
  const bit = required.reduce((mask, index) => mask | (1 << index), 0);
  const trades = [];
  for (const book of books) {
    let openUntil = -1;
    for (const signal of book.signals) {
      if (signal.index < openUntil) continue;
      if ((signal.mask & bit) !== bit) continue;
      const chosen = signal[exitName];
      if (!chosen) continue;
      trades.push(chosen);
      openUntil = chosen.exit;
    }
  }
  return trades;
}
function monthlyOf(trades) {
  const byMonth = new Map();
  for (const trade of trades) {
    for (const day of trade.days || []) {
      const month = day.date.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(day.stock - day.index);
    }
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => (
    rows.reduce((equity, value) => equity * (1 + value), 1) - 1
  ));
}
function fmt(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function main() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'research', 'fmp', 'us-universe.json'), 'utf8'));
  const members = everMembers(snapshot);
  const benchmark = loadCut('SPY');
  if (!benchmark) throw new Error('SPY cache missing');
  const benchByDate = new Map(benchmark.dates.map((date, index) => [date, index]));
  const excessByDate = new Map();
  const books = [];
  let volumeSymbols = 0;
  for (const symbol of members) {
    const series = loadCut(symbol);
    if (!series) continue;
    if (series.volumeBars > 0) volumeSymbols += 1;
    const signals = [];
    const six = new Float64Array(series.dates.length);
    for (let index = 0; index < series.dates.length; index += 1) {
      const bench = benchByDate.get(series.dates[index]);
      if (index >= 126 && bench >= 126 && series.close[index - 126] > 0 && benchmark.close[bench - 126] > 0) {
        six[index] = (series.close[index] / series.close[index - 126] - 1) - (benchmark.close[bench] / benchmark.close[bench - 126] - 1);
        if (!excessByDate.has(series.dates[index])) excessByDate.set(series.dates[index], []);
        excessByDate.get(series.dates[index]).push(six[index]);
      } else six[index] = NaN;
    }
    series.six = six;
    series.signals = signals;
    books.push(series);
  }
  const f9Threshold = new Map();
  for (const [date, values] of excessByDate) {
    const sorted = values.slice().sort((a, b) => b - a);
    const keep = Math.max(1, Math.ceil(sorted.length * 0.3));
    f9Threshold.set(date, sorted[keep - 1]);
  }
  let b1 = 0;
  let b2 = 0;
  for (const series of books) {
    for (let index = 1; index < series.dates.length - 1; index += 1) {
      if (series.dates[index] < START) continue;
      const dailyFlip = series.st.direction[index] > 0 && series.st.direction[index - 1] < 0;
      const weeklyFlip = series.weekFlip[index] === 1;
      if (!dailyFlip && !weeklyFlip) continue;
      const bench = benchByDate.get(series.dates[index]);
      const priorVol = [];
      for (let cursor = index - 20; cursor < index; cursor += 1) if (cursor >= 0 && Number.isFinite(series.volume[cursor])) priorVol.push(series.volume[cursor]);
      const avgVol = priorVol.length === 20 ? priorVol.reduce((sum, value) => sum + value, 0) / 20 : NaN;
      const close = series.close[index];
      const flags = [
        close > series.ma200[index],
        series.ma50[index] > series.ma200[index],
        bench >= 0 && benchmark.close[bench] > benchmark.ma200[bench],
        bench >= 0 && benchmark.st.direction[bench] > 0,
        series.adx[index] > 25,
        Number.isFinite(series.macd[index]) && Number.isFinite(series.macdSignal[index]) && series.macd[index] > series.macdSignal[index],
        series.rsi[index] >= 50 && series.rsi[index] <= 70,
        Number.isFinite(series.volume[index]) && Number.isFinite(avgVol) && avgVol > 0 && series.volume[index] > 1.5 * avgVol,
        Number.isFinite(series.six[index]) && series.six[index] >= f9Threshold.get(series.dates[index]),
        false,
        close >= Math.max(...series.close.slice(Math.max(0, index - 54), index + 1)),
        series.st.direction[index] > 0 && series.st.atr[index] > 0 && Math.abs(close - series.st.line[index]) <= series.st.atr[index],
      ];
      const x1Exit = exitX1(series, index);
      const x2Exit = exitX2(series, index);
      const make = (baseName) => {
        const bits = flags.slice();
        bits[9] = baseName === 'B1' ? series.weeklyDir[index] > 0 : series.st.direction[index] > 0;
        return {
          index,
          mask: bits.reduce((bitsMask, flag, bit) => bitsMask | (flag ? (1 << bit) : 0), 0),
          base: baseName,
          x1: tradeReturn(series, benchmark, index, x1Exit.exit, x1Exit.fill, x1Exit.fillPrice),
          x2: tradeReturn(series, benchmark, index, x2Exit.exit, x2Exit.fill, x2Exit.fillPrice),
        };
      };
      if (dailyFlip) { series.signals.push(make('B1')); b1 += 1; }
      if (weeklyFlip) { series.signals.push(make('B2')); b2 += 1; }
    }
    series.signals.sort((a, b) => a.index - b.index || a.base.localeCompare(b.base));
  }
  console.log('priced', books.length, 'of', members.length, 'signals', b1, b2, 'volume symbols', volumeSymbols);
  const sets = [];
  for (let index = 0; index < 12; index += 1) sets.push([index]);
  for (let left = 0; left < 12; left += 1) {
    for (let right = left + 1; right < 12; right += 1) sets.push([left, right]);
  }
  const analysis = [];
  for (const base of ['B1', 'B2']) {
    const baseBooks = books.map(book => ({ signals: book.signals.filter(signal => signal.base === base) }));
    for (let index = 0; index < 12; index += 1) {
      for (const state of [true, false]) {
        const requiredBooks = baseBooks.map(book => ({
          signals: book.signals.filter(signal => ((signal.mask >> index) & 1) === (state ? 1 : 0)).map(signal => ({ ...signal, mask: 0 })),
        }));
        const row = { base, filter: FILTERS[index], state };
        for (const exitName of ['x1', 'x2']) {
          row[exitName] = summarise(selectTrades(requiredBooks, [], exitName));
        }
        analysis.push(row);
      }
    }
  }
  const trials = [];
  for (const base of ['B1', 'B2']) {
    const baseBooks = books.map(book => ({ signals: book.signals.filter(signal => signal.base === base) }));
    for (const required of sets) {
      for (const exitName of ['x1', 'x2']) {
        const trades = selectTrades(baseBooks, required, exitName);
        const summary = summarise(trades);
        trials.push({
          base,
          exit: exitName.toUpperCase(),
          filters: required.map(index => FILTERS[index]).join('+'),
          ...summary,
          monthly: monthlyOf(trades),
        });
      }
    }
  }
  if (trials.length !== 312) throw new Error(`expected 312 trials, got ${trials.length}`);
  const ranked = trials.slice().sort((a, b) => (b.t ?? -999) - (a.t ?? -999));
  const frozen = ranked.filter(row => row.trades >= 100 && row.pf >= 1.2).slice(0, 5);
  const best = ranked[0];
  const dsr = deflatedSharpe(trials.map(row => ({ sharpe: sharpe(row.monthly).sharpe })), best ? best.monthly : []);
  const lines = [];
  lines.push('# F11 Stage 1 — Supertrend combinations');
  lines.push('');
  lines.push('Research only. Stage 2 was not run.');
  lines.push(`Pre-registration \`30eb91406e66b4b8be9afbd15ad426fdc5330d7e\`.`);
  lines.push('');
  lines.push(`US ever-members priced ${books.length} of ${members.length}. Signals B1 ${b1}, B2 ${b2}. No bar after ${CUTOFF} was loaded.`);
  lines.push('US 2010-2013 caveat: the ever-member file is mostly Nasdaq-100 in those years.');
  lines.push(`Volume is absent on the cached bars (${volumeSymbols} symbols had a volume field), so F8 is false on every signal and every F8 trial has no trades.`);
  lines.push('');
  lines.push(`Deflated Sharpe over ${trials.length} trials, on ${best ? `${best.base} ${best.filters} ${best.exit}` : 'none'}: probability ${fmt(dsr.probability, 3)}, annualized Sharpe ${fmt(dsr.annualized, 2)}.`);
  lines.push('');
  lines.push('## Filter true versus false');
  lines.push('');
  lines.push('| Base | Filter | State | X1 n | X1 mean | X1 win | X1 PF | X1 t | X2 n | X2 mean | X2 win | X2 PF | X2 t |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of analysis) {
    lines.push(`| ${row.base} | ${row.filter} | ${row.state} | ${row.x1.trades} | ${fmt(row.x1.mean == null ? null : row.x1.mean * 100)}% | ${fmt(row.x1.win == null ? null : row.x1.win * 100)}% | ${fmt(row.x1.pf)} | ${fmt(row.x1.t)} | ${row.x2.trades} | ${fmt(row.x2.mean == null ? null : row.x2.mean * 100)}% | ${fmt(row.x2.win == null ? null : row.x2.win * 100)}% | ${fmt(row.x2.pf)} | ${fmt(row.x2.t)} |`);
  }
  lines.push('');
  lines.push('## Top trials by excess t');
  lines.push('');
  lines.push('| Rank | Base | Filters | Exit | Trades | Excess t | PF | Mean |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |');
  ranked.slice(0, 15).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.base} | ${row.filters} | ${row.exit} | ${row.trades} | ${fmt(row.t)} | ${fmt(row.pf)} | ${fmt(row.mean == null ? null : row.mean * 100)}% |`);
  });
  lines.push('');
  lines.push('## Frozen');
  lines.push('');
  if (!frozen.length) lines.push('No trial had at least 100 trades and PF at least 1.2.');
  for (const row of frozen) {
    lines.push(`- ${row.base} ${row.filters} ${row.exit}: n=${row.trades}, t=${fmt(row.t)}, PF=${fmt(row.pf)}`);
    lines.push('');
    lines.push('| Year | Trades | Mean | Win | PF |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const year of row.years) lines.push(`| ${year.year} | ${year.trades} | ${fmt(year.mean * 100)}% | ${fmt(year.win * 100)}% | ${fmt(year.pf)} |`);
    lines.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'supertrend-combo-stage1-2026-10-07.md'), `${lines.join('\n')}\n`);
  const freeze = [];
  freeze.push('# Frozen Supertrend combinations — 2026-10-07');
  freeze.push('');
  freeze.push('Stage 1 freeze. These rules are not to be changed before Stage 2.');
  freeze.push('Stage 2 has not been run.');
  freeze.push(`Pre-registration \`30eb91406e66b4b8be9afbd15ad426fdc5330d7e\`.`);
  freeze.push('');
  freeze.push('Ranked by per-trade excess t among trials with at least 100 trades and PF at least 1.2.');
  freeze.push('');
  if (!frozen.length) freeze.push('None qualified.');
  frozen.forEach((row, index) => {
    freeze.push(`## ${index + 1}. ${row.base} / ${row.filters} / ${row.exit}`);
    freeze.push('');
    freeze.push(`- Base: ${row.base === 'B1' ? 'daily Supertrend(10, 3) bull flip' : 'weekly Supertrend(10, 3) bull flip'}, enter next open.`);
    freeze.push(`- Filters, all required: ${row.filters}.`);
    freeze.push(`- Exit: ${row.exit}.`);
    freeze.push(`- Stage 1: ${row.trades} trades, excess t ${fmt(row.t)}, PF ${fmt(row.pf)}, mean excess ${fmt(row.mean * 100)}%.`);
    freeze.push('');
  });
  fs.writeFileSync(path.join(ROOT, 'docs', 'supertrend-combo-frozen-2026-10-07.md'), `${freeze.join('\n')}\n`);
  fs.writeFileSync(path.join(ROOT, 'scripts', 'supertrend-combo-stage1.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    preregistration: '30eb91406e66b4b8be9afbd15ad426fdc5330d7e',
    priced: books.length,
    members: members.length,
    volumeSymbols,
    dsr,
    frozen: frozen.map(row => ({ base: row.base, filters: row.filters, exit: row.exit, trades: row.trades, t: row.t, pf: row.pf, mean: row.mean, years: row.years })),
    trials: trials.map(row => ({ base: row.base, filters: row.filters, exit: row.exit, trades: row.trades, t: row.t, pf: row.pf, mean: row.mean, years: row.years })),
  }));
  console.log('frozen', frozen.map(row => `${row.base} ${row.filters} ${row.exit} t=${row.t}`).join(' | ') || 'none');
  console.log('dsr', dsr.probability, dsr.annualized);
}

main();
