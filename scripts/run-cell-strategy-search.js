#!/usr/bin/env node
'use strict';

// Research only. Scores the requested empty market × horizon cells under the
// consistency-first framework. See docs/cell-strategy-search-preregistration.md.
//
//   node scripts/run-cell-strategy-search.js            # full (replays engine short)
//   node scripts/run-cell-strategy-search.js --skipEngine
//   node scripts/run-cell-strategy-search.js --engineWorkers=4

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '3999';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
process.chdir(path.join(__dirname, '..'));

const { STATIC_GROUPS } = require('../universe');
const { buildDateAlignedFolds, assertFoldIsolation } = require('../lib/research/walk-forward-optimizer');
const { EMBARGO, FOLD_SPEC, scoreVariant, applyBh } = require('../lib/research/consistency-study');
const {
  STUDY_ID, REQUESTED_CELLS, ENGINE_SHORT_MARKETS, isRequested, cellKey,
  normalizeConsistencyCell, normalizeBookRow, buildCellTable,
} = require('../lib/research/cell-strategy-search');

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value ?? '1'];
}));
const WORKER_ROOT = path.resolve(ROOT, 'scripts/performance-stage1-v2-checkpoint.json.workers/stage1');
const CONSISTENCY = path.resolve(ROOT, 'scripts/consistency-study-results.json');
const NEW_TYPES = path.resolve(ROOT, 'scripts/new-strategy-types-results.json');
const AMENDMENT = path.resolve(ROOT, 'scripts/strategy-amendment-results.json');
const RESCUE = path.resolve(ROOT, 'scripts/backtest-omitted-geo-rescue-results.json');
const ENGINE_SHORT = path.resolve(ROOT, args.engineOutput || 'scripts/cell-strategy-search-engine-short.json');
const OUTPUT = path.resolve(ROOT, args.output || 'scripts/cell-strategy-search-results.json');
const READOUT = path.resolve(ROOT, args.readout || 'docs/cell-strategy-search-readout.md');
const ENGINE_WORKERS = Math.max(1, Number(args.engineWorkers) || 6);
const MIN_BARS = 1400;

