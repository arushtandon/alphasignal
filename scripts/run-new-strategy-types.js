#!/usr/bin/env node
'use strict';

// Research only. Does not import the live setup book and does not change flags.
process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { applyCosts, estimateRoundTripCostPct } = require('../lib/research/cost-model');
const { buildPitPiotroskiScores } = require('../lib/research/pit-piotroski');

const ROOT = path.join(__dirname, '..');
const WORKERS = path.join(ROOT, 'scripts', 'performance-stage1-v2-checkpoint.json.workers', 'stage1');
const PRICE_CACHE = path.join(ROOT, 'data', 'research', 'exit-amendment-prices');
const OUT_JSON = path.join(ROOT, 'scripts', 'new-strategy-types-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'new-strategy-types-readout.md');
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));

const CRYPTO_LIST = Object.freeze([
  'BTC-USD', 'ETH-USD', 'BNB-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD', 'SOL-USD',
  'TRX-USD', 'DOT-USD', 'LTC-USD', 'BCH-USD', 'LINK-USD', 'XLM-USD', 'AVAX-USD',
  'UNI-USD', 'ATOM-USD', 'ETC-USD', 'NEAR-USD', 'FIL-USD', 'APT-USD',
]);

const VARIANTS = [];
for (const beat of [0.05, 0.10]) {
  for (const hold of [40, 60]) {
    VARIANTS.push({
      id: `A__US__medium__pead_beat${beat}_hold${hold}`,
      part: 'A', market: 'US', horizon: 'medium',
      strategy: `Post-earnings drift, EPS beat ≥ ${beat * 100}%, hold ${hold}`,
      benchmark: 'SPY',
    });
  }
}
for (const cell of [
  ['US', 'long', 'SPY'],
  ['UK', 'medium', 'EWU'],
  ['UK', 'long', 'EWU'],
  ['France', 'medium', 'EWQ'],
  ['France', 'long', 'EWQ'],
]) {
  for (const quality of [false, true]) {
    for (const regime of [false, true]) {
      VARIANTS.push({
        id: `B__${cell[0]}__${cell[1]}__${quality ? 'piotroski6' : 'momentum'}__regime${regime ? 'on' : 'off'}`,
        part: 'B', market: cell[0], horizon: cell[1], quality, regime,
        strategy: `12-1 momentum${quality ? ' among Piotroski ≥ 6' : ''}${regime ? ', cash below 200-day MA' : ''}`,
        benchmark: cell[2],
        top: cell[0] === 'US' ? 0.10 : 10,
      });
    }
  }
}
for (const count of [5, 10]) {
  for (const regime of [false, true]) {
    VARIANTS.push({
      id: `C__Hong_Kong__short__worst${count}__regime${regime ? 'on' : 'off'}`,
      part: 'C', market: 'Hong Kong', horizon: 'short', count, regime,
      strategy: `Weekly reversal, worst ${count}${regime ? ', only above 200-day MA' : ''}`,
      benchmark: 'EWH',
    });
  }
}
for (const market of ['Commodities', 'Crypto']) {
  const benchmark = market === 'Crypto' ? 'BTC-USD' : 'DBC';
  for (const look of [252, 63]) {
    for (const horizon of ['medium', 'long']) {
      VARIANTS.push({
        id: `D__${market}__${horizon}__trend${look === 252 ? '12m' : '3m'}`,
        part: 'D', market, horizon, lookback: look, mode: 'trend',
        strategy: `${look === 252 ? '12-month' : '3-month'} trend and 200-day MA`,
        benchmark,
      });
    }
  }
  VARIANTS.push({
    id: `D__${market}__short__breakout20`,
    part: 'D', market, horizon: 'short', mode: 'breakout',
    strategy: '20-day breakout, exit on a 10-day low',
    benchmark,
  });
}
for (const market of ['UK', 'France']) {
  for (const count of [5, 10]) {
    for (const regime of [false, true]) {
      VARIANTS.push({
        id: `E__${market}__short__worst${count}__regime${regime ? 'on' : 'off'}`,
        part: 'E', market, horizon: 'short', count, regime,
        strategy: `Weekly reversal, worst ${count}${regime ? ', only above 200-day MA' : ''}`,
        benchmark: market === 'UK' ? 'EWU' : 'EWQ',
      });
    }
  }
}
if (VARIANTS.length !== 46) {
  throw new Error(`Frozen family drift: expected 46, found ${VARIANTS.length}`);
}

