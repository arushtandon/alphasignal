'use strict';

// Research only. Rules are frozen in docs/supertrend-preregistration-2026-10-07.md.
const fs = require('fs');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { applyCosts } = require('../lib/research/cost-model');
const { membershipAt } = require('../lib/research/us-universe');
const { scoreCell, deflatedSharpe, sharpe, compound } = require('../lib/research/strategy-gaps');
const { loadSeries, loadSeriesPath, dayReturns, hedgeDays, roundTrip, borrowRate, bookFrom } = require('./run-downtrend-short');

const ROOT = path.join(__dirname, '..');
const OUT_MD = path.join(ROOT, 'docs', 'supertrend-results-2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'scripts', 'supertrend-results.json');
const NOTIONAL = 30000;

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
  if (close.length <= period) return atr;
  atr[period] = seed / period;
  for (let index = period + 1; index < close.length; index += 1) {
    atr[index] = (atr[index - 1] * (period - 1) + tr[index]) / period;
  }
  return atr;
}

function supertrend(high, low, close, period, multiplier) {
  const atr = wilderAtr(high, low, close, period);
  const direction = new Int8Array(close.length);
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
  }
  return direction;
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

function mondayOf(date) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

function weeklyBars(series) {
  const groups = [];
  let current = null;
  for (let index = 0; index < series.dates.length; index += 1) {
    const key = mondayOf(series.dates[index]);
    if (!current || current.key !== key) {
      current = {
        key,
        start: index,
        end: index,
        open: series.open[index],
        high: series.high[index],
        low: series.low[index],
        close: series.close[index],
      };
      groups.push(current);
    } else {
      current.end = index;
      current.high = Math.max(current.high, series.high[index]);
      current.low = Math.min(current.low, series.low[index]);
      current.close = series.close[index];
    }
  }
  return {
    high: groups.map(row => row.high),
    low: groups.map(row => row.low),
    close: groups.map(row => row.close),
    end: groups.map(row => row.end),
  };
}

function ever(snapshot) {
  const symbols = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) symbols.add(change.added);
    if (change.removed) symbols.add(change.removed);
  }
  return [...symbols];
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

function indexPath(benchmark, dates) {
  const out = [];
  let prev = null;
  for (const date of dates) {
    const index = indexOn(benchmark, date);
    if (index < 0) { out.push(0); continue; }
    if (prev == null) {
      out.push(benchmark.dates[index] === date && benchmark.open[index] > 0
        ? benchmark.close[index] / benchmark.open[index] - 1 : 0);
    } else if (index === prev) out.push(0);
    else out.push(benchmark.close[index] / benchmark.close[prev] - 1);
    prev = index;
  }
  return out;
}

function openToOpen(series, entry, exit, sign) {
  const days = dayReturns(series, entry, exit, sign);
  if (exit > entry && series.close[exit - 1] > 0 && series.open[exit] > 0) {
    days[days.length - 1].ret = sign * (series.open[exit] / series.close[exit - 1] - 1);
  }
  return days;
}

function finishTrade(spec, series, entry, exit, side, benchmark, fx, costMarket) {
  const sign = side === 'short' ? -1 : 1;
  const days = openToOpen(series, entry, exit, sign);
  let hedgeCost = 0;
  if (side === 'short') {
    const extra = hedgeDays(benchmark, days.map(row => row.date));
    if (!extra) return null;
    for (let index = 0; index < days.length; index += 1) days[index].ret += extra[index];
    hedgeCost = roundTrip('US', benchmark.symbol, 0);
  }
  const stockCost = side === 'short'
    ? roundTrip(costMarket, series.symbol, 0)
    : applyCosts(0, { market: costMarket, symbol: series.symbol, side: 'buy', holdDays: 0 }).costPct / 100;
  const borrow = side === 'short' ? (exit - entry + 1) * (borrowRate(series, entry, fx) / 252) : 0;
  days[days.length - 1].ret -= stockCost + hedgeCost + borrow;
  const indexLong = indexPath(benchmark, days.map(row => row.date));
  const excessDays = side === 'short'
    ? days
    : days.map((row, index) => ({ date: row.date, ret: row.ret - (indexLong[index] || 0) }));
  const absolute = openToOpen(series, entry, exit, sign)
    .reduce((equity, row) => equity * (1 + row.ret), 1) - 1;
  return {
    symbol: series.symbol,
    side,
    entryDate: series.dates[entry],
    exitDate: series.dates[exit],
    date: series.dates[exit],
    ret: excessDays.reduce((equity, row) => equity * (1 + row.ret), 1) - 1,
    absolute,
    days: excessDays,
    pnl: null,
  };
}

