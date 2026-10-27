'use strict';

// Research only. Frozen in docs/earnings-miss-short-preregistration-2026-10-07.md.
// A pass is signals-only. This script does not place orders.
const fs = require('fs');
const path = require('path');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { scoreCell, deflatedSharpe, compound } = require('../lib/research/strategy-gaps');
const {
  loadSeries, dayReturns, hedgeDays, roundTrip, borrowRate, bookFrom,
} = require('./run-downtrend-short');

const ROOT = path.join(__dirname, '..');
const EARN = path.join(ROOT, 'data', 'research', 'f9-earnings');
const PRICE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const OUT_MD = path.join(ROOT, 'docs', 'earnings-miss-short-results-2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'scripts', 'earnings-miss-short-results.json');
const SANITY = ['NKE', 'SBUX', 'MCD', 'GFS', 'META', 'FB', 'INTC'];
const SECTOR = {
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
const VARIANTS = [
  { id: 'a', hedge: null, cover: 'time' },
  { id: 'b', hedge: 'SPY', cover: 'time' },
  { id: 'c', hedge: 'SPY', cover: 'ma50' },
  { id: 'd', hedge: 'SPY', cover: 'time', priorMiss: true },
  { id: 'e', hedge: 'sector', cover: 'time' },
  { id: 'f', hedge: 'SPY', cover: 'time', revenueMiss: true },
];

function sessionOnOrAfter(series, date) {
  for (let index = 0; index < series.dates.length; index += 1) {
    if (series.dates[index] >= date) return index;
  }
  return -1;
}
function loadEarnings(symbol) {
  const file = path.join(EARN, `${symbol}.json`);
  if (!fs.existsSync(file)) return [];
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '').slice(0, 10)))
    .map(row => ({
      date: String(row.date).slice(0, 10),
      epsActual: row.epsActual === '' || row.epsActual == null ? null : Number(row.epsActual),
      epsEstimated: row.epsEstimated === '' || row.epsEstimated == null ? null : Number(row.epsEstimated),
      revenueActual: row.revenueActual === '' || row.revenueActual == null ? null : Number(row.revenueActual),
      revenueEstimated: row.revenueEstimated === '' || row.revenueEstimated == null ? null : Number(row.revenueEstimated),
    }))
    .filter(row => Number.isFinite(row.epsActual) && Number.isFinite(row.epsEstimated))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function hold(series, entry, cover) {
  const last = series.close.length - 1;
  let exit = Math.min(last, entry + 62);
  if (cover === 'ma50') {
    for (let index = entry; index <= exit; index += 1) {
      if (series.close[index] > series.ma50[index]) return index;
    }
  }
  return exit;
}
function signalsFor(symbol, series, reports, snapshot) {
  const out = [];
  for (let reportIndex = 0; reportIndex < reports.length; reportIndex += 1) {
    const report = reports[reportIndex];
    if (!(report.epsActual < report.epsEstimated)) continue;
    if (report.date < '2010-01-01') continue;
    const d0 = sessionOnOrAfter(series, report.date);
    if (d0 < 1 || d0 + 2 >= series.dates.length) continue;
    const reactionEnd = d0 + 1;
    const priorClose = series.close[d0 - 1];
    const endClose = series.close[reactionEnd];
    if (!(priorClose > 0) || !(endClose > 0)) continue;
    out.push({ symbol, series, report, reportIndex, d0, reactionEnd, reports });
  }
  return out.filter(row => membershipAt(snapshot, row.series.dates[row.d0]).has(symbol));
}
function qualifies(row, spy, variant) {
  const { series, reactionEnd, report, reports, reportIndex } = row;
  const stock = series.close[reactionEnd] / series.close[row.d0 - 1] - 1;
  const spyAt = spy.byDate.get(series.dates[reactionEnd]);
  const spyPrev = spy.byDate.get(series.dates[row.d0 - 1]);
  if (spyAt == null || spyPrev == null) return false;
  const market = spy.close[spyAt] / spy.close[spyPrev] - 1;
  if (stock - market > -0.05) return false;
  const ma = series.ma200[reactionEnd];
  const priorMa = reactionEnd >= 21 ? series.ma200[reactionEnd - 21] : NaN;
  if (!(series.close[reactionEnd] < ma) || !(ma < priorMa)) return false;
  if (!(spy.close[spyAt] > spy.ma200[spyAt])) return false;
  if (variant.priorMiss) {
    const previous = reports[reportIndex - 1];
    if (!previous || !(previous.epsActual < previous.epsEstimated)) return false;
  }
  if (variant.revenueMiss) {
    if (!Number.isFinite(report.revenueActual) || !Number.isFinite(report.revenueEstimated)) return false;
    if (!(report.revenueActual < report.revenueEstimated)) return false;
  }
  return true;
}
function tradeFor(row, variant, spy, sectors) {
  const entry = row.d0 + 2;
  if (entry >= row.series.close.length) return null;
  const exit = hold(row.series, entry, variant.cover);
  const stockDays = dayReturns(row.series, entry, exit, -1);
  let hedge = null;
  if (variant.hedge === 'SPY') hedge = spy;
  if (variant.hedge === 'sector') {
    const etf = sectors.get(row.symbol);
    if (!etf) return null;
    hedge = etf;
  }
  let days = stockDays;
  const indexLeg = hedgeDays(hedge || spy, stockDays.map(item => item.date));
  if (!indexLeg) return null;
  days = stockDays.map((item, index) => ({ date: item.date, ret: item.ret + indexLeg[index] }));
  if (hedge) days[days.length - 1].ret -= roundTrip('US', hedge.symbol, 0);
  const rate = borrowRate(row.series, entry, null);
  days[days.length - 1].ret -= roundTrip('US', row.symbol, 0) + (exit - entry + 1) * (rate / 252);
  return {
    symbol: row.symbol,
    side: 'short',
    signalDate: row.report.date,
    entryDate: row.series.dates[entry],
    exitDate: row.series.dates[exit],
    date: row.series.dates[exit],
    ret: days.reduce((equity, item) => equity * (1 + item.ret), 1) - 1,
    days,
  };
}
function sectorMap() {
  const map = new Map();
  const file = path.join(ROOT, 'data', 'research', 'f9-sectors.json');
  if (!fs.existsSync(file)) return map;
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [symbol, sector] of Object.entries(rows)) {
    const etf = SECTOR[sector];
    if (etf) map.set(symbol, etf);
  }
  return map;
}

