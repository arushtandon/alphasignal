#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '3998';

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const {
  backtestSignal,
  buildMarketRegime,
  dailyToWeeklyBars,
  fetchOHLCV,
  sectorEtfForSymbol,
} = require('../server');
const { STATIC_GROUPS } = require('../universe');
const { buildDateAlignedFolds, assertFoldIsolation } = require('../lib/research/walk-forward-optimizer');
const { scoreAtDecision } = require('../lib/research/pit-quality');
const { signalAt, simulateTrade: simulateMeanReversion } = require('../lib/research/mean-reversion');
const {
  MODELS, candidateTrades: waveTrades, dateIndex,
} = require('./backtest-factor-combinations');
const {
  STUDY_ID, HOLDOUT_STATUS, EMBARGO, FOLD_SPEC, REGIME_VARIANTS, MR_MODELS,
  setupRegistry, dedupeTrades, metricSummary, exactBinomialP,
  applyBenjaminiHochberg, passingMetrics, classifyVerdict, rejectionReason, perYear,
} = require('../lib/research/validated-setup-book');

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value ?? '1'];
}));
const WORKER_ROOT = path.resolve(ROOT, args.workerRoot
  || 'scripts/performance-stage1-v2-checkpoint.json.workers/stage1');
const OUTPUT = path.resolve(ROOT, args.output || 'scripts/validated-setup-book-results.json');
const READOUT = path.resolve(ROOT, args.readout || 'docs/validated-setup-book-readout.md');
const CHECKPOINT = path.resolve(ROOT, args.checkpoint || 'scripts/validated-setup-book-checkpoint.json');
const NOTIONAL = 10_000;
const MARKET_FILE = {
  US: 'US', UK: 'UK', Japan: 'Japan', Germany: 'Germany',
  France: 'France', Commodities: 'Commodities',
};
const LISTING = {
  US: { currency: 'USD', scale: 1 },
  UK: { currency: 'GBP', scale: 0.01 },
  Japan: { currency: 'JPY', scale: 1 },
  Germany: { currency: 'EUR', scale: 1 },
  France: { currency: 'EUR', scale: 1 },
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
function tradeDate(value) {
  if (value == null) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const number = Number(value);
  return Number.isFinite(number)
    ? new Date(number < 1e12 ? number * 1000 : number).toISOString().slice(0, 10)
    : null;
}
function normalizeTrade(row) {
  return {
    ...row,
    signalDate: tradeDate(row.signalDate ?? row.signalTs ?? row.entryDate ?? row.entryTs),
    entryDate: tradeDate(row.entryDate ?? row.entryTs),
    exitDate: tradeDate(row.exitDate ?? row.exitTs),
  };
}
function inRange(date, range) {
  return date != null && date >= range.from && date <= range.to;
}
function monthsInRange(range) {
  const start = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  return Math.max(1, (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + end.getUTCMonth() - start.getUTCMonth() + 1);
}
function resultFiles(market, horizon) {
  const prefix = `${MARKET_FILE[market]}__${horizon}__`;
  return fs.readdirSync(WORKER_ROOT)
    .filter(file => file.startsWith(prefix) && file.endsWith('.result.json'))
    .sort();
}
function eachCachedResult(market, horizon, callback) {
  const files = resultFiles(market, horizon);
  for (const file of files) {
    const payload = readJson(path.join(WORKER_ROOT, file)).result;
    if (payload?.outcome === 'success' && payload.context?.bars?.length) callback(payload, file);
  }
  return files.length;
}
function firstContext(market, horizon) {
  for (const file of resultFiles(market, horizon)) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    if (result?.outcome === 'success' && result.context?.bars?.length) return result.context;
  }
  return null;
}
function foldsFor(market, horizon, benchmarkBars) {
  const folds = buildDateAlignedFolds((benchmarkBars || []).map(dateOf), {
    ...FOLD_SPEC,
    embargoBars: EMBARGO[horizon],
  });
  assertFoldIsolation(folds);
  if (folds.length !== FOLD_SPEC.folds) {
    throw new Error(`${market} ${horizon} produced ${folds.length} folds; expected ${FOLD_SPEC.folds}.`);
  }
  return folds;
}
function nonOverlapping(trades, range) {
  const locked = new Map();
  return (trades || [])
    .filter(row => inRange(row.signalDate, range) && inRange(row.exitDate, range))
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate)
      || String(a.symbol).localeCompare(String(b.symbol)))
    .filter(row => {
      const key = row.symbol || row.ticker;
      const priorExit = locked.get(key);
      if (priorExit && row.signalDate <= priorExit) return false;
      locked.set(key, row.exitDate);
      return true;
    });
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function benchmarkRegimes(bars) {
  const values = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let i = 270; i < bars.length; i++) {
    const returns = [];
    for (let j = i - 19; j <= i; j++) returns.push(closes[j] / closes[j - 1] - 1);
    const average = mean(returns);
    const vol = Math.sqrt(mean(returns.map(ret => (ret - average) ** 2)));
    const history = [];
    for (let j = i - 251; j <= i; j++) {
      const sample = [];
      for (let k = j - 19; k <= j; k++) sample.push(closes[k] / closes[k - 1] - 1);
      const sampleMean = mean(sample);
      history.push(Math.sqrt(mean(sample.map(ret => (ret - sampleMean) ** 2))));
    }
    const sorted = history.sort((a, b) => a - b);
    const ma50 = mean(closes.slice(i - 49, i + 1));
    const priorMa50 = mean(closes.slice(i - 59, i - 9));
    values.set(dateOf(bars[i]), {
      vol,
      q80: sorted[Math.floor((sorted.length - 1) * 0.8)],
      q70: sorted[Math.floor((sorted.length - 1) * 0.7)],
      slopeFlatOrUp: ma50 >= priorMa50,
    });
  }
  return values;
}
function passesRegime(map, date, variant) {
  const row = map.get(date);
  if (!row) return false;
  if (variant.volQuantile && row.vol >= (variant.volQuantile === 0.8 ? row.q80 : row.q70)) return false;
  return !(variant.slope && !row.slopeFlatOrUp);
}
function fxAt(currency, date) {
  if (currency === 'USD') return 1;
  const names = { GBP: 'GBPUSD_X', EUR: 'EURUSD_X', JPY: 'JPYUSD_X' };
  const file = names[currency] && path.join(ROOT, 'data', 'research', 'fx', `${names[currency]}.json`);
  if (!file || !fs.existsSync(file)) return null;
  const cached = readJson(file);
  const row = (cached.bars || []).find(bar => dateOf(bar) === date);
  return Number(row?.c) > 0 ? Number(row.c) : null;
}

