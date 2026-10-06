#!/usr/bin/env node
'use strict';

// Research only. Dated amendment: docs/new-strategy-types-amendment-2026-10-06.md
const fs = require('fs');
const https = require('https');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { applyCosts, estimateRoundTripCostPct } = require('../lib/research/cost-model');
const { buildPitPiotroskiScores } = require('../lib/research/pit-piotroski');
const { atr } = require('../lib/research/mean-reversion');

const { loadResearchEnv } = require('./research-env');
const ROOT = path.join(__dirname, '..');
const WORKERS = path.join(ROOT, 'scripts', 'performance-stage1-v2-checkpoint.json.workers', 'stage1');
const CACHE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const EARNINGS_CACHE = path.join(ROOT, 'data', 'research', 'strategy-amendment-earnings');
const OUT_JSON = path.join(ROOT, 'scripts', 'strategy-amendment-results.json');
const READOUT = path.join(ROOT, 'docs', 'new-strategy-types-readout.md');
const US = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
const US_MEMBERSHIP_START = (US.historicalMembership?.changes || [])
  .map(change => change.date)
  .filter(Boolean)
  .sort()[0] || '2014-01-23';
const PERIOD1 = Math.floor(Date.parse('2010-01-01T00:00:00Z') / 1000);
const PAPER_NLV = (() => {
  try {
    const risk = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk_state.json'), 'utf8'));
    return Number(risk.equity) > 0 ? Number(risk.equity) : 700000;
  } catch (_) { return 700000; }
})();
const TICKET = 30000;

const MOMENTUM = [];
for (const cell of [
  ['US', 'long', 'SPY'],
  ['UK', 'medium', 'EWU'],
  ['UK', 'long', 'EWU'],
  ['France', 'medium', 'EWQ'],
  ['France', 'long', 'EWQ'],
]) {
  for (const quality of [false, true]) {
    for (const regime of [false, true]) {
      MOMENTUM.push({
        id: `B__${cell[0]}__${cell[1]}__${quality ? 'piotroski6' : 'momentum'}__regime${regime ? 'on' : 'off'}`,
        part: 'B', market: cell[0], horizon: cell[1], quality, regime, benchmark: cell[2],
        top: cell[0] === 'US' ? 0.10 : 10,
        strategy: `12-1 momentum${quality ? ' among Piotroski ≥ 6' : ''}${regime ? ', cash below 200-day MA' : ''}`,
      });
    }
  }
}
const EARNINGS = [];
for (const threshold of [0.03, 0.05]) {
  for (const delay of [1, 2]) {
    for (const hold of [40, 60]) {
      EARNINGS.push({
        id: `A2__US__medium__react${threshold}_d${delay}_h${hold}`,
        part: 'A2', market: 'US', horizon: 'medium', threshold, delay, hold,
        benchmark: 'SPY',
        strategy: `Earnings reaction, excess ≥ ${threshold * 100}%, enter +${delay} session, hold ${hold} or 2.5 ATR`,
      });
    }
  }
}
if (MOMENTUM.length !== 20 || EARNINGS.length !== 8) {
  throw new Error('Amendment family drift');
}