function main() {
  const snapshot = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
  const spy = loadSeries('SPY');
  if (!spy) throw new Error('SPY cache missing');
  const symbols = fs.readdirSync(PRICE).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const books = new Map();
  for (const symbol of symbols) {
    if (symbol === 'SPY' || symbol.startsWith('XL')) continue;
    const series = loadSeries(symbol);
    if (series) books.set(symbol, series);
  }
  const labels = sectorMap();
  const sectors = new Map();
  const etfs = new Map();
  for (const [symbol, etf] of labels) {
    if (!etfs.has(etf)) {
      const series = loadSeries(etf);
      if (series) etfs.set(etf, series);
    }
    if (etfs.has(etf)) sectors.set(symbol, etfs.get(etf));
  }
  const raw = [];
  for (const [symbol, series] of books) {
    const reports = loadEarnings(symbol);
    if (!reports.length) continue;
    raw.push(...signalsFor(symbol, series, reports, snapshot));
  }
  const folds = buildDateAlignedFolds(spy.dates, { ...FOLD_SPEC, embargoBars: EMBARGO.medium });
  const cells = [];
  const sanity = [];
  for (const variant of VARIANTS) {
    const trades = [];
    for (const row of raw) {
      if (!qualifies(row, spy, variant)) continue;
      const trade = tradeFor(row, variant, spy, sectors);
      if (trade) trades.push(trade);
    }
    const packed = bookFrom(trades, spy);
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
      years.push(slice.length ? +(compound(slice.map(item => item.ret)) * 100).toFixed(2) : null);
    }
    const months = [];
    for (let index = 1; index < spy.dates.length; index += 1) {
      const month = spy.dates[index].slice(0, 7);
      if (!months.length || months[months.length - 1].month !== month) months.push({ month, ret: spy.close[index] / spy.close[index - 1] - 1 });
      else months[months.length - 1].ret = (1 + months[months.length - 1].ret) * (spy.close[index] / spy.close[index - 1]) - 1;
    }
    const hot = months.filter(row => row.month >= '2010-01').sort((a, b) => b.ret - a.ret);
    const hotSet = new Set(hot.slice(0, Math.floor(hot.length / 10)).map(row => row.month));
    const reboundSlice = packed.monthly.filter(row => hotSet.has(row.date.slice(0, 7)));
    cells.push({
      id: variant.id,
      verdict: scored.verdict,
      full: scored.full,
      windows: scored.windows,
      trades: trades.length,
      years,
      rebound: reboundSlice.length ? +(compound(reboundSlice.map(item => item.ret)) * 100).toFixed(2) : null,
      worst: trades.slice().sort((a, b) => a.ret - b.ret).slice(0, 10),
      monthlyReturns: packed.monthly.map(row => row.ret),
    });
    for (const trade of trades) {
      if (SANITY.includes(trade.symbol)) sanity.push({ variant: variant.id, ...trade, days: undefined });
    }
    console.log(variant.id, scored.verdict, 'trades', trades.length, 't', scored.full.tStat);
  }
  const trials = cells.map(cell => ({ sharpe: cell.full.sharpe, id: cell.id }));
  const best = cells.slice().sort((a, b) => (b.full.sharpe || -Infinity) - (a.full.sharpe || -Infinity))[0];
  const dsr = deflatedSharpe(trials, best ? best.monthlyReturns : []);
  const lines = [
    '# F9 earnings-miss short — results',
    '',
    'Research only. Nothing was enabled. Pre-registration `fa0d5c5b520a2607ba509f4d5b0fd610537f9080`.',
    'A pass would be signals-only forward tracking. No order was sent.',
    'US ever-members. Empty windows are neutral. The t-stat is on the per-trade excess return.',
    'Naked excess is the stock short plus the SPY move over the same sessions. Hedged excess is that spread, with the ETF cost included.',
    `Variant e uses a sector SPDR only when a stored sector label maps to one. Labels on hand: ${sectors.size} names. Names without a label are left out.`,
    '',
    `Trials 6. DSR ${dsr.probability == null ? '—' : dsr.probability.toFixed(3)} on ${best ? best.id : '—'}, annualized Sharpe ${dsr.annualized == null ? '—' : dsr.annualized.toFixed(2)}. Not a pass gate.`,
    '',
    '| Variant | Verdict | Full excess | t | PF | Trades | Max DD | Rebound |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const cell of cells) {
    lines.push(`| ${cell.id} | ${cell.verdict} | ${cell.full.returnPct}% | ${cell.full.tStat == null ? '—' : cell.full.tStat} | ${cell.full.pf == null ? '—' : cell.full.pf} | ${cell.trades} | ${cell.full.maxDrawdownPct}% | ${cell.rebound == null ? '—' : cell.rebound}% |`);
  }
  lines.push('', '| Variant | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const cell of cells) lines.push(`| ${cell.id} | ${cell.years.map(value => (value == null ? '—' : value)).join(' | ')} |`);
  lines.push('', '## Worst 10', '');
  for (const cell of cells) {
    lines.push(`### ${cell.id}`, '');
    for (const row of cell.worst) lines.push(`- ${row.symbol} ${row.signalDate} → ${row.exitDate}: ${(row.ret * 100).toFixed(2)}% ($${(row.ret * 30000).toFixed(0)})`);
    lines.push('');
  }
  lines.push('## Sanity names', '', '| Variant | Symbol | Signal | Exit | Excess | P&L |', '| --- | --- | --- | --- | ---: | ---: |');
  for (const row of sanity.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.signalDate.localeCompare(b.signalDate))) {
    lines.push(`| ${row.variant} | ${row.symbol} | ${row.signalDate} | ${row.exitDate} | ${(row.ret * 100).toFixed(2)}% | $${(row.ret * 30000).toFixed(0)} |`);
  }
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify({ generatedAt: new Date().toISOString(), preregistration: 'fa0d5c5b520a2607ba509f4d5b0fd610537f9080', cells: cells.map(cell => ({ ...cell, monthlyReturns: undefined })), sanity }, null, 2)}\n`);
  console.log(`wrote ${OUT_MD}`);
}

main();
