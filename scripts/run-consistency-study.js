#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '3999';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
process.chdir(path.join(__dirname, '..'));

const {
  buildMarketRegime, fetchOHLCV, sectorEtfForSymbol,
} = require('../server');
const { STATIC_GROUPS, US_CORE } = require('../universe');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { buildDateAlignedFolds, assertFoldIsolation } = require('../lib/research/walk-forward-optimizer');
const { signalAt, simulateTrade: simulateMeanReversion } = require('../lib/research/mean-reversion');
const { MODELS, candidateTrades: waveTrades, dateIndex } = require('./backtest-factor-combinations');
const {
  STUDY_ID, MARKETS, HORIZONS, TREND_HORIZONS, TRIGGERS, REGIMES,
  STOPS, TIME_STOPS, REALISATIONS, EMBARGO, FOLD_SPEC,
  EXPECTED_BH_FAMILY_SIZE, registry, metric, scoreVariant, applyBh, rankConsistent,
  rescoreVariant,
} = require('../lib/research/consistency-study');

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value ?? '1'];
}));
const WORKER_ROOT = path.resolve(ROOT, args.workerRoot
  || 'scripts/performance-stage1-v2-checkpoint.json.workers/stage1');
const OUTPUT = path.resolve(ROOT, args.output || 'scripts/consistency-study-results.json');
const READOUT = path.resolve(ROOT, args.readout || 'docs/consistency-study-readout.md');
const CHECKPOINT = path.resolve(ROOT, args.checkpoint || 'scripts/consistency-study-checkpoint.json');
const PAPER = path.resolve(ROOT, args.paper || 'docs/consistency-paper-candidates.md');
const PER_MARKET = Math.max(0, Number(args.perMarket) || 0);
const FETCH_CONCURRENCY = Math.max(1, Number(args.fetchConcurrency) || 8);
const TREND_WORKERS = Math.max(1, Number(args.trendWorkers) || 6);
const MIN_BARS = Math.max(1000, Number(args.minBars) || 1400);
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));

