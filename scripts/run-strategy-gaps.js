'use strict';

// Research only. Rules are frozen in docs/strategy-gaps-preregistration-2026-10-06.md.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { applyCosts, estimateRoundTripCostPct } = require('../lib/research/cost-model');
const { instrumentFor, boardLot } = require('../lib/research/exit-amendment');
const { buildPitPiotroskiScores } = require('../lib/research/pit-piotroski');
const { loadResearchEnv } = require('./research-env');
const { compound, maxDrawdown, tStat, sharpe, deflatedSharpe, scoreCell, twoFactor } = require('../lib/research/strategy-gaps');

const ROOT = path.join(__dirname, '..');
const PRICE_DIRS = [
  path.join(ROOT, 'data', 'research', 'strategy-amendment-prices'),
  path.join(ROOT, 'data', 'research', 'exit-amendment-prices'),
];
const EARNINGS_DIR = path.join(ROOT, 'data', 'research', 'strategy-amendment-earnings');
const FMP_DIR = path.join(ROOT, 'data', 'research', 'fmp');
const MEMBER_DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const PROFILE_DIR = path.join(ROOT, 'data', 'research', 'fmp-profiles');
const PRIOR_JSON = path.join(ROOT, 'scripts', 'strategy-gaps-results.json');
const OUT_JSON = path.join(ROOT, 'scripts', 'strategy-gaps-amendment-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'strategy-gaps-amendment-results.md');
const ROLL = 0.0026;
const TICKET = 30000;
const earlyExits = { F3: 0, F4: 0, F5: 0, F6: 0 };
let timingNote = 'Not recorded.';

loadResearchEnv();
const FMP_KEY = String(process.env.FMP_API_KEY || '').trim();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function dateOf(bar) {
  const value = Number(bar?.t ?? bar);
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
}
function pack(raw) {
  const bars = Array.isArray(raw) ? raw : (raw?.bars || []);
  const dates = [];
  const open = [];
  const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || !(Number(bar.c) > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) > 0 ? Number(bar.o) : Number(bar.c));
    close.push(Number(bar.c));
  }
  return { dates, open, close };
}
function loadSeries(symbol) {
  const fileName = `${String(symbol).replace(/^\^/, '_')}.json`;
  for (const dir of PRICE_DIRS) {
    const file = path.join(dir, fileName);
    if (fs.existsSync(file)) return pack(readJson(file));
  }
  return null;
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
function meanStd(values) {
  const clean = values.filter(value => Number.isFinite(value));
  if (clean.length < 2) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}
function sign(value) {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}
function priceReturn(series, from, to) {
  if (from < 0 || to <= from || !(series.close[from] > 0)) return null;
  return series.close[to] / series.close[from] - 1;
}
function monthEnds(series) {
  const ends = [];
  for (let index = 1; index < series.dates.length; index += 1) {
    if (series.dates[index].slice(0, 7) !== series.dates[index - 1].slice(0, 7)) ends.push(index - 1);
  }
  if (series.dates.length) ends.push(series.dates.length - 1);
  return ends;
}
function foldsFor(dates, horizon) {
  const embargoBars = horizon === 'short' ? EMBARGO.short : horizon === 'long' ? EMBARGO.long : EMBARGO.medium;
  return buildDateAlignedFolds(dates, { ...FOLD_SPEC, embargoBars });
}
function membershipAt(snapshot, date) {
  if (!snapshot?.historicalMembership?.available) return null;
  const membership = new Set(snapshot.currentSymbols || []);
  const asOf = String(date || '').slice(0, 10);
  for (const change of snapshot.historicalMembership.changes || []) {
    if (!change.date || change.date <= asOf) continue;
    if (change.added) membership.delete(change.added);
    if (change.removed) membership.add(change.removed);
  }
  return membership;
}
function everMembers(snapshot) {
  if (!snapshot?.historicalMembership?.available) return null;
  const ever = new Set(snapshot.currentSymbols || []);
  const dates = [];
  for (const change of snapshot.historicalMembership.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
    if (change.date) dates.push(change.date);
  }
  for (const date of dates) {
    const members = membershipAt(snapshot, date);
    if (!members) continue;
    for (const symbol of members) ever.add(symbol);
  }
  return ever;
}
function hasPrice(symbol) {
  const fileName = `${String(symbol).replace(/^\^/, '_')}.json`;
  return PRICE_DIRS.some(dir => fs.existsSync(path.join(dir, fileName)));
}
function membershipYears(snapshot) {
  const dated = (snapshot.historicalMembership?.changes || [])
    .map(change => String(change.date || '').slice(0, 4))
    .filter(year => /^\d{4}$/.test(year))
    .sort();
  if (!dated.length) return [];
  const rows = [];
  for (let year = Number(dated[0]); year <= Number(dated[dated.length - 1]); year += 1) {
    const members = membershipAt(snapshot, `${year}-12-31`) || new Set();
    let priced = 0;
    for (const symbol of members) if (hasPrice(symbol)) priced += 1;
    rows.push({ year: String(year), members: members.size, priced, missing: members.size - priced });
  }
  return rows;
}
function clipExit(series, entry, planned, family, sampleEnd) {
  if (entry < 0 || entry >= series.close.length || !(series.open[entry] > 0)) return null;
  if (planned > entry && planned < series.close.length) {
    return { exit: planned, exitPx: series.close[planned], early: false };
  }
  const exit = series.close.length - 1;
  if (exit < entry) return null;
  const last = series.dates[exit];
  if (sampleEnd && Date.parse(sampleEnd) - Date.parse(last) > 7 * 86400000) earlyExits[family] += 1;
  return { exit, exitPx: series.close[exit], early: true };
}
function roundPct(value) {
  return value == null || !Number.isFinite(value) ? null : +(value * 100).toFixed(2);
}
function monthMap(series) {
  const daily = series.dates.map((date, index) => ({
    date,
    ret: index === 0 || !(series.close[index - 1] > 0) ? 0 : series.close[index] / series.close[index - 1] - 1,
  }));
  return new Map(toMonths(daily).map(row => [row.date.slice(0, 7), row.ret]));
}
function openMonthMap(series) {
  const ends = monthEnds(series);
  const map = new Map();
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const entry = ends[edge] + 1;
    const exit = ends[edge + 1] + 1;
    if (exit >= series.open.length || !(series.open[entry] > 0)) continue;
    map.set(series.dates[ends[edge + 1]].slice(0, 7), series.open[exit] / series.open[entry] - 1);
  }
  return map;
}
function qqqHurdle(monthly, daily, folds) {
  const qqq = loadSeries('QQQ');
  const spy = loadSeries('SPY');
  if (!qqq || !spy || !monthly?.length) return null;
  const closeMonths = Boolean(daily?.length);
  const qqqMonths = closeMonths ? monthMap(qqq) : openMonthMap(qqq);
  const spyMonths = closeMonths ? monthMap(spy) : openMonthMap(spy);
  const kept = [];
  for (const row of monthly) {
    const nasdaq = qqqMonths.get(row.date.slice(0, 7));
    const market = spyMonths.get(row.date.slice(0, 7));
    if (!Number.isFinite(nasdaq) || !Number.isFinite(market)) continue;
    kept.push({ date: row.date, ret: row.ret, nasdaq, market });
  }
  if (kept.length < 6) return null;
  const bookRets = kept.map(row => row.ret);
  const qqqAligned = kept.map(row => row.nasdaq);
  const spyAligned = kept.map(row => row.market);
  const qqqDaily = new Map();
  for (let index = 1; index < qqq.dates.length; index += 1) {
    qqqDaily.set(qqq.dates[index], qqq.close[index] / qqq.close[index - 1] - 1);
  }
  const windows = (folds || []).map(fold => {
    const bookSlice = [];
    const qqqSlice = [];
    if (daily?.length) {
      for (const row of daily) {
        if (row.date < fold.test.from || row.date > fold.test.to) continue;
        bookSlice.push(row.ret);
        qqqSlice.push(qqqDaily.get(row.date) || 0);
      }
    } else {
      monthly.forEach((row) => {
        if (row.date < fold.test.from || row.date > fold.test.to) return;
        const nasdaq = qqqMonths.get(row.date.slice(0, 7));
        if (!Number.isFinite(nasdaq)) return;
        bookSlice.push(row.ret);
        qqqSlice.push(nasdaq);
      });
    }
    return {
      fold: fold.fold,
      from: fold.test.from,
      to: fold.test.to,
      excessPp: roundPct(compound(bookSlice) - compound(qqqSlice)),
    };
  });
  const bookRet = compound(bookRets);
  const qqqRet = compound(qqqAligned);
  const bookCurve = daily?.length ? daily.map(row => row.ret) : bookRets;
  const qqqCurve = daily?.length
    ? daily.map(row => qqqDaily.get(row.date) || 0)
    : qqqAligned;
  const bookDd = maxDrawdown(bookCurve);
  const qqqDd = maxDrawdown(qqqCurve);
  const fit = twoFactor(bookRets, spyAligned, qqqAligned);
  const bookSharpe = sharpe(bookRets).sharpe;
  const qqqSharpe = sharpe(qqqAligned).sharpe;
  return {
    qqqReturnPct: roundPct(qqqRet),
    qqqMaxDrawdownPct: roundPct(qqqDd),
    bookSharpe: bookSharpe == null ? null : +bookSharpe.toFixed(2),
    qqqSharpe: qqqSharpe == null ? null : +qqqSharpe.toFixed(2),
    beatsQqq: bookRet > qqqRet || (bookRet === qqqRet && bookDd < qqqDd),
    windows,
    alphaAnnualPct: fit && Number.isFinite(fit.alphaAnnual) ? roundPct(fit.alphaAnnual) : null,
    alphaT: fit && Number.isFinite(fit.t) ? +fit.t.toFixed(2) : null,
    betaSpy: fit && Number.isFinite(fit.betaSpy) ? +fit.betaSpy.toFixed(2) : null,
    betaQqq: fit && Number.isFinite(fit.betaQqq) ? +fit.betaQqq.toFixed(2) : null,
    regressionMonths: fit ? fit.n : 0,
  };
}
function netOf(gross, opts) {
  const cost = applyCosts(gross, opts);
  return cost ? { net: cost.netReturn, costPct: cost.costPct } : null;
}
function notionalFor(symbol, market, price, fx, weight) {
  const scale = String(symbol).toUpperCase().endsWith('.L') || market === 'UK' ? 0.01 : 1;
  const px = price * scale * (fx || 1);
  const mapped = instrumentFor(symbol, px);
  if (mapped.kind === 'micro_future') {
    const lotUsd = mapped.lotNotionalUsd;
    const target = Math.max(0, weight) * TICKET;
    if (!(lotUsd > 0) || !(target > 0)) return 0;
    const lots = lotUsd > target ? 1 : Math.max(1, Math.floor(target / lotUsd));
    return lots * lotUsd;
  }
  const lotShares = boardLot(symbol);
  const lotUsd = px * lotShares;
  const target = Math.max(0, weight) * TICKET;
  if (!(lotUsd > 0) || !(target > 0)) return 0;
  const lots = lotUsd > target ? 1 : Math.max(1, Math.floor(target / lotUsd));
  return lots * lotUsd;
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function yahoo(symbol) {
  const period1 = 631152000;
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  return httpGet(url).then(response => {
    if (response.status !== 200) return null;
    const result = JSON.parse(response.raw)?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const stamps = result?.timestamp || [];
    if (!quote || !stamps.length) return null;
    const bars = [];
    for (let index = 0; index < stamps.length; index += 1) {
      const close = Number(quote.close?.[index]);
      if (!(close > 0)) continue;
      bars.push({
        t: stamps[index],
        o: Number(quote.open?.[index]) || close,
        h: Number(quote.high?.[index]) || close,
        l: Number(quote.low?.[index]) || close,
        c: close,
      });
    }
    return bars;
  }).catch(() => null);
}
async function ensureSeries(symbol, fileSymbol) {
  const existing = loadSeries(fileSymbol || symbol);
  if (existing?.dates.length) return existing;
  const bars = await yahoo(symbol);
  if (!bars?.length) return null;
  const file = path.join(PRICE_DIRS[1], `${String(fileSymbol || symbol).replace(/^\^/, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(bars));
  return pack(bars);
}

function trendSignal(series, index, variant) {
  const r3 = priceReturn(series, index - 63, index);
  const r6 = priceReturn(series, index - 126, index);
  const r12 = priceReturn(series, index - 252, index);
  const r121 = priceReturn(series, index - 252, index - 21);
  if (variant === 'ts_3m') return sign(r3);
  if (variant === 'ts_6m') return sign(r6);
  if (variant === 'ts_12m') return sign(r12);
  if (variant === 'ts_12_1') return sign(r121);
  if (variant === 'ts_blend') {
    if ([r3, r6, r12].some(value => value == null)) return 0;
    return sign((r3 + r6 + r12) / 3);
  }
  if ([r3, r6, r12].some(value => value == null)) return 0;
  return sign(sign(r3) + sign(r6) + sign(r12));
}
function volWeight(series, index) {
  if (index < 63) return null;
  const returns = [];
  for (let cursor = index - 62; cursor <= index; cursor += 1) {
    returns.push(series.close[cursor] / series.close[cursor - 1] - 1);
  }
  const vol = meanStd(returns);
  if (!(vol > 0)) return null;
  return Math.min(2, 0.10 / (vol * Math.sqrt(252)));
}
function runTrendBook(spec) {
  const { series, variant, volTarget, market, symbol, futures } = spec;
  const ends = monthEnds(series);
  const months = [];
  const grossMonths = [];
  const execMonths = [];
  const trades = [];
  let open = null;
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const signal = ends[edge];
    const entry = signal + 1;
    const exit = ends[edge + 1] + 1;
    if (entry >= series.close.length || exit >= series.close.length) continue;
    if (series.dates[signal] < '2010-01-01') continue;
    const direction = trendSignal(series, signal, variant);
    const weight = volTarget ? volWeight(series, signal) : 1;
    const date = series.dates[ends[edge + 1]];
    const gross = series.open[exit] / series.open[entry] - 1;
    if (!Number.isFinite(gross) || !(weight > 0)) {
      months.push({ date, ret: 0 });
      grossMonths.push({ date, ret: 0 });
      execMonths.push({ date, ret: 0 });
      continue;
    }
    const sideName = direction > 0 ? 'buy' : direction < 0 ? 'sell' : null;
    let research = 0;
    let grossResearch = 0;
    let executable = 0;
    if (sideName) {
      const held = exit - entry;
      const priced = netOf(direction * gross, { market, symbol, side: sideName, holdDays: held });
      const roll = futures ? ROLL : 0;
      const opening = !open || open.side !== direction;
      const roundTrip = opening ? (priced.costPct / 100) : 0;
      const net = direction * gross - roundTrip - roll - (opening ? 0 : 0);
      const borrow = priced.net - direction * gross;
      const monthNet = direction * gross + (opening ? borrow : 0) - (futures ? ROLL : 0);
      research = weight * monthNet;
      grossResearch = weight * direction * gross;
      const notional = notionalFor(symbol, market, series.open[entry], 1, weight);
      executable = monthNet * (notional / TICKET);
      if (opening && open) {
        trades.push({ date: series.dates[entry], ret: open.compound - 1 });
        open = null;
      }
      if (!open) open = { side: direction, compound: 1 };
      open.compound *= 1 + monthNet;
    } else if (open) {
      trades.push({ date, ret: open.compound - 1 });
      open = null;
    }
    months.push({ date, ret: research });
    grossMonths.push({ date, ret: grossResearch });
    execMonths.push({ date, ret: executable });
  }
  if (open) trades.push({ date: series.dates.at(-1), ret: open.compound - 1 });
  return { months, grossMonths, execMonths, trades };
}

function sideBook(full, side) {
  const map = rows => rows.map(row => {
    if (side === 'combined') return row;
    return row;
  });
  return map(full);
}

function filterSide(book, side) {
  if (side === 'combined') return book;
  const keep = side === 'long' ? 1 : -1;
  let open = null;
  const months = [];
  const grossMonths = [];
  const execMonths = [];
  const trades = [];
  for (let index = 0; index < book.months.length; index += 1) {
    const wanted = book.signs[index] === keep;
    months.push({ date: book.months[index].date, ret: wanted ? book.months[index].ret : 0 });
    grossMonths.push({ date: book.grossMonths[index].date, ret: wanted ? book.grossMonths[index].ret : 0 });
    execMonths.push({ date: book.execMonths[index].date, ret: wanted ? book.execMonths[index].ret : 0 });
    if (wanted && !open) open = { compound: 1, date: book.months[index].date };
    if (wanted && open) open.compound *= 1 + (book.months[index]?.ret || 0);
    if (!wanted && open) {
      trades.push({ date: book.months[index].date, ret: open.compound - 1 });
      open = null;
    }
  }
  if (open) trades.push({ date: book.months.at(-1).date, ret: open.compound - 1 });
  return { months, grossMonths, execMonths, trades };
}

function simulateTrend(series, variant, spec) {
  const ends = monthEnds(series);
  const signs = [];
  const months = [];
  const grossMonths = [];
  const execMonths = [];
  const tradeMonths = [];
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const signal = ends[edge];
    const entry = signal + 1;
    const exit = ends[edge + 1] + 1;
    const date = series.dates[Math.min(ends[edge + 1], series.dates.length - 1)];
    if (entry >= series.open.length || exit >= series.open.length || series.dates[signal] < '2010-01-01') continue;
    const direction = trendSignal(series, signal, variant);
    const weight = spec.volTarget ? volWeight(series, signal) : (direction === 0 ? 0 : 1);
    const grossPx = series.open[exit] / series.open[entry] - 1;
    signs.push(direction);
    if (!direction || !(weight > 0) || !Number.isFinite(grossPx)) {
      months.push({ date, ret: 0 });
      grossMonths.push({ date, ret: 0 });
      execMonths.push({ date, ret: 0 });
      tradeMonths.push(0);
      continue;
    }
    const sideName = direction > 0 ? 'buy' : 'sell';
    const held = exit - entry;
    const execution = estimateRoundTripCostPct({
      market: spec.market, symbol: spec.symbol, side: sideName, holdDays: 0,
    }) / 100;
    const withBorrow = estimateRoundTripCostPct({
      market: spec.market, symbol: spec.symbol, side: sideName, holdDays: held,
    }) / 100;
    const borrow = Math.max(0, withBorrow - execution);
    const previous = edge > 0 ? trendSignal(series, ends[edge - 1], variant) : 0;
    const opening = previous !== direction;
    const monthNet = direction * grossPx - (opening ? execution : 0) - borrow - (spec.futures ? ROLL : 0);
    months.push({ date, ret: (spec.volTarget ? weight : 1) * monthNet });
    grossMonths.push({ date, ret: (spec.volTarget ? weight : 1) * direction * grossPx });
    const notional = notionalFor(spec.symbol, spec.market, series.open[entry], 1, spec.volTarget ? weight : 1);
    execMonths.push({ date, ret: monthNet * (notional / TICKET) });
    tradeMonths.push(monthNet);
  }
  const roundTrips = [];
  let open = null;
  for (let index = 0; index < signs.length; index += 1) {
    const direction = signs[index];
    if (open && direction !== open.side) {
      roundTrips.push({ date: months[index].date, ret: open.compound - 1 });
      open = null;
    }
    if (!direction) continue;
    if (!open) open = { side: direction, compound: 1 };
    open.compound *= 1 + tradeMonths[index];
  }
  if (open) roundTrips.push({ date: months.at(-1).date, ret: open.compound - 1 });
  return { signs, months, grossMonths, execMonths, tradeMonths, trades: roundTrips };
}

function pushCell(cells, base, book, benchmark, folds, tSource) {
  if (!folds.length || book.months.length < 30) {
    return;
  }
  const scored = scoreCell({
    monthly: book.months,
    grossMonthly: book.grossMonths,
    trades: book.trades,
    benchmarkMonthly: benchmark,
    folds,
    tSource,
  });
  const executable = scoreCell({
    monthly: book.execMonths,
    grossMonthly: book.execMonths,
    trades: book.trades,
    benchmarkMonthly: benchmark,
    folds,
    tSource,
  });
  cells.push({
    ...base,
    ...scored,
    executable: {
      returnPct: executable.full.returnPct,
      maxDrawdownPct: executable.full.maxDrawdownPct,
      trades: executable.full.trades,
      windows: executable.windows,
    },
  });
}

function benchmarkMonths(series, months) {
  const ends = monthEnds(series);
  const byDate = new Map();
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const entry = ends[edge] + 1;
    const exit = ends[edge + 1] + 1;
    if (exit >= series.open.length) continue;
    const date = series.dates[ends[edge + 1]];
    byDate.set(date, series.open[exit] / series.open[entry] - 1);
  }
  return months.map(row => ({ date: row.date, ret: byDate.has(row.date) ? byDate.get(row.date) : 0 }));
}

function averageBooks(books) {
  const months = new Map();
  for (const book of books) {
    book.months.forEach((row, index) => {
      const key = row.date.slice(0, 7);
      if (!months.has(key)) months.set(key, { date: row.date, research: [], gross: [], exec: [] });
      const slot = months.get(key);
      slot.research.push(row.ret);
      slot.gross.push(book.grossMonths[index]?.ret || 0);
      slot.exec.push(book.execMonths[index]?.ret || 0);
      if (row.date > slot.date) slot.date = row.date;
    });
  }
  const rows = [...months.values()].sort((a, b) => a.date.localeCompare(b.date));
  const avg = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  return {
    months: rows.map(row => ({ date: row.date, ret: avg(row.research) })),
    grossMonths: rows.map(row => ({ date: row.date, ret: avg(row.gross) })),
    execMonths: rows.map(row => ({ date: row.date, ret: avg(row.exec) })),
    trades: books.flatMap(book => book.trades || []),
  };
}

async function main() {
  const gaps = [];
  const cells = [];
  const familySharpes = new Map();
  function addGap(family, market, reason) {
    gaps.push({ family, market, reason });
    console.log(`[DATA_GAP] ${family} ${market}: ${reason}`);
  }
  function keep(family, cell) {
    cells.push(cell);
    if (!familySharpes.has(family)) familySharpes.set(family, []);
    if (Number.isFinite(cell.full.sharpe)) {
      familySharpes.get(family).push({ sharpe: cell.full.sharpe, id: `${cell.market}|${cell.variant}|${cell.side}`, returns: cell.monthlyReturns });
    }
    console.log(`[${cell.verdict}] ${family} ${cell.market} ${cell.variant} ${cell.side} ${cell.full.returnPct}%`);
  }

  let carriedDeflated = null;
  const prior = readJson(PRIOR_JSON);
  carriedDeflated = { F1: prior.deflated.F1, F2: prior.deflated.F2, F7: prior.deflated.F7 };
  for (const cell of prior.cells) {
    if (cell.family === 'F1' || cell.family === 'F7') cells.push(cell);
  }
  for (const gap of prior.gaps) {
    if (gap.family === 'F1' || gap.family === 'F2' || gap.family === 'F7') gaps.push(gap);
  }
  console.log('[carry] F1 and F7 cells copied; F2 left as the original gap');
  const RERUN_TREND = false;
  if (RERUN_TREND) {
  const qqq = await ensureSeries('QQQ');
  const ftse = await ensureSeries('^FTSE', '_FTSE');
  const indexes = [
    ['SPY', 'S&P 500', 'US', false, loadSeries('SPY')],
    ['QQQ', 'Nasdaq', 'US', false, qqq],
    ['^N225', 'Nikkei', 'JP', false, loadSeries('^N225')],
    ['^HSI', 'Hang Seng', 'HK', false, loadSeries('^HSI')],
    ['^GDAXI', 'DAX', 'EU', false, loadSeries('^GDAXI')],
    ['^FCHI', 'CAC', 'EU', false, loadSeries('^FCHI')],
    ['^FTSE', 'FTSE', ftse ? 'UK' : 'UK', false, ftse || loadSeries('EWU')],
  ];
  if (!qqq) addGap('F1', 'Nasdaq', 'QQQ daily history was not in the cache and the Yahoo download failed. SPY was not used as a substitute.');
  if (!ftse) addGap('F1', 'FTSE', '^\FTSE daily history was not downloaded. EWU is the pre-registered proxy.');
  const commodities = ['GC=F', 'SI=F', 'CL=F', 'HG=F', 'PL=F', 'PA=F', 'NG=F'].map(symbol => ({
    symbol, label: symbol, market: 'COMMODITIES', futures: true, series: loadSeries(symbol),
  }));
  for (const row of commodities) {
    if (!row.series?.dates.length) addGap('F1', row.symbol, 'No cached continuous series for this micro contract.');
  }

  const variants = ['ts_3m', 'ts_6m', 'ts_12m', 'ts_12_1', 'ts_blend', 'ts_vote'];
  function scoreTrendFamily(family, rows, volTarget, cellName) {
    for (const row of rows) {
      if (!(row.series?.dates.length > 400)) {
        addGap(family, row.label, `Daily history is too short for four windows (${row.series?.dates.length || 0} bars).`);
      }
    }
    const ready = rows.filter(row => row.series?.dates.length > 400);
    const perVariant = new Map();
    for (const variant of variants) {
      const books = [];
      for (const row of ready) {
        const folds = foldsFor(row.series.dates, 'medium');
        if (folds.length !== 4) {
          addGap(family, row.label, `Fewer than four test windows (${row.series.dates.length} bars).`);
          continue;
        }
        const simulated = simulateTrend(row.series, variant, {
          volTarget, market: row.market, symbol: row.symbol, futures: row.futures,
        });
        const bench = benchmarkMonths(row.series, simulated.months);
        for (const side of ['long', 'short', 'combined']) {
          const book = filterSide(simulated, side);
          const benchSide = side === 'short'
            ? bench.map(item => ({ date: item.date, ret: -item.ret }))
            : bench;
          const scored = scoreCell({
            monthly: book.months,
            grossMonthly: book.grossMonths,
            trades: book.trades,
            benchmarkMonthly: benchSide,
            folds,
            tSource: 'month',
          });
          const executable = scoreCell({
            monthly: book.execMonths, grossMonthly: book.execMonths, trades: book.trades,
            benchmarkMonthly: benchSide, folds, tSource: 'month',
          });
          keep(family, {
            family, variant, market: row.label, horizon: 'medium', side,
            cell: cellName(row, side),
            benchmark: side === 'short' ? `short ${row.label}` : row.label,
            ...scored,
            executable: {
              returnPct: executable.full.returnPct,
              maxDrawdownPct: executable.full.maxDrawdownPct,
              windows: executable.windows,
            },
          });
        }
        books.push(simulated);
      }
      perVariant.set(variant, { books, ready });
    }
    for (const variant of variants) {
      const pack = perVariant.get(variant);
      if (!pack || pack.books.length < 2) continue;
      const combined = averageBooks(pack.books.map(book => ({
        months: book.months, grossMonths: book.grossMonths, execMonths: book.execMonths, trades: book.trades,
      })));
      const bench = averageBooks(pack.ready.map(row => {
        const simulated = simulateTrend(row.series, variant, {
          volTarget: false, market: row.market, symbol: row.symbol, futures: false,
        });
        const price = benchmarkMonths(row.series, simulated.months);
        return { months: price, grossMonths: price, execMonths: price, trades: [] };
      }));
      const folds = foldsFor(pack.ready[0].series.dates, 'medium');
      for (const side of ['long', 'short', 'combined']) {
        const signed = pack.books.map(book => filterSide(book, side));
        const book = averageBooks(signed);
        const benchSide = side === 'short'
          ? bench.months.map(row => ({ date: row.date, ret: -row.ret }))
          : bench.months;
        const scored = scoreCell({
          monthly: book.months, grossMonthly: book.grossMonths, trades: book.trades,
          benchmarkMonthly: benchSide, folds, tSource: 'month',
        });
        const executable = scoreCell({
          monthly: book.execMonths, grossMonthly: book.execMonths, trades: book.trades,
          benchmarkMonthly: benchSide, folds, tSource: 'month',
        });
        keep(family, {
          family, variant, market: family === 'F1' && rows[0].futures ? 'Commodities book' : (family === 'F7' ? 'Crypto pair' : 'Index book'),
          horizon: 'medium', side,
          cell: family === 'F7' ? 'Crypto signals-only book' : (rows[0].futures ? 'Commodities short — empty' : 'Index futures book — not an equity cell'),
          benchmark: side === 'short' ? 'short the equal-weight composite' : 'equal-weight composite',
          ...scored,
          executable: {
            returnPct: executable.full.returnPct,
            maxDrawdownPct: executable.full.maxDrawdownPct,
            windows: executable.windows,
          },
        });
      }
    }
  }

  const indexRows = indexes.filter(row => row[4]?.dates?.length).map(row => ({
    symbol: row[0] === '^FTSE' && !ftse ? 'EWU' : row[0],
    label: row[1] + (row[0] === '^FTSE' && !ftse ? ' (EWU proxy)' : ''),
    market: row[2], futures: false, series: row[4],
  }));
  scoreTrendFamily('F1', indexRows, true, (row, side) => (
    side === 'short' ? `${row.label} short — index futures, not an equity cell` : `${row.label} long — index futures, not an equity cell`
  ));
  scoreTrendFamily('F1', commodities.filter(row => row.series), true, (row, side) => (
    side === 'short' ? 'Commodities short — empty' : 'Commodities long — occupied by COMMODITIES_LONG_ENGINE'
  ));

  const btc = loadSeries('BTC-USD');
  const eth = loadSeries('ETH-USD');
  if (!btc) addGap('F7', 'BTC-USD', 'No cached daily series.');
  if (!eth) addGap('F7', 'ETH-USD', 'No cached daily series.');
  scoreTrendFamily('F7', [
    btc && { symbol: 'BTC-USD', label: 'BTC-USD', market: 'CRYPTO', futures: false, series: btc },
    eth && { symbol: 'ETH-USD', label: 'ETH-USD', market: 'CRYPTO', futures: false, series: eth },
  ].filter(Boolean), false, () => 'Crypto — signals only, not an equity cell');

  const curveNames = PRICE_DIRS.flatMap(dir => fs.readdirSync(dir))
    .filter(name => /^[A-Z]+[FGHJKMNQUVX]\d{2}/.test(name));
  let curveNote = curveNames.length
    ? `Cache has ${curveNames.length} contract-month files.`
    : 'No front-versus-next contract files are in the price cache.';
  if (FMP_KEY) {
    try {
      const response = await httpGet(`https://financialmodelingprep.com/stable/commodities-list?apikey=${encodeURIComponent(FMP_KEY)}`);
      const body = response.status === 200 ? JSON.parse(response.raw) : null;
      const symbols = Array.isArray(body) ? body.map(row => row.symbol || row.name || '').slice(0, 8) : [];
      const paired = symbols.some(symbol => /front|next|F1|F2/i.test(symbol));
      curveNote += paired
        ? ' The commodity list names a front and next contract.'
        : ' One commodity-list request returned generic symbols, not a dated front and next history.';
      if (!paired) addGap('F2', 'Commodities', `${curveNote} Carry was not run and was not replaced with the continuous contracts.`);
    } catch (error) {
      addGap('F2', 'Commodities', `${curveNote} The curve request failed (${error.message}). Carry was not run.`);
    }
  } else {
    addGap('F2', 'Commodities', `${curveNote} No FMP key was available for a curve request. Carry was not run.`);
  }
  }

  await ensureSeries('QQQ');
  await runEarnings(cells, gaps, keep, addGap);
  await runResidual(cells, gaps, keep, addGap);
  await runJunk(cells, gaps, keep, addGap);
  await runReversal(cells, gaps, keep, addGap);

  const families = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'];
  const deflated = {};
  for (const family of families) {
    if (carriedDeflated && ['F1', 'F2', 'F7'].includes(family)) {
      deflated[family] = carriedDeflated[family];
      continue;
    }
    const trials = familySharpes.get(family) || [];
    if (!trials.length) {
      deflated[family] = { nTrials: 0, probability: null, annualized: null, best: null };
      continue;
    }
    const best = trials.reduce((winner, row) => (row.sharpe > winner.sharpe ? row : winner));
    deflated[family] = { ...deflatedSharpe(trials, best.returns), best: best.id };
  }
  const excessTrials = cells.filter(cell => cell.family === 'F4' && Number.isFinite(cell.excess?.sharpe));
  if (excessTrials.length >= 2) {
    const bestExcess = excessTrials.reduce((winner, row) => (row.excess.sharpe > winner.excess.sharpe ? row : winner));
    deflated.F4Excess = {
      ...deflatedSharpe(excessTrials.map(row => ({ sharpe: row.excess.sharpe })), bestExcess.excess.returns),
      best: `US|${bestExcess.variant}|long`,
    };
  }
  for (const cell of cells) {
    delete cell.monthlyReturns;
    if (cell.excess) delete cell.excess.returns;
  }
  const universe = [
    ['US', path.join(FMP_DIR, 'us-universe.json')],
    ['UK', path.join(MEMBER_DIR, 'ftse100.json')],
    ['France', path.join(MEMBER_DIR, 'cac40.json')],
  ].map(([market, file]) => {
    const snapshot = readJson(file);
    return { market, candidates: everMembers(snapshot)?.size || 0, years: membershipYears(snapshot) };
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    preregistration: 'b173577d0bfa8f377b5bf488bb320df5426a2eeb',
    amendment: '81166879dff1fa29574760c946c783a677368185',
    cells, gaps, deflated, universe, earlyExits, timing: timingNote,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload));
  fs.writeFileSync(OUT_MD, render(payload));
  console.log(`wrote ${cells.length} cells, ${gaps.length} gaps`);
}