const FILE_MARKET = { 'Hong Kong': 'Hong_Kong', UK: 'UK', Germany: 'Germany', France: 'France' };
const BENCHMARK = { Commodities: 'DBC', Crypto: 'BTC-USD' };
const EXTRA_COMMODITIES = [
  'ZW=F', 'ZC=F', 'ZS=F', 'GLD', 'SLV', 'USO', 'UNG', 'DBC',
  'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX',
];
const FETCHED_UNIVERSES = {
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
function normalizeTrade(row, context) {
  return {
    ...row,
    symbol: context.symbol,
    market: context.market,
    signalDate: row.signalDate || dateOf(context.bars[row.signalIndex]),
    entryDate: row.entryDate || dateOf(context.bars[row.entryIndex]),
    exitDate: row.exitDate || dateOf(context.bars[row.exitIndex]),
  };
}
function survivorshipLabel(market) {
  if (market === 'Commodities' || market === 'Crypto') return 'NOT_APPLICABLE';
  return 'SURVIVORSHIP_BIAS';
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
function engineId(market, sector) {
  return `B__${market.replace(/\s+/g, '_')}__short__sector_${sector ? 'on' : 'off'}`;
}

// ── Engine short replay ────────────────────────────────────────────────────
function cachedShortContexts(market) {
  const prefix = `${FILE_MARKET[market]}__short__`;
  const contexts = [];
  const cachedOff = [];
  for (const file of fs.readdirSync(WORKER_ROOT).filter(name => name.startsWith(prefix) && name.endsWith('.result.json')).sort()) {
    const result = readJson(path.join(WORKER_ROOT, file)).result;
    if (result?.outcome !== 'success' || !(result.context?.bars?.length >= MIN_BARS)) continue;
    const context = { ...result.context, market, symbol: result.context.symbol };
    contexts.push(context);
    for (const raw of result.eventSets?.primary?.buy || []) cachedOff.push(normalizeTrade(raw, context));
  }
  return { contexts, cachedOff };
}
function runWorkerTasks(tasks) {
  if (!tasks.length) return Promise.resolve([]);
  const workerFile = path.join(__dirname, 'consistency-trend-worker.js');
  const count = Math.min(ENGINE_WORKERS, tasks.length);
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
        if (message?.type === 'ready') { assign(child); return; }
        if (message?.type === 'error') {
          finish(new Error(`Engine worker task ${message.taskId} failed: ${message.error}`));
          return;
        }
        if (message?.type !== 'result') return;
        output[message.taskId] = message.output;
        completed++;
        if (completed % 20 === 0 || completed === tasks.length) {
          console.log(`[engine short] ${completed}/${tasks.length}`);
        }
        assign(child);
      });
      child.on('error', finish);
      child.on('exit', code => {
        if (!settled && code && completed < tasks.length) {
          finish(new Error(`Engine worker exited ${code} during task ${child._taskId}.`));
        }
      });
    }
  });
}
async function replayEngineShort() {
  // Lazy: loading server.js is only needed for the replay.
  const { fetchOHLCV, sectorEtfForSymbol } = require('../server');
  const priceCache = new Map();
  const loadPrice = symbol => {
    if (!priceCache.has(symbol)) priceCache.set(symbol, fetchOHLCV(symbol, '10y', '1d').catch(() => null));
    return priceCache.get(symbol);
  };
  const out = { generatedAt: new Date().toISOString(), study: STUDY_ID, markets: {} };
  for (const market of ENGINE_SHORT_MARKETS) {
    let contexts;
    let benchmarkBars;
    let cachedOff = null;
    if (FILE_MARKET[market]) {
      const cached = cachedShortContexts(market);
      contexts = cached.contexts;
      cachedOff = cached.cachedOff;
      benchmarkBars = contexts[0]?.benchmarkBars;
    } else {
      benchmarkBars = await loadPrice(BENCHMARK[market]);
      contexts = [];
      for (const symbol of FETCHED_UNIVERSES[market]) {
        const bars = await loadPrice(symbol);
        if (bars?.length >= MIN_BARS) contexts.push({ market, symbol, bars, benchmarkBars, arrays: null });
      }
    }
    if (!benchmarkBars?.length) throw new Error(`${market}: benchmark bars unavailable.`);
    console.log(`[contexts] ${market} short: ${contexts.length}`);
    const tasks = [];
    for (const context of contexts) {
      const proxy = sectorEtfForSymbol(context.symbol);
      const proxyBars = proxy ? await loadPrice(proxy) : null;
      const sectorBars = Array.isArray(proxyBars) && proxyBars.length >= 250 ? proxyBars : benchmarkBars;
      const variants = [{ id: engineId(market, true), horizon: 'short', sector: true }];
      if (!cachedOff) variants.push({ id: engineId(market, false), horizon: 'short', sector: false });
      tasks.push({
        context: {
          market, symbol: context.symbol, bars: context.bars,
          benchmarkBars, arrays: context.arrays || null,
        },
        sectorBars,
        variants,
      });
    }
    const results = await runWorkerTasks(tasks);
    const trades = { [engineId(market, true)]: [], [engineId(market, false)]: cachedOff || [] };
    for (const result of results) {
      for (const [id, rows] of Object.entries(result || {})) trades[id].push(...rows);
    }
    out.markets[market] = {
      contexts: contexts.length,
      benchmarkDates: benchmarkBars.map(dateOf),
      sectorOffSource: cachedOff ? 'stage1-cache primary buy events' : 'replayed',
      trades,
    };
    writeJson(ENGINE_SHORT, out);
  }
  return out;
}
function scoreEngineShort(replay) {
  const cells = [];
  for (const market of ENGINE_SHORT_MARKETS) {
    const data = replay.markets[market];
    if (!data) continue;
    const benchmarkBars = data.benchmarkDates.map(date => ({ t: Date.parse(`${date}T00:00:00Z`) }));
    const folds = foldsFor(market, 'short', benchmarkBars);
    for (const sector of [false, true]) {
      const id = engineId(market, sector);
      const definition = { id, part: 'B', market, horizon: 'short', side: 'buy', sector };
      cells.push(scoreVariant(definition, data.trades[id] || [], folds, survivorshipLabel(market)));
    }
  }
  applyBh(cells);
  return cells;
}

// ── Reference rows (different fold calendar; not ranked) ───────────────────
function rescueReference() {
  if (!fs.existsSync(RESCUE)) return [];
  const rescue = readJson(RESCUE);
  const marketName = { HK: 'Hong Kong' };
  return (rescue.cells || []).map(cell => ({
    market: marketName[cell.market] || cell.market,
    horizon: cell.horizon,
    model: cell.frozenModel,
    holdout: cell.holdout || null,
    development: cell.development || null,
    decision: `mtcPass ${cell.mtcPass}, stable development folds ${fmt(cell.stableDevelopmentFolds)}, sample confidence ${fmt(cell.sampleConfidence?.flag)}, promotable ${fmt(cell.sampleConfidence?.promotable)}`,
    note: 'Omitted-geography rescue (2026-09-25): different fold calendar; reference only.',
  })).filter(row => isRequested(row.market, row.horizon));
}

