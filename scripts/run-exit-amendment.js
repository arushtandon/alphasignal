#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
process.chdir(path.join(__dirname, '..'));

const { buildMarketRegime, fetchOHLCV, sectorEtfForSymbol } = require('../server');
const { signalAt, simulateTrade } = require('../lib/research/mean-reversion');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { EMBARGO, FOLD_SPEC, metric, nonOverlapping } = require('../lib/research/consistency-study');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { STATIC_GROUPS } = require('../universe');
const {
  positionSize, simulateAmendedMeanReversion, holdDistribution, maxConcurrent, approveAmendment,
} = require('../lib/research/exit-amendment');

const ROOT = process.cwd();
const WORKER_ROOT = path.join(ROOT, 'scripts', 'performance-stage1-v2-checkpoint.json.workers', 'stage1');
const PRICE_CACHE = path.join(ROOT, 'data', 'research', 'exit-amendment-prices');
const OUTPUT = path.join(ROOT, 'scripts', 'exit-amendment-results.json');
const READOUT = path.join(ROOT, 'docs', 'exit-amendment-readout.md');
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
const WORKERS = Math.max(1, Number(process.env.EXIT_AMENDMENT_WORKERS) || 4);

const MR = [
  { id: 'JAPAN_MEDIUM_MR', market: 'Japan', horizon: 'medium', trigger: 'williams_r10_lt_minus_95', regime: 'vol_skip_top30', stopAtr: 2.5, partial: false, cap: 5 },
  { id: 'JAPAN_SHORT_MR', market: 'Japan', horizon: 'short', trigger: 'williams_r10_lt_minus_95', regime: 'vol_skip_top30', stopAtr: 2.5, partial: true, cap: 3 },
  { id: 'COMMODITIES_MEDIUM_MR', market: 'Commodities', horizon: 'medium', trigger: 'close_below_lower_bb20_2', regime: 'none', stopAtr: 2.5, partial: true, cap: 3 },
  { id: 'US_SHORT_MR', market: 'US', horizon: 'short', trigger: 'williams_r10_lt_minus_95', regime: 'vol_skip_top30_and_ma50_flat_or_up', stopAtr: 2, partial: true, cap: 2 },
];
const ENGINE = [
  ['Japan', 'long', 3],
  ['Hong Kong', 'medium', 3],
  ['Hong Kong', 'long', 3],
  ['Germany', 'medium', 3],
  ['Germany', 'long', 3],
  ['France', 'long', 3],
  ['India', 'long', 3],
  ['Commodities', 'long', 3],
];
const BENCHMARK = {
  US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH', UK: 'EWU',
  Germany: 'EWG', France: 'EWQ', India: 'INDA', Commodities: 'DBC',
};
const FILE_MARKET = {
  US: 'US', Japan: 'Japan', 'Hong Kong': 'Hong_Kong', Germany: 'Germany', France: 'France',
};
const FX = { Japan: 'JPY', 'Hong Kong': 'HKD', Germany: 'EUR', France: 'EUR', UK: 'GBP', India: 'INR' };

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function dateOf(bar) {
  const value = Number(bar?.t);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}
