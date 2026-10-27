#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '0';

const fs = require('fs');
const path = require('path');
const { metric } = require('../lib/research/consistency-study');
const {
  backtestSignal,
  buildMarketRegime,
  dailyToWeeklyBars,
  fetchOHLCV,
} = require('../server');
const { STATIC_GROUPS } = require('../universe');

const ROOT = path.join(__dirname, '..');
const WORKERS = path.join(
  ROOT,
  'scripts',
  'performance-stage1-v2-checkpoint.json.workers',
  'stage1',
);
const CONSISTENCY_RESULTS = path.join(ROOT, 'scripts', 'consistency-study-results.json');
const OUTPUT = path.join(ROOT, 'scripts', 'long-trend-entry-window-results.json');
const READOUT = path.join(ROOT, 'docs', 'long-trend-entry-window-readout.md');
const MARKETS = ['Japan', 'Hong Kong', 'Germany', 'France', 'Commodities', 'India'];
const FILE_MARKET = {
  Japan: 'Japan',
  'Hong Kong': 'Hong_Kong',
  Germany: 'Germany',
  France: 'France',
  Commodities: 'Commodities',
  India: 'India',
};
const EXTRA_COMMODITIES = [
  'ZW=F', 'ZC=F', 'ZS=F', 'GLD', 'SLV', 'USO', 'UNG', 'DBC',
  'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX',
];
const FETCHED_UNIVERSES = {
  India: [...new Set(STATIC_GROUPS.NIFTY50)],
  Commodities: [...new Set((STATIC_GROUPS.COMMODITIES || [])
    .filter(symbol => !symbol.endsWith('-USD')).concat(EXTRA_COMMODITIES))],
};
const BENCHMARK = { India: 'INDA', Commodities: 'DBC' };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function dateFrom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString().slice(0, 10);
}

function barDate(bar) {
  return dateFrom(bar?.t);
}

function normalize(raw, context) {
  const bars = context.bars || [];
  return {
    ...raw,
    market: context.market,
    symbol: context.symbol,
    signalDate: raw.signalDate || dateFrom(raw.signalTs) || barDate(bars[raw.signalIndex]),
    entryDate: raw.entryDate || dateFrom(raw.entryTs) || barDate(bars[raw.entryIndex]),
    exitDate: raw.exitDate || dateFrom(raw.exitTs) || barDate(bars[raw.exitIndex]),
  };
}

function globallyNonOverlapping(rows) {
  const locked = new Map();
  return rows
    .filter(row => row.entryDate && row.exitDate && Number.isFinite(Number(row.ret)))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate)
      || String(a.symbol).localeCompare(String(b.symbol)))
    .filter(row => {
      const previousExit = locked.get(row.symbol);
      if (previousExit && row.entryDate <= previousExit) return false;
      locked.set(row.symbol, row.exitDate);
      return true;
    });
}

function loadMarketTrades(market) {
  const prefix = `${FILE_MARKET[market]}__long__`;
  const rows = [];
  for (const file of fs.readdirSync(WORKERS)
    .filter(name => name.startsWith(prefix) && name.endsWith('.result.json'))
    .sort()) {
    const result = readJson(path.join(WORKERS, file)).result;
    if (result?.outcome !== 'success' || !result.context) continue;
    const context = { ...result.context, market };
    for (const raw of result.eventSets?.primary?.buy || []) {
      rows.push(normalize(raw, context));
    }
  }
  return globallyNonOverlapping(rows);
}

async function mapLimit(values, limit, operation) {
  let cursor = 0;
  const output = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await operation(values[index]);
    }
  }));
  return output;
}