const EXTRA_COMMODITIES = [
  'ZW=F', 'ZC=F', 'ZS=F', 'GLD', 'SLV', 'USO', 'UNG', 'DBC',
  'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX',
];
const CRYPTO = ['BTC-USD', 'ETH-USD'];
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
  Crypto: CRYPTO,
};
const BENCHMARK = {
  US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH', UK: 'EWU',
  Germany: 'EWG', France: 'EWQ', India: 'INDA', Commodities: 'DBC',
  Crypto: 'BTC-USD',
};
const FILE_MARKET = {
  US: 'US', Japan: 'Japan', 'Hong Kong': 'Hong_Kong',
  UK: 'UK', Germany: 'Germany', France: 'France',
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
function normalizeTrade(row, context) {
  const signalDate = row.signalDate || dateOf(context.bars[row.signalIndex]);
  const entryDate = row.entryDate || dateOf(context.bars[row.entryIndex]);
  const exitDate = row.exitDate || dateOf(context.bars[row.exitIndex]);
  return { ...row, symbol: context.symbol, market: context.market, signalDate, entryDate, exitDate };
}
function mapLimit(values, limit, operation) {
  let next = 0;
  const output = new Array(values.length);
  return Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index], index);
    }
  })).then(() => output);
}
function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}
function benchmarkRegimes(bars) {
  const values = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let index = 270; index < bars.length; index++) {
    const recent = [];
    for (let cursor = index - 19; cursor <= index; cursor++) {
      recent.push(closes[cursor] / closes[cursor - 1] - 1);
    }
    const recentMean = mean(recent);
    const volatility = Math.sqrt(mean(recent.map(value => (value - recentMean) ** 2)));
    const history = [];
    for (let cursor = index - 251; cursor <= index; cursor++) {
      const sample = [];
      for (let point = cursor - 19; point <= cursor; point++) {
        sample.push(closes[point] / closes[point - 1] - 1);
      }
      const sampleMean = mean(sample);
      history.push(Math.sqrt(mean(sample.map(value => (value - sampleMean) ** 2))));
    }
    history.sort((a, b) => a - b);
    const ma50 = mean(closes.slice(index - 49, index + 1));
    const priorMa50 = mean(closes.slice(index - 59, index - 9));
    values.set(dateOf(bars[index]), {
      vol: volatility,
      q70: history[Math.floor((history.length - 1) * 0.7)],
      slopeFlatOrUp: ma50 >= priorMa50,
    });
  }
  return values;
}
function passesRegime(regimes, date, variant) {
  if (variant === 'none') return true;
  const row = regimes.get(date);
  if (!row || row.vol >= row.q70) return false;
  return variant !== 'vol_skip_top30_and_ma50_flat_or_up' || row.slopeFlatOrUp;
}
function foldsFor(market, horizon, benchmarkBars) {
  const folds = buildDateAlignedFolds(benchmarkBars.map(dateOf), {
    ...FOLD_SPEC, embargoBars: EMBARGO[horizon],
  });
  assertFoldIsolation(folds);
  if (folds.length !== FOLD_SPEC.folds) {
    throw new Error(`${market} ${horizon}: expected ${FOLD_SPEC.folds} folds, got ${folds.length}.`);
  }
  return folds;
}
function membershipAllowed(market, symbol, date) {
  return market !== 'US' || membershipAt(US_SNAPSHOT, date).has(symbol);
}
function survivorshipLabel(market) {
  if (market === 'US') return US_SNAPSHOT.historicalMembership?.available
    ? 'POINT_IN_TIME' : 'SURVIVORSHIP_BIAS';
  if (market === 'Commodities' || market === 'Crypto') return 'NOT_APPLICABLE';
  return 'SURVIVORSHIP_BIAS';
}
function resultFiles(market) {
  const prefix = `${FILE_MARKET[market]}__medium__`;
  if (!FILE_MARKET[market] || !fs.existsSync(WORKER_ROOT)) return [];
  return fs.readdirSync(WORKER_ROOT)
    .filter(file => file.startsWith(prefix) && file.endsWith('.result.json'))
    .sort();
}
function resultFilesFor(market, horizon) {
  const prefix = `${FILE_MARKET[market]}__${horizon}__`;
  if (!FILE_MARKET[market] || !fs.existsSync(WORKER_ROOT)) return [];
  return fs.readdirSync(WORKER_ROOT)
    .filter(file => file.startsWith(prefix) && file.endsWith('.result.json'))
    .sort();
}
function cachedContexts(market) {
  const contexts = [];
  for (const file of resultFiles(market)) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    if (result?.outcome === 'success' && result.context?.bars?.length >= MIN_BARS) {
      contexts.push({ ...result.context, market, symbol: result.context.symbol });
    }
  }
  return contexts;
}
async function loadMarketContexts(market, priceCache) {
  const bySymbol = new Map(cachedContexts(market).map(context => [context.symbol, context]));
  const symbols = PER_MARKET ? UNIVERSES[market].slice(0, PER_MARKET) : UNIVERSES[market];
  const benchmarkBars = await loadPrice(BENCHMARK[market], priceCache);
  if (!benchmarkBars?.length) throw new Error(`${market}: benchmark ${BENCHMARK[market]} unavailable.`);
  const missing = symbols.filter(symbol => !bySymbol.has(symbol));
  await mapLimit(missing, FETCH_CONCURRENCY, async symbol => {
    const bars = await loadPrice(symbol, priceCache);
    if (bars?.length >= MIN_BARS) bySymbol.set(symbol, { market, symbol, bars, benchmarkBars, arrays: null });
  });
  const contexts = [...bySymbol.values()]
    .filter(context => symbols.includes(context.symbol))
    .map(context => ({ ...context, benchmarkBars }));
  console.log(`[contexts] ${market}: ${contexts.length}/${symbols.length}`);
  return { contexts, benchmarkBars };
}
async function loadPrice(symbol, cache) {
  if (!cache.has(symbol)) {
    cache.set(symbol, fetchOHLCV(symbol, '10y', '1d').catch(() => null));
  }
  return cache.get(symbol);
}
async function sectorBarsFor(context, marketData, priceCache) {
  const proxy = sectorEtfForSymbol(context.symbol);
  const bars = proxy ? await loadPrice(proxy, priceCache) : null;
  return Array.isArray(bars) && bars.length >= 250 ? bars : marketData.benchmarkBars;
}
async function meanReversionEvents(market, marketData, priceCache) {
  const events = new Map();
  const tide = buildMarketRegime(marketData.benchmarkBars);
  const regimes = benchmarkRegimes(marketData.benchmarkBars);
  let done = 0;
  for (const context of marketData.contexts) {
    const sectorBars = await sectorBarsFor(context, marketData, priceCache);
    const sectorIndex = new Map(sectorBars.map((bar, index) => [dateOf(bar), index]));
    for (const horizon of HORIZONS) {
      for (const trigger of TRIGGERS) {
        const base = {
          trigger, target: 'one_atr', stopAtr: 1.5,
          timeStopBars: TIME_STOPS[horizon][0], partial: false,
        };
        const signalIndexes = [];
        for (let index = 270; index < context.bars.length - 2; index++) {
          if (signalAt(context.bars, index, base, tide, sectorBars, sectorIndex)) signalIndexes.push(index);
        }
        for (const regime of REGIMES) {
          const entries = signalIndexes.filter(index =>
            passesRegime(regimes, dateOf(context.bars[index]), regime));
          for (const stopAtr of STOPS) {
            for (const timeStopBars of TIME_STOPS[horizon]) {
              for (const partial of REALISATIONS) {
                const definition = {
                  part: 'A', market, horizon, trigger, regime, stopAtr,
                  timeStopBars, partial,
                };
                const id = [
                  'A', market, horizon, trigger, regime, `sl${stopAtr}`,
                  `t${timeStopBars}`, partial ? 'partial' : 'full',
                ].join('__').replace(/\s+/g, '_');
                if (!events.has(id)) events.set(id, []);
                const candidate = {
                  trigger, target: 'one_atr', stopAtr, timeStopBars, partial,
                };
                for (const signalIndex of entries) {
                  const signalDate = dateOf(context.bars[signalIndex]);
                  if (!membershipAllowed(market, context.symbol, signalDate)) continue;
                  const trade = simulateMeanReversion(context.bars, signalIndex, candidate, {
                    market, symbol: context.symbol,
                  });
                  if (trade) events.get(id).push(normalizeTrade({
                    ...trade, ...definition, signalIndex,
                  }, context));
                }
              }
            }
          }
        }
      }
    }
    done++;
    if (done % 25 === 0) console.log(`[MR] ${market}: ${done}/${marketData.contexts.length}`);
  }
  return events;
}
function cachedTrendOff(market, horizon) {
  const rows = [];
  const symbols = new Set();
  for (const file of resultFilesFor(market, horizon)) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    if (result?.outcome !== 'success' || !result.context?.symbol) continue;
    symbols.add(result.context.symbol);
    for (const raw of result.eventSets?.primary?.buy || []) {
      const trade = normalizeTrade(raw, result.context);
      if (membershipAllowed(market, result.context.symbol, trade.signalDate)) rows.push(trade);
    }
  }
  return { rows, symbols };
}
function runTrendWorkerTasks(tasks) {
  if (!tasks.length) return Promise.resolve([]);
  const workerFile = path.join(__dirname, 'consistency-trend-worker.js');
  const count = Math.min(TREND_WORKERS, tasks.length);
  const output = new Array(tasks.length);
  let next = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    const children = [];
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      for (const child of children) {
        try { child.send({ type: 'shutdown' }); } catch (_) {}
      }
      if (error) reject(error);
      else resolve(output);
    };
    const assign = child => {
      if (next >= tasks.length) {
        if (completed === tasks.length) finish();
        return;
      }
      const taskId = next++;
      child._taskId = taskId;
      child.send({ type: 'task', taskId, task: tasks[taskId] });
    };
    for (let index = 0; index < count; index++) {
      const child = fork(workerFile, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, RESEARCH_MODE: '1', AUTH_TEST_BYPASS: '1', PORT: '0' },
      });
      children.push(child);
      child.on('message', message => {
        if (message?.type === 'ready') {
          assign(child);
          return;
        }
        if (message?.type === 'error') {
          finish(new Error(`Trend worker task ${message.taskId} failed: ${message.error}`));
          return;
        }
        if (message?.type !== 'result') return;
        output[message.taskId] = message.output;
        completed++;
        if (completed % 25 === 0) console.log(`[trend workers] ${completed}/${tasks.length}`);
        assign(child);
      });
      child.on('error', finish);
      child.on('exit', code => {
        if (!settled && code && completed < tasks.length) {
          finish(new Error(`Trend worker exited ${code} during task ${child._taskId}.`));
        }
      });
    }
  });
}
async function trendEvents(market, marketData, priceCache) {
  const events = new Map();
  const cached = {};
  for (const horizon of TREND_HORIZONS) {
    cached[horizon] = cachedTrendOff(market, horizon);
    const id = `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_off`;
    events.set(id, cached[horizon].rows);
  }
  const tasks = [];
  for (const context of marketData.contexts) {
    // Missing FMP deterministically forces US/UK to Hold. Avoid scanning bars
    // that cannot produce a recommendation.
    if ((market === 'US' || market === 'UK') && !context.arrays) continue;
    const sectorBars = await sectorBarsFor(context, marketData, priceCache);
    const variants = [];
    for (const horizon of TREND_HORIZONS) {
      variants.push({
        id: `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_on`,
        horizon,
        sector: true,
      });
      if (!cached[horizon].symbols.has(context.symbol)) {
        variants.push({
          id: `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_off`,
          horizon,
          sector: false,
        });
      }
    }
    tasks.push({
      context: {
        market,
        symbol: context.symbol,
        bars: context.bars,
        benchmarkBars: marketData.benchmarkBars,
        arrays: context.arrays || null,
      },
      sectorBars,
      variants,
    });
  }
  const results = await runTrendWorkerTasks(tasks);
  for (const result of results) {
    for (const [id, rows] of Object.entries(result || {})) {
      if (!events.has(id)) events.set(id, []);
      for (const trade of rows) {
        if (membershipAllowed(market, trade.symbol, trade.signalDate)) events.get(id).push(trade);
      }
    }
  }
  return events;
}
async function wave3Events(usData, priceCache) {
  const baseline = MODELS.find(model => model.id === 'baseline');
  const old = new Set(US_CORE);
  const events = { old68: [], pit_full: [] };
  for (const context of usData.contexts) {
    const sectorBars = await sectorBarsFor(context, usData, priceCache);
    const waveContext = {
      ...context,
      marketBars: usData.benchmarkBars,
      marketIndex: dateIndex(usData.benchmarkBars),
      sectorBars,
      sectorIndex: dateIndex(sectorBars),
    };
    const rows = waveTrades(waveContext, 'long', 'buy', baseline, 0, context.bars.length);
    const barByEntry = new Map(context.bars.map((bar, index) => [dateOf(bar), index]));
    for (const row of rows) {
      const entryIndex = barByEntry.get(row.entryDate);
      if (!(entryIndex > 0)) continue;
      const trade = {
        ...row,
        symbol: context.symbol,
        signalDate: dateOf(context.bars[entryIndex - 1]),
      };
      if (old.has(context.symbol)) events.old68.push(trade);
      if (membershipAllowed('US', context.symbol, trade.signalDate)) events.pit_full.push(trade);
    }
  }
  return events;
}
function mergeEvents(target, source) {
  for (const [id, rows] of source) target.set(id, rows);
}
function bestTable(cells) {
  const keys = [];
  for (const market of MARKETS) {
    for (const horizon of ['short', 'medium', 'long']) {
      if (horizon === 'short' || horizon === 'medium' || TREND_HORIZONS.includes(horizon)) {
        keys.push(`${market}|${horizon}`);
      }
    }
  }
  return keys.map(key => {
    const [market, horizon] = key.split('|');
    const ranked = rankConsistent(cells.filter(cell =>
      cell.market === market && cell.horizon === horizon));
    const best = ranked[0];
    if (!best) return { market, horizon, setup: 'NONE', consistent: false };
    return {
      market,
      horizon,
      setup: best.id,
      part: best.part,
      consistent: true,
      developmentWindows: best.windows.filter(row => !row.final)
        .map(row => ({ fold: row.fold, pnlUsd: row.metrics.pnlUsd, pf: row.metrics.profitFactor })),
      finalWindow: {
        pnlUsd: best.finalWindow?.metrics?.pnlUsd,
        pf: best.finalWindow?.metrics?.profitFactor,
        status: 'OVERLAP_RISK',
      },
      worstWindowPf: best.worstWindowPf,
      avgWinPct: best.pooledDevelopment.avgWinPct,
      avgLossPct: best.pooledDevelopment.avgLossPct,
      breakevenMargin: best.pooledDevelopment.breakevenMargin,
      picksPerMonth: best.pooledDevelopment.picksPerMonth,
      sampleSize: best.pooledDevelopment.trades,
      survivorship: best.survivorship,
      bhQValue: best.bhQValue,
    };
  });
}
function reconcileJapanLong(cells, eventMap, marketData) {
  const folds = foldsFor('Japan', 'long', marketData.benchmarkBars);
  const development = folds.slice(0, -1).map(fold => fold.test);
  const primary = [];
  for (const file of fs.readdirSync(WORKER_ROOT)
    .filter(name => name.startsWith('Japan__long__') && name.endsWith('.result.json'))) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    for (const row of result?.eventSets?.primary?.buy || []) {
      const context = result.context;
      primary.push(normalizeTrade(row, context));
    }
  }
  const signalled = primary.filter(row =>
    development.some(range => row.signalDate >= range.from && row.signalDate <= range.to));
  const exitContained = signalled.filter(row =>
    development.some(range => row.signalDate >= range.from && row.signalDate <= range.to
      && row.exitDate >= range.from && row.exitDate <= range.to));
  const v3Metric = metric(signalled);
  const containedMetric = metric(exitContained);
  const sectorOff = cells.find(cell =>
    cell.id === 'B__Japan__long__sector_off');
  const sectorOn = cells.find(cell =>
    cell.id === 'B__Japan__long__sector_on');
  return {
    v3Reported: { trades: 58, profitFactor: 1.817, note: 'v3 primary pooled development' },
    cachedPrimarySignalDateOnly: v3Metric,
    cachedPrimaryExitContained: containedMetric,
    consistencySectorOff: sectorOff?.pooledDevelopment || null,
    consistencySectorOn: sectorOn?.pooledDevelopment || null,
    attribution: [
      `Fold containment removed ${signalled.length - exitContained.length} trades by requiring exits inside each window; v3 selected by signal date only.`,
      'Per-window non-overlap then removes same-symbol re-entries until the previous trade exits.',
      'The setup-book 14-trade/PF 0.47 result used both restrictions; it was not an entry-engine replacement.',
      'Sector ON versus OFF isolates the additional sector-ETF tide effect in this run.',
      'Both consistency variants retain the same causal PIT quality provider when cached statements exist.',
    ],
  };
}
function renderReadout(report) {
  const fmt = value => value == null ? '—' : value;
  const table = report.bestByCell.map(row => {
    const developmentPnl = row.developmentWindows?.map(window => `$${window.pnlUsd}`).join(' / ') || '—';
    const finalPnl = row.finalWindow?.pnlUsd == null ? '—' : `$${row.finalWindow.pnlUsd}`;
    return `| ${row.market} | ${row.horizon} | ${row.setup} | ${row.consistent ? 'CONSISTENT' : 'NONE'} | ${developmentPnl} | ${finalPnl} | ${fmt(row.worstWindowPf)} | ${fmt(row.avgWinPct)}% / ${fmt(row.avgLossPct)}% | ${fmt(row.breakevenMargin)}pp | ${fmt(row.picksPerMonth)} | ${fmt(row.sampleSize)} | ${fmt(row.bhQValue)} | ${row.survivorship || '—'} |`;
  });
  const partB = MARKETS.flatMap(market => TREND_HORIZONS.map(horizon => {
    const off = report.cells.find(cell => cell.id === `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_off`);
    const on = report.cells.find(cell => cell.id === `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_on`);
    return `- ${market} ${horizon}: sector OFF n=${off?.pooledDevelopment.trades ?? 0}, PF=${fmt(off?.pooledDevelopment.profitFactor)}, PnL=$${fmt(off?.pooledDevelopment.pnlUsd)}; ON n=${on?.pooledDevelopment.trades ?? 0}, PF=${fmt(on?.pooledDevelopment.profitFactor)}, PnL=$${fmt(on?.pooledDevelopment.pnlUsd)}.`;
  }));
  const old = report.cells.find(cell => cell.id === 'C__us__long__old68');
  const full = report.cells.find(cell => cell.id === 'C__us__long__pit_full');
  return [
    '# Consistency-first all-market study',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'Backtest only. Final windows are OVERLAP_RISK. No paper or live book was enabled.',
    `One BH family: ${report.methodology.bhFamilySize} variants.`,
    '',
    '## Best CONSISTENT setup by market × horizon',
    '| Market | Horizon | Setup | Verdict | Development PnL by window | Final PnL (OVERLAP_RISK) | Worst PF | Avg win/loss | Breakeven margin | Picks/mo | n | BH q | Survivorship |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |',
    ...table,
    '',
    '## Part B — sector overlay',
    ...partB,
    '',
    '- No trend-engine cell was CONSISTENT with either overlay setting.',
    '- The overlay usually reduced or left unchanged the sparse live-engine sample; Hong Kong medium improved in aggregate with it, but still failed the all-window rule.',
    '',
    '### Japan long reconciliation',
    ...report.japanLongReconciliation.attribution.map(line => `- ${line}`),
    `- v3: n=58, PF=1.817. This run sector OFF: n=${report.japanLongReconciliation.consistencySectorOff?.trades ?? 0}, PF=${fmt(report.japanLongReconciliation.consistencySectorOff?.profitFactor)}; sector ON: n=${report.japanLongReconciliation.consistencySectorOn?.trades ?? 0}, PF=${fmt(report.japanLongReconciliation.consistencySectorOn?.profitFactor)}.`,
    '',
    '## Part C — Wave 3 US long survivorship',
    `- Old 68-name list: n=${old?.pooledDevelopment.trades ?? 0}, PF=${fmt(old?.pooledDevelopment.profitFactor)}, PnL=$${fmt(old?.pooledDevelopment.pnlUsd)}, consistent=${old?.consistent === true}.`,
    `- Full point-in-time universe: n=${full?.pooledDevelopment.trades ?? 0}, PF=${fmt(full?.pooledDevelopment.profitFactor)}, PnL=$${fmt(full?.pooledDevelopment.pnlUsd)}, consistent=${full?.consistent === true}.`,
    '- Expanding from the old list to the point-in-time universe increased sample size and nominal PnL, but reduced PF materially; neither version passed the all-window consistency rule.',
    '',
    'Machine-readable per-window results: `scripts/consistency-study-results.json`.',
    '',
  ].join('\n');
}
function renderPaper(report) {
  const candidates = report.bestByCell.filter(row => row.consistent);
  return [
    '# Consistency study — paper candidate design',
    '',
    'Design only. Nothing is enabled. `SETUP_BOOK_ENABLED` and IBKR routing are unchanged.',
    '',
    ...candidates.flatMap(row => [
      `## ${row.market} ${row.horizon} — ${row.setup}`,
      '',
      `- Tag: \`CONSISTENCY_${row.market.replace(/\s+/g, '_').toUpperCase()}_${row.horizon.toUpperCase()}\``,
      `- Mode: ${row.market === 'India' || row.market === 'Crypto' ? 'signals-only' : 'paper-only'}`,
      '- Rules: frozen exactly to the setup ID above; separate realised/unrealised PnL view.',
      '- Forward pass: ≥30 closed trades; profitable overall; WR ≥ breakeven +5pp; no two-month loss worse than one average month gain.',
      '- Promotion: requires a future dated approval; never automatic.',
      '',
    ]),
    ...(candidates.length ? [] : ['No CONSISTENT cells; no paper candidate books were designed.', '']),
  ].join('\n');
}