function cachedLiveTrades(market, horizon, qualityGate = null) {
  const rows = [];
  eachCachedResult(market, horizon, result => {
    for (const raw of result.eventSets?.primary?.buy || []) {
      const row = normalizeTrade(raw);
      if (!qualityGate || qualityGate(row.quality)) rows.push(row);
    }
  });
  return rows;
}

function cachedWaveTrades(market, horizon, piotroskiGate = null) {
  const rows = [];
  const baseline = MODELS.find(model => model.id === 'baseline');
  eachCachedResult(market, horizon, result => {
    const context = result.context;
    const bars = context.bars;
    const benchmarkBars = context.benchmarkBars;
    const waveContext = {
      symbol: context.symbol,
      market,
      bars,
      marketBars: benchmarkBars,
      marketIndex: dateIndex(benchmarkBars),
      sectorBars: benchmarkBars,
      sectorIndex: dateIndex(benchmarkBars),
    };
    const trades = waveTrades(waveContext, horizon, 'buy', baseline, 0, bars.length);
    const barByDate = new Map(bars.map((bar, index) => [dateOf(bar), { bar, index }]));
    const causalTrades = trades.map(trade => {
      const entry = barByDate.get(trade.entryDate);
      return {
        ...trade,
        signalDate: entry?.index > 0 ? dateOf(bars[entry.index - 1]) : null,
      };
    }).filter(trade => trade.signalDate);
    if (!piotroskiGate) {
      rows.push(...causalTrades.map(normalizeTrade));
      return;
    }
    const listing = LISTING[market];
    for (const trade of causalTrades) {
      const located = barByDate.get(trade.signalDate);
      if (!located) continue;
      const quality = scoreAtDecision(context.arrays, {
        market,
        decisionDate: trade.signalDate,
        close: located.bar.c,
        listingCurrency: listing.currency,
        listingPriceScale: listing.scale,
        fxAt,
      });
      if (Number(quality.piotroski) >= piotroskiGate) {
        rows.push(normalizeTrade({ ...trade, quality }));
      }
    }
  });
  return rows;
}

