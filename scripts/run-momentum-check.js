'use strict';

// Research only. Does not write the momentum state or the 2 November book.
const fs = require('fs');
const path = require('path');
const { tStat, maxDrawdown, compound } = require('../lib/research/strategy-gaps');
const { membershipAt } = require('../lib/research/us-universe');
const {
  runMomentum, momentumRank, monthStops, indexOf, priceReturn, pack,
} = require('./run-strategy-amendment');
const { estimateRoundTripCostPct } = require('../lib/research/cost-model');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const PRICE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const OUT = path.join(ROOT, 'docs', 'momentum-check-2026-10-07.md');

function everMembers(snapshot) {
  const ever = new Set(snapshot.currentSymbols || []);
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
    if (change.date) {
      const members = membershipAt(snapshot, change.date);
      if (members) for (const symbol of members) ever.add(symbol);
    }
  }
  return ever;
}
function hasPrice(symbol) {
  return fs.existsSync(path.join(PRICE, `${symbol.replace(/[\\/]/g, '_')}.json`));
}
function loadIndex(snapshot, benchmarkSymbol) {
  const symbols = everMembers(snapshot);
  const benchmark = pack(JSON.parse(fs.readFileSync(path.join(PRICE, `${benchmarkSymbol}.json`), 'utf8')).bars);
  const books = new Map();
  for (const symbol of symbols) {
    const file = path.join(PRICE, `${symbol.replace(/[\\/]/g, '_')}.json`);
    if (!fs.existsSync(file)) continue;
    const series = pack(JSON.parse(fs.readFileSync(file, 'utf8')).bars);
    if (series.dates.length < 260) continue;
    books.set(symbol, series);
  }
  return { books, benchmark, candidates: symbols.size };
}
function benchMonths(benchmark, periods) {
  const byMonth = new Map();
  for (let index = 1; index < benchmark.dates.length; index += 1) {
    const prev = benchmark.open[index - 1];
    const next = benchmark.open[index];
    if (!(prev > 0) || !Number.isFinite(next)) continue;
    const month = benchmark.dates[index].slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(next / prev - 1);
  }
  return periods.map(row => {
    const bucket = byMonth.get(String(row.date).slice(0, 7)) || [];
    return bucket.reduce((equity, value) => equity * (1 + value), 1) - 1;
  });
}
function oneFactor(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 6) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    sx += x[index];
    sy += y[index];
    sxx += x[index] * x[index];
    sxy += x[index] * y[index];
  }
  const denom = n * sxx - sx * sx;
  if (!(Math.abs(denom) > 1e-18)) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  let sse = 0;
  for (let index = 0; index < n; index += 1) {
    const error = y[index] - alpha - beta * x[index];
    sse += error * error;
  }
  const xBar = sx / n;
  const sxxDev = sxx - sx * sx / n;
  const variance = sse / (n - 2);
  const se = Math.sqrt(Math.max(0, variance) * (1 / n + (xBar * xBar) / sxxDev));
  return {
    alphaAnnual: alpha * 12,
    t: se > 0 ? alpha / se : null,
    beta,
    n,
  };
}
function executablePeriods(market, snapshot, loaded, k) {
  const slots = 6 * k;
  const holdMonths = 6;
  const drag = estimateRoundTripCostPct({ market }) / 100 / holdMonths;
  const { books, benchmark } = loaded;
  const stops = monthStops(benchmark);
  const held = [];
  const periods = [];
  const variant = {
    market, horizon: 'long', quality: false, regime: false, top: 999,
    membership: snapshot, membershipStart: '2010-01-01',
  };
  for (let cursor = 0; cursor < stops.length - 1; cursor += 1) {
    const next = stops[cursor + 1];
    const ranked = momentumRank(books, benchmark, stops[cursor], variant);
    const open = held.filter(row => cursor >= row.start && cursor < row.start + holdMonths);
    const buys = ranked.filter(row => !open.some(heldRow => heldRow.symbol === row.symbol)).slice(0, k);
    for (const name of buys) held.push({ ...name, start: cursor });
    const active = held.filter(row => cursor >= row.start && cursor < row.start + holdMonths);
    let sum = 0;
    for (const name of active) {
      const gross = priceReturn(
        name.series,
        indexOf(name.series, benchmark.dates[stops[cursor]]),
        indexOf(name.series, benchmark.dates[next]),
      );
      if (gross == null) continue;
      sum += gross - drag;
    }
    periods.push({ date: benchmark.dates[next], ret: sum / slots });
  }
  return periods;
}
function plainPeriods(market, snapshot, loaded) {
  const variant = {
    id: `${market}-plain`,
    part: 'B',
    market,
    horizon: 'long',
    quality: false,
    regime: false,
    benchmark: market === 'UK' ? 'EWU' : 'EWQ',
    top: 10,
    membership: snapshot,
    membershipStart: '2010-01-01',
    strategy: '12-1 momentum',
    keepPeriods: true,
  };
  const scored = runMomentum(variant, loaded);
  return scored.periods || [];
}