const fxMaps = new Map();
function fxOn(market, date) {
  const currency = FX[market];
  if (!currency) return 1;
  if (!fxMaps.has(currency)) {
    const file = path.join(ROOT, 'data', 'research', 'fx', `${currency}USD_X.json`);
    const bars = fs.existsSync(file) ? readJson(file).bars || [] : [];
    fxMaps.set(currency, new Map(bars.map(bar => [dateOf(bar), Number(bar.c)])));
  }
  return fxMaps.get(currency).get(date) || 1;
}
function regimesFor(bars) {
  const values = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let index = 270; index < bars.length; index++) {
    const recent = [];
    for (let cursor = index - 19; cursor <= index; cursor++) recent.push(closes[cursor] / closes[cursor - 1] - 1);
    const recentMean = mean(recent);
    const volatility = Math.sqrt(mean(recent.map(value => (value - recentMean) ** 2)));
    const history = [];
    for (let cursor = index - 251; cursor <= index; cursor++) {
      const sample = [];
      for (let point = cursor - 19; point <= cursor; point++) sample.push(closes[point] / closes[point - 1] - 1);
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
const priceMemory = new Map();
async function loadPrice(symbol) {
  if (priceMemory.has(symbol)) return priceMemory.get(symbol);
  const file = path.join(PRICE_CACHE, `${String(symbol).replace(/[^\w.=-]/g, '_')}.json`);
  let bars = null;
  if (fs.existsSync(file)) {
    const cached = readJson(file);
    if (Array.isArray(cached) && cached.length >= 250) bars = cached;
  }
  if (!bars) {
    bars = await fetchOHLCV(symbol, '10y', '1d');
    if (Array.isArray(bars) && bars.length >= 15) {
      fs.mkdirSync(PRICE_CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(bars));
    }
  }
  priceMemory.set(symbol, bars);
  return bars;
}
function filesFor(market, horizon) {
  const prefix = `${FILE_MARKET[market]}__${horizon}__`;
  if (!FILE_MARKET[market] || !fs.existsSync(WORKER_ROOT)) return [];
  return fs.readdirSync(WORKER_ROOT).filter(file => file.startsWith(prefix) && file.endsWith('.result.json')).sort();
}
function foldsFor(bars, horizon) {
  return buildDateAlignedFolds(bars.map(dateOf), { ...FOLD_SPEC, embargoBars: EMBARGO[horizon] });
}
function months(range) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  return Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + 1);
}
function taken(trades, range) {
  return nonOverlapping(trades, range);
}
function variantRows(rows) {
  return rows.flatMap(row => {
    if (!row.variant?.closed) return [];
    return [{ ...row, ret: row.variant.ret, exitDate: row.variant.exitDate, holdBars: row.variant.holdBars, status: row.variant.status }];
  });
}
function summarise(label, trades, folds, cap) {
  const windows = folds.map(fold => {
    const baseline = taken(trades, fold.test);
    const amended = variantRows(baseline);
    const unresolved = baseline.length - amended.length;
    return {
      fold: fold.fold,
      range: fold.test,
      baseline: metric(baseline, months(fold.test)),
      amended: metric(amended, months(fold.test)),
      unresolved,
      hold: holdDistribution(amended),
      maxConcurrent: maxConcurrent(amended),
      cap,
    };
  });
  const approved = approveAmendment(
    windows.map(row => row.baseline),
    windows.map(row => row.amended),
  );
  return { label, approved, windows };
}
function line(row) {
  const base = row.baseline;
  const next = row.amended;
  return `| ${row.fold} | ${base.trades} | ${base.winRate} | ${base.profitFactor} | ${base.pnlUsd} | ${next.trades} | ${next.winRate} | ${next.profitFactor} | ${next.pnlUsd} | ${next.avgWinPct} / ${next.avgLossPct} | ${row.unresolved} | ${row.hold.median}/${row.hold.p90}/${row.hold.max} | ${row.maxConcurrent}/${row.cap} |`;
}