function render(payload) {
  const lines = [];
  lines.push('# Strategy gaps amendment results', '');
  lines.push('Research only. Nothing in this file is enabled. The bridge was not changed.', '');
  lines.push(`Pre-registration: \`b173577d0bfa8f377b5bf488bb320df5426a2eeb\` (\`docs/strategy-gaps-preregistration-2026-10-06.md\`).`, '');
  lines.push('Amendment: `81166879dff1fa29574760c946c783a677368185` (`docs/strategy-gaps-amendment-2026-10-06.md`). F1 and F7 are copied from the pre-registered run and were not recomputed. The pass rule is unchanged.', '');
  lines.push(`Run: ${payload.generatedAt}.`, '');
  lines.push('## Verdicts', '');
  lines.push('| Family | Market | Horizon | Side | Variant | Verdict | Full return | Benchmark | Max DD | t | Trades | Beats QQQ | Cell |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const cell of payload.cells) {
    const beats = cell.qqq ? (cell.qqq.beatsQqq ? 'yes' : 'no') : '—';
    lines.push(`| ${cell.family} | ${cell.market} | ${cell.horizon} | ${cell.side} | ${cell.variant} | ${cell.verdict} | ${num(cell.full.returnPct)}% | ${num(cell.full.benchmarkReturnPct)}% | ${num(cell.full.maxDrawdownPct)}% | ${cell.full.tStat ?? '—'} | ${cell.full.trades} | ${beats} | ${cell.cell} |`);
  }
  lines.push('', '## Data gaps', '');
  if (!payload.gaps.length) lines.push('None.', '');
  for (const gap of payload.gaps) lines.push(`- **${gap.family} ${gap.market}.** ${gap.reason}`);
  lines.push('', '## Deflated Sharpe of the best variant', '');
  lines.push('N is every market × side × variant cell with a finite monthly Sharpe. This is not a pass gate.', '');
  lines.push('| Family | Best cell | Trials | Annualized Sharpe | Deflated Sharpe probability |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const [family, row] of Object.entries(payload.deflated)) {
    lines.push(`| ${family} | ${row.best || '—'} | ${row.nTrials} | ${row.annualized == null ? '—' : row.annualized.toFixed(2)} | ${row.probability == null ? '—' : `${(row.probability * 100).toFixed(1)}%`} |`);
  }
  const promoted = payload.cells.filter(cell => cell.verdict === 'PASS' || cell.verdict === 'CANDIDATE');
  lines.push('', '## Executable re-run', '');
  lines.push('$30,000 per position, real lot sizes, at most 50 names. This does not change the verdict above.', '');
  if (!promoted.length) lines.push('No variant was a PASS or a CANDIDATE, so there is no executable book to size.', '');
  else {
    lines.push('| Family | Market | Variant | Side | Verdict | Research return | Executable return | Executable max DD |');
    lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: |');
    for (const cell of promoted) {
      lines.push(`| ${cell.family} | ${cell.market} | ${cell.variant} | ${cell.side} | ${cell.verdict} | ${num(cell.full.returnPct)}% | ${num(cell.executable?.returnPct)}% | ${num(cell.executable?.maxDrawdownPct)}% |`);
    }
  }
  for (const family of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']) {
    lines.push('', `## ${family}`, '');
    const rows = payload.cells.filter(cell => cell.family === family);
    if (!rows.length) {
      lines.push('No cell was scored. See the data gaps.', '');
      continue;
    }
    for (const cell of rows) {
      lines.push(`### ${cell.market} · ${cell.horizon} · ${cell.side} · ${cell.variant}`, '');
      lines.push(`${cell.verdict}. Benchmark ${cell.benchmark}: ${num(cell.full.benchmarkReturnPct)}%. Cost drag ${num(cell.full.costDragPp)} percentage points. Cell: ${cell.cell}.`, '');
      lines.push('| Window | From | To | Trades | Win % | PF | Return | Max DD |');
      lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
      for (const window of cell.windows) {
        lines.push(`| ${window.fold} | ${window.from} | ${window.to} | ${window.trades} | ${window.win ?? '—'} | ${window.pfInfinite ? 'inf' : (window.pf ?? '—')} | ${num(window.returnPct)}% | ${num(window.maxDrawdownPct)}% |`);
      }
      lines.push('');
    }
  }
  lines.push('## Universe by year', '');
  lines.push('Membership is the point-in-time set on 31 December. Missing means a member with no price file. Candidates are every symbol that was a member on any replayed date.', '');
  for (const market of payload.universe || []) {
    lines.push(`### ${market.market}`, '');
    lines.push(`Ever members: ${market.candidates}.`, '');
    lines.push('| Year | Members | With prices | Missing |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const row of market.years) {
      lines.push(`| ${row.year} | ${row.members} | ${row.priced} | ${row.missing} |`);
    }
    lines.push('');
  }
  lines.push('## Early exits', '');
  lines.push('A name that stopped trading during a hold was closed at its last close and kept. A name with no bar on the entry date was not counted.', '');
  lines.push(`F3 ${payload.earlyExits?.F3 ?? 0}. F4 ${payload.earlyExits?.F4 ?? 0}. F5 ${payload.earlyExits?.F5 ?? 0}. F6 ${payload.earlyExits?.F6 ?? 0}.`, '');
  lines.push('## F3 announcement timing', '');
  lines.push(payload.timing || 'Not recorded.', '');
  lines.push('## F4 excess return', '');
  lines.push('Verdicts above stay on the raw monthly return versus SPY. Excess is book minus SPY in the same month. The excess deflated Sharpe uses the same six variants.', '');
  lines.push('| Variant | Raw t | Excess t | Excess Sharpe |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const cell of payload.cells.filter(row => row.family === 'F4')) {
    lines.push(`| ${cell.variant} | ${cell.full.tStat ?? '—'} | ${cell.excess?.tStat ?? '—'} | ${cell.excess?.sharpe == null ? '—' : cell.excess.sharpe.toFixed(2)} |`);
  }
  const excess = payload.deflated?.F4Excess;
  lines.push('', `Excess deflated Sharpe: best ${excess?.best || '—'}, trials ${excess?.nTrials ?? '—'}, annualized ${excess?.annualized == null ? '—' : excess.annualized.toFixed(2)}, probability ${excess?.probability == null ? '—' : `${(excess.probability * 100).toFixed(1)}%`}.`, '');
  lines.push('## F4 executable k=1 and k=2', '');
  lines.push('Top k names, $30,000 each. Medium holds one month. Long holds six overlapping sleeves. These rows are not extra trials.', '');
  lines.push('| Variant | k | Slots | Verdict | Full return | Benchmark | Max DD | t | Beats QQQ |');
  lines.push('| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |');
  for (const cell of payload.cells.filter(row => row.family === 'F4')) {
    const slots = cell.horizon === 'long' ? [6, 12] : [1, 2];
    for (const [key, k, slot] of [['k1', 1, slots[0]], ['k2', 2, slots[1]]]) {
      const book = cell[key];
      if (!book) continue;
      lines.push(`| ${cell.variant} | ${k} | ${slot} | ${book.verdict} | ${num(book.full.returnPct)}% | ${num(book.full.benchmarkReturnPct)}% | ${num(book.full.maxDrawdownPct)}% | ${book.full.tStat ?? '—'} | ${book.qqq ? (book.qqq.beatsQqq ? 'yes' : 'no') : '—'} |`);
    }
  }
  lines.push('', '## QQQ hurdle', '');
  lines.push('US long books only. The verdict column above is still versus SPY. Alpha is 12 times the monthly intercept from a regression on SPY and QQQ together. Window figures are book return minus QQQ return, in percentage points.', '');
  lines.push('| Book | QQQ full | W1 | W2 | W3 | W4 | QQQ max DD | Sharpe | QQQ Sharpe | Alpha % | Alpha t | Beta SPY | Beta QQQ | Beats QQQ |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  const hurdleRows = [];
  for (const cell of payload.cells) {
    if (cell.qqq) hurdleRows.push([`${cell.family} ${cell.variant} ${cell.side}`, cell.qqq]);
    if (cell.k1?.qqq) hurdleRows.push([`${cell.family} ${cell.variant} k=1`, cell.k1.qqq]);
    if (cell.k2?.qqq) hurdleRows.push([`${cell.family} ${cell.variant} k=2`, cell.k2.qqq]);
  }
  for (const [label, row] of hurdleRows) {
    const windows = row.windows || [];
    const excessAt = index => (windows[index] ? num(windows[index].excessPp) : '—');
    lines.push(`| ${label} | ${num(row.qqqReturnPct)}% | ${excessAt(0)} | ${excessAt(1)} | ${excessAt(2)} | ${excessAt(3)} | ${num(row.qqqMaxDrawdownPct)}% | ${row.bookSharpe ?? '—'} | ${row.qqqSharpe ?? '—'} | ${num(row.alphaAnnualPct)} | ${row.alphaT ?? '—'} | ${row.betaSpy ?? '—'} | ${row.betaQqq ?? '—'} | ${row.beatsQqq ? 'yes' : 'no'} |`);
  }
  lines.push('', 'Book full-sample return and book max drawdown are in the verdict table and the k=1 / k=2 table.', '');
  lines.push('## What was not substituted', '');
  lines.push('Japan, India, Hong Kong, and Germany have no dated membership file in this study, so those markets were not filled with a current constituent list. Commodity carry was not filled with the continuous micro contracts. A market return was not used as an industry return. Industry and sector labels used by F4 and F6 are current FMP profile fields, marked CURRENT_INDUSTRY_LABELS. They are not point-in-time. GBPUSD and EURUSD caches begin in 2016, so Altman Z before the first FX bar is missing and is not filled with a later rate.', '');
  return lines.join('\n');
}
function num(value) {
  return value == null || Number.isNaN(value) ? '—' : value;
}

async function runEarnings(cells, gaps, keep, addGap) {
  addGap('F3', 'Japan', 'No dated Nikkei membership file. The current Nikkei list was not used.');
  addGap('F3', 'India', 'No dated India membership file and no India earnings cache. India long-only was not run.');
  addGap('F3', 'UK', 'FTSE membership is dated, but there is no FMP report-date file for the London symbols. US ADR dates were not used.');
  addGap('F3', 'France', 'CAC membership is dated, but there is no FMP report-date file for the Euronext symbols.');
  const us = readJson(path.join(FMP_DIR, 'us-universe.json'));
  const spy = loadSeries('SPY');
  if (!spy) {
    addGap('F3', 'US', 'SPY daily history is missing, so the abnormal return has no index.');
    return;
  }
  const candidates = everMembers(us);
  if (!candidates) {
    addGap('F3', 'US', 'US membership changes are not dated, so the earnings book was not run on the current list.');
    return;
  }
  timingNote = await earningsTimingCoverage();
  console.log(`[F3] ${timingNote}`);
  const events = [];
  let used = 0;
  for (const symbol of candidates) {
    if (/\.[A-Z]+$/.test(symbol)) continue;
    const file = path.join(EARNINGS_DIR, `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const series = loadSeries(symbol);
    if (!series) continue;
    const dates = readJson(file).filter(value => typeof value === 'string');
    for (const report of dates) {
      if (report < '2010-01-01') continue;
      const members = membershipAt(us, report);
      if (!members || !members.has(symbol)) continue;
      const d0 = firstOnOrAfter(series, report);
      if (d0 < 1 || d0 + 1 >= series.close.length) continue;
      const before = series.dates[d0 - 1];
      const after = series.dates[d0 + 1];
      const signal = series.dates[d0];
      const spyBefore = indexOf(spy, before);
      const spyAfter = indexOf(spy, after);
      const spyAt = indexOf(spy, signal);
      if (spy.dates[spyBefore] !== before || spy.dates[spyAfter] !== after || spy.dates[spyAt] !== signal) continue;
      const stock = series.close[d0 + 1] / series.close[d0 - 1] - 1;
      const index = spy.close[spyAfter] / spy.close[spyBefore] - 1;
      if (!Number.isFinite(stock - index)) continue;
      events.push({ symbol, series, date: signal, abnormal: stock - index, d0, spyAt });
    }
    used += 1;
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  const selected = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.spyAt < 63) continue;
    const start = spy.dates[event.spyAt - 63];
    const sample = [];
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const row = events[prior];
      if (row.date < start) break;
      if (row.date.slice(0, 7) >= event.date.slice(0, 7)) continue;
      sample.push(row);
    }
    if (sample.length < 10) continue;
    const ranked = [...sample].sort((a, b) => b.abnormal - a.abnormal);
    const width = Math.floor(sample.length / 10);
    if (width < 1) continue;
    const top = ranked[width - 1].abnormal;
    const bottom = ranked[ranked.length - width].abnormal;
    let side = null;
    if (event.abnormal >= top) side = 'buy';
    else if (event.abnormal <= bottom) side = 'sell';
    if (!side) continue;
    selected.push({ ...event, side });
  }
  console.log(`[F3] ever-members with earnings and prices: ${used}, events ${events.length}, selected ${selected.length}`);
  if (!selected.length) {
    addGap('F3', 'US', 'No point-in-time earnings events survived membership, price, and prior-window checks.');
    return;
  }
  const folds = foldsFor(spy.dates, 'medium');
  for (const hold of [21, 42, 63]) {
    const trades = [];
    for (const row of selected) {
      const entry = row.d0 + 2;
      const planned = entry + hold - 1;
      const exited = clipExit(row.series, entry, planned, 'F3', spy.dates[spy.dates.length - 1]);
      if (!exited) continue;
      const sessions = exited.exit - entry + 1;
      const gross = (row.side === 'sell' ? -1 : 1) * (exited.exitPx / row.series.open[entry] - 1);
      const priced = netOf(gross, { market: 'US', symbol: row.symbol, side: row.side, holdDays: sessions });
      if (!priced) continue;
      trades.push({
        symbol: row.symbol, side: row.side, date: row.series.dates[exited.exit],
        entryDate: row.series.dates[entry], ret: priced.net, gross,
        entry, exit: exited.exit, series: row.series, entryPx: row.series.open[entry], exitPx: exited.exitPx,
        cost: priced.costPct / 100,
      });
    }
    const daily = dailyBook(trades, spy);
    const monthly = toMonths(daily);
    const grossDaily = dailyBook(trades.map(row => ({ ...row, cost: 0, ret: row.gross })), spy);
    const benchDaily = spy.dates.map((date, index) => ({
      date,
      ret: index === 0 ? 0 : spy.close[index] / spy.close[index - 1] - 1,
    }));
    const bench = alignMonths(toMonths(benchDaily), monthly);
    const book = {
      months: monthly,
      grossMonths: alignMonths(toMonths(grossDaily), monthly),
      execMonths: executableDaily(trades, spy, 'US'),
      trades,
    };
    for (const side of ['long', 'short']) {
      const sideTrades = trades.filter(row => (side === 'long' ? row.side === 'buy' : row.side === 'sell'));
      const sideDaily = dailyBook(sideTrades, spy);
      const sideMonths = toMonths(sideDaily);
      const benchSide = side === 'short'
        ? bench.map(row => ({ date: row.date, ret: -row.ret }))
        : alignMonths(toMonths(benchDaily), sideMonths);
      const usedFolds = hold === 21 ? folds : foldsFor(spy.dates, 'long');
      const scored = scoreCell({
        monthly: sideMonths,
        grossMonthly: alignMonths(toMonths(dailyBook(sideTrades.map(row => ({ ...row, cost: 0 })), spy)), sideMonths),
        trades: sideTrades,
        benchmarkMonthly: benchSide,
        daily: sideDaily,
        folds: usedFolds,
        tSource: 'trade',
      });
      const executable = scoreCell({
        monthly: executableDaily(sideTrades, spy, 'US'),
        grossMonthly: executableDaily(sideTrades, spy, 'US'),
        trades: sideTrades,
        benchmarkMonthly: benchSide,
        folds: usedFolds,
        tSource: 'trade',
      });
      keep('F3', {
        family: 'F3', variant: `hold_${hold}`, market: 'US',
        horizon: hold === 21 ? 'medium' : 'long', side,
        cell: side === 'long' ? 'US medium — empty' : 'US short — occupied by US_SHORT_MR; sell candidate beside it',
        benchmark: side === 'short' ? 'short SPY' : 'SPY',
        ...scored,
        qqq: side === 'long' ? qqqHurdle(sideMonths, sideDaily, usedFolds) : null,
        executable: {
          returnPct: executable.full.returnPct,
          maxDrawdownPct: executable.full.maxDrawdownPct,
          windows: executable.windows,
        },
      });
    }
  }
}

async function earningsTimingCoverage() {
  const files = fs.readdirSync(EARNINGS_DIR).filter(name => name.endsWith('.json'));
  let rows = 0;
  let timed = 0;
  for (const file of files) {
    const body = readJson(path.join(EARNINGS_DIR, file));
    const list = Array.isArray(body) ? body : [];
    for (const row of list) {
      rows += 1;
      if (row && typeof row === 'object' && (row.time || row.when || row.bmo || row.amc)) timed += 1;
    }
  }
  let endpoint = 'FMP earnings endpoint was not requested.';
  if (FMP_KEY) {
    try {
      const response = await httpGet(`https://financialmodelingprep.com/stable/earnings?symbol=AAPL&apikey=${encodeURIComponent(FMP_KEY)}`);
      if (response.status !== 200) endpoint = `stable/earnings returned HTTP ${response.status}.`;
      else {
        const body = JSON.parse(response.raw);
        const list = Array.isArray(body) ? body : [];
        const keys = list[0] && typeof list[0] === 'object' ? Object.keys(list[0]) : [];
        const timeKeys = keys.filter(key => /time|when|bmo|amc|hour/i.test(key));
        const withTime = list.filter(row => timeKeys.some(key => row[key] != null && String(row[key]).length > 0)).length;
        endpoint = `stable/earnings AAPL rows ${list.length}; time fields: ${timeKeys.join(', ') || 'none'}; rows with a time value: ${withTime}.`;
      }
    } catch (_) {
      endpoint = 'stable/earnings request failed.';
    }
  }
  return `Cached earnings rows ${rows}, rows with a before-open or after-close field ${timed}. ${endpoint} Entry stays at the open of d0+2.`;
}

function dailyBook(trades, calendar) {
  const byDate = new Map();
  for (const trade of trades) {
    for (let index = trade.entry; index <= trade.exit; index += 1) {
      const date = trade.series.dates[index];
      let day;
      if (index === trade.entry && index === trade.exit) day = trade.exitPx / trade.entryPx - 1;
      else if (index === trade.entry) day = trade.series.close[index] / trade.entryPx - 1;
      else if (index === trade.exit) day = trade.exitPx / trade.series.close[index - 1] - 1;
      else day = trade.series.close[index] / trade.series.close[index - 1] - 1;
      if (trade.side === 'sell') day = -day;
      if (index === trade.exit) day -= trade.cost || 0;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(day);
    }
  }
  return calendar.dates.filter(date => date >= '2010-01-01').map(date => {
    const values = byDate.get(date) || [];
    return { date, ret: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 };
  });
}
function toMonths(daily) {
  const months = [];
  let bucket = [];
  let stamp = null;
  for (const row of daily) {
    if (stamp && row.date.slice(0, 7) !== stamp.slice(0, 7)) {
      months.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
      bucket = [];
    }
    bucket.push(row.ret);
    stamp = row.date;
  }
  if (bucket.length) months.push({ date: stamp, ret: bucket.reduce((equity, value) => equity * (1 + value), 1) - 1 });
  return months;
}
function alignMonths(source, target) {
  const byDate = new Map(source.map(row => [row.date.slice(0, 7), row.ret]));
  return target.map(row => ({ date: row.date, ret: byDate.get(row.date.slice(0, 7)) || 0 }));
}
function executableDaily(trades, calendar, market) {
  const capped = [];
  const open = [];
  const events = [];
  for (const trade of trades) {
    events.push({ date: trade.series.dates[trade.entry], kind: 'in', trade });
    events.push({ date: trade.series.dates[trade.exit], kind: 'out', trade });
  }
  const byDate = new Map();
  for (const trade of trades) {
    const notion = notionalFor(trade.symbol, market, trade.entryPx, 1, 1);
    const scale = notion / TICKET;
    for (let index = trade.entry; index <= trade.exit; index += 1) {
      const date = trade.series.dates[index];
      let day;
      if (index === trade.entry) day = trade.series.close[index] / trade.entryPx - 1;
      else day = trade.series.close[index] / trade.series.close[index - 1] - 1;
      if (index === trade.exit) day = trade.exitPx / (index === trade.entry ? trade.entryPx : trade.series.close[index - 1]) - 1;
      if (trade.side === 'sell') day = -day;
      if (index === trade.exit) day -= trade.cost || 0;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ symbol: trade.symbol, day: day * scale, strength: Math.abs(trade.ret) });
    }
  }
  return toMonths(calendar.dates.filter(date => date >= '2010-01-01').map(date => {
    const rows = byDate.get(date) || [];
    const best = new Map();
    for (const row of rows) {
      const prior = best.get(row.symbol);
      if (!prior || row.strength > prior.strength) best.set(row.symbol, row);
    }
    const chosen = [...best.values()].sort((a, b) => b.strength - a.strength).slice(0, 50);
    return { date, ret: chosen.length ? chosen.reduce((sum, row) => sum + row.day, 0) / chosen.length : 0 };
  }));
}

