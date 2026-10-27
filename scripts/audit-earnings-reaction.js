'use strict';

// Research audit of the 3% / next-session / 40-session earnings-reaction book.
// Does not change live orders. Recomputes 2022 from the trade list and re-prices
// 20 trades from a fresh Yahoo daily bar download.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { applyCosts } = require('../lib/research/cost-model');
const { atr } = require('../lib/research/mean-reversion');

const ROOT = path.join(__dirname, '..');
const PRICE_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const EARN_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-earnings');
const US = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
const US_START = '2014-01-23';
const THRESHOLD = 0.03;
const DELAY = 1;
const HOLD = 40;

function dateOf(bar) {
  const value = Number(bar?.t ?? bar);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
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
function priceReturn(series, from, to) {
  if (from < 0 || to <= from || !(series.close[from] > 0)) return null;
  return series.close[to] / series.close[from] - 1;
}
function monthStops(series) {
  const stops = [];
  for (let index = 1; index < series.dates.length; index++) {
    if (series.dates[index].slice(0, 7) !== series.dates[index - 1].slice(0, 7)) stops.push(index - 1);
  }
  return stops;
}
function compound(values) {
  return values.reduce((equity, value) => equity * (1 + value), 1) - 1;
}
function tradeStats(returns) {
  const rows = returns.filter(value => Number.isFinite(value));
  if (!rows.length) return { n: 0, avg: null, pf: null };
  const gain = rows.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(rows.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    n: rows.length,
    avg: +((rows.reduce((sum, value) => sum + value, 0) / rows.length) * 100).toFixed(2),
    pf: loss > 0 ? +(gain / loss).toFixed(3) : (gain > 0 ? 99 : 0),
  };
}
function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
function yahooChart(symbol) {
  const period1 = Math.floor(Date.parse('2010-01-01T00:00:00Z') / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
  return new Promise(resolve => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)?.chart?.result?.[0] || null); }
        catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
  });
}

function buildTrades(books, benchmark) {
  const trades = [];
  for (const [symbol, series] of books) {
    for (const reportDate of series.earnings || []) {
      if (reportDate < US_START) continue;
      if (!membershipAt(US, reportDate).has(symbol)) continue;
      const reportAt = firstOnOrAfter(series, reportDate);
      if (reportAt < 20) continue;
      const sessionGap = Date.parse(series.dates[reportAt]) - Date.parse(reportDate);
      if (!(sessionGap >= 0) || sessionGap > 5 * 24 * 60 * 60 * 1000) continue;
      const stock = priceReturn(series, reportAt - 1, reportAt);
      const benchAt = indexOf(benchmark, series.dates[reportAt]);
      const bench = priceReturn(benchmark, benchAt - 1, benchAt);
      if (stock == null || bench == null || stock - bench < THRESHOLD) continue;
      const entryAt = reportAt + DELAY;
      if (entryAt >= series.close.length) continue;
      const entry = series.open[entryAt];
      const bars = series.dates.slice(0, entryAt).map((date, index) => ({
        t: Date.parse(`${date}T00:00:00Z`) / 1000,
        o: series.open[index], h: series.high[index], l: series.low[index], c: series.close[index],
      }));
      const range = atr(bars, bars.length - 1, 14);
      if (!(entry > 0) || !(range > 0)) continue;
      const stop = entry - 2.5 * range;
      let exit = series.close[Math.min(series.close.length - 1, entryAt + HOLD - 1)];
      let exitAt = Math.min(series.close.length - 1, entryAt + HOLD - 1);
      let stopped = false;
      for (let cursor = entryAt; cursor < entryAt + HOLD && cursor < series.close.length; cursor++) {
        if (series.low[cursor] <= stop) { exit = stop; exitAt = cursor; stopped = true; break; }
      }
      const gross = exit / entry - 1;
      const priced = applyCosts(gross, { market: 'US' });
      if (!priced) continue;
      trades.push({
        symbol,
        reportDate,
        signalDate: series.dates[reportAt],
        entryDate: series.dates[entryAt],
        exitDate: series.dates[exitAt],
        entryAt,
        exitAt,
        entry,
        exit,
        stopped,
        gross,
        ret: priced.netReturn,
        series,
      });
    }
  }
  return trades;
}