async function cachedMeanReversionTrades(market, horizon) {
  const model = MR_MODELS[market]?.[horizon];
  if (!model) return { trades: [], regimes: new Map() };
  const benchmark = firstContext(market, horizon)?.benchmarkBars || [];
  const tide = buildMarketRegime(benchmark);
  const regimes = benchmarkRegimes(benchmark);
  const rows = [];
  const sectorCache = new Map();
  for (const file of resultFiles(market, horizon)) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    if (result?.outcome !== 'success' || !result.context?.bars?.length) continue;
    const context = result.context;
    const sectorSymbol = sectorEtfForSymbol(context.symbol);
    if (!sectorCache.has(sectorSymbol)) {
      const fetched = await fetchOHLCV(sectorSymbol, '10y', '1d').catch(() => null);
      sectorCache.set(sectorSymbol, Array.isArray(fetched) && fetched.length >= 250 ? fetched : benchmark);
    }
    const sectorBars = sectorCache.get(sectorSymbol);
    const sectorIndex = new Map(sectorBars.map((bar, index) => [dateOf(bar), index]));
    for (let index = 270; index < context.bars.length - 2; index++) {
      if (!signalAt(context.bars, index, model, tide, sectorBars, sectorIndex)) continue;
      const trade = simulateMeanReversion(context.bars, index, model, {
        market, symbol: context.symbol,
      });
      if (!trade) continue;
      rows.push(normalizeTrade({
        ...trade,
        symbol: context.symbol,
        market,
        horizon,
        side: 'buy',
        signalDate: dateOf(context.bars[index]),
        entryDate: dateOf(context.bars[trade.entryIndex]),
        exitDate: dateOf(context.bars[trade.exitIndex]),
      }));
    }
  }
  return { trades: rows, regimes };
}

async function commodityContexts() {
  const benchmarkBars = await fetchOHLCV('DBC', '10y', '1d');
  const contexts = [];
  for (const symbol of [...new Set(STATIC_GROUPS.COMMODITIES || [])]) {
    const bars = await fetchOHLCV(symbol, '10y', '1d').catch(() => null);
    if (Array.isArray(bars) && bars.length >= 1400) {
      contexts.push({ market: 'Commodities', symbol, bars, benchmarkBars });
    }
  }
  return contexts;
}
async function commodityTradeSets() {
  const contexts = await commodityContexts();
  const sets = { medium: { live: [], wave: [] }, long: { live: [], wave: [] } };
  const baseline = MODELS.find(model => model.id === 'baseline');
  for (const context of contexts) {
    const marketSeries = buildMarketRegime(context.benchmarkBars);
    for (const horizon of ['medium', 'long']) {
      const live = await backtestSignal(
        context.bars,
        horizon,
        dailyToWeeklyBars(context.bars),
        null,
        {
          symbol: context.symbol,
          market: 'Commodities',
          marketSeries,
          windowBars: context.bars.length,
          entryStep: 2,
          allowOverlapping: true,
          closedOnly: true,
          stopFirst: true,
        },
      );
      sets[horizon].live.push(...(live.tradeResults || [])
        .filter(row => row.side === 'buy')
        .map(row => normalizeTrade({
          ...row,
          symbol: context.symbol,
          signalDate: dateOf(context.bars[row.signalIndex]),
        })));
      const wave = waveTrades({
        ...context,
        marketBars: context.benchmarkBars,
        marketIndex: dateIndex(context.benchmarkBars),
        sectorBars: context.benchmarkBars,
        sectorIndex: dateIndex(context.benchmarkBars),
      }, horizon, 'buy', baseline, 0, context.bars.length);
      const indexByDate = new Map(context.bars.map((bar, index) => [dateOf(bar), index]));
      sets[horizon].wave.push(...wave.map(trade => {
        const entryIndex = indexByDate.get(trade.entryDate);
        return normalizeTrade({
          ...trade,
          signalDate: entryIndex > 0 ? dateOf(context.bars[entryIndex - 1]) : null,
        });
      }).filter(trade => trade.signalDate));
    }
  }
  return { contexts, sets };
}