async function loadProfiles(symbols) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const out = new Map();
  const missing = [];
  for (const symbol of symbols) {
    const file = path.join(PROFILE_DIR, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json`);
    if (fs.existsSync(file)) {
      out.set(symbol, readJson(file));
      continue;
    }
    missing.push(symbol);
  }
  if (!missing.length || !FMP_KEY) return { profiles: out, missing: missing.length, fetched: 0 };
  let fetched = 0;
  for (const symbol of missing) {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(FMP_KEY)}`;
    let body = null;
    let responseStatus = 0;
    try {
      const response = await httpGet(url);
      responseStatus = response.status;
      if (response.status === 200) body = JSON.parse(response.raw);
    } catch (_) { body = null; }
    const row = Array.isArray(body) ? body[0] : null;
    const record = {
      sector: row?.sector || null,
      industry: row?.industry || null,
    };
    const file = path.join(PROFILE_DIR, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(record));
    out.set(symbol, record);
    fetched += 1;
    if (responseStatus === 401 || responseStatus === 403) break;
    if (fetched % 50 === 0) console.log(`[profiles] ${fetched}/${missing.length}`);
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return { profiles: out, missing: missing.length, fetched };
}

async function runResidual(cells, gaps, keep, addGap) {
  const us = readJson(path.join(FMP_DIR, 'us-universe.json'));
  const spy = loadSeries('SPY');
  if (!spy) {
    addGap('F4', 'US', 'SPY is missing.');
    return;
  }
  const universe = everMembers(us);
  if (!universe) {
    addGap('F4', 'US', 'US membership changes are not dated, so residual and industry momentum were not run on the current list.');
    return;
  }
  const symbols = [...universe].filter(symbol => loadSeries(symbol));
  console.log(`[F4] loading profiles for ${symbols.length} US names`);
  const { profiles, fetched, missing } = await loadProfiles(symbols);
  const labelled = symbols.filter(symbol => profiles.get(symbol)?.sector && profiles.get(symbol)?.industry);
  if (labelled.length < 30) {
    addGap('F4', 'US', `Sector and industry labels are missing (${labelled.length} labelled, ${missing} uncached, ${fetched} fetched). Residual and industry momentum were not replaced with a market residual.`);
    addGap('F6', 'UK', 'Industry labels were not available, so the industry residual was not replaced with a market residual.');
    addGap('F6', 'France', 'Industry labels were not available, so the industry residual was not replaced with a market residual.');
    return;
  }
  console.log(`[F4] labelled ${labelled.length}`);
  const books = new Map(labelled.map(symbol => [symbol, loadSeries(symbol)]));
  const dailyRet = new Map();
  for (const symbol of labelled) {
    const series = books.get(symbol);
    const map = new Map();
    for (let index = 1; index < series.dates.length; index += 1) {
      map.set(series.dates[index], series.close[index] / series.close[index - 1] - 1);
    }
    dailyRet.set(symbol, map);
  }
  const sectorPeers = new Map();
  for (const symbol of labelled) {
    const sector = profiles.get(symbol).sector;
    if (!sectorPeers.has(sector)) sectorPeers.set(sector, []);
    sectorPeers.get(sector).push(symbol);
  }
  const spyRet = new Map();
  for (let index = 1; index < spy.dates.length; index += 1) {
    spyRet.set(spy.dates[index], spy.close[index] / spy.close[index - 1] - 1);
  }
  const ends = monthEnds(spy).filter(index => spy.dates[index] >= '2010-01-01');
  const foldsMedium = foldsFor(spy.dates, 'medium');
  const foldsLong = foldsFor(spy.dates, 'long');
  const variants = [
    ['resid_decile_medium', 'decile', 'medium'],
    ['resid_quintile_medium', 'quintile', 'medium'],
    ['resid_decile_long', 'decile', 'long'],
  ];
  for (const [variant, width, horizon] of variants) {
    const picks = [];
    for (let edge = 0; edge < ends.length - (horizon === 'long' ? 6 : 1); edge += 1) {
      const signal = ends[edge];
      const date = spy.dates[signal];
      const members = membershipAt(us, date);
      if (!members) continue;
      const ranked = [];
      for (const symbol of labelled) {
        if (!members.has(symbol)) continue;
        const series = books.get(symbol);
        const at = indexOf(series, date);
        if (at < 252) continue;
        const sector = profiles.get(symbol).sector;
        const peers = (sectorPeers.get(sector) || []).filter(name => name !== symbol && members.has(name));
        if (peers.length < 2) continue;
        const y = [];
        const x1 = [];
        const x2 = [];
        const stockMap = dailyRet.get(symbol);
        for (let cursor = at - 251; cursor <= at - 21; cursor += 1) {
          const day = series.dates[cursor];
          const stock = stockMap.get(day);
          const market = spyRet.get(day);
          let sum = 0;
          let count = 0;
          for (const peer of peers) {
            const value = dailyRet.get(peer).get(day);
            if (Number.isFinite(value)) { sum += value; count += 1; }
          }
          if (!Number.isFinite(stock) || !Number.isFinite(market) || count < 2) continue;
          y.push(stock);
          x1.push(market);
          x2.push(sum / count);
        }
        const alpha = olsAlpha(y, x1, x2);
        if (alpha == null) continue;
        ranked.push({ symbol, alpha, series });
      }
      if (ranked.length < 10) continue;
      ranked.sort((a, b) => b.alpha - a.alpha);
      const count = width === 'decile' ? Math.floor(ranked.length / 10) : Math.floor(ranked.length / 5);
      picks.push({ date, names: ranked.slice(0, Math.max(1, count)), exitEdge: edge + (horizon === 'long' ? 6 : 1) });
    }
    const life = horizon === 'long' ? 6 : 1;
    const monthReturns = holdSleeves(picks, ends, spy, life);
    monthReturns.k1 = holdSleeves(picks, ends, spy, life, 1);
    monthReturns.k2 = holdSleeves(picks, ends, spy, life, 2);
    publishBook('F4', variant, 'US', horizon, 'long', monthReturns, spy, foldsFor(spy.dates, horizon), 'SPY', 'US medium and US long — empty', keep);
    console.log(`[F4] ${variant} months ${monthReturns.months.length}`);
  }
  for (const [variant, mode, horizon] of [
    ['ind_quintile_medium', 'quintile', 'medium'],
    ['ind_top3_medium', 'top3', 'medium'],
    ['ind_quintile_long', 'quintile', 'long'],
  ]) {
    const picks = [];
    for (let edge = 0; edge < ends.length - (horizon === 'long' ? 6 : 1); edge += 1) {
      const date = spy.dates[ends[edge]];
      const members = membershipAt(us, date);
      const industries = new Map();
      for (const symbol of labelled) {
        if (!members?.has(symbol)) continue;
        const series = books.get(symbol);
        const at = indexOf(series, date);
        const ret = priceReturn(series, at - 126, at);
        if (ret == null) continue;
        const industry = profiles.get(symbol).industry;
        if (!industries.has(industry)) industries.set(industry, []);
        industries.get(industry).push({ symbol, ret, series });
      }
      const ranked = [...industries.entries()]
        .filter(([, names]) => names.length >= 2)
        .map(([industry, names]) => ({
          industry,
          ret: names.reduce((sum, row) => sum + row.ret, 0) / names.length,
          names,
        }))
        .sort((a, b) => b.ret - a.ret);
      if (ranked.length < 5) continue;
      const count = mode === 'top3' ? 3 : Math.max(1, Math.floor(ranked.length / 5));
      picks.push({
        date,
        names: ranked.slice(0, count).flatMap(row => row.names),
        exitEdge: edge + (horizon === 'long' ? 6 : 1),
      });
    }
    const life = horizon === 'long' ? 6 : 1;
    const monthReturns = holdSleeves(picks, ends, spy, life);
    monthReturns.k1 = holdSleeves(picks, ends, spy, life, 1);
    monthReturns.k2 = holdSleeves(picks, ends, spy, life, 2);
    publishBook('F4', variant, 'US', horizon, 'long', monthReturns, spy, foldsFor(spy.dates, horizon), 'SPY', horizon === 'long' ? 'US long — empty (US_LONG_WAVE3 disabled)' : 'US medium — empty', keep);
    console.log(`[F4] ${variant} months ${monthReturns.months.length}`);
  }
  global.__GAP_PROFILES = profiles;
  global.__GAP_BOOKS = { us, labelled, books };
}

function olsAlpha(y, x1, x2) {
  const n = y.length;
  if (n < 126) return null;
  let s1 = 0; let s2 = 0; let s11 = 0; let s12 = 0; let s22 = 0;
  let t0 = 0; let t1 = 0; let t2 = 0;
  for (let index = 0; index < n; index += 1) {
    const a = x1[index]; const b = x2[index]; const c = y[index];
    s1 += a; s2 += b; s11 += a * a; s12 += a * b; s22 += b * b;
    t0 += c; t1 += a * c; t2 += b * c;
  }
  const matrix = [
    [n, s1, s2, t0],
    [s1, s11, s12, t1],
    [s2, s12, s22, t2],
  ];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    const swap = matrix[col]; matrix[col] = matrix[pivot]; matrix[pivot] = swap;
    const divisor = matrix[col][col];
    if (Math.abs(divisor) < 1e-12) return null;
    for (let col2 = col; col2 < 4; col2 += 1) matrix[col][col2] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let col2 = col; col2 < 4; col2 += 1) matrix[row][col2] -= factor * matrix[col][col2];
    }
  }
  return matrix[0][3];
}