function dateOf(bar) {
  const value = Number(bar?.t);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function yahooDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d`;
  return new Promise(resolve => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body)?.chart?.result?.[0];
          const stamps = result?.timestamp || [];
          const close = result?.indicators?.quote?.[0]?.close || [];
          const bars = [];
          for (let index = 0; index < stamps.length; index++) {
            if (close[index] > 0) bars.push({ t: stamps[index], c: close[index] });
          }
          resolve(bars);
        } catch (_) { resolve([]); }
      });
    });
    request.on('error', () => resolve([]));
  });
}
async function ensureCryptoPrices() {
  fs.mkdirSync(PRICE_CACHE, { recursive: true });
  for (const symbol of CRYPTO_LIST) {
    if (readPriceFile(symbol)) continue;
    const bars = await yahooDaily(symbol);
    if (bars.length < 756) {
      console.log(`[crypto] ${symbol} history ${bars.length} bars, below 3 years`);
      continue;
    }
    fs.writeFileSync(path.join(PRICE_CACHE, `${symbol}.json`), JSON.stringify({ bars }));
    console.log(`[crypto] cached ${symbol} ${bars.length}`);
  }
}
function readPriceFile(symbol) {
  const file = path.join(PRICE_CACHE, `${symbol.replace(/[\\/]/g, '_')}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bars = Array.isArray(raw) ? raw : (raw.bars || raw.result?.context?.bars || null);
  return Array.isArray(bars) ? packBars(bars) : null;
}
function packBars(bars) {
  const dates = [];
  const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    const px = Number(bar.c);
    if (!date || !(px > 0)) continue;
    dates.push(date);
    close.push(px);
  }
  return { dates, close };
}
function loadWorkerMarket(prefix) {
  const books = new Map();
  let benchmark = null;
  const files = fs.readdirSync(WORKERS).filter(name =>
    name.startsWith(`${prefix}__long__`) && name.endsWith('.result.json'));
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(WORKERS, file), 'utf8')); }
    catch (_) { continue; }
    const context = parsed?.result?.context;
    if (!context?.bars?.length) continue;
    if (!benchmark && context.benchmarkBars?.length) benchmark = packBars(context.benchmarkBars);
    const packed = packBars(context.bars);
    if (packed.dates.length < 260) continue;
    let scores = [];
    if (context.arrays) {
      try {
        const built = buildPitPiotroskiScores(context.arrays);
        scores = (built.scores || [])
          .map(row => ({ availableOn: row.availableOn, score: row.score }))
          .sort((left, right) => String(left.availableOn).localeCompare(String(right.availableOn)));
      } catch (_) { scores = []; }
    }
    books.set(context.symbol, { ...packed, scores });
  }
  return { books, benchmark };
}
function indexOf(series, date) {
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
function sma(close, index, length) {
  if (index < length - 1) return null;
  let sum = 0;
  for (let cursor = index - length + 1; cursor <= index; cursor++) sum += close[cursor];
  return sum / length;
}
function priceReturn(series, from, to) {
  if (from < 0 || to <= from || !(series.close[from] > 0)) return null;
  return series.close[to] / series.close[from] - 1;
}
function scoreAt(series, date) {
  let score = null;
  for (const row of series.scores || []) {
    if (row.availableOn && row.availableOn <= date) score = row.score;
    else break;
  }
  return score;
}
function net(gross, market) {
  const priced = applyCosts(gross, { market });
  return priced ? priced.netReturn : null;
}
function stats(returns) {
  const rows = returns.filter(value => Number.isFinite(value));
  if (!rows.length) {
    return { n: 0, win: null, pf: null, avgWin: null, avgLoss: null };
  }
  const wins = rows.filter(value => value > 0);
  const losses = rows.filter(value => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    n: rows.length,
    win: +((wins.length / rows.length) * 100).toFixed(1),
    pf: loss > 0 ? +(gain / loss).toFixed(3) : (gain > 0 ? 99 : 0),
    avgWin: wins.length ? +(wins.reduce((a, b) => a + b, 0) / wins.length * 100).toFixed(3) : null,
    avgLoss: losses.length ? +(losses.reduce((a, b) => a + b, 0) / losses.length * 100).toFixed(3) : null,
  };
}
function curveStats(periodReturns, periodsPerYear) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  const clean = [];
  for (const value of periodReturns) {
    if (!Number.isFinite(value)) continue;
    clean.push(value);
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
  }
  const mean = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : 0;
  const variance = clean.length > 1
    ? clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1) : 0;
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(periodsPerYear) : null;
  return {
    returnPct: +((equity - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    sharpe: sharpe == null ? null : +sharpe.toFixed(3),
    periods: clean.length,
  };
}
function folds(benchmark, horizon) {
  return buildDateAlignedFolds(benchmark.dates, { ...FOLD_SPEC, embargoBars: EMBARGO[horizon] || 20 });
}
function inFold(date, fold) {
  return date >= fold.test.from && date <= fold.test.to;
}
function benchmarkBuyHold(benchmark, fold) {
  const from = indexOf(benchmark, fold.test.from);
  const to = indexOf(benchmark, fold.test.to);
  const gross = priceReturn(benchmark, from, to);
  return gross == null ? null : gross;
}
function monthStops(benchmark) {
  const stops = [];
  for (let index = 1; index < benchmark.dates.length; index++) {
    if (benchmark.dates[index].slice(0, 7) !== benchmark.dates[index - 1].slice(0, 7)) stops.push(index - 1);
  }
  return stops;
}
function aboveMa(series, index) {
  const average = sma(series.close, index, 200);
  return average != null && series.close[index] > average;
}
function momentumRank(books, benchmark, signalIndex, variant) {
  const date = benchmark.dates[signalIndex];
  const members = variant.market === 'US' && US_SNAPSHOT
    ? new Set(membershipAt(US_SNAPSHOT, date) || []) : null;
  const ranked = [];
  for (const [symbol, series] of books) {
    if (members && !members.has(symbol)) continue;
    const at = indexOf(series, date);
    if (at < 252) continue;
    if (variant.quality && !(scoreAt(series, date) >= 6)) continue;
    const skipped = priceReturn(series, at - 252, at - 21);
    if (skipped == null) continue;
    ranked.push({ symbol, series, at, score: skipped });
  }
  ranked.sort((left, right) => right.score - left.score);
  const count = variant.top < 1 ? Math.max(1, Math.floor(ranked.length * variant.top)) : variant.top;
  return ranked.slice(0, count);
}
function runMomentum(variant, loaded) {
  const { books, benchmark } = loaded;
  const stops = monthStops(benchmark);
  const sleeves = [];
  const monthly = [];
  const trades = [];
  const holdMonths = variant.horizon === 'long' ? 6 : 1;
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
    const signal = stops[cursor];
    const next = stops[cursor + 1];
    if (variant.regime && !aboveMa(benchmark, signal)) {
      monthly.push({ date: benchmark.dates[next], ret: 0 });
      continue;
    }
    const picked = momentumRank(books, benchmark, signal, variant);
    sleeves.push({ until: cursor + holdMonths, names: picked });
    const active = sleeves.filter(sleeve => sleeve.until > cursor);
    const held = [];
    for (const sleeve of active) {
      for (const name of sleeve.names) {
        const end = indexOf(name.series, benchmark.dates[next]);
        const gross = priceReturn(name.series, name.at, end);
        if (gross == null) continue;
        const monthRet = net(gross, variant.market);
        if (monthRet == null) continue;
        held.push(monthRet);
        if (sleeve.until === cursor + 1) trades.push(monthRet);
      }
    }
    const weight = holdMonths > 1 ? (1 / holdMonths) : 1;
    const sleeveCount = active.length || 1;
    const ret = held.length ? (held.reduce((a, b) => a + b, 0) / held.length) * (holdMonths > 1 ? Math.min(1, sleeveCount * weight) : 1) : 0;
    monthly.push({ date: benchmark.dates[next], ret });
  }
  return scoreWindows(variant, benchmark, monthly, trades, 12);
}
function runWeekly(variant, loaded) {
  const { books, benchmark } = loaded;
  const weekly = [];
  const trades = [];
  for (let signal = 200; signal + 5 < benchmark.dates.length; signal += 5) {
    if (variant.regime && !aboveMa(benchmark, signal)) {
      weekly.push({ date: benchmark.dates[signal + 5], ret: 0 });
      continue;
    }
    const date = benchmark.dates[signal];
    const ranked = [];
    for (const [symbol, series] of books) {
      const at = indexOf(series, date);
      const gross = priceReturn(series, at - 5, at);
      if (gross == null) continue;
      ranked.push({ series, at, gross });
    }
    ranked.sort((left, right) => left.gross - right.gross);
    const picked = ranked.slice(0, variant.count);
    const rets = [];
    for (const name of picked) {
      const end = indexOf(name.series, benchmark.dates[Math.min(signal + 5, benchmark.dates.length - 1)]);
      const gross = priceReturn(name.series, name.at, end);
      const value = gross == null ? null : net(gross, variant.market);
      if (value == null) continue;
      rets.push(value);
      trades.push(value);
    }
    weekly.push({
      date: benchmark.dates[Math.min(signal + 5, benchmark.dates.length - 1)],
      ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    });
  }
  return scoreWindows(variant, benchmark, weekly, trades, 52);
}
function runTrend(variant, loaded) {
  const { books, benchmark } = loaded;
  const daily = [];
  const trades = [];
  const open = new Map();
  for (let index = 252; index < benchmark.dates.length; index++) {
    const date = benchmark.dates[index];
    const names = [];
    for (const [symbol, series] of books) {
      const at = indexOf(series, date);
      if (at < 252) continue;
      const uptrend = variant.mode === 'breakout'
        ? series.close[at] >= Math.max(...series.close.slice(Math.max(0, at - 20), at))
        : priceReturn(series, at - variant.lookback, at) > 0 && aboveMa(series, at);
      const held = open.get(symbol);
      if (uptrend && !held) open.set(symbol, { at, series });
      if (!uptrend && held) {
        const gross = priceReturn(series, held.at, at);
        if (gross != null) trades.push(net(gross, variant.market));
        open.delete(symbol);
      }
      if (open.has(symbol)) names.push(series);
    }
    const rets = [];
    if (index > 252) {
      for (const series of names) {
        const at = indexOf(series, date);
        const prev = indexOf(series, benchmark.dates[index - 1]);
        const gross = priceReturn(series, prev, at);
        if (gross != null) rets.push(gross);
      }
    }
    daily.push({ date, ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0 });
  }
  for (const held of open.values()) {
    const gross = priceReturn(held.series, held.at, held.close.length - 1);
    if (gross != null) trades.push(net(gross, variant.market));
  }
  return scoreWindows(variant, benchmark, daily, trades.filter(Number.isFinite), 252);
}
function scoreWindows(variant, benchmark, periods, trades, periodsPerYear) {
  const built = folds(benchmark, variant.horizon);
  const windows = built.map(fold => {
    const slice = periods.filter(row => inFold(row.date, fold.test.to) && row.date >= fold.test.from && row.date <= fold.test.to);
    const curve = curveStats(slice.map(row => row.ret), periodsPerYear);
    const tradeSlice = [];
    const bench = benchmarkBuyHold(benchmark, fold);
    const benchCurve = curveStats(
      periods.filter(row => inFold(row.date, fold.test.to) && row.date >= fold.test.from && row.date <= fold.test.to)
        .map(() => 0),
      periodsPerYear,
    );
    void benchCurve;
    const tradeStats = stats(trades.filter(() => false));
    void tradeSlice;
    void tradeStats;
    return {
      fold: fold.fold,
      from: fold.test.from,
      to: fold.test.to,
      ...curve,
      benchmarkReturnPct: bench == null ? null : +(bench * 100).toFixed(2),
      beat: bench != null && curve.returnPct > bench * 100,
    };
  });
  const tradeAll = stats(trades);
  const byWindowTrades = built.map(fold => stats(trades));
  void byWindowTrades;
  return { windows, trades: tradeAll };
}