function evaluateCell(definition, rawTrades, benchmarkBars) {
  const folds = foldsFor(definition.market, definition.horizon, benchmarkBars);
  const unique = dedupeTrades(rawTrades, definition.id);
  const developmentFolds = folds.slice(0, -1).map(fold => {
    const rows = nonOverlapping(unique, fold.test);
    return {
      fold: fold.fold,
      range: fold.test,
      metrics: metricSummary(rows, monthsInRange(fold.test)),
      trades: rows,
    };
  });
  const developmentTrades = dedupeTrades(developmentFolds.flatMap(row => row.trades), definition.id);
  const holdoutFold = folds.at(-1);
  const holdoutTrades = nonOverlapping(unique, holdoutFold.test);
  const developmentMonths = developmentFolds.reduce((sum, row) => sum + monthsInRange(row.range), 0);
  const development = metricSummary(developmentTrades, developmentMonths);
  const holdout = metricSummary(holdoutTrades, monthsInRange(holdoutFold.test));
  return {
    ...definition,
    folds,
    development,
    developmentFoldTests: developmentFolds.map(row => ({ fold: row.fold, ...row.metrics })),
    stableDevelopmentFolds: developmentFolds.filter(row => passingMetrics(row.metrics)).length,
    holdout,
    holdoutStatus: HOLDOUT_STATUS,
    holdoutWinRatePValue: +exactBinomialP(holdoutTrades).toFixed(6),
    measuredConfidence: development.winRate,
    perYear: perYear([...developmentTrades, ...holdoutTrades]),
    _holdoutTrades: holdoutTrades,
  };
}

function setupTable(cells) {
  const keys = [...new Set(cells.map(cell => `${cell.market}|${cell.horizon}`))].sort();
  return keys.map(key => {
    const [market, horizon] = key.split('|');
    if ((market === 'US' || market === 'UK') && horizon === 'short') {
      return { market, horizon, setupId: null, verdict: 'NO_VALIDATED_SETUP', reason: 'No preregistered short setup; prior US short development folds all lost money.' };
    }
    const candidates = cells.filter(cell => `${cell.market}|${cell.horizon}` === key && !cell.control)
      .sort((left, right) => {
        const order = { VALIDATED: 2, CANDIDATE: 1, REJECTED: 0 };
        return order[right.verdict] - order[left.verdict]
          || Number(right.holdout?.profitFactor || 0) - Number(left.holdout?.profitFactor || 0);
      });
    const selected = candidates.find(cell => cell.verdict !== 'REJECTED');
    if (!selected) return { market, horizon, setupId: null, verdict: 'NO_RECOMMENDATION', reason: 'No setup passed the frozen safeguards.' };
    return {
      market,
      horizon,
      setupId: selected.id,
      setup: selected.label,
      verdict: selected.verdict,
      expectedWinRate: selected.measuredConfidence,
      holdoutWinRate: selected.holdout.winRate,
      holdoutProfitFactor: selected.holdout.profitFactor,
      picksPerMonth: selected.development.picksPerMonth,
    };
  });
}