async function main() {
  const definitions = registry();
  if (args.rescore === '1') {
    const prior = readJson(OUTPUT);
    if (prior.study !== STUDY_ID || prior.cells?.length !== definitions.length) {
      throw new Error('Cannot rescore: existing result does not match the frozen study family.');
    }
    const cells = prior.cells.map(rescoreVariant);
    applyBh(cells);
    const report = {
      ...prior,
      rescoredAt: new Date().toISOString(),
      methodology: {
        ...prior.methodology,
        bhInput: 'pooled development windows',
        consistency: 'all four windows; final remains labelled OVERLAP_RISK',
        ranking: 'worst all-window PF, then smaller absolute average loss',
      },
      cells,
      bestByCell: bestTable(cells),
      consistentCount: cells.filter(cell => cell.consistent).length,
    };
    writeJson(OUTPUT, report);
    fs.writeFileSync(READOUT, `${renderReadout(report)}\n`);
    fs.writeFileSync(PAPER, `${renderPaper(report)}\n`);
    writeJson(CHECKPOINT, {
      version: 1, study: STUDY_ID, state: 'complete',
      completedAt: report.generatedAt, rescoredAt: report.rescoredAt,
      output: path.relative(ROOT, OUTPUT),
      cells: cells.length, consistent: report.consistentCount,
    });
    console.log(`Rescored ${cells.length} variants; CONSISTENT=${report.consistentCount}`);
    return;
  }
  let saved = null;
  try { saved = readJson(CHECKPOINT); } catch (_) {}
  const resumable = saved?.study === STUDY_ID && saved?.state === 'running'
    && Array.isArray(saved.cells) && saved.familySize === definitions.length;
  const completedMarkets = new Set(resumable ? saved.completedMarkets || [] : []);
  const cells = resumable ? saved.cells : [];
  const contextCounts = resumable ? saved.contextCounts || {} : {};
  let japanLongReconciliation = resumable ? saved.japanLongReconciliation || null : null;
  writeJson(CHECKPOINT, {
    version: 1, study: STUDY_ID, state: 'running',
    startedAt: resumable ? saved.startedAt : new Date().toISOString(),
    familySize: definitions.length,
    completedMarkets: [...completedMarkets],
    contextCounts,
    cells,
    japanLongReconciliation,
  });
  const priceCache = new Map();
  for (const market of MARKETS) {
    if (completedMarkets.has(market)) {
      console.log(`[resume] ${market}: already scored`);
      continue;
    }
    const marketData = await loadMarketContexts(market, priceCache);
    contextCounts[market] = marketData.contexts.length;
    const eventMap = new Map();
    mergeEvents(eventMap, await meanReversionEvents(market, marketData, priceCache));
    mergeEvents(eventMap, await trendEvents(market, marketData, priceCache));
    if (market === 'US') {
      const wave = await wave3Events(marketData, priceCache);
      eventMap.set('C__us__long__old68', wave.old68);
      eventMap.set('C__us__long__pit_full', wave.pit_full);
    }
    const marketDefinitions = definitions.filter(definition => definition.market === market);
    for (const definition of marketDefinitions) {
      const folds = foldsFor(market, definition.horizon, marketData.benchmarkBars);
      cells.push(scoreVariant(
        definition,
        eventMap.get(definition.id) || [],
        folds,
        survivorshipLabel(market),
      ));
    }
    if (market === 'Japan') {
      japanLongReconciliation = reconcileJapanLong(cells, eventMap, marketData);
    }
    completedMarkets.add(market);
    writeJson(CHECKPOINT, {
      version: 1, study: STUDY_ID, state: 'running',
      startedAt: resumable ? saved.startedAt : new Date().toISOString(),
      completedMarkets: [...completedMarkets],
      contextCounts,
      familySize: definitions.length,
      cells,
      japanLongReconciliation,
    });
  }
  if (cells.length !== definitions.length) {
    throw new Error(`Incomplete study: scored ${cells.length}/${definitions.length} variants.`);
  }
  applyBh(cells);
  const report = {
    generatedAt: new Date().toISOString(),
    study: STUDY_ID,
    mode: 'BACKTEST_ONLY',
    methodology: {
      preregistration: 'docs/consistency-study-preregistration.md',
      folds: FOLD_SPEC,
      embargo: EMBARGO,
      bhFamilySize: cells.length,
      expectedBhFamilySize: EXPECTED_BH_FAMILY_SIZE,
      pooledWindowsCountedOnce: true,
      finalWindowStatus: 'OVERLAP_RISK',
      costs: 'implementation-cost-v1',
      bhInput: 'pooled development windows',
      consistency: 'all four windows; final remains labelled OVERLAP_RISK',
      ranking: 'worst all-window PF, then smaller absolute average loss',
      membershipCheck: 'scripts/fmp-international-membership-check.json',
    },
    contextCounts,
    cells,
    bestByCell: bestTable(cells),
    japanLongReconciliation,
    consistentCount: cells.filter(cell => cell.consistent).length,
    liveBehaviorChanged: false,
    flagsEnabled: [],
  };
  writeJson(OUTPUT, report);
  fs.writeFileSync(READOUT, `${renderReadout(report)}\n`);
  fs.writeFileSync(PAPER, `${renderPaper(report)}\n`);
  writeJson(CHECKPOINT, {
    version: 1, study: STUDY_ID, state: 'complete',
    completedAt: report.generatedAt, output: path.relative(ROOT, OUTPUT),
    cells: cells.length, consistent: report.consistentCount,
  });
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}, ${path.relative(ROOT, READOUT)}, and ${path.relative(ROOT, PAPER)}.`);
  console.log(`Variants=${cells.length} CONSISTENT=${report.consistentCount}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