function oldMonthReturn(trades, benchmark, year) {
  const stops = monthStops(benchmark);
  const months = [];
  let dropped = 0;
  let kept = 0;
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
    const fromDate = benchmark.dates[stops[cursor]];
    const toDate = benchmark.dates[stops[cursor + 1]];
    if (!toDate.startsWith(year)) continue;
    const live = trades.filter(row => row.entryDate <= fromDate && row.exitDate >= toDate);
    const partial = trades.filter(row => row.entryDate <= toDate && row.exitDate >= fromDate && !(row.entryDate <= fromDate && row.exitDate >= toDate));
    dropped += partial.length;
    kept += live.length;
    const rets = live.map(row => priceReturn(row.series, indexOf(row.series, fromDate), indexOf(row.series, toDate))).filter(value => value != null);
    months.push({ date: toDate, names: live.length, ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0 });
  }
  return { yearReturn: compound(months.map(row => row.ret)), months, dropped, kept };
}

function dailyBook(trades, benchmark) {
  const byDate = new Map();
  for (const trade of trades) {
    const series = trade.series;
    for (let index = trade.entryAt; index <= trade.exitAt; index++) {
      let day;
      if (index === trade.entryAt && index === trade.exitAt) day = trade.exit / trade.entry - 1;
      else if (index === trade.entryAt) day = series.close[index] / trade.entry - 1;
      else if (index === trade.exitAt) day = trade.exit / series.close[index - 1] - 1;
      else day = series.close[index] / series.close[index - 1] - 1;
      const date = series.dates[index];
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(day);
    }
  }
  const rows = benchmark.dates.map(date => {
    const values = byDate.get(date) || [];
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const sum = values.reduce((total, value) => total + value, 0);
    return { date, n: values.length, avg, sum };
  });
  return rows;
}

async function reprice(sample) {
  const symbols = [...new Set(sample.map(row => row.symbol))];
  const fresh = new Map();
  for (const symbol of symbols) fresh.set(symbol, await yahooChart(symbol));
  const rows = [];
  for (const trade of sample) {
    const result = fresh.get(trade.symbol);
    const stamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || [];
    const bars = new Map();
    for (let index = 0; index < stamps.length; index++) {
      const date = new Date(stamps[index] * 1000).toISOString().slice(0, 10);
      if (!(quote.close?.[index] > 0)) continue;
      bars.set(date, {
        o: quote.open[index],
        c: quote.close[index],
        a: adjusted[index],
      });
    }
    const entryBar = bars.get(trade.entryDate);
    const exitBar = bars.get(trade.exitDate);
    const cachedExit = trade.stopped ? null : trade.series.close[trade.exitAt];
    const quoteReturn = entryBar && exitBar && !trade.stopped ? exitBar.c / entryBar.o - 1 : null;
    const adjustedReturn = entryBar && exitBar && entryBar.a > 0 && exitBar.a > 0 && !trade.stopped
      ? (exitBar.a / entryBar.a) * (entryBar.c / exitBar.c) * (exitBar.c / entryBar.o) - 1
      : null;
    rows.push({
      symbol: trade.symbol,
      entryDate: trade.entryDate,
      exitDate: trade.exitDate,
      stopped: trade.stopped,
      cachedOpen: +trade.entry.toFixed(4),
      freshOpen: entryBar ? +entryBar.o.toFixed(4) : null,
      openMatch: entryBar ? Math.abs(entryBar.o - trade.entry) / trade.entry < 0.002 : false,
      cachedClose: cachedExit == null ? null : +cachedExit.toFixed(4),
      freshClose: !trade.stopped && exitBar ? +exitBar.c.toFixed(4) : null,
      closeMatch: !trade.stopped && exitBar ? Math.abs(exitBar.c - cachedExit) / cachedExit < 0.002 : null,
      cachedGrossPct: +(trade.gross * 100).toFixed(2),
      freshGrossPct: quoteReturn == null ? null : +(quoteReturn * 100).toFixed(2),
      dividendAdjustedGrossPct: adjustedReturn == null ? null : +(adjustedReturn * 100).toFixed(2),
    });
  }
  return rows;
}

