'use strict';

// Part B of the frozen regime-hedge study. Rebuilds each buy setup's trades
// from the stage-1 worker price cache (including .T) and scores the index
// hedge. Does not import server.js. Commodities hedge-on stays a gap:
// HEDGE_ETFS has no commodities ETF and DBC is not a substitute.
const fs = require('fs');
const path = require('path');
const { sma } = require('../lib/research/mean-reversion');
const { signalAt, simulateTrade } = require('../lib/research/mean-reversion');
const { SETUPS, wave3SignalAt } = require('../lib/strategy/evidence-setup-book');
const { confirmedDowntrend, HEDGE_ETFS } = require('../lib/research/regime-sell-hedge');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { EMBARGO, FOLD_SPEC } = require('../lib/research/consistency-study');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');
const { PROFILES, estimateRoundTripCostPct, applyCosts } = require('../lib/research/cost-model');

const ROOT = path.join(__dirname, '..');
const WORKERS = path.join(ROOT, 'scripts', 'performance-stage1-v2-checkpoint.json.workers', 'stage1');
const OUT_JSON = path.join(ROOT, 'scripts', 'regime-hedge-part-b-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'regime-hedge-part-b-2026-10-07.md');
const NOTIONAL = 30000;
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));

const SETUPS_TO_SCORE = [
  { id: 'JAPAN_MEDIUM_MR', market: 'Japan', horizon: 'medium', prefix: 'Japan__medium__', hedge: 'EWJ' },
  { id: 'JAPAN_SHORT_MR', market: 'Japan', horizon: 'short', prefix: 'Japan__short__', hedge: 'EWJ' },
  { id: 'US_SHORT_MR', market: 'US', horizon: 'short', prefix: 'US__short__', hedge: 'SPY' },
  { id: 'US_LONG_WAVE3', market: 'US', horizon: 'long', prefix: 'US__long__', hedge: 'SPY', wave: true },
];