function attachTradeWindows(result, periods, trades, benchmark, variant) {
  const built = folds(benchmark, variant.horizon);
  result.windows = built.map(fold => {
    const slice = periods.filter(row => row.date >= fold.test.from && row.date <= fold.test.to);
    const curve = curveStats(slice.map(row => row.ret), result.periodsPerYear);
    const bench = benchmarkBuyHold(benchmark, fold);
    const benchPeriods = [];
    for (let index = 1; index < benchmark.dates.length; index++) {
      const date = benchmark.dates[index];
      if (date < fold.test.from || date > fold.test.to) continue;
      const step = benchmark.close[index] / benchmark.close[index - 1] - 1;
      if (result.periodsPerYear === 12 && benchmark.dates[index].slice(0, 7) === benchmark.dates[index - 1].slice(0, 7)) continue;
      benchPeriods.push(step);
    }
    const benchCurve = curveStats(
      result.periodsPerYear === 12
        ? monthlyBenchmark(benchmark, fold)
        : benchPeriods,
      result.periodsPerYear,
    );
    const foldTrades = trades.filter(row => row.date >= fold.test.from && row.date <= fold.test.to);
    const trade = stats(foldTrades.map(row => row.ret));
    return {
      fold: fold.fold,
      from: fold.test.from,
      to: fold.test.to,
      returnPct: curve.returnPct,
      pf: trade.pf,
      win: trade.win,
      maxDrawdownPct: curve.maxDrawdownPct,
      sharpe: curve.sharpe,
      trades: trade.n,
      benchmarkReturnPct: bench == null ? null : +(bench * 100).toFixed(2),
      benchmarkPf: null,
      benchmarkWin: null,
      benchmarkMaxDrawdownPct: benchCurve.maxDrawdownPct,
      benchmarkSharpe: benchCurve.sharpe,
      beat: bench != null && curve.returnPct > +(bench * 100).toFixed(2),
    };
  });
  const overall = curveStats(periods.map(row => row.ret), result.periodsPerYear);
  const trade = stats(trades.map(row => row.ret));
  result.overall = {
    returnPct: overall.returnPct,
    pf: trade.pf,
    win: trade.win,
    maxDrawdownPct: overall.maxDrawdownPct,
    sharpe: overall.sharpe,
    trades: trade.n,
  };
  const consistent = result.windows.length === 4 && result.windows.every(row =>
    row.returnPct > 0 && row.pf >= 1.2 && row.trades > 0);
  const beats = result.windows.filter(row => row.beat).length;
  result.verdict = consistent && beats >= 3 ? 'PASS'
    : (consistent || beats >= 3) ? 'CANDIDATE' : 'FAIL';
  return result;
}
function monthlyBenchmark(benchmark, fold) {
  const stops = monthStops(benchmark).filter(index => {
    const date = benchmark.dates[index];
    return date >= fold.test.from && date <= fold.test.to;
  });
  const out = [];
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
    const value = priceReturn(benchmark, stops[cursor], stops[cursor + 1]);
    if (value != null) out.push(value);
  }
  return out;
}