async function meanReversion() {
  const grouped = new Map(MR.map(setup => [setup.id, []]));
  const foldCache = new Map();
  const markets = [...new Set(MR.map(setup => setup.market))];
  for (const market of markets) {
    const benchmark = BENCHMARK[market];
    let contexts = [];
    if (FILE_MARKET[market]) {
      for (const file of filesFor(market, 'medium')) {
        const result = readJson(path.join(WORKER_ROOT, file)).result;
        if (result?.outcome === 'success' && result.context?.bars?.length >= 1400) contexts.push(result.context);
      }
    } else {
      const symbols = [...new Set((STATIC_GROUPS.COMMODITIES || []).concat([
        'ZW=F', 'ZC=F', 'ZS=F', 'GLD', 'SLV', 'USO', 'UNG', 'DBC', 'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX',
      ]))].filter(symbol => !symbol.endsWith('-USD'));
      const benchmarkBars = await loadPrice(benchmark);
      for (const symbol of symbols) {
        const bars = await loadPrice(symbol);
        if (bars?.length >= 1400) contexts.push({ symbol, bars, benchmarkBars });
      }
    }
    console.log(`[MR contexts] ${market}: ${contexts.length}`);
    const benchmarkBars = contexts[0]?.benchmarkBars || await loadPrice(BENCHMARK[market]);
    foldCache.set(market, {
      short: foldsFor(benchmarkBars, 'short'),
      medium: foldsFor(benchmarkBars, 'medium'),
    });
    const tide = buildMarketRegime(benchmarkBars);
    const regimes = regimesFor(benchmarkBars);
    let done = 0;
    for (const context of contexts) {
      const sectorSymbol = sectorEtfForSymbol(context.symbol);
      const sectorBars = !sectorSymbol || sectorSymbol === benchmark
        ? benchmarkBars
        : (await loadPrice(sectorSymbol)) || benchmarkBars;
      const sectorIndex = new Map((sectorBars || []).map((bar, index) => [dateOf(bar), index]));
      const setups = MR.filter(setup => setup.market === market);
      for (let index = 270; index < context.bars.length - 2; index++) {
        const signalDate = dateOf(context.bars[index]);
        if (market === 'US' && !membershipAt(US_SNAPSHOT, signalDate).has(context.symbol)) continue;
        for (const setup of setups) {
          if (!passesRegime(regimes, signalDate, setup.regime)) continue;
          if (!signalAt(context.bars, index, setup, tide, sectorBars, sectorIndex)) continue;
          const baseline = simulateTrade(context.bars, index, {
            trigger: setup.trigger, target: 'one_atr', stopAtr: setup.stopAtr,
            timeStopBars: setup.horizon === 'short' ? 5 : 21, partial: setup.partial,
          }, { market, symbol: context.symbol });
          if (!baseline) continue;
          const entryDate = dateOf(context.bars[baseline.entryIndex]);
          const sized = positionSize({
            symbol: context.symbol, market, price: Number(context.bars[baseline.entryIndex]?.o), fx: fxOn(market, entryDate),
          });
          const amended = simulateAmendedMeanReversion(context.bars, index, setup, {
            market, symbol: context.symbol, oneLot: sized?.oneLot === true,
          });
          grouped.get(setup.id).push({
            symbol: context.symbol,
            signalDate,
            entryDate,
            exitDate: dateOf(context.bars[baseline.exitIndex]),
            ret: baseline.ret,
            holdBars: baseline.exitIndex - baseline.entryIndex,
            status: baseline.status,
            oneLot: sized?.oneLot === true,
            variant: amended?.closed ? {
              ...amended,
              exitDate: dateOf(context.bars[amended.exitIndex]),
            } : { closed: false, status: 'open' },
          });
        }
      }
      done++;
      if (done % 50 === 0) console.log(`[MR] ${market}: ${done}/${contexts.length}`);
    }
  }
  return MR.map(setup => ({
    id: setup.id,
    kind: 'mean_reversion',
    ...summarise(setup.id, grouped.get(setup.id), foldCache.get(setup.market)[setup.horizon], setup.cap),
    trades: grouped.get(setup.id).length,
  }));
}

function runTasks(tasks) {
  if (!tasks.length) return Promise.resolve([]);
  const workerFile = path.join(__dirname, 'exit-amendment-trend-worker.js');
  const output = new Array(tasks.length);
  let next = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const children = [];
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
      child.send({ type: 'task', taskId, task: tasks[taskId] });
    };
    for (let index = 0; index < Math.min(WORKERS, tasks.length); index++) {
      const child = fork(workerFile, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, RESEARCH_MODE: '1', AUTH_TEST_BYPASS: '1', PORT: '0' },
      });
      children.push(child);
      child.on('message', message => {
        if (message?.type === 'ready') return assign(child);
        if (message?.type === 'error') {
          console.error(`engine task ${message.taskId} failed: ${String(message.error).split('\n')[0]}`);
          output[message.taskId] = [];
          completed++;
          assign(child);
          return;
        }
        if (message?.type !== 'result') return;
        output[message.taskId] = message.output;
        completed++;
        if (completed % 25 === 0) console.log(`[engine] ${completed}/${tasks.length}`);
        assign(child);
      });
      child.on('error', finish);
      child.on('exit', code => {
        if (!settled && code && completed < tasks.length) finish(new Error(`worker exit ${code}`));
      });
    }
  });
}