function dateOf(barOrSeconds) {
  const value = Number(barOrSeconds?.t ?? barOrSeconds);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function yahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${PERIOD1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=earnings`;
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
          for (let index = 0; index < stamps.length; index++) {
            if (!(quote.close?.[index] > 0)) continue;
            bars.push({
              t: stamps[index],
              o: quote.open?.[index] || quote.close[index],
              h: quote.high?.[index] || quote.close[index],
              l: quote.low?.[index] || quote.close[index],
              c: quote.close[index],
            });
          }
          const earnings = Object.values(result?.events?.earnings || {})
            .map(row => dateOf(row.date))
            .filter(Boolean);
          resolve({ bars, earnings });
        } catch (_) { resolve({ bars: [], earnings: [] }); }
      });
    });
    request.on('error', () => resolve({ bars: [], earnings: [] }));
  });
}
function cacheFile(symbol) {
  return path.join(CACHE, `${String(symbol).replace(/[\\/]/g, '_').replace(/^\./, '_')}.json`);
}
function earningsFile(symbol) {
  return path.join(EARNINGS_CACHE, `${String(symbol).replace(/[\\/]/g, '_').replace(/^\./, '_')}.json`);
}
async function cachedChart(symbol) {
  const file = cacheFile(symbol);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const chart = await yahooChart(symbol);
  if (chart.bars.length) fs.writeFileSync(file, JSON.stringify(chart));
  return chart;
}
function fmpEarnings(symbol) {
  const key = String(process.env.FMP_API_KEY || '').trim();
  if (!key) return Promise.resolve(null);
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
  return new Promise(resolve => {
    const request = https.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve(null); return; }
        try {
          const rows = JSON.parse(body);
          const dates = [...new Set((Array.isArray(rows) ? rows : [])
            .filter(row => row && row.epsActual != null && row.epsActual !== '')
            .map(row => String(row.date || '').slice(0, 10))
            .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
          resolve(dates);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
  });
}
async function cachedEarnings(symbol) {
  const file = earningsFile(symbol);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const dates = await fmpEarnings(symbol);
  if (dates) fs.writeFileSync(file, JSON.stringify(dates));
  return dates || [];
}
async function mapLimit(items, limit, operation) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}
function pack(bars) {
  const dates = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  for (const bar of bars || []) {
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
function firstOnOrAfter(series, date) {
  let lo = 0;
  let hi = series.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] >= date) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
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
function aboveMa(series, index) {
  const average = sma(series.close, index, 200);
  return average != null && series.close[index] > average;
}
function monthStops(series) {
  const stops = [];
  for (let index = 1; index < series.dates.length; index++) {
    if (series.dates[index].slice(0, 7) !== series.dates[index - 1].slice(0, 7)) stops.push(index - 1);
  }
  return stops;
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
function tradeStats(returns) {
  const rows = returns.filter(value => Number.isFinite(value));
  if (!rows.length) return { n: 0, win: null, pf: null };
  const wins = rows.filter(value => value > 0);
  const losses = rows.filter(value => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    n: rows.length,
    win: +((wins.length / rows.length) * 100).toFixed(1),
    pf: loss > 0 ? +(gain / loss).toFixed(3) : (gain > 0 ? 99 : 0),
  };
}
function curveStats(values) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  const clean = values.filter(value => Number.isFinite(value));
  for (const value of clean) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
  }
  const mean = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : 0;
  const variance = clean.length > 1
    ? clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1) : 0;
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(12) : null;
  return {
    returnPct: +((equity - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    sharpe: sharpe == null ? null : +sharpe.toFixed(3),
  };
}
function folds(benchmark) {
  return buildDateAlignedFolds(benchmark.dates, { ...FOLD_SPEC, embargoBars: EMBARGO.medium });
}
function yearly(periods, benchmark) {
  const byYear = new Map();
  for (const row of periods) {
    const year = row.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(row);
  }
  const years = [];
  for (const [year, rows] of [...byYear.entries()].sort()) {
    const curve = curveStats(rows.map(row => row.ret));
    const from = firstOnOrAfter(benchmark, `${year}-01-01`);
    const to = indexOf(benchmark, `${year}-12-31`);
    const bench = from >= 0 && String(benchmark.dates[from] || '').startsWith(year)
      ? priceReturn(benchmark, from, to)
      : null;
    years.push({
      year,
      returnPct: curve.returnPct,
      benchmarkReturnPct: bench == null ? null : +(bench * 100).toFixed(2),
    });
  }
  let worst = null;
  for (const row of periods) {
    if (!worst || row.ret < worst.ret) worst = row;
  }
  return {
    years,
    worstMonth: worst ? { date: worst.date, returnPct: +(worst.ret * 100).toFixed(2) } : null,
    maxDrawdownPct: curveStats(periods.map(row => row.ret)).maxDrawdownPct,
  };
}
function scoreSample(variant, benchmark, periods, trades, cohortSizes) {
  const built = folds(benchmark).map(fold => {
    const slice = periods.filter(row => row.date >= fold.test.from && row.date <= fold.test.to);
    const curve = curveStats(slice.map(row => row.ret));
    const from = indexOf(benchmark, fold.test.from);
    const to = indexOf(benchmark, fold.test.to);
    const bench = priceReturn(benchmark, from, to);
    const trade = tradeStats(trades.filter(row => row.date >= fold.test.from && row.date <= fold.test.to).map(row => row.ret));
    return {
      fold: fold.fold,
      from: fold.test.from,
      to: fold.test.to,
      returnPct: curve.returnPct,
      pf: trade.pf,
      win: trade.win,
      trades: trade.n,
      maxDrawdownPct: curve.maxDrawdownPct,
      benchmarkReturnPct: bench == null ? null : +(bench * 100).toFixed(2),
      beat: bench != null && (slice.some(row => row.ret !== 0) || trade.n > 0)
        && curve.returnPct > +(bench * 100).toFixed(2),
    };
  });
  const consistent = built.length === 4 && built.every(row => row.returnPct > 0 && row.pf >= 1.2 && row.trades > 0);
  const beats = built.filter(row => row.beat).length;
  const sizes = cohortSizes.filter(value => value > 0).sort((a, b) => a - b);
  const overall = { ...curveStats(periods.map(row => row.ret)), ...tradeStats(trades.map(row => row.ret)) };
  const last = periods.length ? periods[periods.length - 1].date : null;
  const benchFull = last ? priceReturn(benchmark, 0, indexOf(benchmark, last)) : null;
  const benchmarkReturnPct = benchFull == null ? null : +(benchFull * 100).toFixed(2);
  overall.benchmarkReturnPct = benchmarkReturnPct;
  const fullSampleBeat = overall.returnPct > 0 && benchmarkReturnPct != null && overall.returnPct > benchmarkReturnPct;
  let verdict = 'FAIL';
  if (fullSampleBeat && consistent && beats >= 3) verdict = 'PASS';
  else if (fullSampleBeat && (consistent || beats >= 3)) verdict = 'CANDIDATE';
  return {
    windows: built,
    overall,
    ...yearly(periods, benchmark),
    medianNames: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0,
    fullSampleBeat,
    verdict,
  };
}
function momentumRank(books, benchmark, signalIndex, variant) {
  const date = benchmark.dates[signalIndex];
  if (variant.market === 'US' && date < US_MEMBERSHIP_START) return [];
  if (variant.membership && date < variant.membershipStart) return [];
  const members = variant.membership
    ? membershipAt(variant.membership, date)
    : variant.market === 'US' ? membershipAt(US, date) : null;
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
  const count = variant.top < 1 ? Math.max(1, Math.floor(ranked.length * variant.top)) : Math.min(variant.top, ranked.length);
  return ranked.slice(0, count);
}
function runMomentum(variant, loaded) {
  const { books, benchmark } = loaded;
  const stops = monthStops(benchmark);
  const periods = [];
  const trades = [];
  const cohorts = [];
  const sizes = [];
  const holdMonths = variant.horizon === 'long' ? 6 : 1;
  const drag = estimateRoundTripCostPct({ market: variant.market }) / 100 / holdMonths;
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
    const signal = stops[cursor];
    const next = stops[cursor + 1];
    if (variant.regime && !aboveMa(benchmark, signal)) {
      periods.push({ date: benchmark.dates[next], ret: 0 });
      sizes.push(0);
      continue;
    }
    const picked = momentumRank(books, benchmark, signal, variant);
    sizes.push(picked.length);
    cohorts.push({ start: cursor, names: picked });
    const active = cohorts.filter(cohort => cursor >= cohort.start && cursor < cohort.start + holdMonths);
    let sleeveReturn = 0;
    let sleeves = 0;
    for (const cohort of active) {
      const piece = [];
      for (const name of cohort.names) {
        const gross = priceReturn(
          name.series,
          indexOf(name.series, benchmark.dates[stops[cursor]]),
          indexOf(name.series, benchmark.dates[next]),
        );
        if (gross != null) piece.push(gross - drag);
      }
      if (!piece.length) continue;
      sleeves += 1;
      sleeveReturn += piece.reduce((sum, value) => sum + value, 0) / piece.length;
      if (cursor + 1 === cohort.start + holdMonths) {
        const exitAt = stops[Math.min(cohort.start + holdMonths, stops.length - 1)];
        for (const name of cohort.names) {
          const life = priceReturn(name.series, name.at, indexOf(name.series, benchmark.dates[exitAt]));
          if (life != null) trades.push({ date: benchmark.dates[exitAt], ret: net(life, variant.market) });
        }
      }
    }
    const invested = holdMonths === 1 ? 1 : Math.min(1, sleeves / holdMonths);
    periods.push({ date: benchmark.dates[next], ret: sleeves ? (sleeveReturn / sleeves) * invested : 0 });
  }
  return scoreSample(variant, benchmark, periods, trades.filter(row => Number.isFinite(row.ret)), sizes);
}
function runEarnings(variant, loaded) {
  const { books, benchmark } = loaded;
  const trades = [];
  const open = [];
  for (const [symbol, series] of books) {
    for (const reportDate of series.earnings || []) {
      if (reportDate < US_MEMBERSHIP_START) continue;
      if (!membershipAt(US, reportDate).has(symbol)) continue;
      const reportAt = firstOnOrAfter(series, reportDate);
      if (reportAt < 20) continue;
      const sessionGap = Date.parse(series.dates[reportAt]) - Date.parse(reportDate);
      if (!(sessionGap >= 0) || sessionGap > 5 * 24 * 60 * 60 * 1000) continue;
      const signalDate = series.dates[reportAt];
      const stock = priceReturn(series, reportAt - 1, reportAt);
      const benchAt = indexOf(benchmark, signalDate);
      const bench = priceReturn(benchmark, benchAt - 1, benchAt);
      if (stock == null || bench == null || stock - bench < variant.threshold) continue;
      const entryAt = reportAt + variant.delay;
      if (entryAt >= series.close.length) continue;
      const entry = series.open[entryAt];
      const bars = series.dates.slice(0, entryAt).map((date, index) => ({
        t: Date.parse(date) / 1000, o: series.open[index], h: series.high[index], l: series.low[index], c: series.close[index],
      }));
      const range = atr(bars, bars.length - 1, 14);
      if (!(entry > 0) || !(range > 0)) continue;
      const stop = entry - 2.5 * range;
      let exit = series.close[Math.min(series.close.length - 1, entryAt + variant.hold - 1)];
      let exitAt = Math.min(series.close.length - 1, entryAt + variant.hold - 1);
      for (let cursor = entryAt; cursor < entryAt + variant.hold && cursor < series.close.length; cursor++) {
        if (series.low[cursor] <= stop) { exit = stop; exitAt = cursor; break; }
      }
      const gross = exit / entry - 1;
      const value = net(gross, 'US');
      if (value == null) continue;
      const row = {
        symbol, date: series.dates[exitAt], entryDate: series.dates[entryAt], ret: value,
        series, entryAt, exitAt, entryPx: entry, exitPx: exit,
      };
      trades.push(row);
      open.push(row);
    }
  }
  const byDate = new Map();
  for (const trade of open) {
    for (let index = trade.entryAt; index <= trade.exitAt; index++) {
      let day;
      if (index === trade.entryAt && index === trade.exitAt) day = trade.exitPx / trade.entryPx - 1;
      else if (index === trade.entryAt) day = trade.series.close[index] / trade.entryPx - 1;
      else if (index === trade.exitAt) day = trade.exitPx / trade.series.close[index - 1] - 1;
      else day = trade.series.close[index] / trade.series.close[index - 1] - 1;
      const date = trade.series.dates[index];
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(day);
    }
  }
  const daily = benchmark.dates.map(date => {
    const values = byDate.get(date) || [];
    return { date, ret: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 };
  });
  const periods = [];
  let bucket = [];
  let bucketDate = null;
  for (const row of daily) {
    if (bucketDate && row.date.slice(0, 7) !== bucketDate.slice(0, 7)) {
      periods.push({
        date: bucketDate,
        ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1,
      });
      bucket = [];
    }
    bucket.push(row.ret);
    bucketDate = row.date;
  }
  if (bucket.length) {
    periods.push({
      date: bucketDate,
      ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1,
    });
  }
  const scored = scoreSample(variant, benchmark, periods, trades, trades.map(() => 1));
  scored.maxDrawdownPct = curveStats(daily.map(row => row.ret)).maxDrawdownPct;
  const byYear = new Map();
  for (const trade of trades) {
    const year = trade.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(trade.ret);
  }
  scored.tradeYears = [...byYear.entries()].sort().map(([year, returns]) => {
    const average = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    return {
      year,
      ...tradeStats(returns),
      avg: average == null ? null : +(average * 100).toFixed(2),
    };
  });
  const concurrent = [];
  for (const date of benchmark.dates) {
    concurrent.push(open.filter(row => row.series.dates[row.entryAt] <= date && row.series.dates[row.exitAt] >= date).length);
  }
  concurrent.sort((a, b) => a - b);
  scored.medianNames = concurrent.length ? concurrent[Math.floor(concurrent.length / 2)] : 0;
  scored.peakNames = concurrent.length ? concurrent[concurrent.length - 1] : 0;
  return scored;
}
function design(row) {
  const slots = Math.floor(PAPER_NLV / TICKET);
  if (row.part === 'A2') {
    return `The scored curve is the uncapped equal-weight book (peak ${row.peakNames || 0} names, median ${row.medianNames}). An executable book sizes each new report at $${TICKET.toLocaleString('en-US')} and stops at ${slots} open names on the $${PAPER_NLV.toLocaleString('en-US')} paper pool, keeping the largest excess-return names and skipping the rest. That cap was not re-scored. Orders are the entry open and the stop or the hold-date close, not a monthly rebalance.`;
  }
  const names = row.medianNames || (row.top < 1 ? 'top 10%' : row.top);
  const sleeve = row.horizon === 'long'
    ? 'Long holds six overlapping sleeves. Once a month, replace the oldest sleeve and leave the other five in place.'
    : 'Rebalance once a month: sell names that leave the cohort and buy the new ones.';
  return `Median cohort is ${names} names. Target $${TICKET.toLocaleString('en-US')} each, capped at ${slots} names so the book stays inside the $${PAPER_NLV.toLocaleString('en-US')} paper pool. ${sleeve} If several of these cells are on together, they share that same gross cap.`;
}
function workerSymbols(prefix) {
  const books = new Map();
  const files = fs.readdirSync(WORKERS).filter(name => name.startsWith(`${prefix}__long__`) && name.endsWith('.result.json'));
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(WORKERS, file), 'utf8')); } catch (_) { continue; }
    const context = parsed?.result?.context;
    if (!context?.symbol) continue;
    let scores = [];
    try {
      scores = (buildPitPiotroskiScores(context.arrays).scores || [])
        .map(row => ({ availableOn: row.availableOn, score: row.score }))
        .sort((left, right) => String(left.availableOn).localeCompare(String(right.availableOn)));
    } catch (_) { scores = []; }
    books.set(context.symbol, { scores });
  }
  return books;
}

async function loadMarket(market) {
  const prefix = market === 'Hong Kong' ? 'Hong_Kong' : market;
  const meta = workerSymbols(prefix);
  const symbols = [...meta.keys()];
  const benchmarkSymbol = { US: 'SPY', UK: 'EWU', France: 'EWQ' }[market];
  console.log(`[fetch] ${market} ${symbols.length}`);
  await mapLimit([benchmarkSymbol, ...symbols], 8, symbol => cachedChart(symbol));
  const earningsBySymbol = new Map();
  if (market === 'US') {
    console.log(`[earnings] ${symbols.length} announcement dates`);
    let missed = 0;
    await mapLimit(symbols, 6, async symbol => {
      earningsBySymbol.set(symbol, await cachedEarnings(symbol));
      if (!fs.existsSync(earningsFile(symbol))) missed += 1;
    });
    if (missed > Math.max(10, Math.floor(symbols.length * 0.05))) {
      throw new Error(`Earnings dates missing for ${missed} of ${symbols.length} US symbols; not scoring a partial book`);
    }
    console.log(`[earnings] missed ${missed}`);
  }
  const benchmark = pack(JSON.parse(fs.readFileSync(cacheFile(benchmarkSymbol), 'utf8')).bars);
  const books = new Map();
  let earningsDates = 0;
  for (const symbol of symbols) {
    const file = cacheFile(symbol);
    if (!fs.existsSync(file)) continue;
    const chart = JSON.parse(fs.readFileSync(file, 'utf8'));
    const series = pack(chart.bars);
    if (series.dates.length < 260) continue;
    series.scores = meta.get(symbol).scores;
    series.earnings = earningsBySymbol.get(symbol) || [];
    earningsDates += series.earnings.length;
    books.set(symbol, series);
  }
  console.log(`[load] ${market} ${books.size} from ${books.size ? [...books.values()][0].dates[0] : 'n/a'} benchmark ${benchmark.dates[0] || 'n/a'} earnings ${earningsDates}`);
  return { books, benchmark, start: benchmark.dates[0] || null, earningsDates };
}

function appendReadout(rows, starts) {
  const lines = [
    '',
    '## Amendment 2026-10-06',
    '',
    'Pre-registration: docs/new-strategy-types-amendment-2026-10-06.md. No live change.',
    `US membership is point-in-time from ${US_MEMBERSHIP_START}, and US signals start on that date. UK and France are SURVIVORSHIP_BIAS. Price start: ${starts.join('; ')}.`,
    'Yahoo chart events=earnings returned no report dates on 2026-10-06. Report dates are Financial Modeling Prep announcement dates that already have a reported EPS, joined to the cached Yahoo prices. A date that is not a session uses the next session, and only when that session is within five calendar days.',
    'A flat window with no positions does not count as beating the benchmark.',
    'Earnings portfolio returns are the equal-weight average of open positions\' daily returns, and a day with no open position earns 0. The prior curve kept only names that were open for a whole month, which dropped stop-outs. The benchmark day is the signal session. FMP has no before-open or after-close flag, so the signal session is the first session on or after the announcement date and entry is one or two sessions after that.',
    '',
    '| Market | Horizon | Strategy | Verdict | Full-sample return | Max DD | Worst month | Beat windows |',
    '| --- | --- | --- | --- | ---: | ---: | --- | ---: |',
  ];
  for (const row of rows) {
    lines.push(`| ${row.market} | ${row.horizon} | ${row.strategy} | ${row.verdict} | ${row.overall?.returnPct ?? '—'}% | ${row.maxDrawdownPct ?? '—'}% | ${row.worstMonth ? `${row.worstMonth.date} ${row.worstMonth.returnPct}%` : '—'} | ${(row.windows || []).filter(window => window.beat).length}/4 |`);
  }
  lines.push('', '### Per year vs benchmark', '');
  for (const row of rows.filter(item => item.verdict === 'PASS' || item.verdict === 'CANDIDATE')) {
    lines.push(`#### ${row.market} ${row.horizon} — ${row.strategy}`, '');
    lines.push('| Year | Strategy | Benchmark |', '| --- | ---: | ---: |');
    for (const year of row.years || []) {
      lines.push(`| ${year.year} | ${year.returnPct}% | ${year.benchmarkReturnPct}% |`);
    }
    lines.push('', row.design, '');
  }
  const audited = rows.find(item => item.id === 'A2__US__medium__react0.03_d1_h40');
  if (audited?.tradeYears) {
    lines.push('### Earnings trade list by exit year', '', '3% excess, enter the next session, hold 40 or a 2.5 ATR stop. Returns are net of the cost model.', '');
    lines.push('| Year | Trades | Avg trade | PF |', '| --- | ---: | ---: | ---: |');
    for (const year of audited.tradeYears) lines.push(`| ${year.year} | ${year.n} | ${year.avg}% | ${year.pf} |`);
    lines.push('');
  }
  lines.push(
    '### Portfolio execution for the original PASS and CANDIDATE rows',
    '',
    `Paper pool $${PAPER_NLV.toLocaleString('en-US')}, ticket $${TICKET.toLocaleString('en-US')}, ${Math.floor(PAPER_NLV / TICKET)} name slots. Not implemented. Cells that share the pool also share that gross cap.`,
    '',
    'US long 12-1 momentum passed the original windows and failed the 2010 sample. Its ranked book is the top 10 percent, which is larger than 23 names, so an executable book keeps the strongest 23 at $30,000 and drops the rest. Six overlapping sleeves, replace the oldest sleeve once a month.',
    '',
    'UK and France momentum rows that were PASS or CANDIDATE on the original windows and failed this longer sample stay at 10 names, $30,000 each ($300,000). Medium rebalances the whole cohort monthly. Long keeps six sleeves and replaces one sleeve a month. UK and France lists are SURVIVORSHIP_BIAS.',
    '',
    'Commodities 20-day breakout is a CANDIDATE on 12 ETFs (GLD, SLV, USO, UNG, DBC, PDBC, GSG, DBA, WEAT, CPER, BNO, COPX). One $30,000 ticket per name that breaks out, so the book is at most $360,000. Orders are the breakout entry and the 10-day-low exit.',
    '',
    'Crypto trend and 20-day breakout are CANDIDATE on the 18 coins that had at least three years of prices. One $30,000 ticket per name in trend or in a breakout is at most $540,000, inside the paper pool. Trend is checked once a month against the 200-day average. Breakout orders are the entry and the 10-day-low exit. The medium and long trend rows are the same book scored twice, so only one of them would be run.',
    '',
  );
  const prior = fs.readFileSync(READOUT, 'utf8').split('\n## Amendment 2026-10-06')[0].trimEnd();
  fs.writeFileSync(READOUT, `${prior}\n${lines.join('\n')}\n`);
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(EARNINGS_CACHE, { recursive: true });
  loadResearchEnv();
  console.log(`[family] momentum ${MOMENTUM.length} + earnings reaction ${EARNINGS.length}`);
  const markets = new Map();
  for (const market of ['US', 'UK', 'France']) markets.set(market, await loadMarket(market));
  const rows = [];
  for (const variant of MOMENTUM) {
    const scored = runMomentum(variant, markets.get(variant.market));
    const row = {
      ...variant,
      survivorship: variant.market === 'US' ? 'POINT_IN_TIME' : 'SURVIVORSHIP_BIAS',
      ...scored,
    };
    row.design = design(row);
    rows.push(row);
    console.log(`[${row.verdict}] ${row.id} names=${row.medianNames} worst=${row.worstMonth && row.worstMonth.returnPct}`);
  }
  for (const variant of EARNINGS) {
    const scored = runEarnings(variant, markets.get('US'));
    const row = { ...variant, survivorship: 'POINT_IN_TIME', ...scored };
    if (!(markets.get('US').earningsDates > 0)) row.verdict = 'INSUFFICIENT';
    row.design = design(row);
    rows.push(row);
    console.log(`[${row.verdict}] ${row.id} trades=${row.overall?.n} peak=${row.peakNames}`);
  }
  const starts = [...markets.entries()].map(([market, loaded]) => `${market} ${loaded.start}`);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    preregistration: 'docs/new-strategy-types-amendment-2026-10-06.md',
    paperNlv: PAPER_NLV,
    liveBehaviorChanged: false,
    starts,
    rows,
  }, null, 2)}\n`);
  appendReadout(rows, starts);
  const counts = rows.reduce((map, row) => {
    map[row.verdict] = (map[row.verdict] || 0) + 1;
    return map;
  }, {});
  console.log(JSON.stringify(counts));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runMomentum,
  momentumRank,
  scoreSample,
  monthStops,
  indexOf,
  priceReturn,
  cachedChart,
  pack,
  workerSymbols,
  PAPER_NLV,
  TICKET,
};