// ── Readout ────────────────────────────────────────────────────────────────
const fmt = value => value == null ? '—' : value;
const pct = value => value == null ? '—' : `${value}%`;
function windowText(row) {
  return row.windows.map(window => {
    const money = window.pnlUsd != null ? `$${window.pnlUsd}` : pct(window.returnPct);
    return `${money} / PF ${fmt(window.profitFactor)} / n ${window.trades}`;
  }).join(' · ');
}
function renderReadout(report) {
  const lines = [
    '# Cell strategy search — readout',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'Research only. No live signal, setup-book cell, bracket, order, flag, or deployment setting changed.',
    'Pre-registration: `docs/cell-strategy-search-preregistration.md`. Consistency rule: mean reversion needs every window profitable with win rate ≥ 60%; trend, momentum, breakout, reversal and earnings books need every window profitable with PF ≥ 1.2. Ranking: CONSISTENT first, then worst all-window PF, then smaller average loss. The fourth window is OVERLAP_RISK in every source.',
    '',
    '## Best strategy by requested cell',
    '',
    'A row is the best available strategy for the cell, not an endorsement: only CONSISTENT cells clear the framework. Rows from the trend/momentum books report per-window book return (%) rather than $ PnL; the crypto trend rows are the same monthly-rebalanced book scored under the medium and long labels in the source study.',
    '',
    '| Market | Horizon | Verdict | Best row | Family | Worst PF | Pooled n | Pooled WR | Pooled PF | Why not consistent | Source | Membership |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
  ];
  for (const cell of report.cells) {
    const best = cell.best;
    lines.push(`| ${cell.market} | ${cell.horizon} | ${cell.verdict} | ${best ? `\`${best.id}\`` : '—'} | ${best ? best.kind : '—'} | ${best ? fmt(best.worstWindowPf) : '—'} | ${best ? best.pooled.trades : '—'} | ${best ? pct(best.pooled.winRate) : '—'} | ${best ? fmt(best.pooled.profitFactor) : '—'} | ${best ? (best.failReason || '—') : 'no variant in any source'} | ${best ? best.source : '—'} | ${best ? fmt(best.survivorship) : '—'} |`);
  }
  lines.push('', '## Per-cell detail', '');
  for (const cell of report.cells) {
    lines.push(`### ${cell.market} · ${cell.horizon} — ${cell.verdict}`, '');
    lines.push(`Variants scored: ${cell.variantsScored}.${cell.blockedFamilies.length ? ` Blocked families: ${cell.blockedFamilies.join('; ')}.` : ''}`, '');
    lines.push('| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |');
    lines.push('| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |');
    for (const family of cell.families) {
      const b = family.best;
      lines.push(`| ${family.kind} | ${family.variants} | ${family.consistent} | ${b ? `\`${b.id}\`` : '—'} | ${b ? fmt(b.worstWindowPf) : '—'} | ${b ? fmt(b.pooledTrades) : '—'} | ${b ? pct(b.pooledWinRate) : '—'} | ${b ? fmt(b.pooledProfitFactor) : '—'} | ${b ? (b.failReason || '—') : '—'} |`);
    }
    lines.push('', 'Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):', '');
    for (const row of cell.top) {
      lines.push(`- \`${row.id}\` — ${row.description}. ${windowText(row)}.${row.sourceVerdict ? ` Source verdict: ${row.sourceVerdict}.` : ''}${row.benchmarkBeat != null ? ` Beat benchmark in ${row.benchmarkBeat}/4 windows.` : ''}${row.bhQValue != null ? ` BH q ${row.bhQValue}.` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Live engine at the short horizon (new replay)', '');
  lines.push('Sector OFF for Hong Kong, UK, Germany and France is the stage-1 cache primary buy stream (same engine, same bars); sector ON was replayed through `scripts/consistency-trend-worker.js`. Commodities and Crypto were fetched fresh (10y daily) and replayed for both variants. The engine almost never fires at the short horizon: 0–4 trades per market over the whole sample, so no window pattern exists to be consistent. A small BH q with n ≤ 4 (Hong Kong) is a win-rate artefact, not evidence; the consistency rule already fails on the empty window.', '');
  lines.push('| Market | Sector | Contexts | Pooled n | Pooled WR | Pooled PF | Pooled PnL | Windows (PnL / PF / n) | BH q | Consistent |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |');
  for (const row of report.engineShort) {
    lines.push(`| ${row.market} | ${row.sector ? 'on' : 'off'} | ${row.contexts} | ${row.pooledDevelopment.trades} | ${pct(row.pooledDevelopment.winRate)} | ${fmt(row.pooledDevelopment.profitFactor)} | $${fmt(row.pooledDevelopment.pnlUsd)} | ${row.windows.map(window => `$${window.metrics.pnlUsd} / ${fmt(window.metrics.profitFactor)} / ${window.metrics.trades}`).join(' · ')} | ${fmt(row.bhQValue)} | ${row.consistent} |`);
  }
  lines.push('', '## Reference only — omitted-geography rescue (different fold calendar)', '');
  for (const row of report.reference) {
    const h = row.holdout || {};
    lines.push(`- ${row.market} ${row.horizon}: \`${row.model}\` holdout n ${fmt(h.trades)}, WR ${pct(h.winRate)}, PF ${fmt(h.profitFactor)}, PnL $${fmt(h.pnlUsd)} — ${row.decision}.`);
  }
  lines.push('', '## Sources', '');
  for (const source of report.sources) lines.push(`- ${source}`);
  lines.push('', 'Machine-readable results: `scripts/cell-strategy-search-results.json`; engine-short replay trades: `scripts/cell-strategy-search-engine-short.json`.', '');
  return lines.join('\n');
}