function renderReadout(report) {
  const metric = value => value == null ? '—' : value;
  const rows = report.cells.map(cell => `| ${cell.market} | ${cell.horizon} | ${cell.label} | ${cell.control ? 'CONTROL' : cell.verdict} | ${metric(cell.development.trades)} | ${metric(cell.development.picksPerMonth)} | ${metric(cell.development.winRate)}% | ${metric(cell.development.profitFactor)} | $${metric(cell.development.pnlUsd)} | ${metric(cell.development.averageWinPct)}% / ${metric(cell.development.averageLossPct)}% | ${metric(cell.measuredConfidence)}% | ${metric(cell.holdout.trades)} | ${metric(cell.holdout.winRate)}% | ${metric(cell.holdout.profitFactor)} | $${metric(cell.holdout.pnlUsd)} | ${cell.bhPass ? 'PASS' : 'FAIL'} (${metric(cell.bhQValue)}) | ${cell.rejectionReason || '—'} |`);
  const book = report.setupBook.map(row => `| ${row.market} | ${row.horizon} | ${row.setup || row.reason} | ${row.verdict} | ${metric(row.expectedWinRate)}% | ${metric(row.holdoutWinRate)}% | ${metric(row.holdoutProfitFactor)} | ${metric(row.picksPerMonth)} |`);
  return [
    '# Validated Setup Book Readout',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'Research only. No feature flag was enabled and no live recommendation, order, or deployment setting was changed.',
    `All ${report.methodology.bhFamilySize} tested control/setup rows share one Benjamini-Hochberg family. The trailing holdout is ${report.methodology.holdoutStatus} and cannot produce a VALIDATED verdict.`,
    '',
    '## One-page recommendation specification',
    '| Market | Horizon | Setup | Verdict | Dev Conf / WR | Holdout WR | Holdout PF | Picks / month |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...book,
    '',
    '## Full setup results',
    '| Market | Hz | Setup | Verdict | Dev n | Picks/mo | Dev WR | Dev PF | Dev PnL | Avg win/loss | Conf | Holdout n | Holdout WR | Holdout PF | Holdout PnL | BH q | Why rejected |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows,
    '',
    'Per-year breakdowns and fold-level results are in `scripts/validated-setup-book-results.json`.',
    '',
    '## Reference only',
    'The August Danelfin-era paper results remain historical operational evidence only. They were not used for selection, confidence, BH testing, or promotion.',
    '',
    '## Live router',
    report.validatedCount
      ? 'A VALIDATED setup exists. Any live router must remain behind SETUP_BOOK_ENABLED (default off) and must not be enabled by this study.'
      : 'No VALIDATED setup. The designed `SETUP_BOOK_ENABLED` router is not wired into pick generation or IBKR. The flag stays off and every cell remains `NO RECOMMENDATION` / `NO_VALIDATED_SETUP`.',
    '',
  ].join('\n');
}