function main() {
  const ftse = JSON.parse(fs.readFileSync(path.join(DIR, 'ftse100.json'), 'utf8'));
  const cac = JSON.parse(fs.readFileSync(path.join(DIR, 'cac40.json'), 'utf8'));
  const loaded = {
    UK: loadIndex(ftse, 'EWU'),
    France: loadIndex(cac, 'EWQ'),
  };
  const lines = [
    '# UK and France momentum check',
    '',
    'Research only. The books and the 2 November run were not changed.',
    'Plain 12-1 is the top 10 names, six-month hold. k=1 buys the top name not already held, $30,000 is the slot count of 6, and empty slots earn 0.',
    '',
  ];
  for (const [market, snapshot, benchName] of [['UK', ftse, 'EWU'], ['France', cac, 'EWQ']]) {
    const packLoaded = loaded[market];
    const books = [
      ['12-1 plain', plainPeriods(market, snapshot, packLoaded)],
      ['k=1', executablePeriods(market, snapshot, packLoaded, 1)],
    ];
    const ever = everMembers(snapshot);
    const former = [...ever].filter(symbol => !(snapshot.currentSymbols || []).includes(symbol));
    lines.push(`## ${market} vs ${benchName}`, '');
    lines.push(`Ever-members ${ever.size}. Current ${snapshot.currentSymbols.length}. Former members ${former.length}, of which ${former.filter(hasPrice).length} have a price file. Candidates used in the rank are the ever-member set.`, '');
    lines.push('| Year | Members | With prices | Missing |');
    lines.push('| --- | ---: | ---: | ---: |');
    const years = [...new Set((snapshot.historicalMembership.changes || []).map(row => String(row.date).slice(0, 4)))].sort();
    const first = Number(years[0]);
    const last = Number(years[years.length - 1]);
    for (let year = first; year <= last; year += 1) {
      const members = membershipAt(snapshot, `${year}-12-31`);
      let priced = 0;
      for (const symbol of members) if (hasPrice(symbol)) priced += 1;
      lines.push(`| ${year} | ${members.size} | ${priced} | ${members.size - priced} |`);
    }
    lines.push('');
    lines.push('| Book | Excess t | Alpha ann. | Alpha t | Beta | Book max DD | Benchmark max DD |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [label, periods] of books) {
      const y = periods.map(row => row.ret);
      const x = benchMonths(packLoaded.benchmark, periods);
      const excess = tStat(y.map((value, index) => value - x[index]));
      const fit = oneFactor(y, x);
      const bookDd = maxDrawdown(y);
      const benchDd = maxDrawdown(x);
      lines.push(`| ${label} | ${excess.t == null ? '—' : excess.t.toFixed(2)} | ${fit ? `${(fit.alphaAnnual * 100).toFixed(2)}%` : '—'} | ${fit && fit.t != null ? fit.t.toFixed(2) : '—'} | ${fit ? fit.beta.toFixed(2) : '—'} | ${(bookDd * 100).toFixed(2)}% | ${(benchDd * 100).toFixed(2)}% |`);
      console.log(market, label, 'months', periods.length, 'excess t', excess.t && excess.t.toFixed(2), 'full', (compound(y) * 100).toFixed(2));
    }
    if (market === 'UK') {
      lines.push('## UK sub-periods', '');
      lines.push('Same books, sliced from the month. The live book was not changed.', '');
      lines.push('| Book | From | Excess t | Alpha ann. | Alpha t |');
      lines.push('| --- | --- | ---: | ---: | ---: |');
      for (const [label, periods] of books) {
        for (const start of ['2018-01-01', '2021-01-01']) {
          const slice = periods.filter(row => row.date >= start);
          const y = slice.map(row => row.ret);
          const x = benchMonths(packLoaded.benchmark, slice);
          const excess = tStat(y.map((value, index) => value - x[index]));
          const fit = oneFactor(y, x);
          lines.push(`| ${label} | ${start.slice(0, 7)} | ${excess.t == null ? '—' : excess.t.toFixed(2)} | ${fit ? `${(fit.alphaAnnual * 100).toFixed(2)}%` : '—'} | ${fit && fit.t != null ? fit.t.toFixed(2) : '—'} |`);
        }
      }
      lines.push('');
    }
    lines.push('');
  }
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`wrote ${OUT}`);
}

main();