function dateOf(bar) {
  const value = Number(bar?.t);
  if (!(value > 0)) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
}
function stampDate(value) {
  const number = Number(value);
  if (!(number > 0)) return null;
  return new Date(number < 1e12 ? number * 1000 : number).toISOString().slice(0, 10);
}
function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}
function buildMarketRegime(bars) {
  const map = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let index = 0; index < bars.length; index += 1) {
    const close = closes[index];
    if (!Number.isFinite(close)) continue;
    const ma50 = sma(bars, index, 50);
    const ma200 = sma(bars, index, 200);
    const ma50Prev = sma(bars, index - 10, 50);
    const aboveMa200 = ma200 != null ? close > ma200 : close >= closes[Math.max(0, index - 1)];
    const aboveMa50 = ma50 != null ? close > ma50 : true;
    const ma50Rising = ma50 != null && ma50Prev != null ? ma50 > ma50Prev : true;
    const goldMa = ma50 != null && ma200 != null ? ma50 > ma200 : aboveMa50;
    let trend = 'flat';
    if (aboveMa200 && aboveMa50 && goldMa && ma50Rising) trend = 'up';
    else if (!aboveMa200 && !ma50Rising) trend = 'down';
    const riskOff = ma200 != null ? (!aboveMa200 && !ma50Rising) : false;
    map.set(dateOf(bars[index]), { riskOff, trend, aboveMa200, aboveMa50, ma50Rising });
  }
  return map;
}
function benchmarkRegimes(bars) {
  const values = new Map();
  const closes = bars.map(bar => Number(bar.c));
  for (let index = 270; index < bars.length; index += 1) {
    const recent = [];
    for (let cursor = index - 19; cursor <= index; cursor += 1) {
      recent.push(closes[cursor] / closes[cursor - 1] - 1);
    }
    const recentMean = mean(recent);
    const volatility = Math.sqrt(mean(recent.map(value => (value - recentMean) ** 2)));
    const history = [];
    for (let cursor = index - 251; cursor <= index; cursor += 1) {
      const sample = [];
      for (let point = cursor - 19; point <= cursor; point += 1) {
        sample.push(closes[point] / closes[point - 1] - 1);
      }
      const sampleMean = mean(sample);
      history.push(Math.sqrt(mean(sample.map(value => (value - sampleMean) ** 2))));
    }
    history.sort((left, right) => left - right);
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
function readResult(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).result;
}
function filesFor(prefix) {
  return fs.readdirSync(WORKERS).filter(name => name.startsWith(prefix) && name.endsWith('.result.json')).sort();
}
function allowed(market, symbol, date) {
  return market !== 'US' || membershipAt(US_SNAPSHOT, date).has(symbol);
}
function dailyFromPath(bars, entryIndex, exitIndex, entryPrice, exitPrice, netRet) {
  const days = [];
  let prev = entryPrice;
  for (let index = entryIndex; index <= exitIndex; index += 1) {
    const price = index === exitIndex ? exitPrice : Number(bars[index].c);
    const ret = prev > 0 && Number.isFinite(price) ? price / prev - 1 : 0;
    days.push({ date: dateOf(bars[index]), ret });
    prev = price;
  }
  const gross = days.reduce((sum, day) => sum + day.ret, 0);
  const gap = (Number(netRet) || 0) - gross;
  if (days.length) days[days.length - 1].ret += gap;
  return days;
}
function collectMeanReversion(spec) {
  const setup = SETUPS[spec.id];
  const names = filesFor(spec.prefix);
  const trades = [];
  let benchmark = null;
  let tide = null;
  let regimes = null;
  let sectorIndex = null;
  let symbols = 0;
  for (const name of names) {
    const result = readResult(path.join(WORKERS, name));
    if (result?.outcome !== 'success' || !result.context?.bars?.length) continue;
    const context = result.context;
    symbols += 1;
    if (!benchmark) {
      benchmark = context.benchmarkBars;
      tide = buildMarketRegime(benchmark);
      regimes = benchmarkRegimes(benchmark);
      sectorIndex = new Map(benchmark.map((bar, index) => [dateOf(bar), index]));
    }
    const candidate = {
      trigger: setup.trigger,
      target: 'one_atr',
      stopAtr: setup.stopAtr,
      timeStopBars: setup.amendedExits ? context.bars.length : setup.timeStopBars,
      partial: setup.partial,
    };
    for (let index = 270; index < context.bars.length - 2; index += 1) {
      const date = dateOf(context.bars[index]);
      if (!passesRegime(regimes, date, setup.regime)) continue;
      if (!signalAt(context.bars, index, candidate, tide, context.benchmarkBars, sectorIndex)) continue;
      if (!allowed(spec.market, context.symbol, date)) continue;
      const trade = simulateTrade(context.bars, index, candidate, { market: spec.market, symbol: context.symbol });
      if (!trade) continue;
      const entryPrice = Number(context.bars[trade.entryIndex].o);
      const days = dailyFromPath(
        context.bars,
        trade.entryIndex,
        trade.exitIndex,
        entryPrice,
        Number(context.bars[trade.exitIndex].c),
        trade.ret,
      );
      trades.push({
        symbol: context.symbol,
        entryDate: dateOf(context.bars[trade.entryIndex]),
        exitDate: dateOf(context.bars[trade.exitIndex]),
        ret: trade.ret,
        days,
      });
    }
    if (symbols % 40 === 0) console.log(`[${spec.id}] ${symbols} symbols, ${trades.length} trades`);
  }
  return { trades, benchmark, symbols, files: names.length };
}
function waveTrueRange(bars, index) {
  const bar = bars[index];
  const previous = Number(bars[index - 1]?.c);
  const high = Number(bar?.h);
  const low = Number(bar?.l);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  if (!Number.isFinite(previous)) return high - low;
  return Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
}
function waveAtr(bars, index, period = 20) {
  if (index - period + 1 < 1) return null;
  let sum = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const range = waveTrueRange(bars, cursor);
    if (range == null) return null;
    sum += range;
  }
  return sum / period;
}
function simulateWaveLong(bars, signalIndex) {
  const entryIndex = signalIndex + 1;
  const entry = Number(bars[entryIndex]?.o);
  const entryAtr = waveAtr(bars, signalIndex, 20);
  if (!(entry > 0) || !(entryAtr > 0)) return null;
  let stop = entry - 4 * entryAtr;
  let favorable = entry;
  const end = Math.min(entryIndex + 180, bars.length - 1);
  for (let index = entryIndex; index <= end; index += 1) {
    const high = Number(bars[index].h);
    const low = Number(bars[index].l);
    const close = Number(bars[index].c);
    const open = Number(bars[index].o) || close;
    if (low <= stop) {
      return { entryIndex, exitIndex: index, exit: Math.min(open, stop), entry };
    }
    const currentAtr = waveAtr(bars, index, 20) || entryAtr;
    favorable = Math.max(favorable, high);
    stop = Math.max(stop, favorable - 5 * currentAtr);
    const ma200 = sma(bars, index, 200);
    if (ma200 > 0 && close < ma200) {
      return { entryIndex, exitIndex: index, exit: close, entry };
    }
  }
  return { entryIndex, exitIndex: end, exit: Number(bars[end].c) || entry, entry };
}
function collectWave(spec) {
  const names = filesFor(spec.prefix);
  const trades = [];
  let benchmark = null;
  let symbols = 0;
  for (const name of names) {
    const result = readResult(path.join(WORKERS, name));
    if (result?.outcome !== 'success' || !result.context?.bars?.length) continue;
    symbols += 1;
    if (!benchmark) benchmark = result.context.benchmarkBars;
    const bars = result.context.bars;
    let index = 275;
    while (index < bars.length - 2) {
      if (!wave3SignalAt(bars, index)) { index += 2; continue; }
      const signalDate = dateOf(bars[index]);
      if (!allowed(spec.market, result.context.symbol, signalDate)) { index += 2; continue; }
      const trade = simulateWaveLong(bars, index);
      if (!trade) { index += 2; continue; }
      const gross = trade.exit / trade.entry - 1;
      const exitDate = dateOf(bars[trade.exitIndex]);
      const entryDate = dateOf(bars[trade.entryIndex]);
      const heldDays = Math.max(0, (Date.parse(exitDate) - Date.parse(entryDate)) / 86400000);
      const costed = applyCosts(gross, {
        market: spec.market, symbol: result.context.symbol, side: 'buy', holdDays: heldDays,
      });
      trades.push({
        symbol: result.context.symbol,
        entryDate,
        exitDate,
        ret: costed.netReturn,
        days: dailyFromPath(bars, trade.entryIndex, trade.exitIndex, trade.entry, trade.exit, costed.netReturn),
      });
      index = Math.max(index + 2, trade.exitIndex + 1);
    }
    if (symbols % 100 === 0) console.log(`[${spec.id}] ${symbols} symbols, ${trades.length} trades`);
  }
  return { trades, benchmark, symbols, files: names.length };
}
function scoreBook(trades, benchmark, horizon) {
  const dates = benchmark.map(dateOf).filter(Boolean);
  const folds = buildDateAlignedFolds(dates, { ...FOLD_SPEC, embargoBars: EMBARGO[horizon] });
  const windows = folds.map(fold => fold.test);
  const byDate = new Map();
  for (const trade of trades) {
    for (const day of trade.days) {
      if (!byDate.has(day.date)) byDate.set(day.date, []);
      byDate.get(day.date).push(day.ret);
    }
  }
  const down = benchmark.map((bar, index) => index > 0 && confirmedDowntrend(benchmark, index - 1));
  const benchRet = benchmark.map((bar, index) => {
    if (index === 0) return 0;
    const prev = Number(benchmark[index - 1].c);
    const close = Number(bar.c);
    return prev > 0 ? close / prev - 1 : 0;
  });
  const oneWay = estimateRoundTripCostPct({
    market: 'US', symbol: 'SPY', side: 'sell', holdDays: 0, profile: { borrowBpsPerDay: 0 },
  }) / 2 / 100;
  const borrowPerDay = PROFILES.US.borrowBpsPerDay / 10000;
  function run(hedgeOn) {
    let prevHedge = 0;
    let hedgePnl = 0;
    let execution = 0;
    let borrow = 0;
    const daily = dates.map((date, index) => {
      const rets = byDate.get(date) || [];
      const exposure = rets.length * NOTIONAL;
      const stock = rets.reduce((sum, value) => sum + value, 0) * NOTIONAL;
      let hedge = 0;
      const active = hedgeOn && down[index] && exposure > 0;
      const hedgeNotional = active ? exposure : 0;
      if (hedgeNotional > 0) {
        hedge -= benchRet[index] * hedgeNotional;
        const borrowDollars = borrowPerDay * hedgeNotional;
        hedge -= borrowDollars;
        borrow += borrowDollars;
      }
      const traded = Math.abs(hedgeNotional - prevHedge);
      const fee = traded * oneWay;
      hedge -= fee;
      execution += fee;
      prevHedge = hedgeNotional;
      hedgePnl += hedge;
      return { date, stock, hedge, exposure, hedged: hedgeNotional > 0 };
    });
    return { daily, hedgePnl, execution, borrow };
  }
  function windowStats(daily, range) {
    const rows = daily.filter(row => row.date >= range.from && row.date <= range.to && row.exposure > 0);
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    let gains = 0;
    let losses = 0;
    let pnl = 0;
    let hedged = 0;
    for (const row of rows) {
      const dayPnl = row.stock + row.hedge;
      pnl += dayPnl;
      const ret = dayPnl / row.exposure;
      if (dayPnl > 0) gains += dayPnl;
      else losses += dayPnl;
      equity *= (1 + ret);
      peak = Math.max(peak, equity);
      maxDd = Math.min(maxDd, equity / peak - 1);
      if (row.hedged) hedged += 1;
    }
    return {
      from: range.from,
      to: range.to,
      sessions: rows.length,
      sessionsHedged: hedged,
      returnPct: rows.length ? +((equity - 1) * 100).toFixed(2) : null,
      pnlUsd: +pnl.toFixed(0),
      profitFactor: losses < 0 ? +(gains / Math.abs(losses)).toFixed(3) : null,
      maxDrawdownPct: rows.length ? +(maxDd * 100).toFixed(2) : null,
    };
  }
  const off = run(false);
  const on = run(true);
  return {
    trades: trades.length,
    windows: windows.map(range => ({
      range,
      off: windowStats(off.daily, range),
      on: windowStats(on.daily, range),
    })),
    hedgeLeg: {
      pnlUsd: +on.hedgePnl.toFixed(0),
      executionUsd: +on.execution.toFixed(0),
      borrowUsd: +on.borrow.toFixed(0),
    },
  };
}
function money(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function main() {
  const lines = [
    '# Regime hedge Part B',
    '',
    'Scored from the stage-1 worker price cache. No `server.js` import. Each open trade is $30,000 from its entry date through its exit date. The hedge is short the US-listed index ETF on the session after a confirmed downtrend, sized to the prior exposure, and covered when that state ends. Hedge execution and borrow use the US cost profile because SPY and EWJ are US-listed.',
    '',
    'The sector filter uses the market benchmark. The ticker-to-sector map lives in `server.js` and was not copied. Japan `.T` prices are the bars stored on the Japan worker results. Japan amended books drop the time stop and hold until the target, the stop, or the last cached bar.',
    '',
    'US_LONG_WAVE3 is rebuilt from those same bars: 12-1 momentum above zero, close above MA200, entry on the next open, 4 ATR initial stop, 5 ATR trail, MA200 exit, 180-session cap, sampled every second bar. The worker files do not store that trade list.',
    '',
    'COMMODITIES_MEDIUM_MR hedge-on is a gap. `HEDGE_ETFS` has no commodities ETF. DBC was not substituted. There is also no Commodities worker cache, so hedge-off was not rebuilt.',
    '',
  ];
  const results = [];
  for (const spec of SETUPS_TO_SCORE) {
    console.log('setup', spec.id);
    const book = spec.wave ? collectWave(spec) : collectMeanReversion(spec);
    if (!book.benchmark || !book.trades.length) {
      results.push({ id: spec.id, gap: true, symbols: book.symbols, files: book.files, trades: book.trades.length });
      lines.push(`## ${spec.id}`, '', `Not scored. Worker files ${book.files}, symbols ${book.symbols}, trades ${book.trades.length}.`, '');
      continue;
    }
    const scored = scoreBook(book.trades, book.benchmark, spec.horizon);
    results.push({ id: spec.id, hedge: spec.hedge, symbols: book.symbols, ...scored });
    lines.push(`## ${spec.id}`, '', `Hedge ETF ${spec.hedge}. Symbols ${book.symbols}. Trades ${scored.trades}. Hedge-leg P&L $${money(scored.hedgeLeg.pnlUsd)} (execution $${money(scored.hedgeLeg.executionUsd)}, borrow $${money(scored.hedgeLeg.borrowUsd)}).`, '');
    lines.push('| Window | Hedge | Return | PF | Max DD | Sessions | Sessions hedged | Book P&L |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const window of scored.windows) {
      for (const [label, side] of [['off', window.off], ['on', window.on]]) {
        lines.push(`| ${window.range.from} → ${window.range.to} | ${label} | ${side.returnPct == null ? '—' : `${side.returnPct}%`} | ${side.profitFactor == null ? '—' : side.profitFactor} | ${side.maxDrawdownPct == null ? '—' : `${side.maxDrawdownPct}%`} | ${side.sessions} | ${side.sessionsHedged} | $${money(side.pnlUsd)} |`);
      }
    }
    lines.push('');
  }
  lines.push('## COMMODITIES_MEDIUM_MR', '', 'Gap. No commodities ETF is in the frozen hedge map, and the worker cache has no Commodities contexts.', '');
  lines.push('The informational overlay on the current paper book was not run. It is not a trial.', '');
  fs.writeFileSync(OUT_JSON, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log(`wrote ${OUT_MD}`);
}

main();
