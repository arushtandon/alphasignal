'use strict';

// Research only. Executable long momentum: each month buy the top k names
// not already held, $30k each, hold six months, no stops. Dated 2026-10-06.
const fs = require('fs');
const path = require('path');
const { estimateRoundTripCostPct } = require('../lib/research/cost-model');
const {
  momentumRank, scoreSample, monthStops, indexOf, priceReturn, pack, workerSymbols,
} = require('./run-strategy-amendment');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const PRICE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const OUT = path.join(ROOT, 'scripts', 'executable-momentum-results.json');
const READOUT = path.join(ROOT, 'docs', 'new-strategy-types-readout.md');

function loadIndex(market, snapshot, benchmarkSymbol) {
  const symbols = new Set(snapshot.currentSymbols);
  for (const change of snapshot.historicalMembership.changes) {
    if (change.added) symbols.add(change.added);
    if (change.removed) symbols.add(change.removed);
  }
  const scores = workerSymbols(market);
  const benchmark = pack(JSON.parse(fs.readFileSync(path.join(PRICE, `${benchmarkSymbol}.json`), 'utf8')).bars);
  const books = new Map();
  for (const symbol of symbols) {
    const file = path.join(PRICE, `${symbol.replace(/[\\/]/g, '_')}.json`);
    if (!fs.existsSync(file)) continue;
    const series = pack(JSON.parse(fs.readFileSync(file, 'utf8')).bars);
    if (series.dates.length < 260) continue;
    series.scores = scores.get(symbol)?.scores || [];
    books.set(symbol, series);
  }
  return { books, benchmark };
}

function runExecutable(market, snapshot, loaded, k) {
  const slots = 6 * k;
  const holdMonths = 6;
  const drag = estimateRoundTripCostPct({ market }) / 100 / holdMonths;
  const { books, benchmark } = loaded;
  const stops = monthStops(benchmark);
  const held = [];
  const periods = [];
  const trades = [];
  const variant = {
    market, horizon: 'long', quality: false, regime: false, top: 999,
    membership: snapshot, membershipStart: '2010-01-01',
    strategy: `Executable 12-1 momentum, k=${k}, hold 6 months`,
  };
  for (let cursor = 0; cursor < stops.length - 1; cursor++) {
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
      if (cursor + 1 === name.start + holdMonths) {
        const exitAt = stops[Math.min(name.start + holdMonths, stops.length - 1)];
        const life = priceReturn(name.series, name.at, indexOf(name.series, benchmark.dates[exitAt]));
        if (life != null) trades.push({ date: benchmark.dates[exitAt], ret: life - drag * holdMonths });
      }
    }
    periods.push({ date: benchmark.dates[next], ret: sum / slots });
  }
  const scored = scoreSample(variant, benchmark, periods, trades.filter(row => Number.isFinite(row.ret)), []);
  return {
    id: `${market}__long__k${k}`,
    market,
    k,
    slots,
    strategy: variant.strategy,
    ...scored,
  };
}

function main() {
  const ftse = JSON.parse(fs.readFileSync(path.join(DIR, 'ftse100.json'), 'utf8'));
  const cac = JSON.parse(fs.readFileSync(path.join(DIR, 'cac40.json'), 'utf8'));
  const loaded = {
    UK: loadIndex('UK', ftse, 'EWU'),
    France: loadIndex('France', cac, 'EWQ'),
  };
  const rows = [];
  for (const [market, snapshot] of [['UK', ftse], ['France', cac]]) {
    for (const k of [1, 2]) {
      const row = runExecutable(market, snapshot, loaded[market], k);
      rows.push(row);
      console.log(`[${row.verdict}] ${row.id} ret=${row.overall.returnPct} bench=${row.overall.benchmarkReturnPct} dd=${row.maxDrawdownPct} worst=${row.worstMonth && row.worstMonth.returnPct}`);
    }
  }
  fs.writeFileSync(OUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: 'PASS or CANDIDATE also needs a positive full-sample return that beats the benchmark',
    liveBehaviorChanged: false,
    rows: rows.map(row => ({ ...row, windows: row.windows })),
  }, null, 2)}\n`);
  const lines = [
    '',
    '## Executable momentum 2026-10-06',
    '',
    'Point-in-time membership. Each month buy the top k names by 12-1 momentum that are not already held, hold six months, no stops. Empty slots earn 0, so the book return is the sum of open-name returns divided by 6×k. A pass or candidate also needs a positive full-sample return above the benchmark. Not implemented from this run unless a k=1 row passes.',
    '',
    '| Market | k | Slots | Verdict | Full sample | Benchmark | Max DD | Worst month | Beat windows |',
    '| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const row of rows) {
    const beats = (row.windows || []).filter(window => window.beat).length;
    lines.push(`| ${row.market} | ${row.k} | ${row.slots} | ${row.verdict} | ${row.overall.returnPct}% | ${row.overall.benchmarkReturnPct}% | ${row.maxDrawdownPct}% | ${row.worstMonth ? `${row.worstMonth.date} ${row.worstMonth.returnPct}%` : '—'} | ${beats}/4 |`);
  }
  lines.push('', '### Per year vs benchmark', '');
  for (const row of rows) {
    lines.push(`#### ${row.market} k=${row.k}`, '', '| Year | Strategy | Benchmark |', '| --- | ---: | ---: |');
    for (const year of row.years || []) lines.push(`| ${year.year} | ${year.returnPct}% | ${year.benchmarkReturnPct}% |`);
    lines.push('');
  }
  const prior = fs.readFileSync(READOUT, 'utf8').split('\n## Executable momentum 2026-10-06')[0].trimEnd();
  fs.writeFileSync(READOUT, `${prior}\n${lines.join('\n')}\n`);
}

main();
