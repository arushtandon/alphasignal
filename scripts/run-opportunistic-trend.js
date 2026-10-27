'use strict';

// Research only. Rules are frozen in docs/opportunistic-trend-preregistration-2026-10-07.md.
const fs = require('fs');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { applyCosts } = require('../lib/research/cost-model');
const { membershipAt } = require('../lib/research/us-universe');
const { scoreCell, deflatedSharpe, sharpe, compound } = require('../lib/research/strategy-gaps');
const {
  loadSeries, loadSeriesPath, fxOn, dayReturns, hedgeDays, roundTrip, borrowRate, bookFrom,
} = require('./run-downtrend-short');

const ROOT = path.join(__dirname, '..');
const OUT_MD = path.join(ROOT, 'docs', 'opportunistic-trend-results-2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'scripts', 'opportunistic-trend-results.json');
const SANITY = ['NKE', 'SBUX', 'MCD', 'GFS', 'META', 'FB', 'INTC', 'VOW3.DE'];

function atr14(series) {
  const out = new Float64Array(series.close.length);
  let sum = 0;
  for (let index = 1; index < series.close.length; index += 1) {
    const prev = series.close[index - 1];
    const range = Math.max(
      series.high[index] - series.low[index],
      Math.abs(series.high[index] - prev),
      Math.abs(series.low[index] - prev),
    );
    sum += range;
    if (index > 14) {
      const oldPrev = series.close[index - 15];
      const oldRange = Math.max(
        series.high[index - 14] - series.low[index - 14],
        Math.abs(series.high[index - 14] - oldPrev),
        Math.abs(series.low[index - 14] - oldPrev),
      );
      sum -= oldRange;
    }
    out[index] = index >= 14 ? sum / 14 : NaN;
  }
  return out;
}
function closeExtreme(values, length, min) {
  const out = new Float64Array(values.length);
  const deque = [];
  for (let index = 0; index < values.length; index += 1) {
    while (deque.length && deque[0] <= index - length) deque.shift();
    while (deque.length && (min ? values[deque[deque.length - 1]] >= values[index] : values[deque[deque.length - 1]] <= values[index])) deque.pop();
    deque.push(index);
    out[index] = index >= length - 1 ? values[deque[0]] : NaN;
  }
  return out;
}
function ret126(series) {
  const out = new Float64Array(series.close.length);
  for (let index = 0; index < series.close.length; index += 1) {
    out[index] = index >= 126 && series.close[index - 126] > 0
      ? series.close[index] / series.close[index - 126] - 1
      : NaN;
  }
  return out;
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
function shortSetup(series, index) {
  const close = series.close[index];
  const ma = series.ma200[index];
  const prior = index >= 21 ? series.ma200[index - 21] : NaN;
  return Number.isFinite(close) && Number.isFinite(ma) && close < ma
    && Number.isFinite(prior) && ma < prior
    && Number.isFinite(series.lowClose[index]) && close <= series.lowClose[index];
}
function longSetup(series, index) {
  const close = series.close[index];
  const ma = series.ma200[index];
  const prior = index >= 21 ? series.ma200[index - 21] : NaN;
  return Number.isFinite(close) && Number.isFinite(ma) && close > ma
    && Number.isFinite(prior) && ma > prior
    && Number.isFinite(series.highClose[index]) && close >= series.highClose[index];
}
function coverMa50(series, entry) {
  const last = Math.min(series.close.length - 1, entry + 125);
  for (let index = entry; index <= last; index += 1) {
    if (series.close[index] > series.ma50[index]) return { exit: index, price: series.close[index], truncated: false };
  }
  return { exit: last, price: series.close[last], truncated: last < entry + 125 };
}
function coverTrail(series, entry) {
  const last = Math.min(series.close.length - 1, entry + 125);
  let lowest = series.close[entry];
  for (let index = entry; index <= last; index += 1) {
    lowest = Math.min(lowest, series.close[index]);
    const band = series.atr[index];
    if (Number.isFinite(band) && series.high[index] >= lowest + 3 * band) {
      return { exit: index, price: lowest + 3 * band, truncated: false };
    }
  }
  return { exit: last, price: series.close[last], truncated: last < entry + 125 };
}
function finishShort(signal, exit, exitPrice, spec, context) {
  const series = signal.series;
  const days = dayReturns(series, signal.entry, exit, -1);
  if (exitPrice !== series.close[exit]) {
    const prev = exit === signal.entry ? series.open[exit] : series.close[exit - 1];
    days[days.length - 1].ret = prev > 0 ? -(exitPrice / prev - 1) : days[days.length - 1].ret;
  }
  let hedgeCost = 0;
  if (spec.hedge) {
    const extra = hedgeDays(context.benchmark, days.map(row => row.date));
    if (!extra) return null;
    for (let index = 0; index < days.length; index += 1) days[index].ret += extra[index];
    hedgeCost = roundTrip('US', context.benchmark.symbol, 0);
  }
  const stockCost = roundTrip(context.costMarket, series.symbol, 0);
  const rate = borrowRate(series, signal.entry, context.fx);
  const borrow = (exit - signal.entry + 1) * (rate / 252);
  days[days.length - 1].ret -= stockCost + hedgeCost + borrow;
  const indexLong = indexPath(context.benchmark, days.map(row => row.date));
  const absoluteDays = dayReturns(series, signal.entry, exit, -1);
  if (exitPrice !== series.close[exit]) {
    const prev = exit === signal.entry ? series.open[exit] : series.close[exit - 1];
    absoluteDays[absoluteDays.length - 1].ret = prev > 0 ? -(exitPrice / prev - 1) : absoluteDays[absoluteDays.length - 1].ret;
  }
  const absolute = absoluteDays.reduce((equity, row) => equity * (1 + row.ret), 1) - 1;
  const excessDays = spec.hedge ? days : absoluteDays.map((row, index) => ({
    date: row.date,
    ret: row.ret + (indexLong[index] || 0),
  }));
  if (!spec.hedge) {
    const drag = stockCost + borrow;
    excessDays[excessDays.length - 1].ret -= drag;
  }
  return {
    symbol: series.symbol,
    side: 'short',
    signalDate: signal.signalDate,
    entryDate: series.dates[signal.entry],
    exitDate: series.dates[exit],
    date: series.dates[exit],
    ret: excessDays.reduce((equity, row) => equity * (1 + row.ret), 1) - 1,
    absolute,
    days: excessDays,
    truncated: exit === series.close.length - 1 && signal.entry + 125 > exit,
  };
}
function indexPath(benchmark, dates) {
  const out = [];
  let prev = null;
  for (const date of dates) {
    const index = indexOn(benchmark, date);
    if (index < 0) { out.push(0); continue; }
    if (prev == null) {
      out.push(benchmark.dates[index] === date && benchmark.open[index] > 0
        ? benchmark.close[index] / benchmark.open[index] - 1
        : 0);
    } else if (index === prev) out.push(0);
    else out.push(benchmark.close[index] / benchmark.close[prev] - 1);
    prev = index;
  }
  return out;
}
function runMarket(label, snapshot, benchmark, books, fx, costMarket) {
  for (const series of books.values()) {
    series.lowClose = closeExtreme(series.close, 252, true);
    series.highClose = closeExtreme(series.close, 252, false);
    series.r126 = ret126(series);
    series.atr = atr14(series);
  }
  benchmark.r126 = ret126(benchmark);
  const ranked = [];
  for (let index = 252; index < benchmark.dates.length - 1; index += 1) {
    const date = benchmark.dates[index];
    if (date < '2010-01-01') continue;
    if (!Number.isFinite(benchmark.r126[index])) continue;
    const members = membershipAt(snapshot, date);
    const rows = [];
    for (const symbol of members) {
      const series = books.get(symbol);
      if (!series) continue;
      const at = series.byDate.get(date);
      if (at == null || !Number.isFinite(series.r126[at])) continue;
      rows.push({ symbol, series, at, rel: series.r126[at] - benchmark.r126[index] });
    }
    if (rows.length < 5) continue;
    rows.sort((a, b) => a.rel - b.rel || a.symbol.localeCompare(b.symbol));
    const width = Math.floor(rows.length * 0.2);
    if (width < 1) continue;
    const indexDown = Number.isFinite(benchmark.ma200[index]) && benchmark.close[index] < benchmark.ma200[index];
    ranked.push({
      date,
      indexDown,
      shorts: rows.slice(0, width).filter(row => shortSetup(row.series, row.at)),
      longs: rows.slice(-width).filter(row => longSetup(row.series, row.at)),
    });
  }
  const variants = [
    { id: 'a', hedge: false, cover: 'ma50', indexFilter: false, flip: false },
    { id: 'b', hedge: false, cover: 'trail', indexFilter: false, flip: false },
    { id: 'c', hedge: true, cover: 'ma50', indexFilter: false, flip: false },
    { id: 'd', hedge: true, cover: 'trail', indexFilter: false, flip: false },
    { id: 'e', hedge: true, cover: 'ma50', indexFilter: true, flip: false },
    { id: 'f', hedge: false, cover: 'ma50', indexFilter: false, flip: true },
  ];
  const folds = buildDateAlignedFolds(benchmark.dates, { ...FOLD_SPEC, embargoBars: EMBARGO.medium });
  const cells = [];
  const sanity = [];
  const context = { benchmark, fx, costMarket };
  for (const variant of variants) {
    const openUntil = new Map();
    const ready = new Map();
    const trades = [];
    let truncated = 0;
    for (const day of ranked) {
      for (const row of day.shorts) {
        if (variant.indexFilter && !day.indexDown) continue;
        if ((openUntil.get(row.symbol) || '') >= day.date) continue;
        const entry = row.at + 1;
        if (entry >= row.series.close.length) continue;
        if (Date.parse(row.series.dates[entry]) - Date.parse(day.date) > 7 * 86400000) continue;
        const covered = variant.cover === 'trail' ? coverTrail(row.series, entry) : coverMa50(row.series, entry);
        const trade = finishShort({ ...row, entry, signalDate: day.date }, covered.exit, covered.price, variant, context);
        if (!trade) continue;
        if (trade.truncated) truncated += 1;
        openUntil.set(row.symbol, trade.exitDate);
        trades.push(trade);
        if (variant.flip) ready.set(row.symbol, trade.exitDate);
      }
      if (!variant.flip) continue;
      for (const row of day.longs) {
        const after = ready.get(row.symbol);
        if (!after || day.date <= after) continue;
        if ((openUntil.get(row.symbol) || '') >= day.date) continue;
        const entry = row.at + 1;
        if (entry >= row.series.close.length) continue;
        let exit = row.series.close.length - 1;
        for (let cursor = entry; cursor < row.series.close.length; cursor += 1) {
          if (row.series.close[cursor] < row.series.ma200[cursor]) { exit = cursor; break; }
        }
        const days = dayReturns(row.series, entry, exit, 1);
        const cost = applyCosts(0, {
          market: costMarket,
          symbol: row.symbol,
          side: 'buy',
          holdDays: 0,
          profile: { borrowBpsPerDay: 0 },
        });
        days[days.length - 1].ret -= cost.costPct / 100;
        const indexLong = indexPath(benchmark, days.map(item => item.date));
        const excessDays = days.map((item, index) => ({ date: item.date, ret: item.ret - (indexLong[index] || 0) }));
        const trade = {
          symbol: row.symbol,
          side: 'long',
          signalDate: day.date,
          entryDate: row.series.dates[entry],
          exitDate: row.series.dates[exit],
          date: row.series.dates[exit],
          ret: excessDays.reduce((equity, item) => equity * (1 + item.ret), 1) - 1,
          absolute: days.reduce((equity, item) => equity * (1 + item.ret), 1) - 1,
          days: excessDays,
        };
        trades.push(trade);
        openUntil.set(row.symbol, trade.exitDate);
        ready.delete(row.symbol);
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
      years.push({ year, returnPct: slice.length ? +(compound(slice.map(row => row.ret)) * 100).toFixed(2) : null, trades: trades.filter(row => row.exitDate.startsWith(String(year))).length });
    }
    let concurrent = 0;
    const events = [];
    for (const trade of trades) {
      events.push({ date: trade.entryDate, delta: 1 });
      events.push({ date: trade.exitDate, delta: -1 });
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.delta - b.delta);
    let open = 0;
    for (const event of events) {
      open += event.delta;
      if (open > concurrent) concurrent = open;
    }
    const hot = benchmarkMonths(benchmark).sort((a, b) => b.ret - a.ret).slice(0, Math.floor(benchmarkMonths(benchmark).length / 10));
    const hotSet = new Set(hot.map(row => row.month));
    const reboundSlice = packed.monthly.filter(row => hotSet.has(row.date.slice(0, 7)));
    cells.push({
      id: `${label}|${variant.id}`,
      market: label,
      variant: variant.id,
      verdict: scored.verdict,
      full: scored.full,
      windows: scored.windows,
      trades: trades.length,
      truncated,
      years,
      concurrent,
      rebound: reboundSlice.length ? +(compound(reboundSlice.map(row => row.ret)) * 100).toFixed(2) : null,
      worst: trades.slice().sort((a, b) => a.ret - b.ret).slice(0, 10).map(row => ({
        symbol: row.symbol, side: row.side, signalDate: row.signalDate, exitDate: row.exitDate, ret: row.ret,
      })),
      decisionReturns: packed.monthly.map(row => row.ret),
    });
    for (const trade of trades) {
      if (!SANITY.includes(trade.symbol)) continue;
      if (trade.symbol === 'META' && (trade.signalDate < '2021-01-01' || trade.signalDate > '2023-12-31')) continue;
      sanity.push({ market: label, variant: variant.id, symbol: trade.symbol, side: trade.side, signalDate: trade.signalDate, exitDate: trade.exitDate, ret: trade.ret });
    }
    console.log(label, variant.id, scored.verdict, 'trades', trades.length, 't', scored.full.tStat);
  }
  return { cells, sanity };
}
function benchmarkMonths(benchmark) {
  const monthly = [];
  let bucket = [];
  let stamp = null;
  for (let index = 1; index < benchmark.dates.length; index += 1) {
    if (benchmark.dates[index] < '2010-01-01') continue;
    const prev = benchmark.close[index - 1];
    if (!(prev > 0)) continue;
    const date = benchmark.dates[index];
    if (stamp && date.slice(0, 7) !== stamp.slice(0, 7)) {
      monthly.push({ month: stamp.slice(0, 7), ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
      bucket = [];
    }
    bucket.push(benchmark.close[index] / prev - 1);
    stamp = date;
  }
  if (bucket.length) monthly.push({ month: stamp.slice(0, 7), ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
  return monthly;
}
function ever(snapshot) {
  const symbols = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) symbols.add(change.added);
    if (change.removed) symbols.add(change.removed);
  }
  return [...symbols];
}
function fmt(value) {
  return value == null || !Number.isFinite(value) ? '—' : String(value);
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
  ];
  const daxFile = path.join(ROOT, 'data', 'research', 'index-membership', 'dax.json');
  const gaps = [];
  if (fs.existsSync(daxFile) && loadSeries('EWG')) markets.push(['Germany', daxFile, 'EWG', 'Germany', fx.Germany]);
  else gaps.push('Germany is a data gap: dated membership or EWG prices are missing.');
  if (!fs.existsSync(path.join(ROOT, 'data', 'research', 'index-membership', 'hsi.json'))) {
    gaps.push('Hong Kong is a data gap. A complete 2010-to-today Hang Seng change list was not assembled from the quarterly review announcements, so no membership file was written and no current constituent list was substituted. The designated-short-selling flag was not applied.');
  }
  const all = [];
  const sanity = [];
  for (const [label, file, benchSymbol, costMarket, fxSeries] of markets) {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const benchmark = loadSeries(benchSymbol);
    const books = new Map();
    for (const symbol of ever(snapshot)) {
      const series = loadSeries(symbol);
      if (series) books.set(symbol, series);
    }
    console.log(label, 'priced', books.size);
    const result = runMarket(label, snapshot, benchmark, books, fxSeries, costMarket);
    all.push(...result.cells);
    sanity.push(...result.sanity);
  }
  const lines = [
    '# F8 opportunistic single-stock trend — results',
    '',
    'Research only. Nothing was enabled. Pre-registration `292f9cf663bfcedd44b3d6f82d74565151a139eb`.',
    'An empty window is neutral. A window with trades must be net positive. There is no candidate verdict.',
    'The t-stat is on the per-trade excess return. Naked excess is the stock short minus shorting the hedge ETF over the same sessions. Hedged excess is the spread. The long in variant f is the stock minus the hedge ETF.',
    'The scan clock is the hedge ETF calendar. Profile files have no market cap, so 3% borrow is only a price under $5. Covestro, MAN, Metro and Wirecard have no usable Yahoo history and are listed with the DAX file.',
    '',
    ...gaps,
    '',
  ];
  for (const market of [...new Set(all.map(cell => cell.market))]) {
    const cells = all.filter(cell => cell.market === market);
    const trials = cells.map(cell => ({ sharpe: sharpe(cell.decisionReturns).sharpe, id: cell.id, returns: cell.decisionReturns }));
    const best = trials.slice().sort((a, b) => (b.sharpe || -Infinity) - (a.sharpe || -Infinity))[0];
    const dsr = best ? deflatedSharpe(trials, best.returns) : null;
    lines.push(`## ${market}`, '');
    lines.push(`Trials ${trials.length}. DSR ${dsr && dsr.probability != null ? dsr.probability.toFixed(3) : '—'} on ${best ? best.id : '—'}, annualized Sharpe ${dsr && dsr.annualized != null ? dsr.annualized.toFixed(2) : '—'}. Not a pass gate.`, '');
    lines.push('| Variant | Verdict | Full excess | t | PF | Trades | Max DD | Concurrent | Rebound |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const cell of cells) {
      lines.push(`| ${cell.variant} | ${cell.verdict} | ${fmt(cell.full.returnPct)}% | ${fmt(cell.full.tStat)} | ${cell.full.pfInfinite ? 'inf' : fmt(cell.full.pf)} | ${cell.trades} | ${fmt(cell.full.maxDrawdownPct)}% | ${cell.concurrent} | ${fmt(cell.rebound)}% |`);
    }
    lines.push('', '| Variant | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const cell of cells) {
      lines.push(`| ${cell.variant} | ${cell.years.map(row => fmt(row.returnPct)).join(' | ')} |`);
    }
    lines.push('');
    for (const cell of cells) {
      lines.push(`### ${cell.id} windows`, '');
      lines.push('| Window | Return | Trades |');
      lines.push('| --- | ---: | ---: |');
      for (const window of cell.windows) {
        const labelText = window.trades > 0 ? `${fmt(window.returnPct)}%` : 'neutral';
        lines.push(`| ${window.from} to ${window.to} | ${labelText} | ${window.trades} |`);
      }
      lines.push('', 'Worst 10:', '');
      for (const row of cell.worst) {
        lines.push(`- ${row.symbol} ${row.side} ${row.signalDate} to ${row.exitDate}: ${(row.ret * 100).toFixed(2)}%`);
      }
      lines.push('');
    }
  }
  lines.push('## Sanity', '');
  lines.push('Every variant a–f is in the market tables above, including the hedged books c, d, and e. Dollar P&L is that trade\'s excess return on a $30,000 leg.', '');
  lines.push('| Market | Variant | Symbol | Side | Signal | Exit | Excess | P&L |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: |');
  for (const row of sanity.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.signalDate.localeCompare(b.signalDate) || a.variant.localeCompare(b.variant))) {
    const pnl = row.ret * 30000;
    lines.push(`| ${row.market} | ${row.variant} | ${row.symbol} | ${row.side} | ${row.signalDate} | ${row.exitDate} | ${(row.ret * 100).toFixed(2)}% | $${pnl.toFixed(0)} |`);
  }
  if (!sanity.length) lines.push('| — | — | — | — | — | — | — |');
  const seen = new Set(sanity.map(row => row.symbol));
  const quiet = ['NKE', 'SBUX', 'MCD', 'GFS', 'META', 'INTC', 'VOW3.DE'].filter(symbol => !seen.has(symbol));
  if (quiet.length) lines.push('', `No trade: ${quiet.join(', ')}.`);
  lines.push('');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    preregistration: '292f9cf663bfcedd44b3d6f82d74565151a139eb',
    gaps,
    cells: all.map(cell => ({ ...cell, decisionReturns: undefined })),
    sanity,
  }, null, 2));
  console.log(`wrote ${OUT_MD}`);
}

main();