async function main() {
  if (!fs.existsSync(WORKER_ROOT)) throw new Error(`Missing worker cache: ${WORKER_ROOT}`);
  const registry = setupRegistry();
  writeJson(CHECKPOINT, {
    version: 1,
    study: STUDY_ID,
    state: 'running',
    startedAt: new Date().toISOString(),
    registry: registry.map(row => row.id),
  });

  const rawById = new Map();
  const benchmarkByCell = new Map();
  for (const [market, horizon] of [...new Set(registry
    .filter(row => row.market !== 'Commodities')
    .map(row => `${row.market}|${row.horizon}`))].map(key => key.split('|'))) {
    const context = firstContext(market, horizon);
    if (!context) throw new Error(`No cached context for ${market} ${horizon}`);
    benchmarkByCell.set(`${market}|${horizon}`, context.benchmarkBars);
    rawById.set(`v0_live__${market.toLowerCase()}__${horizon}`, cachedLiveTrades(market, horizon));
  }

  for (const definition of registry.filter(row => row.kind === 'wave3' || row.kind === 'wave3_pio5')) {
    rawById.set(definition.id, cachedWaveTrades(
      definition.market,
      definition.horizon,
      definition.kind === 'wave3_pio5' ? 5 : null,
    ));
  }
  rawById.set('live_v3__japan__long', cachedLiveTrades('Japan', 'long'));
  rawById.set('live_pio5__germany__medium', cachedLiveTrades(
    'Germany', 'medium', quality => Number(quality?.piotroski) >= 5,
  ));

  const mrCache = new Map();
  for (const definition of registry.filter(row => row.kind === 'mean_reversion')) {
    const key = `${definition.market}|${definition.horizon}`;
    if (!mrCache.has(key)) mrCache.set(key, await cachedMeanReversionTrades(definition.market, definition.horizon));
    const source = mrCache.get(key);
    const variant = REGIME_VARIANTS.find(row => row.id === definition.variant);
    rawById.set(definition.id, source.trades.filter(row => passesRegime(source.regimes, row.signalDate, variant)));
  }

  const commodities = await commodityTradeSets();
  for (const horizon of ['medium', 'long']) {
    benchmarkByCell.set(`Commodities|${horizon}`, commodities.contexts[0]?.benchmarkBars || []);
    rawById.set(`v0_live__commodities__${horizon}`, commodities.sets[horizon].live);
    rawById.set(`wave3_baseline__commodities__${horizon}`, commodities.sets[horizon].wave);
  }

  const cells = registry.map(definition => evaluateCell(
    definition,
    rawById.get(definition.id) || [],
    benchmarkByCell.get(`${definition.market}|${definition.horizon}`),
  ));
  applyBenjaminiHochberg(cells);
  const controls = new Map(cells.filter(cell => cell.control)
    .map(cell => [`${cell.market}|${cell.horizon}`, cell]));
  cells.forEach(cell => {
    const mrBaseline = cell.kind === 'mean_reversion' && cell.variant !== 'baseline'
      ? cells.find(row => row.kind === 'mean_reversion'
        && row.market === cell.market && row.horizon === cell.horizon && row.variant === 'baseline')
      : null;
    const baseline = mrBaseline || controls.get(`${cell.market}|${cell.horizon}`);
    cell.baselineId = baseline?.id || null;
    cell.beatsControl = cell.control || (Number.isFinite(cell.development?.winRate)
      && Number.isFinite(cell.development?.pnlUsd)
      && Number.isFinite(baseline?.development?.winRate)
      && Number.isFinite(baseline?.development?.pnlUsd)
      && cell.development.winRate > baseline.development.winRate
      && cell.development.pnlUsd > baseline.development.pnlUsd);
    cell.verdict = cell.control ? 'CONTROL' : classifyVerdict(cell);
    cell.rejectionReason = cell.control ? null : rejectionReason(cell);
    delete cell._holdoutTrades;
  });
  const report = {
    generatedAt: new Date().toISOString(),
    study: STUDY_ID,
    mode: 'BACKTEST_ONLY',
    methodology: {
      preregistration: 'docs/validated-setup-book-preregistration.md',
      folds: FOLD_SPEC,
      embargo: EMBARGO,
      pooledDevelopmentWindowsCountedOnce: true,
      currentCosts: 'implementation-cost-v1',
      nextOpenEntry: true,
      stopFirst: true,
      overlappingPositions: false,
      bhFamilySize: cells.length,
      bhScope: 'Every V0 control and setup variant in this report.',
      holdoutStatus: HOLDOUT_STATUS,
      holdoutSelectionUse: false,
      confidence: 'Pooled development win rate only.',
      universe: 'Full available cached universe; no 80-name cap.',
      survivorshipBias: 'US uses the cached current-constituent snapshot and remains SURVIVORSHIP_BIAS.',
    },
    registry,
    cells,
    setupBook: setupTable(cells),
    validatedCount: cells.filter(cell => cell.verdict === 'VALIDATED').length,
    candidateCount: cells.filter(cell => cell.verdict === 'CANDIDATE').length,
    liveRouterImplemented: false,
    liveBehaviorChanged: false,
    flagsEnabled: [],
  };
  writeJson(OUTPUT, report);
  fs.mkdirSync(path.dirname(READOUT), { recursive: true });
  fs.writeFileSync(READOUT, `${renderReadout(report)}\n`);
  writeJson(CHECKPOINT, {
    version: 1,
    study: STUDY_ID,
    state: 'complete',
    completedAt: report.generatedAt,
    output: path.relative(ROOT, OUTPUT),
    cells: cells.length,
  });
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} and ${path.relative(ROOT, READOUT)}`);
  console.log(`Validated=${report.validatedCount} Candidate=${report.candidateCount} BH family=${cells.length}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