function collectMomentum(variant, loaded) {
  const { books, benchmark } = loaded;
  const stops = monthStops(benchmark);
  const monthly = [];
  const trades = [];
  const cohorts = [];
  const holdMonths = variant.horizon === 'long' ? 6 : 1;
  const drag = estimateRoundTripCostPct({ market: variant.market }) / 100 / holdMonths;
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
    const signal = stops[cursor];
    const next = stops[cursor + 1];
    if (variant.regime && !aboveMa(benchmark, signal)) {
      monthly.push({ date: benchmark.dates[next], ret: 0 });
      continue;
    }
    cohorts.push({
      start: cursor,
      names: momentumRank(books, benchmark, signal, variant),
    });
    const active = cohorts.filter(cohort => cursor >= cohort.start && cursor < cohort.start + holdMonths);
    let ret = 0;
    let sleeves = 0;
    for (const cohort of active) {
      const piece = [];
      for (const name of cohort.names) {
        const from = indexOf(name.series, benchmark.dates[stops[cursor]]);
        const to = indexOf(name.series, benchmark.dates[next]);
        const gross = priceReturn(name.series, from, to);
        if (gross == null) continue;
        piece.push(gross - drag);
      }
      if (!piece.length) continue;
      sleeves += 1;
      ret += piece.reduce((sum, value) => sum + value, 0) / piece.length;
      if (cursor + 1 === cohort.start + holdMonths) {
        for (const name of cohort.names) {
          const exitAt = stops[Math.min(cohort.start + holdMonths, stops.length - 1)];
          const life = priceReturn(name.series, name.at, indexOf(name.series, benchmark.dates[exitAt]));
          if (life != null) trades.push({ date: benchmark.dates[exitAt], ret: net(life, variant.market) });
        }
      }
    }
    const invested = holdMonths === 1 ? 1 : Math.min(1, sleeves / holdMonths);
    monthly.push({ date: benchmark.dates[next], ret: sleeves ? (ret / sleeves) * invested : 0 });
  }
  return attachTradeWindows({ periodsPerYear: 12 }, monthly, trades.filter(row => Number.isFinite(row.ret)), benchmark, variant);
}
function collectWeekly(variant, loaded) {
  const { books, benchmark } = loaded;
  const periods = [];
  const trades = [];
  for (let signal = 200; signal + 5 < benchmark.dates.length; signal += 5) {
    const exitIndex = Math.min(signal + 5, benchmark.dates.length - 1);
    if (variant.regime && !aboveMa(benchmark, signal)) {
      periods.push({ date: benchmark.dates[exitIndex], ret: 0 });
      continue;
    }
    const date = benchmark.dates[signal];
    const ranked = [];
    for (const series of books.values()) {
      const at = indexOf(series, date);
      const prior = priceReturn(series, at - 5, at);
      if (prior == null) continue;
      ranked.push({ series, at, prior });
    }
    ranked.sort((left, right) => left.prior - right.prior);
    const rets = [];
    for (const name of ranked.slice(0, variant.count)) {
      const end = indexOf(name.series, benchmark.dates[exitIndex]);
      const gross = priceReturn(name.series, name.at, end);
      const value = gross == null ? null : net(gross, variant.market);
      if (value == null) continue;
      rets.push(value);
      trades.push({ date: benchmark.dates[exitIndex], ret: value });
    }
    periods.push({ date: benchmark.dates[exitIndex], ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0 });
  }
  return attachTradeWindows({ periodsPerYear: 52 }, periods, trades, benchmark, variant);
}
function collectTrend(variant, loaded) {
  const { books, benchmark } = loaded;
  const periods = [];
  const trades = [];
  const open = new Map();
  let lastMonth = '';
  let monthRet = 0;
  let monthCost = 0;
  const roundTrip = estimateRoundTripCostPct({ market: variant.market }) / 100;
  for (let index = 260; index < benchmark.dates.length; index++) {
    const date = benchmark.dates[index];
    const live = [];
    for (const [symbol, series] of books) {
      const at = indexOf(series, date);
      if (at < 252) continue;
      let enter = false;
      let exit = false;
      if (variant.mode === 'breakout') {
        const priorHigh = Math.max(...series.close.slice(Math.max(0, at - 20), at));
        const priorLow = Math.min(...series.close.slice(Math.max(0, at - 10), at));
        enter = series.close[at] > priorHigh;
        exit = series.close[at] < priorLow;
      } else {
        const trend = priceReturn(series, at - variant.lookback, at);
        enter = trend > 0 && aboveMa(series, at);
        exit = !(trend > 0 && aboveMa(series, at));
      }
      if (enter && !open.has(symbol)) open.set(symbol, { at, series });
      if (exit && open.has(symbol)) {
        const held = open.get(symbol);
        const gross = priceReturn(series, held.at, at);
        if (gross != null) {
          trades.push({ date, ret: net(gross, variant.market) });
          monthCost += roundTrip;
        }
        open.delete(symbol);
      }
      if (open.has(symbol)) live.push(series);
    }
    const dayRets = [];
    for (const series of live) {
      const at = indexOf(series, date);
      const gross = priceReturn(series, at - 1, at);
      if (gross != null) dayRets.push(gross);
    }
    monthRet = (1 + monthRet) * (1 + (dayRets.length ? dayRets.reduce((a, b) => a + b, 0) / dayRets.length : 0)) - 1;
    const month = date.slice(0, 7);
    if (lastMonth && month !== lastMonth) {
      periods.push({ date: benchmark.dates[index - 1], ret: monthRet - monthCost });
      monthRet = 0;
      monthCost = 0;
    }
    lastMonth = month;
  }
  if (lastMonth) periods.push({ date: benchmark.dates[benchmark.dates.length - 1], ret: monthRet - monthCost });
  for (const held of open.values()) {
    const gross = priceReturn(held.series, held.at, held.series.close.length - 1);
    if (gross != null) trades.push({ date: held.series.dates[held.series.dates.length - 1], ret: net(gross, variant.market) });
  }
  return attachTradeWindows({ periodsPerYear: 12 }, periods, trades.filter(row => row.ret != null), benchmark, variant);
}