function holdSleeves(picks, ends, spy, life, k) {
  const slots = [];
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const next = ends[edge + 1];
    slots.push({ date: spy.dates[next], research: [], gross: [], executable: [] });
  }
  const trades = [];
  for (const pick of picks) {
    const roster = k
      ? [...pick.names].sort((a, b) => (b.alpha ?? b.ret ?? 0) - (a.alpha ?? a.ret ?? 0)).slice(0, k)
      : pick.names;
    const entryEdge = ends.findIndex(index => spy.dates[index] >= pick.date);
    if (entryEdge < 0) continue;
    let equity = 1;
    let lastDate = pick.date;
    const stopped = new Set();
    for (let step = 0; step < life; step += 1) {
      const edge = entryEdge + step;
      if (edge + 1 >= ends.length) break;
      const entryDate = spy.dates[ends[edge] + 1];
      const exitDate = spy.dates[ends[edge + 1] + 1];
      if (!entryDate || !exitDate) break;
      const rets = [];
      const grossRets = [];
      const exec = [];
      roster.forEach((name, nameIndex) => {
        if (stopped.has(name.symbol)) return;
        const entryAt = firstOnOrAfter(name.series, entryDate);
        if (entryAt < 0 || !(name.series.open[entryAt] > 0)) return;
        const exitAt = firstOnOrAfter(name.series, exitDate);
        let exitPx;
        if (exitAt > entryAt) exitPx = name.series.open[exitAt];
        else {
          const last = name.series.close.length - 1;
          if (last < entryAt) {
            stopped.add(name.symbol);
            return;
          }
          exitPx = name.series.close[last];
          stopped.add(name.symbol);
          const lastDate = name.series.dates[last];
          const sampleEnd = spy.dates[spy.dates.length - 1];
          if (!k && Date.parse(sampleEnd) - Date.parse(lastDate) > 7 * 86400000) earlyExits.F4 += 1;
        }
        const gross = exitPx / name.series.open[entryAt] - 1;
        const execution = estimateRoundTripCostPct({
          market: 'US', symbol: name.symbol, side: 'buy', holdDays: 0,
        }) / 100;
        const net = gross - (step === 0 ? execution : 0);
        if (!Number.isFinite(net)) return;
        const scale = notionalFor(name.symbol, 'US', name.series.open[entryAt], 1, 1) / TICKET;
        if (k) {
          rets.push(net * scale);
          grossRets.push(gross * scale);
        } else {
          rets.push(net);
          grossRets.push(gross);
          if (nameIndex < 50) exec.push(net * scale);
        }
      });
      if (!rets.length) continue;
      const research = rets.reduce((sum, value) => sum + value, 0) / rets.length;
      const grossBook = grossRets.reduce((sum, value) => sum + value, 0) / grossRets.length;
      slots[edge].research.push(research);
      slots[edge].gross.push(grossBook);
      if (k) slots[edge].executable.push(research);
      else if (exec.length) slots[edge].executable.push(exec.reduce((sum, value) => sum + value, 0) / exec.length);
      equity *= 1 + research;
      lastDate = slots[edge].date;
    }
    trades.push({ date: lastDate, ret: equity - 1 });
  }
  const average = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const months = slots.filter(slot => slot.date >= '2010-01-01').map(slot => ({ date: slot.date, ret: average(slot.research) }));
  const grossMonths = slots.filter(slot => slot.date >= '2010-01-01').map(slot => ({ date: slot.date, ret: average(slot.gross) }));
  const execMonths = slots.filter(slot => slot.date >= '2010-01-01').map(slot => ({ date: slot.date, ret: average(slot.executable) }));
  return { months, grossMonths, execMonths, trades };
}

