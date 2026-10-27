'use strict';

// Research only. Rules are frozen in docs/downtrend-short-preregistration-2026-10-07.md.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { applyCosts } = require('../lib/research/cost-model');
const { positionSize } = require('../lib/research/exit-amendment');
const { membershipAt } = require('../lib/research/us-universe');
const {
  compound, maxDrawdown, sharpe, scoreCell, deflatedSharpe, trialSharpes,
} = require('../lib/research/strategy-gaps');

const ROOT = path.join(__dirname, '..');
const PRICE_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const EARNINGS_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-earnings');
const PROFILE_DIR = path.join(ROOT, 'data', 'research', 'fmp-profiles');
const OUT_MD = path.join(ROOT, 'docs', 'downtrend-short-results-2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'scripts', 'downtrend-short-results.json');
const PERIOD1 = 631152000;
const TICKET = 30000;
const SECTOR_ETF = {
  Technology: 'XLK',
  'Financial Services': 'XLF',
  Healthcare: 'XLV',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  Energy: 'XLE',
  Industrials: 'XLI',
  'Basic Materials': 'XLB',
  'Real Estate': 'XLRE',
  Utilities: 'XLU',
  'Communication Services': 'XLC',
};
const SANITY = ['NKE', 'SBUX', 'MCD', 'GFS', 'NVO'];

function dateOf(bar) {
  const value = Number(bar?.t ?? bar);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function yahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${PERIOD1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  return new Promise(resolve => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body)?.chart?.result?.[0];
          const stamps = result?.timestamp || [];
          const quote = result?.indicators?.quote?.[0] || {};
          const bars = [];
          for (let index = 0; index < stamps.length; index += 1) {
            if (!(quote.close?.[index] > 0)) continue;
            bars.push({
              t: stamps[index],
              o: quote.open?.[index] || quote.close[index],
              h: quote.high?.[index] || quote.close[index],
              l: quote.low?.[index] || quote.close[index],
              c: quote.close[index],
            });
          }
          resolve(bars);
        } catch (_) { resolve([]); }
      });
    });
    request.on('error', () => resolve([]));
    request.setTimeout(20000, () => request.destroy());
  });
}
async function ensurePrice(symbol) {
  const file = path.join(PRICE_DIR, `${symbol}.json`);
  if (fs.existsSync(file)) return true;
  const bars = await yahooChart(symbol);
  if (!bars.length) return false;
  fs.writeFileSync(file, JSON.stringify({ bars }));
  return true;
}
function loadSeries(symbol) {
  const file = path.join(PRICE_DIR, `${String(symbol).replace(/[\\/]/g, '_')}.json`);
  if (!fs.existsSync(file)) return null;
  const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars || [];
  const dates = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || !(bar.c > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) || Number(bar.c));
    high.push(Number(bar.h) || Number(bar.c));
    low.push(Number(bar.l) || Number(bar.c));
    close.push(Number(bar.c));
  }
  if (dates.length < 260) return null;
  return prepare({ symbol, dates, open, high, low, close });
}
function rollingMin(values, length) {
  const out = new Float64Array(values.length);
  const deque = [];
  for (let index = 0; index < values.length; index += 1) {
    while (deque.length && deque[0] <= index - length) deque.shift();
    while (deque.length && values[deque[deque.length - 1]] >= values[index]) deque.pop();
    deque.push(index);
    out[index] = index >= length - 1 ? values[deque[0]] : NaN;
  }
  return out;
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
function prepare(series) {
  const close = series.close;
  const ret121 = new Float64Array(close.length);
  for (let index = 0; index < close.length; index += 1) {
    ret121[index] = index >= 252 && close[index - 252] > 0
      ? close[index - 21] / close[index - 252] - 1
      : NaN;
  }
  const byDate = new Map(series.dates.map((date, index) => [date, index]));
  return {
    ...series,
    ma200: rollingMean(close, 200),
    ma50: rollingMean(close, 50),
    low252: rollingMin(series.low, 252),
    ret121,
    byDate,
  };
}
function loadFx(file) {
  const full = path.join(ROOT, 'data', 'research', 'fx', file);
  if (!fs.existsSync(full)) return null;
  const series = loadSeriesPath(full);
  return series;
}
function loadSeriesPath(file) {
  const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars || [];
  return prepare({
    symbol: path.basename(file, '.json'),
    dates: [],
    open: [],
    high: [],
    low: [],
    close: [],
    ...packBars(bars),
  });
}
function packBars(bars) {
  const dates = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || !(bar.c > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) || Number(bar.c));
    high.push(Number(bar.h) || Number(bar.c));
    low.push(Number(bar.l) || Number(bar.c));
    close.push(Number(bar.c));
  }
  return { dates, open, high, low, close };
}
function fxOn(series, date) {
  if (!series) return null;
  let lo = 0;
  let hi = series.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] <= date) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found >= 0 ? series.close[found] : null;
}
function monthEnds(series) {
  const stops = [];
  for (let index = 1; index < series.dates.length; index += 1) {
    if (series.dates[index].slice(0, 7) !== series.dates[index - 1].slice(0, 7)) stops.push(index - 1);
  }
  if (series.dates.length) stops.push(series.dates.length - 1);
  return stops;
}
function everMembers(snapshot) {
  const ever = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
  }
  return [...ever];
}
function sectorOf(symbol) {
  const file = path.join(PROFILE_DIR, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).sector || null; }
  catch (_) { return null; }
}
function earningsOf(symbol) {
  const file = path.join(EARNINGS_DIR, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (_) { return null; }
}
function passesTechnical(series, index) {
  const close = series.close[index];
  const low = series.low252[index];
  const ma = series.ma200[index];
  const prior = index >= 21 ? series.ma200[index - 21] : NaN;
  return Number.isFinite(close) && Number.isFinite(low) && low > 0 && close <= low * 1.05
    && Number.isFinite(ma) && close < ma
    && Number.isFinite(prior) && ma < prior;
}
function earningsSoon(series, index, dates) {
  if (!dates) return false;
  for (let step = 1; step <= 5; step += 1) {
    const date = series.dates[index + step];
    if (date && dates.has(date)) return true;
  }
  return false;
}
function borrowRate(series, index, fx) {
  const scale = series.symbol.endsWith('.L') ? 0.01 : 1;
  const rate = fxOn(fx, series.dates[index]);
  if (series.symbol.endsWith('.L') || series.symbol.endsWith('.PA') || series.symbol.endsWith('.DE')) {
    if (!(rate > 0)) return 0.01;
    return series.open[index] * scale * rate < 5 ? 0.03 : 0.01;
  }
  return series.open[index] < 5 ? 0.03 : 0.01;
}
function roundTrip(market, symbol, gross) {
  const cost = applyCosts(gross, {
    market,
    symbol,
    side: 'buy',
    holdDays: 0,
    profile: { taxBps: 0, borrowBpsPerDay: 0 },
  });
  return cost ? cost.costPct / 100 : 0;
}
function holdTo(series, entry, cover) {
  const last = series.close.length - 1;
  let exit = Math.min(last, entry + 62);
  let early = exit === last && entry + 62 > last;
  if (cover === 'ma50') {
    for (let index = entry; index <= exit; index += 1) {
      if (series.close[index] > series.ma50[index]) {
        exit = index;
        early = false;
        break;
      }
    }
  }
  return { exit, truncated: early };
}
function dayReturns(series, entry, exit, sign) {
  const days = [{ date: series.dates[entry], ret: sign * (series.close[entry] / series.open[entry] - 1) }];
  for (let index = entry + 1; index <= exit; index += 1) {
    const prev = series.close[index - 1];
    if (!(prev > 0)) continue;
    days.push({ date: series.dates[index], ret: sign * (series.close[index] / prev - 1) });
  }
  return days;
}
function etfIndexOn(etf, date) {
  let lo = 0;
  let hi = etf.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (etf.dates[mid] <= date) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}
function hedgeDays(etf, dates) {
  if (!etf) return null;
  const out = [];
  let prevIndex = null;
  for (const date of dates) {
    const index = etfIndexOn(etf, date);
    if (index < 0) return null;
    if (prevIndex == null) {
      if (!(etf.open[index] > 0)) return null;
      out.push(etf.dates[index] === date ? etf.close[index] / etf.open[index] - 1 : 0);
    } else if (index === prevIndex) out.push(0);
    else out.push(etf.close[index] / etf.close[prevIndex] - 1);
    prevIndex = index;
  }
  return out;
}
function buildSignals(market, books, benchmark, fx, earningsSkip) {
  const stops = monthEnds(benchmark).filter(index => benchmark.dates[index] >= '2010-01-01');
  const decile = [];
  const tail = [];
  for (const stop of stops) {
    const date = benchmark.dates[stop];
    const members = membershipAt(market.snapshot, date);
    const ranked = [];
    for (const symbol of members) {
      const series = books.get(symbol);
      if (!series) continue;
      const index = series.byDate.get(date);
      const at = index != null ? index : (() => {
        let found = -1;
        let lo = 0;
        let hi = series.dates.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (series.dates[mid] <= date) { found = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (found < 0) return null;
        const gap = Date.parse(date) - Date.parse(series.dates[found]);
        return gap <= 5 * 86400000 && series.dates[found].slice(0, 7) === date.slice(0, 7) ? found : null;
      })();
      if (at == null || !Number.isFinite(series.ret121[at])) continue;
      ranked.push({ symbol, series, at, ret: series.ret121[at] });
    }
    if (ranked.length < 10) continue;
    ranked.sort((a, b) => a.ret - b.ret || a.symbol.localeCompare(b.symbol));
    const width = Math.floor(ranked.length / 10);
    const width5 = Math.floor(ranked.length * 0.05);
    const take = (rows, bucket) => {
      for (const row of rows) {
        if (!passesTechnical(row.series, row.at)) continue;
        if (earningsSoon(row.series, row.at, row.series.earnings)) {
          earningsSkip.count += 1;
          continue;
        }
        const entry = row.at + 1;
        if (entry >= row.series.close.length) continue;
        if (Date.parse(row.series.dates[entry]) - Date.parse(row.series.dates[row.at]) > 7 * 86400000) continue;
        bucket.push({ ...row, entry, signalDate: row.series.dates[row.at] });
      }
    };
    take(ranked.slice(0, width), decile);
    if (width5 > 0) take(ranked.slice(0, width5), tail);
  }
  return { decile, tail };
}
function simulate(signals, spec, context) {
  const openUntil = new Map();
  const trades = [];
  let truncated = 0;
  let skippedHedge = 0;
  const ordered = signals.slice().sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.ret - b.ret || a.symbol.localeCompare(b.symbol));
  const perMonth = new Map();
  for (const signal of ordered) {
    if ((openUntil.get(signal.symbol) || '') >= signal.signalDate) continue;
    if (spec.k) {
      const used = perMonth.get(signal.signalDate.slice(0, 7)) || 0;
      if (used >= spec.k) continue;
    }
    const { exit, truncated: cut } = holdTo(signal.series, signal.entry, spec.cover);
    if (cut) truncated += 1;
    openUntil.set(signal.symbol, signal.series.dates[exit]);
    let hedge = null;
    if (spec.hedge === 'market') hedge = context.benchmark;
    if (spec.hedge === 'sector') {
      const etf = context.sectors.get(signal.symbol);
      hedge = etf ? context.etfs.get(etf) : null;
      if (!hedge) { skippedHedge += 1; continue; }
    }
    const stockDays = dayReturns(signal.series, signal.entry, exit, -1);
    let days = stockDays;
    if (hedge) {
      const extra = hedgeDays(hedge, stockDays.map(row => row.date));
      if (!extra) { skippedHedge += 1; continue; }
      days = stockDays.map((row, index) => ({ date: row.date, ret: row.ret + extra[index] }));
      const etfCost = roundTrip('US', hedge.symbol, 0);
      days[days.length - 1].ret -= etfCost;
    }
    const stockCost = roundTrip(context.costMarket, signal.symbol, 0);
    const rate = borrowRate(signal.series, signal.entry, context.fx);
    const borrow = (exit - signal.entry + 1) * (rate / 252);
    days[days.length - 1].ret -= stockCost + borrow;
    if (spec.k) perMonth.set(signal.signalDate.slice(0, 7), (perMonth.get(signal.signalDate.slice(0, 7)) || 0) + 1);
    const stockUp = signal.series.close[exit] / signal.series.open[signal.entry] - 1;
    let scale = 1;
    if (spec.k) {
      const fx = fxOn(context.fx, signal.series.dates[signal.entry]);
      const sized = positionSize({
        symbol: signal.symbol,
        market: context.market,
        price: signal.series.open[signal.entry],
        fx: fx || 1,
      });
      const notional = sized && sized.shares ? sized.shares * signal.series.open[signal.entry] * (signal.symbol.endsWith('.L') ? 0.01 : 1) * (fx || 1) : TICKET;
      scale = notional / TICKET;
    }
    trades.push({
      symbol: signal.symbol,
      signalDate: signal.signalDate,
      entryDate: signal.series.dates[signal.entry],
      exitDate: signal.series.dates[exit],
      date: signal.series.dates[exit],
      ret: days.reduce((equity, row) => equity * (1 + row.ret), 1) - 1,
      stockUp,
      days: days.map(row => ({ date: row.date, ret: row.ret * scale })),
      scale,
    });
  }
  return { trades, truncated, skippedHedge };
}
function bookFrom(trades, benchmark, k) {
  const byDate = new Map();
  for (const trade of trades) {
    for (const day of trade.days) {
      if (!byDate.has(day.date)) byDate.set(day.date, []);
      byDate.get(day.date).push(day.ret);
    }
  }
  const daily = [];
  for (const date of benchmark.dates) {
    if (date < '2010-01-01') continue;
    const rows = byDate.get(date) || [];
    const sum = rows.reduce((total, value) => total + value, 0);
    daily.push({ date, ret: rows.length ? sum / rows.length : 0 });
  }
  const monthly = [];
  let bucket = [];
  let stamp = null;
  for (const row of daily) {
    if (stamp && row.date.slice(0, 7) !== stamp.slice(0, 7)) {
      monthly.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
      bucket = [];
    }
    bucket.push(row.ret);
    stamp = row.date;
  }
  if (bucket.length) {
    monthly.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
  }
  return { daily, monthly };
}
function shortBenchmark(benchmark) {
  const daily = [];
  for (let index = 1; index < benchmark.dates.length; index += 1) {
    if (benchmark.dates[index] < '2010-01-01') continue;
    const prev = benchmark.close[index - 1];
    if (!(prev > 0)) continue;
    daily.push({ date: benchmark.dates[index], ret: -(benchmark.close[index] / prev - 1) });
  }
  const monthly = [];
  let bucket = [];
  let stamp = null;
  for (const row of daily) {
    if (stamp && row.date.slice(0, 7) !== stamp.slice(0, 7)) {
      monthly.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
      bucket = [];
    }
    bucket.push(row.ret);
    stamp = row.date;
  }
  if (bucket.length) monthly.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
  return monthly;
}
function alignBench(monthly, benchMonthly) {
  const byMonth = new Map(benchMonthly.map(row => [row.date.slice(0, 7), row.ret]));
  return monthly.map(row => ({ date: row.date, ret: byMonth.get(row.date.slice(0, 7)) || 0 }));
}
function rebound(monthly, spyMonths) {
  const hot = new Set(spyMonths);
  const slice = monthly.filter(row => hot.has(row.date.slice(0, 7)));
  return {
    months: slice.length,
    returnPct: slice.length ? +(compound(slice.map(row => row.ret)) * 100).toFixed(2) : null,
  };
}
function fmt(value) {
  return value == null || !Number.isFinite(value) ? '—' : String(value);
}

async function main() {
  const sectorSymbols = [...new Set(Object.values(SECTOR_ETF))];
  for (const symbol of sectorSymbols) {
    const ok = await ensurePrice(symbol);
    console.log(symbol, ok ? 'cached' : 'MISSING');
  }
  const fx = {
    UK: loadSeriesPath(path.join(ROOT, 'data', 'research', 'fx', 'GBPUSD_X.json')),
    France: loadSeriesPath(path.join(ROOT, 'data', 'research', 'fx', 'EURUSD_X.json')),
  };
  const markets = [
    ['US', 'US', path.join(ROOT, 'data', 'research', 'fmp', 'us-universe.json'), 'SPY', 'US', null],
    ['UK', 'UK', path.join(ROOT, 'data', 'research', 'index-membership', 'ftse100.json'), 'EWU', 'UK', fx.UK],
    ['France', 'France', path.join(ROOT, 'data', 'research', 'index-membership', 'cac40.json'), 'EWQ', 'France', fx.France],
  ];
  const variants = [
    { id: 'a', hedge: null, cover: 'time', cut: 'decile' },
    { id: 'b', hedge: null, cover: 'ma50', cut: 'decile' },
    { id: 'c', hedge: 'market', cover: 'time', cut: 'decile' },
    { id: 'd', hedge: 'market', cover: 'ma50', cut: 'decile' },
    { id: 'e', hedge: 'sector', cover: 'time', cut: 'decile', usOnly: true },
    { id: 'f', hedge: 'market', cover: 'time', cut: 'tail' },
  ];
  const spy = loadSeries('SPY');
  const spyShort = shortBenchmark(spy);
  const spyRanked = spyShort.map(row => ({ month: row.date.slice(0, 7), ret: -row.ret })).sort((a, b) => b.ret - a.ret);
  const hotMonths = spyRanked.slice(0, Math.floor(spyRanked.length / 10)).map(row => row.month);
  const cells = [];
  const sanity = [];
  const worst = [];
  const notes = [];
  for (const [label, costMarket, file, benchSymbol, marketName, fxSeries] of markets) {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const benchmark = loadSeries(benchSymbol);
    const symbols = everMembers(snapshot);
    const books = new Map();
    for (const symbol of symbols) {
      const series = loadSeries(symbol);
      if (!series) continue;
      series.earnings = earningsOf(symbol);
      books.set(symbol, series);
    }
    console.log(label, 'priced', books.size, 'of', symbols.length);
    const earningsSkip = { count: 0 };
    const signals = buildSignals({ snapshot }, books, benchmark, fxSeries, earningsSkip);
    notes.push(`${label}: ever-members ${symbols.length}, with prices ${books.size}, earnings skips ${earningsSkip.count}.`);
    const etfs = new Map();
    if (label === 'US') {
      for (const symbol of sectorSymbols) {
        const series = loadSeries(symbol);
        if (series) etfs.set(symbol, series);
      }
    }
    const sectors = new Map();
    if (label === 'US') {
      for (const symbol of books.keys()) {
        const sector = sectorOf(symbol);
        if (SECTOR_ETF[sector]) sectors.set(symbol, SECTOR_ETF[sector]);
      }
    }
    const folds = buildDateAlignedFolds(benchmark.dates, { ...FOLD_SPEC, embargoBars: EMBARGO.medium });
    const benchMonthly = alignBench(bookFrom([], benchmark).monthly, shortBenchmark(benchmark));
    for (const variant of variants) {
      if (variant.usOnly && label !== 'US') continue;
      if (variant.hedge === 'sector' && etfs.size < sectorSymbols.length) {
        notes.push(`${label} ${variant.id}: DATA_GAP, a sector ETF price file is missing. Not a trial.`);
        continue;
      }
      const context = { benchmark, etfs, sectors, fx: fxSeries, costMarket, market: marketName };
      const research = simulate(variant.cut === 'tail' ? signals.tail : signals.decile, variant, context);
      const packed = bookFrom(research.trades, benchmark);
      const bench = variant.hedge ? packed.monthly.map(row => ({ date: row.date, ret: 0 })) : alignBench(packed.monthly, benchMonthly);
      const scored = scoreCell({
        monthly: packed.monthly,
        trades: research.trades,
        benchmarkMonthly: bench,
        daily: packed.daily,
        folds,
        tSource: 'month',
        tBasis: variant.hedge ? undefined : 'excess',
      });
      const decision = variant.hedge
        ? packed.monthly.map(row => row.ret)
        : packed.monthly.map((row, index) => row.ret - (bench[index] ? bench[index].ret : 0));
      const ks = {};
      for (const k of [1, 2, 5]) {
        const sized = simulate(variant.cut === 'tail' ? signals.tail : signals.decile, { ...variant, k }, context);
        const kBook = bookFrom(sized.trades, benchmark, k);
        const kBench = variant.hedge ? kBook.monthly.map(row => ({ date: row.date, ret: 0 })) : alignBench(kBook.monthly, benchMonthly);
        const kScored = scoreCell({
          monthly: kBook.monthly,
          trades: sized.trades,
          benchmarkMonthly: kBench,
          daily: kBook.daily,
          folds,
          tSource: 'month',
          tBasis: variant.hedge ? undefined : 'excess',
        });
        ks[`k${k}`] = {
          verdict: kScored.verdict,
          full: kScored.full,
          windows: kScored.windows,
          trades: sized.trades.length,
          decisionReturns: variant.hedge
            ? kBook.monthly.map(row => row.ret)
            : kBook.monthly.map((row, index) => row.ret - (kBench[index] ? kBench[index].ret : 0)),
          rebound: rebound(kBook.monthly, hotMonths),
        };
      }
      const cell = {
        id: `${label}|${variant.id}`,
        market: label,
        variant: variant.id,
        side: 'short',
        verdict: scored.verdict,
        full: scored.full,
        windows: scored.windows,
        trades: research.trades.length,
        truncated: research.truncated,
        skippedHedge: research.skippedHedge,
        rebound: rebound(packed.monthly, hotMonths),
        maxDrawdownPct: scored.full.maxDrawdownPct,
        decisionReturns: decision,
        monthlyReturns: decision,
        k1: { ...ks.k1, monthlyReturns: ks.k1.decisionReturns, full: { ...ks.k1.full, sharpe: sharpe(ks.k1.decisionReturns).sharpe } },
        k2: { ...ks.k2, monthlyReturns: ks.k2.decisionReturns, full: { ...ks.k2.full, sharpe: sharpe(ks.k2.decisionReturns).sharpe } },
        k5: { ...ks.k5, monthlyReturns: ks.k5.decisionReturns, full: { ...ks.k5.full, sharpe: sharpe(ks.k5.decisionReturns).sharpe } },
      };
      cell.full.sharpe = sharpe(decision).sharpe;
      cells.push(cell);
      for (const trade of research.trades) {
        if (SANITY.includes(trade.symbol)) {
          sanity.push({ market: label, variant: variant.id, ...trade, days: undefined });
        }
        worst.push({ market: label, variant: variant.id, symbol: trade.symbol, signalDate: trade.signalDate, exitDate: trade.exitDate, stockUp: trade.stockUp, ret: trade.ret });
      }
      console.log(label, variant.id, scored.verdict, 'trades', research.trades.length, 't', scored.full.tStat, 'full', scored.full.returnPct);
    }
  }
  const trials = trialSharpes(cells, { includeExecutableK: true });
  const selectedTrial = trials.slice().sort((a, b) => (b.sharpe || -Infinity) - (a.sharpe || -Infinity))[0];
  const dsr = selectedTrial ? deflatedSharpe(trials, selectedTrial.returns) : null;
  worst.sort((a, b) => b.stockUp - a.stockUp);
  const uniqueWorst = [];
  const seenWorst = new Set();
  for (const row of worst) {
    const key = `${row.symbol}|${row.signalDate}|${row.exitDate}`;
    if (seenWorst.has(key)) continue;
    seenWorst.add(key);
    uniqueWorst.push(row);
  }
  const lines = [
    '# F8 downtrend short — results',
    '',
    'Research only. Nothing was enabled. Pre-registration `da3c5f8d117f3c6553f9640b7c745fc32d829510`.',
    'Naked t-stats use monthly book minus the return of shorting the market ETF. Hedged t-stats use the spread. The candidate rule is unchanged and is not a pass.',
    'Profile files have sector and industry only, so the 3% borrow branch uses a price under $5. A missing FX rate does not trigger 3%.',
    '',
    ...notes,
    '',
    `Family trials: ${trials.length}. Deflated Sharpe uses the decision series of the highest decision-Sharpe trial${selectedTrial ? ` (${selectedTrial.id})` : ''}.`,
    dsr ? `DSR probability ${dsr.probability == null ? '—' : dsr.probability.toFixed(3)}, annualized Sharpe ${dsr.annualized == null ? '—' : dsr.annualized.toFixed(2)}, nTrials ${dsr.nTrials}. Not a pass gate.` : 'DSR not computed.',
    '',
    '## Research cells',
    '',
    '| Cell | Verdict | Full | t | PF | Trades | Max DD | Rebound months |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const cell of cells) {
    lines.push(`| ${cell.id} | ${cell.verdict} | ${fmt(cell.full.returnPct)}% | ${fmt(cell.full.tStat)} | ${cell.full.pfInfinite ? 'inf' : fmt(cell.full.pf)} | ${cell.trades} | ${fmt(cell.maxDrawdownPct)}% | ${fmt(cell.rebound.returnPct)}% (${cell.rebound.months}) |`);
  }
  lines.push('', '## Windows', '');
  for (const cell of cells) {
    lines.push(`### ${cell.id}`, '');
    lines.push('| Window | Return | PF | Trades | Max DD |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const window of cell.windows) {
      lines.push(`| ${window.from} to ${window.to} | ${fmt(window.returnPct)}% | ${window.pfInfinite ? 'inf' : fmt(window.pf)} | ${window.trades} | ${fmt(window.maxDrawdownPct)}% |`);
    }
    lines.push('');
  }
  lines.push('## Executable k', '');
  lines.push('| Cell | k | Verdict | Full | t | PF | Trades | Max DD |');
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const cell of cells) {
    for (const key of ['k1', 'k2', 'k5']) {
      const book = cell[key];
      lines.push(`| ${cell.id} | ${key.slice(1)} | ${book.verdict} | ${fmt(book.full.returnPct)}% | ${fmt(book.full.tStat)} | ${book.full.pfInfinite ? 'inf' : fmt(book.full.pf)} | ${book.trades} | ${fmt(book.full.maxDrawdownPct)}% |`);
    }
  }
  lines.push('', '## Sanity', '');
  lines.push('| Market | Variant | Symbol | Signal | Exit | Stock rebound | Book return |');
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: |');
  for (const row of sanity.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.signalDate.localeCompare(b.signalDate))) {
    lines.push(`| ${row.market} | ${row.variant} | ${row.symbol} | ${row.signalDate} | ${row.exitDate} | ${(row.stockUp * 100).toFixed(2)}% | ${(row.ret * 100).toFixed(2)}% |`);
  }
  if (!sanity.length) lines.push('| — | — | — | — | — | — | — |');
  const seenSanity = new Set(sanity.map(row => row.symbol));
  const quiet = SANITY.filter(symbol => !seenSanity.has(symbol));
  if (quiet.length) lines.push('', `No short in any variant: ${quiet.join(', ')}.`);
  lines.push('', '## Five worst shorts', '', 'Largest stock rebound while the short was open.', '');
  lines.push('| Market | Variant | Symbol | Signal | Exit | Stock rebound |');
  lines.push('| --- | --- | --- | --- | --- | ---: |');
  for (const row of uniqueWorst.slice(0, 5)) {
    lines.push(`| ${row.market} | ${row.variant} | ${row.symbol} | ${row.signalDate} | ${row.exitDate} | ${(row.stockUp * 100).toFixed(2)}% |`);
  }
  lines.push('');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    preregistration: 'da3c5f8d117f3c6553f9640b7c745fc32d829510',
    nTrials: trials.length,
    dsr,
    cells: cells.map(cell => ({ ...cell, decisionReturns: undefined, monthlyReturns: undefined, k1: { ...cell.k1, decisionReturns: undefined, monthlyReturns: undefined }, k2: { ...cell.k2, decisionReturns: undefined, monthlyReturns: undefined }, k5: { ...cell.k5, decisionReturns: undefined, monthlyReturns: undefined } })),
    sanity,
    worst: uniqueWorst.slice(0, 5),
  }, null, 2));
  console.log(`wrote ${OUT_MD}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  loadSeries,
  loadSeriesPath,
  fxOn,
  dayReturns,
  hedgeDays,
  roundTrip,
  borrowRate,
  bookFrom,
  everMembers,
};