function loadBooks() {
  const benchmark = pack(JSON.parse(fs.readFileSync(path.join(PRICE_DIR, 'SPY.json'), 'utf8')).bars);
  const books = new Map();
  for (const file of fs.readdirSync(EARN_DIR)) {
    if (!file.endsWith('.json')) continue;
    const symbol = file.replace(/\.json$/, '');
    const priceFile = path.join(PRICE_DIR, file);
    if (!fs.existsSync(priceFile)) continue;
    const series = pack(JSON.parse(fs.readFileSync(priceFile, 'utf8')).bars);
    if (series.dates.length < 260) continue;
    series.earnings = JSON.parse(fs.readFileSync(path.join(EARN_DIR, file), 'utf8'));
    books.set(symbol, series);
  }
  return { books, benchmark };
}

async function main() {
  const { books, benchmark } = loadBooks();
  const trades = buildTrades(books, benchmark);
  const oldBook = oldMonthReturn(trades, benchmark, '2022');
  const daily = dailyBook(trades, benchmark);
  const yearDays = daily.filter(row => row.date.startsWith('2022'));
  const sameSymbolOverlap = trades.filter(row => trades.some(other =>
    other !== row && other.symbol === row.symbol && other.entryDate <= row.exitDate && other.exitDate >= row.entryDate)).length;
  const signalIsEntry = trades.filter(row => row.signalDate >= row.entryDate).length;
  const signalAfterReport = trades.filter(row => row.signalDate < row.reportDate).length;
  const entrySameDay = trades.filter(row => row.entryDate === row.signalDate).length;
  const years = new Map();
  for (const trade of trades) {
    const year = trade.exitDate.slice(0, 4);
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(trade.ret);
  }
  const sample = [...trades].sort((left, right) => hash(`${left.symbol}|${left.entryDate}`) - hash(`${right.symbol}|${right.entryDate}`)).slice(0, 20);
  const priced = await reprice(sample);
  const summary = {
    trades: trades.length,
    sameSymbolOverlap,
    timing: {
      feedHasBeforeOpenOrAfterClose: false,
      signalBeforeReport: signalAfterReport,
      entryOnSignalDay: entrySameDay,
      entryOnOrBeforeSignal: signalIsEntry,
    },
    year2022: {
      oldSurvivorMonthPct: +(oldBook.yearReturn * 100).toFixed(2),
      oldMonthNameCounts: oldBook.months.map(row => ({ date: row.date, names: row.names, retPct: +(row.ret * 100).toFixed(2) })),
      partialPositionMonthsDropped: oldBook.dropped,
      fullMonthsKept: oldBook.kept,
      dailyEqualWeightPct: +((compound(yearDays.map(row => row.avg))) * 100).toFixed(2),
      dailySumPct: +((compound(yearDays.map(row => row.sum))) * 100).toFixed(2),
      cashDays: yearDays.filter(row => row.n === 0).length,
      medianNames: yearDays.map(row => row.n).sort((a, b) => a - b)[Math.floor(yearDays.length / 2)],
    },
    tradeYears: [...years.entries()].sort().map(([year, returns]) => ({ year, ...tradeStats(returns) })),
    reprice: priced,
    repriceMatches: priced.filter(row => row.openMatch && (row.closeMatch === true || row.stopped)).length,
  };
  const out = path.join(ROOT, 'scripts', 'earnings-reaction-audit.json');
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({
    trades: summary.trades,
    overlap: summary.sameSymbolOverlap,
    timing: summary.timing,
    year2022: {
      oldSurvivorMonthPct: summary.year2022.oldSurvivorMonthPct,
      dailyEqualWeightPct: summary.year2022.dailyEqualWeightPct,
      dailySumPct: summary.year2022.dailySumPct,
      cashDays: summary.year2022.cashDays,
      dropped: summary.year2022.partialPositionMonthsDropped,
      kept: summary.year2022.fullMonthsKept,
    },
    repriceMatches: summary.repriceMatches,
    tradeYears: summary.tradeYears,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