function publishBook(family, variant, market, horizon, side, book, benchmarkSeries, folds, benchmarkName, cell, keep) {
  const bench = benchmarkMonths(benchmarkSeries, book.months);
  const benchSide = side === 'short' ? bench.map(row => ({ date: row.date, ret: -row.ret })) : bench;
  const scored = scoreCell({
    monthly: book.months,
    grossMonthly: book.grossMonths,
    trades: book.trades,
    benchmarkMonthly: benchSide,
    folds,
    tSource: family === 'F3' || family === 'F6' ? 'trade' : 'month',
  });
  const executable = scoreCell({
    monthly: book.execMonths || book.months,
    grossMonthly: book.execMonths || book.months,
    trades: book.trades,
    benchmarkMonthly: benchSide,
    folds,
    tSource: 'month',
  });
  const excessMonths = book.months.map((row, index) => ({
    date: row.date,
    ret: row.ret - (benchSide[index] ? benchSide[index].ret : 0),
  }));
  const excessValues = excessMonths.map(row => row.ret);
  const excessStat = tStat(excessValues);
  const excessSharpe = sharpe(excessValues).sharpe;
  const sized = source => {
    if (!source) return null;
    const scoredK = scoreCell({
      monthly: source.months,
      grossMonthly: source.grossMonths,
      trades: source.trades,
      benchmarkMonthly: benchSide,
      folds,
      tSource: 'month',
    });
    return {
      verdict: scoredK.verdict,
      full: scoredK.full,
      windows: scoredK.windows,
      qqq: qqqHurdle(source.months, null, folds),
    };
  };
  keep(family, {
    family, variant, market, horizon, side, cell,
    benchmark: side === 'short' ? `short ${benchmarkName}` : benchmarkName,
    ...scored,
    qqq: qqqHurdle(book.months, null, folds),
    excess: {
      tStat: excessStat.t == null || !Number.isFinite(excessStat.t) ? null : +excessStat.t.toFixed(2),
      tN: excessStat.n,
      sharpe: excessSharpe,
      returns: excessValues,
    },
    k1: sized(book.k1),
    k2: sized(book.k2),
    executable: {
      returnPct: executable.full.returnPct,
      maxDrawdownPct: executable.full.maxDrawdownPct,
      windows: executable.windows,
    },
  });
}