async function main() {
  const consistency = readJson(CONSISTENCY);
  const newTypes = readJson(NEW_TYPES);
  const amendment = readJson(AMENDMENT);
  const rows = [];
  const blocked = {};

  for (const cell of consistency.cells) {
    if (!isRequested(cell.market, cell.horizon)) continue;
    rows.push(normalizeConsistencyCell(cell, 'consistency-study 2026-10-05'));
  }
  for (const row of newTypes.rows) {
    if (!isRequested(row.market, row.horizon)) continue;
    if (row.verdict === 'INSUFFICIENT') {
      const key = cellKey(row.market, row.horizon);
      blocked[key] = blocked[key] || [];
      const family = String(row.id).split('__')[0];
      const label = `${family} (${String(row.strategy).split(',')[0]}): ${row.reason}`;
      if (!blocked[key].includes(label)) blocked[key].push(label);
      continue;
    }
    rows.push(normalizeBookRow(row, 'new-strategy-types 2026-10-05'));
  }
  for (const row of amendment.rows) {
    if (!isRequested(row.market, row.horizon)) continue;
    rows.push(normalizeBookRow({ ...row, id: `${row.id}__longsample` }, 'strategy-amendment 2026-10-06'));
  }

  let replay = null;
  if (args.skipEngine !== '1') {
    replay = await replayEngineShort();
  } else if (fs.existsSync(ENGINE_SHORT)) {
    replay = readJson(ENGINE_SHORT);
  }
  const engineShort = replay ? scoreEngineShort(replay) : [];
  for (const cell of engineShort) {
    cell.contexts = replay.markets[cell.market].contexts;
    rows.push(normalizeConsistencyCell(cell, 'engine-short replay 2026-10-22'));
  }

  const cells = buildCellTable(rows, blocked);
  const report = {
    generatedAt: new Date().toISOString(),
    study: STUDY_ID,
    mode: 'BACKTEST_ONLY',
    preregistration: 'docs/cell-strategy-search-preregistration.md',
    requestedCells: REQUESTED_CELLS,
    sources: [
      'scripts/consistency-study-results.json (Part A MR grid short/medium; Part B live engine medium/long; Part C Wave 3)',
      'scripts/new-strategy-types-results.json (momentum, weekly reversal, commodity/crypto trend and breakout, PEAD)',
      'scripts/strategy-amendment-results.json (momentum on the longer sample; US earnings reaction)',
      'scripts/cell-strategy-search-engine-short.json (new: live engine short horizon, sector off/on)',
      'scripts/backtest-omitted-geo-rescue-results.json (reference only)',
    ],
    rowsScored: rows.length,
    cells,
    engineShort,
    reference: rescueReference(),
    liveBehaviorChanged: false,
    flagsEnabled: [],
  };
  writeJson(OUTPUT, report);
  fs.writeFileSync(READOUT, `${renderReadout(report)}\n`);
  console.log(`Rows scored: ${rows.length}. Cells CONSISTENT: ${cells.filter(cell => cell.verdict === 'CONSISTENT').length}/${cells.length}.`);
  for (const cell of cells) {
    console.log(`${cell.market} ${cell.horizon}: ${cell.verdict} ${cell.best ? cell.best.id : ''} ${cell.best?.failReason || ''}`);
  }
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} and ${path.relative(ROOT, READOUT)}.`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  // server.js keeps timers alive once required for the replay.
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});
