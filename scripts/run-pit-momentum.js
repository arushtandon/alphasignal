'use strict';

// Research only. Re-scores UK and France momentum with point-in-time index membership.
const fs = require('fs');
const path = require('path');
const { membershipAt } = require('../lib/research/us-universe');
const { runMomentum, cachedChart, pack, workerSymbols } = require('./run-strategy-amendment');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const PRIOR = path.join(ROOT, 'scripts', 'strategy-amendment-results.json');
const OUT = path.join(ROOT, 'scripts', 'pit-membership-results.json');
const READOUT = path.join(ROOT, 'docs', 'new-strategy-types-readout.md');

function symbolsOf(snapshot) {
  const symbols = new Set(snapshot.currentSymbols);
  for (const change of snapshot.historicalMembership.changes) {
    if (change.added) symbols.add(change.added);
    if (change.removed) symbols.add(change.removed);
  }
  return [...symbols];
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
function fileOf(symbol) {
  return path.join(ROOT, 'data', 'research', 'strategy-amendment-prices', `${symbol.replace(/[\\/]/g, '_')}.json`);
}

async function loadIndex(market, snapshot, benchmarkSymbol) {
  const symbols = symbolsOf(snapshot);
  const scores = workerSymbols(market);
  console.log(`[fetch] ${market} ${symbols.length}`);
  await mapLimit(symbols, 6, symbol => cachedChart(symbol));
  const benchmark = pack(JSON.parse(fs.readFileSync(fileOf(benchmarkSymbol), 'utf8')).bars);
  const books = new Map();
  let priced = 0;
  for (const symbol of symbols) {
    const file = fileOf(symbol);
    if (!fs.existsSync(file)) continue;
    const series = pack(JSON.parse(fs.readFileSync(file, 'utf8')).bars);
    if (series.dates.length < 260) continue;
    series.scores = scores.get(symbol)?.scores || [];
    books.set(symbol, series);
    priced += 1;
  }
  console.log(`[load] ${market} priced ${priced} of ${symbols.length} from ${books.size ? 'ok' : 'empty'}`);
  return { books, benchmark, priced, symbols: symbols.length };
}

function variants(market, benchmark, snapshot) {
  const rows = [];
  for (const horizon of ['medium', 'long']) {
    for (const quality of [false, true]) {
      for (const regime of [false, true]) {
        rows.push({
          id: `B__${market}__${horizon}__${quality ? 'piotroski6' : 'momentum'}__regime${regime ? 'on' : 'off'}`,
          part: 'B', market, horizon, quality, regime, benchmark,
          top: 10,
          membership: snapshot,
          membershipStart: '2010-01-01',
          strategy: `12-1 momentum${quality ? ' among Piotroski ≥ 6' : ''}${regime ? ', cash below 200-day MA' : ''}`,
        });
      }
    }
  }
  return rows;
}

function line(row) {
  const beats = (row.windows || []).filter(window => window.beat).length;
  return `| ${row.market} | ${row.horizon} | ${row.strategy} | ${row.verdict} | ${row.overall?.returnPct ?? '—'}% | ${row.maxDrawdownPct ?? '—'}% | ${row.worstMonth ? `${row.worstMonth.date} ${row.worstMonth.returnPct}%` : '—'} | ${beats}/4 |`;
}

async function main() {
  const ftse = JSON.parse(fs.readFileSync(path.join(DIR, 'ftse100.json'), 'utf8'));
  const cac = JSON.parse(fs.readFileSync(path.join(DIR, 'cac40.json'), 'utf8'));
  const prior = JSON.parse(fs.readFileSync(PRIOR, 'utf8'));
  const priorById = new Map(prior.rows.map(row => [row.id, row]));
  const uk = await loadIndex('UK', ftse, 'EWU');
  const france = await loadIndex('France', cac, 'EWQ');
  const rows = [];
  for (const [loaded, market, snapshot, benchmark] of [[uk, 'UK', ftse, 'EWU'], [france, 'France', cac, 'EWQ']]) {
    for (const variant of variants(market, benchmark, snapshot)) {
      const scored = runMomentum(variant, loaded);
      const row = {
        id: variant.id,
        market,
        horizon: variant.horizon,
        strategy: variant.strategy,
        ...scored,
        membershipCount2010: membershipAt(snapshot, '2010-01-04').size,
        pricedNames: loaded.priced,
        universeNames: loaded.symbols,
      };
      delete row.windows;
      row.windows = scored.windows;
      const before = priorById.get(variant.id);
      row.prior = before ? {
        verdict: before.verdict,
        returnPct: before.overall?.returnPct,
        maxDrawdownPct: before.maxDrawdownPct,
        worstMonth: before.worstMonth,
        beats: (before.windows || []).filter(window => window.beat).length,
      } : null;
      rows.push(row);
      console.log(`[${row.verdict}] ${row.id} was ${row.prior && row.prior.verdict} ret ${row.overall.returnPct} was ${row.prior && row.prior.returnPct}`);
    }
  }
  fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  const lines = [
    '',
    '## Point-in-time membership 2026-10-06',
    '',
    'UK uses the FTSE Russell additions and deletions file through 22 June 2026, with the Wikipedia constituent list after 1 October 2026 as the end set. Replayed membership is 100 names at the end and 107 on 4 January 2010. The seven-name gap is unmatched ticker changes, mostly renames and reviews after that file. France uses the public CAC 40 admission and removal archive. Replayed membership is 40 names at both ends. Former members are included when Yahoo has a price history. Piotroski still requires a point-in-time score file, and former members usually do not have one.',
    '',
    '| Market | Horizon | Strategy | PIT verdict | PIT return | PIT max DD | PIT worst month | PIT beat | Prior verdict | Prior return |',
    '| --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | ---: |',
  ];
  for (const row of rows) {
    lines.push(`${line(row).replace(/\|$/, '')} | ${row.prior ? row.prior.verdict : '—'} | ${row.prior ? `${row.prior.returnPct}%` : '—'} |`);
  }
  lines.push('', `UK prices ${uk.priced} of ${uk.symbols}. France prices ${france.priced} of ${france.symbols}.`, '');
  const priorText = fs.readFileSync(READOUT, 'utf8').split('\n## Point-in-time membership 2026-10-06')[0].trimEnd();
  fs.writeFileSync(READOUT, `${priorText}\n${lines.join('\n')}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