function insufficient(variant, reason) {
  return {
    ...variant,
    survivorship: variant.market === 'US' ? 'POINT_IN_TIME' : variant.market === 'Commodities' || variant.market === 'Crypto' ? 'NOT_APPLICABLE' : 'SURVIVORSHIP_BIAS',
    verdict: 'INSUFFICIENT',
    reason,
    windows: [],
    overall: null,
  };
}

async function main() {
  console.log(`[family] ${VARIANTS.length} variants frozen`);
  await ensureCryptoPrices();
  const cache = new Map();
  function marketData(market) {
    if (cache.has(market)) return cache.get(market);
    const prefix = market === 'Hong Kong' ? 'Hong_Kong' : market;
    const loaded = ['Commodities', 'Crypto'].includes(market) ? { books: new Map(), benchmark: null } : loadWorkerMarket(prefix);
    if (market === 'Commodities') {
      for (const symbol of ['GLD', 'SLV', 'USO', 'UNG', 'DBC', 'PDBC', 'GSG', 'DBA', 'WEAT', 'CPER', 'BNO', 'COPX']) {
        const series = readPriceFile(symbol);
        if (series && series.dates.length >= 260) loaded.books.set(symbol, series);
      }
      loaded.benchmark = readPriceFile('DBC');
    }
    if (market === 'Crypto') {
      for (const symbol of CRYPTO_LIST) {
        const series = readPriceFile(symbol);
        if (series && series.dates.length >= 756) loaded.books.set(symbol, series);
      }
      loaded.benchmark = readPriceFile('BTC-USD') || loaded.books.get('BTC-USD') || null;
    }
    if (!loaded.benchmark) {
      const symbol = { US: 'SPY', UK: 'EWU', France: 'EWQ', 'Hong Kong': 'EWH', Commodities: 'DBC', Crypto: 'BTC-USD' }[market];
      loaded.benchmark = readPriceFile(symbol) || loaded.benchmark;
    }
    cache.set(market, loaded);
    console.log(`[load] ${market} names=${loaded.books.size} benchmark=${loaded.benchmark ? loaded.benchmark.dates.length : 0}`);
    return loaded;
  }
  const rows = [];
  for (const variant of VARIANTS) {
    if (variant.part === 'A') {
      rows.push(insufficient(variant, 'No point-in-time EPS estimate history is in data/research/fmp'));
      continue;
    }
    const loaded = marketData(variant.market);
    if (!loaded.benchmark || loaded.books.size < 3) {
      rows.push(insufficient(variant, `Price history unavailable for ${variant.market}`));
      continue;
    }
    const scored = variant.part === 'B' ? collectMomentum(variant, loaded)
      : variant.part === 'D' ? collectTrend(variant, loaded)
        : collectWeekly(variant, loaded);
    rows.push({
      ...variant,
      quality: undefined,
      survivorship: variant.market === 'US' ? 'POINT_IN_TIME'
        : variant.market === 'Commodities' || variant.market === 'Crypto' ? 'NOT_APPLICABLE'
          : 'SURVIVORSHIP_BIAS',
      cryptoList: variant.market === 'Crypto' ? CRYPTO_LIST : undefined,
      cryptoWithHistory: variant.market === 'Crypto' ? [...loaded.books.keys()] : undefined,
      verdict: scored.verdict,
      windows: scored.windows,
      overall: scored.overall,
    });
    console.log(`[${scored.verdict}] ${variant.id}`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    preregistration: 'docs/new-strategy-types-preregistration.md',
    familySize: VARIANTS.length,
    liveBehaviorChanged: false,
    rows,
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# New strategy types',
    '',
    `Pre-registration: docs/new-strategy-types-preregistration.md. Family size ${VARIANTS.length}. No live change.`,
    '',
    'Non-US stock lists are SURVIVORSHIP_BIAS. Crypto coins with at least three years of cached history are named in the JSON. Part A has no point-in-time EPS estimate file, so those four variants are INSUFFICIENT rather than a scored fail.',
    '',
    '| Market | Horizon | Strategy | W1 ret vs bench | W2 | W3 | W4 | PF | Win % | Max DD | Membership | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const cell = (window) => window ? `${window.returnPct}% / ${window.benchmarkReturnPct}%` : '—';
    const windows = row.windows || [];
    lines.push(`| ${row.market} | ${row.horizon} | ${row.strategy} | ${cell(windows[0])} | ${cell(windows[1])} | ${cell(windows[2])} | ${cell(windows[3])} | ${row.overall?.pf ?? '—'} | ${row.overall?.win ?? '—'} | ${row.overall?.maxDrawdownPct ?? '—'} | ${row.survivorship || '—'} | ${row.verdict} |`);
  }
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  const counts = rows.reduce((map, row) => {
    map[row.verdict] = (map[row.verdict] || 0) + 1;
    return map;
  }, {});
  console.log(JSON.stringify(counts));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