async function replayFetchedMarket(market) {
  const benchmarkBars = await fetchOHLCV(BENCHMARK[market], '10y', '1d');
  if (!benchmarkBars?.length) throw new Error(`${market}: missing benchmark data.`);
  const marketSeries = buildMarketRegime(benchmarkBars);
  const results = await mapLimit(FETCHED_UNIVERSES[market], 8, async symbol => {
    const bars = await fetchOHLCV(symbol, '10y', '1d').catch(() => null);
    if (!bars?.length) return [];
    const result = await backtestSignal(
      bars,
      'long',
      dailyToWeeklyBars(bars),
      null,
      {
        symbol,
        market,
        marketSeries,
        windowBars: bars.length,
        entryStep: 2,
        allowOverlapping: true,
        closedOnly: true,
        stopFirst: true,
      },
    );
    return (result?.tradeResults || [])
      .filter(row => row.side === 'buy')
      .map(row => ({
        ...row,
        market,
        symbol,
        signalDate: barDate(bars[row.signalIndex]),
        entryDate: barDate(bars[row.entryIndex]),
        exitDate: barDate(bars[row.exitIndex]),
      }));
  });
  return globallyNonOverlapping(results.flat());
}

function scoreWindow(rows, window) {
  const selected = rows.filter(row =>
    row.entryDate >= window.range.from && row.entryDate <= window.range.to);
  return {
    fold: window.fold,
    range: window.range,
    exitContainmentRequired: false,
    ...metric(selected),
  };
}

async function main() {
  const consistency = readJson(CONSISTENCY_RESULTS);
  const commonWindows = consistency.cells.find(cell =>
    cell.id === 'B__Japan__long__sector_off')?.windows;
  if (!Array.isArray(commonWindows) || commonWindows.length !== 4) {
    throw new Error('Frozen four-window long-horizon ranges are unavailable.');
  }

  const tradeMap = new Map();
  for (const market of MARKETS) {
    const cached = loadMarketTrades(market);
    tradeMap.set(
      market,
      cached.length || !FETCHED_UNIVERSES[market]
        ? cached
        : await replayFetchedMarket(market),
    );
  }
  const markets = MARKETS.map(market => ({
    market,
    trades: tradeMap.get(market).length,
    windows: commonWindows.map(window => scoreWindow(tradeMap.get(market), window)),
  }));
  const pooledRows = MARKETS.flatMap(market => tradeMap.get(market));
  const pooled = commonWindows.map(window => scoreWindow(pooledRows, window));
  const eligible = pooled.every(window =>
    window.trades > 0 && window.pnlUsd > 0 && window.profitFactor >= 1.2);

  const report = {
    generatedAt: new Date().toISOString(),
    amendmentFrozenAt: '2026-10-05T15:34:00+08:00',
    engine: 'exact live trend engine; long; buy; sector overlay OFF',
    scoring: 'entry date selects the window; exit may follow the window; 180-session embargo retained',
    source: 'performance-stage1-v2 cached exact-live event sets',
    markets,
    pooled: {
      markets: MARKETS,
      trades: pooledRows.length,
      windows: pooled,
      eligible,
      rule: 'positive PnL and PF >= 1.2 in every pooled window',
    },
  };
  writeJson(OUTPUT, report);

  const marketLines = markets.flatMap(result => result.windows.map(window =>
    `| ${result.market} | ${window.fold} | ${window.trades} | ${window.pnlUsd} | ${window.profitFactor ?? '—'} |`));
  const pooledLines = pooled.map(window =>
    `| ${window.fold} | ${window.trades} | ${window.pnlUsd} | ${window.profitFactor ?? '—'} |`);
  fs.writeFileSync(READOUT, [
    '# Long-trend entry-window amendment replay',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    report.scoring,
    '',
    '## Per market',
    '| Market | Window | Trades | PnL USD | PF |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...marketLines,
    '',
    '## Pooled six-market book',
    '| Window | Trades | PnL USD | PF |',
    '| ---: | ---: | ---: | ---: |',
    ...pooledLines,
    '',
    `LONG_TREND_SECTOR_OFF eligible: **${eligible ? 'YES' : 'NO'}**`,
    '',
  ].join('\n'));
  console.log(JSON.stringify(report.pooled, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