async function currentEngine() {
  const tasks = [];
  const folds = {};
  for (const [market, horizon, cap] of ENGINE) {
    const names = filesFor(market, horizon);
    if (names.length) {
      let benchmarkBars = null;
      for (const file of names) {
        const context = readJson(path.join(WORKER_ROOT, file)).result?.context;
        if (context?.benchmarkBars?.length) {
          benchmarkBars = context.benchmarkBars;
          break;
        }
      }
      if (!benchmarkBars) benchmarkBars = await loadPrice(BENCHMARK[market]);
      folds[`${market}|${horizon}`] = { folds: foldsFor(benchmarkBars, horizon), cap };
      for (const file of names) {
        tasks.push({ file: path.join(WORKER_ROOT, file), market, horizon, benchmark: BENCHMARK[market], cell: `${market}|${horizon}` });
      }
    } else {
      const symbols = market === 'India'
        ? [...new Set(STATIC_GROUPS.NIFTY50)]
        : [...new Set((STATIC_GROUPS.COMMODITIES || []).concat(['GLD', 'SLV', 'USO', 'UNG', 'DBC', 'PDBC', 'GSG', 'DBA', 'WEAT', 'COPX']))].filter(symbol => !String(symbol).endsWith('-USD'));
      const benchmarkBars = await loadPrice(BENCHMARK[market]);
      folds[`${market}|${horizon}`] = { folds: foldsFor(benchmarkBars, horizon), cap };
      for (const symbol of symbols) {
        tasks.push({ symbol, market, horizon, benchmark: BENCHMARK[market], cell: `${market}|${horizon}` });
      }
    }
  }
  console.log(`[engine tasks] ${tasks.length}`);
  const results = await runTasks(tasks);
  const grouped = new Map();
  results.forEach((rows, index) => {
    const cell = tasks[index].cell;
    if (!grouped.has(cell)) grouped.set(cell, []);
    grouped.get(cell).push(...(rows || []));
  });
  return ENGINE.map(([market, horizon, cap]) => {
    const key = `${market}|${horizon}`;
    const summary = summarise(key, grouped.get(key) || [], folds[key].folds, cap);
    return { id: key, kind: 'current_engine', market, horizon, ...summary, trades: (grouped.get(key) || []).length };
  });
}

function render(cells) {
  const lines = [
    '# Exit amendment replay',
    '',
    'Pre-registration: docs/exit-amendment-preregistration.md',
    '',
    'Baseline is the tested exit. Amended removes time and signal exits and applies the one-lot ratchet only to single-lot positions.',
    '',
  ];
  for (const cell of cells) {
    lines.push(`## ${cell.label || cell.id} — ${cell.approved ? 'APPLY' : 'KEEP TESTED EXITS'}`);
    lines.push('');
    lines.push('| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |');
    for (const row of cell.windows) lines.push(line(row));
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const engineOnly = process.argv.includes('--engine-only');
  let mr = [];
  if (engineOnly) {
    mr = (readJson(OUTPUT).cells || []).filter(cell => cell.kind === 'mean_reversion');
    console.log(`Reusing ${mr.length} mean-reversion cells`);
  } else {
    console.log('Mean-reversion amendment replay');
    mr = await meanReversion();
    fs.writeFileSync(OUTPUT, JSON.stringify({ phase: 'mean-reversion', cells: mr }, null, 2));
  }
  console.log('Current-engine amendment replay');
  const engine = await currentEngine();
  const cells = [...mr, ...engine];
  const report = {
    generatedAt: new Date().toISOString(),
    preregistration: 'docs/exit-amendment-preregistration.md',
    cells,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(READOUT, render(cells));
  console.log(`Wrote ${READOUT}`);
  for (const cell of cells) console.log(`${cell.approved ? 'APPLY' : 'KEEP'} ${cell.id}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