function signalsFor(series, weekly) {
  const daily10 = supertrend(series.high, series.low, series.close, 10, 3);
  const daily14 = supertrend(series.high, series.low, series.close, 14, 4);
  const ma200 = rollingMean(series.close, 200);
  const week = weeklyBars(series);
  const weekDir = supertrend(week.high, week.low, week.close, 10, 3);
  const weeklyAt = new Int8Array(series.close.length);
  for (let index = 0; index < week.end.length; index += 1) {
    if (weekDir[index] !== 0) weeklyAt[week.end[index]] = weekDir[index];
  }
  let carried = 0;
  for (let index = 0; index < weeklyAt.length; index += 1) {
    if (weeklyAt[index] === 0) weeklyAt[index] = carried;
    else carried = weeklyAt[index];
  }
  return { daily10, daily14, ma200, weeklyAt, weekEnds: new Set(week.end) };
}

function runMarket(label, snapshot, benchmark, books, fx, costMarket) {
  const indexTrend = supertrend(benchmark.high, benchmark.low, benchmark.close, 10, 3);
  const prepared = [];
  for (const [symbol, series] of books) {
    prepared.push({ symbol, series, ...signalsFor(series) });
  }
  const variants = ['a', 'b', 'c', 'd', 'e', 'f'];
  const folds = buildDateAlignedFolds(benchmark.dates, { ...FOLD_SPEC, embargoBars: EMBARGO.medium });
  const cells = [];
  const sanity = [];
  for (const variant of variants) {
    const trades = [];
    const openUntil = new Map();
    for (const row of prepared) {
      const direction = variant === 'b' ? row.daily14 : variant === 'd' ? row.weeklyAt : row.daily10;
      for (let index = 1; index < row.series.close.length - 1; index += 1) {
        if (variant === 'd' && !row.weekEnds.has(index)) continue;
        const previous = direction[index - 1];
        const current = direction[index];
        if (previous === 0 || current === 0 || previous === current) continue;
        const side = current > 0 ? 'long' : 'short';
        if (variant === 'a' || variant === 'b' || variant === 'c' || variant === 'd') {
          if (side !== 'long') continue;
        } else if (side !== 'short') continue;
        const date = row.series.dates[index];
        if (date < '2010-01-01') continue;
        if (!membershipAt(snapshot, date).has(row.symbol)) continue;
        if (variant === 'c' && !(row.series.close[index] > row.ma200[index])) continue;
        if (variant === 'f') {
          const benchIndex = indexOn(benchmark, date);
          if (benchIndex < 0 || indexTrend[benchIndex] !== -1) continue;
        }
        if ((openUntil.get(row.symbol) || '') >= date) continue;
        const entry = index + 1;
        if (entry >= row.series.close.length) continue;
        if (Date.parse(row.series.dates[entry]) - Date.parse(date) > 7 * 86400000) continue;
        let flip = -1;
        const start = variant === 'd' ? index + 1 : entry;
        for (let cursor = start; cursor < direction.length; cursor += 1) {
          if (variant === 'd' && !row.weekEnds.has(cursor)) continue;
          if (direction[cursor] !== 0 && direction[cursor] !== current && direction[cursor - 1] === current) {
            flip = cursor;
            break;
          }
        }
        const exit = flip >= 0 ? Math.min(row.series.close.length - 1, flip + 1) : row.series.close.length - 1;
        if (exit <= entry) continue;
        const trade = finishTrade(variant, row.series, entry, exit, side === 'long' ? 'long' : 'short', benchmark, fx, costMarket);
        if (!trade) continue;
        trade.pnl = +(trade.ret * NOTIONAL).toFixed(2);
        openUntil.set(row.symbol, trade.exitDate);
        trades.push(trade);
        const watch = ['NKE', 'SBUX', 'META', 'FB', 'INTC', 'VOW3.DE'];
        const overlapsMeta = trade.entryDate <= '2023-12-31' && trade.exitDate >= '2021-01-01';
        if (watch.includes(row.symbol) && (row.symbol !== 'META' && row.symbol !== 'FB' || overlapsMeta)) {
          sanity.push({ market: label, variant, ...trade, days: undefined });
        }
      }
    }
    const packed = bookFrom(trades, benchmark);
    const scored = scoreCell({
      monthly: packed.monthly,
      trades,
      benchmarkMonthly: packed.monthly.map(row => ({ date: row.date, ret: 0 })),
      daily: packed.daily,
      folds,
      tSource: 'trade',
      emptyWindow: 'neutral',
    });
    const years = [];
    for (let year = 2010; year <= 2026; year += 1) {
      const slice = packed.monthly.filter(row => row.date.startsWith(String(year)));
      years.push({
        year,
        returnPct: slice.length ? +(compound(slice.map(row => row.ret)) * 100).toFixed(2) : null,
        trades: trades.filter(row => row.exitDate.startsWith(String(year))).length,
      });
    }
    const months = [];
    let bucket = [];
    let stamp = null;
    for (let index = 1; index < benchmark.dates.length; index += 1) {
      if (benchmark.dates[index] < '2010-01-01') continue;
      const month = benchmark.dates[index].slice(0, 7);
      const ret = benchmark.close[index] / benchmark.close[index - 1] - 1;
      if (stamp && month !== stamp) {
        months.push({ month: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
        bucket = [];
      }
      bucket.push(ret);
      stamp = month;
    }
    if (bucket.length) months.push({ month: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
    const hot = new Set(months.slice().sort((a, b) => b.ret - a.ret).slice(0, Math.floor(months.length / 10)).map(row => row.month));
    const reboundSlice = packed.monthly.filter(row => hot.has(row.date.slice(0, 7)));
    cells.push({
      market: label,
      variant,
      verdict: scored.verdict,
      full: scored.full,
      windows: scored.windows,
      trades: trades.length,
      years,
      rebound: reboundSlice.length ? +(compound(reboundSlice.map(row => row.ret)) * 100).toFixed(2) : null,
      worst: trades.slice().sort((a, b) => a.ret - b.ret).slice(0, 10).map(row => ({
        symbol: row.symbol, entry: row.entryDate, exit: row.exitDate,
        excessPct: +(row.ret * 100).toFixed(2), pnl: row.pnl,
      })),
      monthly: packed.monthly,
    });
    console.log(label, variant, scored.verdict, trades.length);
  }
  return { cells, sanity };
}

function main() {
  const fx = {
    UK: loadSeriesPath(path.join(ROOT, 'data', 'research', 'fx', 'GBPUSD_X.json')),
    France: loadSeriesPath(path.join(ROOT, 'data', 'research', 'fx', 'EURUSD_X.json')),
    Germany: loadSeriesPath(path.join(ROOT, 'data', 'research', 'fx', 'EURUSD_X.json')),
  };
  const markets = [
    ['US', path.join(ROOT, 'data', 'research', 'fmp', 'us-universe.json'), 'SPY', 'US', null],
    ['UK', path.join(ROOT, 'data', 'research', 'index-membership', 'ftse100.json'), 'EWU', 'UK', fx.UK],
    ['France', path.join(ROOT, 'data', 'research', 'index-membership', 'cac40.json'), 'EWQ', 'France', fx.France],
    ['Germany', path.join(ROOT, 'data', 'research', 'index-membership', 'dax.json'), 'EWG', 'Germany', fx.Germany],
  ];
  const all = [];
  const sanity = [];
  for (const [label, file, benchSymbol, costMarket, fxSeries] of markets) {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const benchmark = loadSeries(benchSymbol);
    if (!benchmark) throw new Error(`missing benchmark ${benchSymbol}`);
    const books = new Map();
    for (const symbol of ever(snapshot)) {
      const series = loadSeries(symbol);
      if (series) books.set(symbol, series);
    }
    console.log(label, 'priced', books.size, 'of', ever(snapshot).length);
    const result = runMarket(label, snapshot, benchmark, books, fxSeries, costMarket);
    all.push(...result.cells);
    sanity.push(...result.sanity);
  }
  const trials = all.map(cell => ({ sharpe: sharpe(cell.monthly.map(row => row.ret)).sharpe }));
  const best = all.slice().sort((a, b) => (b.full.tStat || -99) - (a.full.tStat || -99))[0];
  const dsr = deflatedSharpe(trials, best ? best.monthly.map(row => row.ret) : []);
  const fmt = value => value == null || !Number.isFinite(Number(value)) ? '—' : String(value);
  const lines = [
    '# F10 Supertrend — results',
    '',
    'Research only. Nothing was enabled. Pre-registration `6be8587e5a6a1742b678c126ef9a00b43be2807c`.',
    '',
    `Deflated Sharpe over 24 trials, scored on ${best ? best.market + ' ' + best.variant : 'none'} (the highest excess t): probability ${fmt(dsr.probability == null ? null : +dsr.probability.toFixed(3))}, annualized Sharpe ${fmt(dsr.annualized == null ? null : +dsr.annualized.toFixed(2))}. Not a pass gate.`,
    '',
    '| Market | Variant | Verdict | Return | Excess t | PF | Trades | Max DD | Rebound |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const cell of all) {
    lines.push(`| ${cell.market} | ${cell.variant} | ${cell.verdict} | ${fmt(cell.full.returnPct)}% | ${fmt(cell.full.tStat)} | ${cell.full.pfInfinite ? 'inf' : fmt(cell.full.pf)} | ${cell.trades} | ${fmt(cell.full.maxDrawdownPct)}% | ${fmt(cell.rebound)}% |`);
  }
  lines.push('', '## Per year', '');
  for (const cell of all) {
    lines.push(`### ${cell.market} ${cell.variant}`, '', '| Year | Return | Trades |', '| --- | ---: | ---: |');
    for (const year of cell.years) lines.push(`| ${year.year} | ${fmt(year.returnPct)}% | ${year.trades} |`);
    lines.push('');
  }
  lines.push('## Worst 10', '');
  for (const cell of all) {
    lines.push(`### ${cell.market} ${cell.variant}`, '', '| Symbol | Entry | Exit | Excess | P&L |', '| --- | --- | --- | ---: | ---: |');
    for (const row of cell.worst) lines.push(`| ${row.symbol} | ${row.entry} | ${row.exit} | ${row.excessPct}% | $${row.pnl} |`);
    lines.push('');
  }
  lines.push('## Named trades', '', '| Market | Variant | Symbol | Entry | Exit | Excess | P&L |', '| --- | --- | --- | --- | --- | ---: | ---: |');
  for (const row of sanity) {
    lines.push(`| ${row.market} | ${row.variant} | ${row.symbol} | ${row.entryDate} | ${row.exitDate} | ${+(row.ret * 100).toFixed(2)}% | $${row.pnl} |`);
  }
  const published = all.map(cell => ({ ...cell, monthly: undefined }));
  fs.writeFileSync(OUT_JSON, JSON.stringify({ preregistration: '6be8587e5a6a1742b678c126ef9a00b43be2807c', dsr, cells: published, sanity }, null, 2));
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log('wrote', OUT_MD);
}

main();
