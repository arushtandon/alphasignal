#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '3998';

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { fetchOHLCV, buildMarketRegime } = require('../server');
const { STATIC_GROUPS } = require('../universe');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { buildDateAlignedFolds, assertFoldIsolation } = require('../lib/research/walk-forward-optimizer');
const { scoreVariant, applyBh, metric, FOLD_SPEC, EMBARGO } = require('../lib/research/consistency-study');
const {
  STUDY_ID, MARKETS, HORIZONS, TRIGGERS, REGIMES, STOPS, TIME_STOPS,
  HEDGE_ETFS, EXPECTED_BH_FAMILY_SIZE, registry, sellSignalAt, simulateSellTrade,
  confirmedDowntrend,
} = require('../lib/research/regime-sell-hedge');

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'scripts', 'regime-sell-hedge-results.json');
const READOUT = path.join(ROOT, 'docs', 'regime-sell-hedge-readout.md');
const CHECKPOINT = path.join(ROOT, 'scripts', 'regime-sell-hedge-checkpoint.json');
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
const BENCHMARK = {
  US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH', UK: 'EWU',
  Germany: 'EWG', France: 'EWQ', India: 'INDA', Commodities: 'DBC',
  Crypto: 'BTC-USD',
};
const EXTRA_COMMODITIES = [
  'ZW=F', 'ZC=F', 'ZS=F', 'GLD', 'SLV', 'USO', 'UNG', 'DBC',
  'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX',
];
const UNIVERSES = {
  US: US_SNAPSHOT.candidateSymbols,
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)],
  'Hong Kong': [...new Set(STATIC_GROUPS.HSI)],
  UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)],
  France: [...new Set(STATIC_GROUPS.CAC40)],
  India: [...new Set(STATIC_GROUPS.NIFTY50)],
  Commodities: [...new Set((STATIC_GROUPS.COMMODITIES || [])
    .filter(symbol => !symbol.endsWith('-USD')).concat(EXTRA_COMMODITIES))],
  Crypto: ['BTC-USD', 'ETH-USD'],
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function dateOf(bar) {
  const value = Number(bar?.t);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}

async function main() {
  const definitions = registry();
  let saved = null;
  try { saved = readJson(CHECKPOINT); } catch (_) {}
  const cells = saved?.study === STUDY_ID && Array.isArray(saved.cells) ? saved.cells : [];
  const done = new Set(cells.map(cell => cell.id));
  const priceCache = new Map();
  const loadPrice = async symbol => {
    if (!priceCache.has(symbol)) {
      priceCache.set(symbol, fetchOHLCV(symbol, '10y', '1d').catch(() => null));
    }
    return priceCache.get(symbol);
  };

  for (const market of MARKETS) {
    const pending = definitions.filter(row => row.part === 'A' && row.market === market && !done.has(row.id));
    if (!pending.length) continue;
    console.log(`[sell] ${market}: ${pending.length} variants`);
    const benchmarkBars = await loadPrice(BENCHMARK[market]);
    if (!benchmarkBars?.length) throw new Error(`${market}: missing benchmark`);
    const folds = buildDateAlignedFolds(benchmarkBars.map(dateOf), {
      ...FOLD_SPEC, embargoBars: EMBARGO.medium,
    });
    assertFoldIsolation(folds);
    const benchIndex = new Map(benchmarkBars.map((bar, index) => [dateOf(bar), index]));
    const events = new Map(pending.map(row => [row.id, []]));
    for (const symbol of UNIVERSES[market] || []) {
      if (market === 'US' && !US_SNAPSHOT.candidateSymbols.includes(symbol)) continue;
      const bars = await loadPrice(symbol);
      if (!bars || bars.length < 400) continue;
      for (let index = 270; index < bars.length - 2; index++) {
        const signalDate = dateOf(bars[index]);
        if (market === 'US' && !membershipAt(US_SNAPSHOT, signalDate).has(symbol)) continue;
        const benchAt = benchIndex.get(signalDate);
        if (benchAt == null) continue;
        for (const definition of pending) {
          if (!sellSignalAt(bars, index, definition, benchmarkBars, benchAt)) continue;
          const trade = simulateSellTrade(bars, index, definition, { market, symbol });
          if (!trade) continue;
          events.get(definition.id).push({
            ...trade,
            symbol,
            signalDate,
            entryDate: dateOf(bars[trade.entryIndex]),
            exitDate: dateOf(bars[trade.exitIndex]),
          });
        }
      }
    }
    for (const definition of pending) {
      cells.push(scoreVariant(
        definition,
        events.get(definition.id) || [],
        folds,
        market === 'US' ? 'POINT_IN_TIME' : (market === 'Commodities' || market === 'Crypto'
          ? 'NOT_APPLICABLE' : 'SURVIVORSHIP_BIAS'),
      ));
      done.add(definition.id);
    }
    writeJson(CHECKPOINT, { study: STUDY_ID, state: 'running', cells });
  }

  for (const definition of definitions.filter(row => row.part === 'B' && !done.has(row.id))) {
    cells.push({
      ...definition,
      consistent: false,
      note: 'Hedge overlay uses the live buy-book exposure series; scored after sell grid.',
      windows: [],
      pooledDevelopment: metric([]),
      finalWindow: { status: 'OVERLAP_RISK', metrics: metric([]) },
    });
  }
  applyBh(cells);
  const report = {
    generatedAt: new Date().toISOString(),
    study: STUDY_ID,
    mode: 'RESEARCH_ONLY',
    liveBehaviorChanged: false,
    flagsEnabled: [],
    methodology: {
      preregistration: 'docs/regime-sell-hedge-preregistration.md',
      bhFamilySize: cells.length,
      expectedBhFamilySize: EXPECTED_BH_FAMILY_SIZE,
    },
    cells,
    consistentCount: cells.filter(cell => cell.consistent).length,
  };
  writeJson(OUTPUT, report);
  fs.writeFileSync(READOUT, [
    '# Regime-gated sells and index hedge',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'Research only. No sell or hedge book was enabled.',
    `Variants=${cells.length} CONSISTENT=${report.consistentCount}`,
    '',
  ].join('\n'));
  writeJson(CHECKPOINT, { study: STUDY_ID, state: 'complete', cells: cells.length });
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} Variants=${cells.length} CONSISTENT=${report.consistentCount}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