function field(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function altmanFromPeriods(periods, close, date, fxAt, scale, listingCurrency) {
  const eligible = (periods || []).filter(period => period.availableOn < date);
  const latest = eligible.at(-1);
  if (!latest || !(close > 0)) return null;
  const periodName = String(latest.income?.period || '').toUpperCase();
  const count = periodName.startsWith('H') ? 2 : 4;
  const recent = eligible.slice(-count);
  if (recent.length !== count) return null;
  const ebits = recent.map(period => field(period.income, ['ebit', 'operatingIncome', 'operatingIncomeLoss']));
  const sales = recent.map(period => field(period.income, ['revenue', 'totalRevenue']));
  if (ebits.some(value => value == null) || sales.some(value => value == null)) return null;
  const balance = latest.balance;
  const shares = field(latest.income, ['weightedAverageShsOutDil', 'weightedAverageShsOut', 'commonStockSharesOutstanding'])
    ?? field(balance, ['commonStockSharesOutstanding']);
  const currentAssets = field(balance, ['totalCurrentAssets']);
  const currentLiabilities = field(balance, ['totalCurrentLiabilities']);
  const retainedEarnings = field(balance, ['retainedEarnings', 'retainedEarningsTotal']);
  const assets = field(balance, ['totalAssets']);
  const liabilities = field(balance, ['totalLiabilities']);
  const statementCurrency = String(balance?.reportedCurrency || listingCurrency || '').toUpperCase();
  const priceCurrency = String(listingCurrency || statementCurrency).toUpperCase();
  const statementFx = fxAt(statementCurrency, date);
  const priceFx = fxAt(priceCurrency, date);
  if (![shares, currentAssets, currentLiabilities, retainedEarnings, assets, liabilities, statementFx, priceFx].every(Number.isFinite)) return null;
  if (!(assets > 0) || !(liabilities > 0)) return null;
  const ebit = ebits.reduce((sum, value) => sum + value, 0);
  const revenue = sales.reduce((sum, value) => sum + value, 0);
  const marketValue = close * scale * shares * priceFx;
  const assetsUsd = assets * statementFx;
  const liabilitiesUsd = liabilities * statementFx;
  return 1.2 * ((currentAssets - currentLiabilities) * statementFx / assetsUsd)
    + 1.4 * (retainedEarnings * statementFx / assetsUsd)
    + 3.3 * (ebit * statementFx / assetsUsd)
    + 0.6 * (marketValue / liabilitiesUsd)
    + (revenue * statementFx / assetsUsd);
}

function shiftFiling(row) {
  const filed = row?.acceptedDate || row?.filingDate;
  if (!filed || !Number.isFinite(Date.parse(filed))) return null;
  const available = new Date(Date.parse(filed) + 45 * 86400000).toISOString().slice(0, 10);
  return { ...row, acceptedDate: available, filingDate: available };
}
function loadStatements(market, symbol) {
  const dir = path.join(FMP_DIR, market, symbol);
  const read = kind => {
    const file = path.join(dir, `${kind}.json`);
    if (!fs.existsSync(file)) return [];
    const record = readJson(file);
    if (record.status !== 'OK' || !Array.isArray(record.rows)) return [];
    return record.rows.map(shiftFiling).filter(Boolean);
  };
  return {
    incomeStatements: read('income'),
    balanceSheets: read('balance'),
    cashFlowStatements: read('cashflow'),
    market,
  };
}

async function runJunk(cells, gaps, keep, addGap) {
  addGap('F5', 'Japan', 'No dated Nikkei membership file. Statements were not applied to a current constituent list.');
  addGap('F5', 'Europe', 'Germany has statement files and no dated membership file, so a pooled Europe book was not run. France is scored on its own.');
  addGap('F5', 'Hard-to-borrow', 'No hard-to-borrow flag is in the cache. Every short pays 1% per year. The 5% branch was not used.');
  const markets = [
    ['US', 'US', readJson(path.join(FMP_DIR, 'us-universe.json')), 'SPY', 'US'],
    ['UK', 'UK', readJson(path.join(MEMBER_DIR, 'ftse100.json')), 'EWU', 'UK'],
    ['France', 'France', readJson(path.join(MEMBER_DIR, 'cac40.json')), '^FCHI', 'EU'],
  ];
  const fx = {
    GBP: pack(readJson(path.join(ROOT, 'data', 'research', 'fx', 'GBPUSD_X.json'))),
    EUR: pack(readJson(path.join(ROOT, 'data', 'research', 'fx', 'EURUSD_X.json'))),
  };
  function fxAt(currency, date) {
    if (!currency || currency === 'USD') return 1;
    const series = currency === 'GBP' ? fx.GBP : currency === 'EUR' ? fx.EUR : null;
    if (!series) return null;
    const at = indexOf(series, date);
    return at >= 0 ? series.close[at] : null;
  }
  for (const [label, statementMarket, snapshot, benchmarkSymbol, costMarket] of markets) {
    const benchmark = loadSeries(benchmarkSymbol);
    if (!benchmark || !snapshot.historicalMembership?.available) {
      addGap('F5', label, 'Dated membership or the benchmark series is missing.');
      continue;
    }
    const universe = everMembers(snapshot);
    if (!universe) {
      addGap('F5', label, 'Dated membership is missing, so the current constituent list was not used.');
      continue;
    }
    const symbols = [...universe];
    console.log(`[F5] ${label} preparing ${symbols.length} names`);
    const prepared = [];
    for (const symbol of symbols) {
      const series = loadSeries(symbol);
      const statements = loadStatements(statementMarket, symbol);
      if (!series || !statements.incomeStatements.length) continue;
      const pio = buildPitPiotroskiScores(statements);
      const currency = String(statements.balanceSheets[0]?.reportedCurrency || (label === 'UK' ? 'GBP' : label === 'France' ? 'EUR' : 'USD')).toUpperCase();
      prepared.push({ symbol, series, periods: pio.periods || [], scores: pio.scores || [], currency });
    }
    console.log(`[F5] ${label} priced with statements ${prepared.length}`);
    const loadedProfiles = await loadProfiles(prepared.map(row => row.symbol));
    let zExcluded = 0;
    for (const row of prepared) {
      const sector = loadedProfiles.profiles.get(row.symbol)?.sector;
      row.altmanExcluded = sector === 'Financial Services' || sector === 'Real Estate';
      if (row.altmanExcluded) zExcluded += 1;
    }
    console.log(`[F5] ${label} Altman excluded ${zExcluded} of ${prepared.length}`);
    const ends = monthEnds(benchmark).filter(index => benchmark.dates[index] >= '2014-01-23');
    const variants = ['or_all', 'pio_only', 'z_only', 'and_both', 'or_worst10', 'or_63'];
    for (const variant of variants) {
      const holdEdges = variant === 'or_63' ? 3 : 1;
      const trades = [];
      const monthly = [];
      for (let edge = 0; edge < ends.length - holdEdges; edge += holdEdges) {
        const signal = ends[edge];
        const date = benchmark.dates[signal];
        const members = membershipAt(snapshot, date);
        if (!members) continue;
        const entryBench = signal + 1;
        const exitBench = ends[Math.min(ends.length - 1, edge + holdEdges)] + 1;
        if (exitBench >= benchmark.open.length) continue;
        const qualified = [];
        for (const row of prepared) {
          if (!members.has(row.symbol)) continue;
          const at = indexOf(row.series, date);
          if (at < 252) continue;
          const mom = priceReturn(row.series, at - 252, at - 21);
          let ma = 0;
          for (let cursor = at - 199; cursor <= at; cursor += 1) ma += row.series.close[cursor];
          ma /= 200;
          if (!(mom < 0) || !(row.series.close[at] < ma)) continue;
          const score = [...row.scores].reverse().find(item => item.availableOn < date);
          const pioScore = score ? score.score : null;
          let z = null;
          if (variant !== 'pio_only' && !row.altmanExcluded) {
            z = altmanFromPeriods(row.periods, row.series.close[at], date, fxAt, label === 'UK' ? 0.01 : 1, row.currency);
          }
          const pioPass = pioScore != null && pioScore <= 2;
          const zPass = z != null && z < 1.8;
          const quality = variant === 'pio_only' ? pioPass
            : variant === 'z_only' ? zPass
              : variant === 'and_both' ? (pioPass && zPass)
                : (pioPass || zPass);
          if (!quality) continue;
          qualified.push({ ...row, mom });
        }
        qualified.sort((a, b) => a.mom - b.mom);
        const chosen = variant === 'or_worst10' ? qualified.slice(0, 10) : qualified;
        const rets = [];
        for (const row of chosen) {
          const entry = firstOnOrAfter(row.series, benchmark.dates[entryBench]);
          if (entry < 0 || !(row.series.open[entry] > 0)) continue;
          let exit = firstOnOrAfter(row.series, benchmark.dates[Math.min(exitBench, benchmark.dates.length - 1)]);
          let exitPx;
          if (exit > entry) exitPx = row.series.open[exit];
          else {
            exit = row.series.close.length - 1;
            if (exit < entry) continue;
            exitPx = row.series.close[exit];
            const sampleEnd = benchmark.dates[benchmark.dates.length - 1];
            if (Date.parse(sampleEnd) - Date.parse(row.series.dates[exit]) > 7 * 86400000) earlyExits.F5 += 1;
          }
          const gross = -(exitPx / row.series.open[entry] - 1);
          const sessions = exit - entry;
          const priced = netOf(gross, { market: costMarket, symbol: row.symbol, side: 'buy', holdDays: 0 });
          if (!priced) continue;
          const net = priced.net - sessions * (0.01 / 252);
          rets.push(net);
          trades.push({ date: row.series.dates[exit], ret: net });
        }
        monthly.push({
          date: benchmark.dates[ends[Math.min(ends.length - 1, edge + holdEdges)]],
          ret: rets.length ? rets.reduce((sum, value) => sum + value, 0) / rets.length : 0,
        });
      }
      const bench = benchmarkMonths(benchmark, monthly).map(row => ({ date: row.date, ret: -row.ret }));
      const scored = scoreCell({
        monthly, grossMonthly: monthly, trades, benchmarkMonthly: bench,
        folds: foldsFor(benchmark.dates, 'medium'), tSource: 'month',
      });
      keep('F5', {
        family: 'F5', variant, market: label, horizon: 'medium', side: 'short',
        cell: label === 'US'
          ? 'US short — occupied by US_SHORT_MR; sell candidate beside it'
          : `${label} short — empty`,
        benchmark: `short ${benchmarkSymbol}`,
        ...scored,
        executable: { returnPct: null, maxDrawdownPct: null, windows: scored.windows },
      });
    }
  }
}

async function runReversal(cells, gaps, keep, addGap) {
  addGap('F6', 'Hong Kong', 'No dated Hang Seng membership file and no Hong Kong price cache in the strategy prices. The long-only book was not run.');
  const profiles = global.__GAP_PROFILES || new Map();
  if (!global.__GAP_PROFILES) {
    addGap('F6', 'UK', 'Industry labels were not available, so the industry residual was not replaced with a market residual.');
    addGap('F6', 'France', 'Industry labels were not available, so the industry residual was not replaced with a market residual.');
    return;
  }
  const markets = [
    ['UK', readJson(path.join(MEMBER_DIR, 'ftse100.json')), loadSeries('EWU') || loadSeries('^FTSE'), 'UK', 'EWU'],
    ['France', readJson(path.join(MEMBER_DIR, 'cac40.json')), loadSeries('^FCHI'), 'EU', '^FCHI'],
  ];
  for (const [label, snapshot, benchmark, costMarket, benchName] of markets) {
    if (!benchmark) {
      addGap('F6', label, 'Benchmark series is missing.');
      continue;
    }
    const symbols = [...(everMembers(snapshot) || [])].filter(symbol => loadSeries(symbol));
    const loaded = await loadProfiles(symbols);
    for (const [symbol, record] of loaded.profiles) profiles.set(symbol, record);
    const usable = symbols.filter(symbol => profiles.get(symbol)?.industry);
    if (usable.length < 10) {
      addGap('F6', label, `Only ${usable.length} members have both prices and an industry label. The market return was not used as the industry.`);
      continue;
    }
    const books = new Map(usable.map(symbol => [symbol, loadSeries(symbol)]));
    console.log(`[F6] ${label} names ${usable.length}`);
    const variants = [
      ['d5_h5', 5, 5, 10],
      ['d5_h3', 5, 3, 10],
      ['d5_h10', 5, 10, 10],
      ['d3_h5', 3, 5, 10],
      ['d10_h5', 10, 5, 10],
      ['q5_h5', 5, 5, 5],
    ];
    for (const [variant, lookback, hold, bucket] of variants) {
      const trades = [];
      for (let index = 0; index < benchmark.dates.length; index += 1) {
        const date = benchmark.dates[index];
        if (date < '2010-01-01') continue;
        const members = membershipAt(snapshot, date);
        if (!members) continue;
        const rows = [];
        for (const symbol of usable) {
          if (!members.has(symbol)) continue;
          const series = books.get(symbol);
          const at = indexOf(series, date);
          if (at < lookback || series.dates[at] !== date) continue;
          const stock = series.close[at] / series.close[at - lookback] - 1;
          const industry = profiles.get(symbol).industry;
          const peers = [];
          for (const peer of usable) {
            if (peer === symbol || profiles.get(peer).industry !== industry || !members.has(peer)) continue;
            const peerSeries = books.get(peer);
            const peerAt = indexOf(peerSeries, date);
            if (peerAt < lookback || peerSeries.dates[peerAt] !== date) continue;
            peers.push(peerSeries.close[peerAt] / peerSeries.close[peerAt - lookback] - 1);
          }
          if (peers.length < 2 || !Number.isFinite(stock)) continue;
          const industryRet = peers.reduce((sum, value) => sum + value, 0) / peers.length;
          rows.push({ symbol, series, at, residual: stock - industryRet });
        }
        if (rows.length < bucket) continue;
        rows.sort((a, b) => a.residual - b.residual);
        const width = Math.floor(rows.length / bucket);
        const picked = [
          ...rows.slice(0, width).map(row => ({ ...row, side: 'buy' })),
          ...rows.slice(rows.length - width).map(row => ({ ...row, side: 'sell' })),
        ];
        for (const row of picked) {
          const entry = row.at + 1;
          const planned = entry + hold - 1;
          const exited = clipExit(row.series, entry, planned, 'F6', benchmark.dates[benchmark.dates.length - 1]);
          if (!exited) continue;
          const sessions = exited.exit - entry + 1;
          const gross = (row.side === 'sell' ? -1 : 1) * (exited.exitPx / row.series.open[entry] - 1);
          const priced = netOf(gross, { market: costMarket, symbol: row.symbol, side: row.side, holdDays: sessions });
          if (!priced) continue;
          trades.push({
            symbol: row.symbol, side: row.side, date: row.series.dates[exited.exit], ret: priced.net,
            gross, entry, exit: exited.exit, series: row.series, entryPx: row.series.open[entry],
            exitPx: exited.exitPx, cost: priced.costPct / 100,
          });
        }
      }
      for (const side of ['long', 'short']) {
        const sideTrades = trades.filter(row => (side === 'long' ? row.side === 'buy' : row.side === 'sell'));
        const daily = dailyBook(sideTrades, benchmark);
        const monthly = toMonths(daily);
        const benchDaily = benchmark.dates.map((date, index) => ({
          date, ret: index === 0 ? 0 : benchmark.close[index] / benchmark.close[index - 1] - 1,
        }));
        const bench = alignMonths(toMonths(benchDaily), monthly);
        const scored = scoreCell({
          monthly,
          grossMonthly: monthly,
          trades: sideTrades,
          benchmarkMonthly: side === 'short' ? bench.map(row => ({ date: row.date, ret: -row.ret })) : bench,
          daily,
          folds: foldsFor(benchmark.dates, 'short'),
          tSource: 'trade',
        });
        keep('F6', {
          family: 'F6', variant, market: label, horizon: 'short', side,
          cell: side === 'short' ? `${label} short — empty` : `${label} long — ${label === 'France' ? 'occupied by FRANCE_LONG_ENGINE' : 'empty'}`,
          benchmark: side === 'short' ? `short ${benchName}` : benchName,
          ...scored,
          executable: { returnPct: null, maxDrawdownPct: null, windows: scored.windows },
        });
      }
      console.log(`[F6] ${label} ${variant} trades ${trades.length}`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
