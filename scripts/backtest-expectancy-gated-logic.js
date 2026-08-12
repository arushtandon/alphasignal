/**
 * Experimental out-of-sample expectancy gate.
 *
 * For each symbol x horizon x side:
 * 1) Backtest the first half of the window.
 * 2) Allow the bracket only if train stats pass a quality gate.
 * 3) Aggregate the second-half trades only.
 *
 * This tests whether a "publish only if this exact bracket has recent edge" rule
 * helps both buys and sells without changing production signal logic.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const express = require('express');
express.application.listen = function listenStub(port, host, cb) {
  if (typeof port === 'function') { cb = port; port = undefined; }
  else if (typeof host === 'function') { cb = host; host = undefined; }
  if (cb) process.nextTick(cb);
  return { on() { return this; }, close() {}, address: () => ({ port: 0 }) };
};

const fs = require('fs');
const { buildFullUniverse } = require('../universe');
const {
  computeQuantSignal,
  fetchOHLCV,
  fundCache,
  simulateHybridExit,
  TECH_TTL,
  techAtBoundedIndex
} = require('../server');

const WINDOW = Math.min(360, Math.max(180, parseInt(process.env.WINDOW || '252', 10) || 252));
const HZS = ['short', 'medium', 'long'];
const SIDES = ['buy', 'sell'];
const GATES = [
  { name: 'strict_60wr_pf125', minTrades: 5, minWR: 60, minPF: 1.25, minAvg: 0, minWL: 1.0 },
  { name: 'balanced_55wr_pf135', minTrades: 5, minWR: 55, minPF: 1.35, minAvg: 0.1, minWL: 1.0 },
  { name: 'payoff_pf150', minTrades: 4, minWR: 50, minPF: 1.5, minAvg: 0.2, minWL: 1.15 }
];

const ohlcvCache = new Map();

async function loadSymbol(sym) {
  if (ohlcvCache.has(sym)) return ohlcvCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 190) {
    ohlcvCache.set(sym, null);
    return null;
  }
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  const fe = fundCache.get(sym);
  const fund = fe && Date.now() - fe.ts < TECH_TTL * 4 ? fe.data : null;
  const row = { daily, weekly, fund };
  ohlcvCache.set(sym, row);
  return row;
}

function makeBucket() {
  return {
    trades: 0,
    wins: 0,
    grossWin: 0,
    grossLoss: 0,
    total: 0,
    winCount: 0,
    lossCount: 0,
    symbolsAllowed: 0
  };
}

function addTrade(b, ret) {
  b.trades++;
  b.total += ret;
  if (ret > 0) {
    b.wins++;
    b.winCount++;
    b.grossWin += ret;
  } else {
    b.lossCount++;
    b.grossLoss += Math.abs(ret);
  }
}

function summarize(b) {
  const avgWin = b.winCount ? b.grossWin / b.winCount * 100 : null;
  const avgLoss = b.lossCount ? b.grossLoss / b.lossCount * 100 : null;
  return {
    trades: b.trades,
    symbolsAllowed: b.symbolsAllowed,
    winRate: b.trades ? +(b.wins / b.trades * 100).toFixed(1) : null,
    avgReturnPct: b.trades ? +(b.total / b.trades * 100).toFixed(2) : null,
    avgWinPct: avgWin == null ? null : +avgWin.toFixed(2),
    avgLossPct: avgLoss == null ? null : +avgLoss.toFixed(2),
    winLossRatio: avgWin != null && avgLoss ? +(avgWin / avgLoss).toFixed(2) : null,
    profitFactor: b.grossLoss ? +(b.grossWin / b.grossLoss).toFixed(2) : null
  };
}

function passes(stats, gate) {
  return stats.trades >= gate.minTrades
    && stats.winRate >= gate.minWR
    && stats.profitFactor >= gate.minPF
    && stats.avgReturnPct >= gate.minAvg
    && (stats.winLossRatio == null || stats.winLossRatio >= gate.minWL);
}

async function exactBacktestRange(data, weekly, fund, hz, side, from, to) {
  const weeklyAll = weekly;
  const isSellSide = side === 'sell';
  const bucket = makeBucket();
  let nextAllowed = from;

  for (let i = from; i < Math.min(to, data.length - 2); i += 2) {
    if (i < nextAllowed) continue;
    const tech = techAtBoundedIndex(data, weeklyAll, i);
    const sig = computeQuantSignal(tech, fund, hz);
    const buyOk = sig.buyScore >= 62 && sig.buyScore > sig.sellScore;
    const sellOk = sig.sellScore >= 62 && sig.sellScore > sig.buyScore;
    if (side === 'buy' && !buyOk) continue;
    if (side === 'sell' && !sellOk) continue;

    const entry = data[i + 1]?.o ?? data[i].c;
    if (!(entry > 0)) continue;
    const res = await simulateHybridExit(data, i + 1, entry, hz, isSellSide, weeklyAll, fund);
    if (!res || res.exitIdx == null) continue;
    addTrade(bucket, res.ret);
    nextAllowed = Math.max(i + 2, res.exitIdx + 1);
  }

  return summarize(bucket);
}

async function main() {
  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '';
  const universe = await buildFullUniverse(global.fetch, fmpKey);
  const tickers = universe.map(u => u.t).filter(Boolean);
  console.log(`Expectancy-gated backtest: ${tickers.length} symbols | window=${WINDOW} bars\n`);

  const totals = {};
  for (const gate of GATES) {
    totals[gate.name] = {};
    for (const hz of HZS) for (const side of SIDES) totals[gate.name][`${side}:${hz}`] = makeBucket();
  }

  let loaded = 0, skipped = 0;
  for (let n = 0; n < tickers.length; n++) {
    const sym = tickers[n];
    process.stdout.write(`\r[${n + 1}/${tickers.length}] ${sym}`.padEnd(42));
    const row = await loadSymbol(sym);
    if (!row) { skipped++; continue; }
    loaded++;

    const start = Math.max(120, row.daily.length - WINDOW);
    const split = start + Math.floor(WINDOW / 2);
    const end = row.daily.length - 2;

    for (const hz of HZS) {
      for (const side of SIDES) {
        const train = await exactBacktestRange(row.daily, row.weekly, row.fund, hz, side, start, split);
        for (const gate of GATES) {
          if (!passes(train, gate)) continue;
          const test = await exactBacktestRange(row.daily, row.weekly, row.fund, hz, side, split, end);
          if (!test.trades) continue;
          const b = totals[gate.name][`${side}:${hz}`];
          b.symbolsAllowed++;
          b.trades += test.trades;
          b.wins += Math.round(test.winRate / 100 * test.trades);
          b.total += (test.avgReturnPct / 100) * test.trades;
          b.grossWin += (test.avgWinPct || 0) / 100 * Math.round(test.winRate / 100 * test.trades);
          const losses = test.trades - Math.round(test.winRate / 100 * test.trades);
          b.grossLoss += (test.avgLossPct || 0) / 100 * losses;
          b.winCount += Math.round(test.winRate / 100 * test.trades);
          b.lossCount += losses;
        }
      }
    }
  }

  console.log('\n');
  const results = [];
  for (const gate of GATES) {
    console.log(`=== ${gate.name} ===`);
    for (const hz of HZS) {
      for (const side of SIDES) {
        const s = summarize(totals[gate.name][`${side}:${hz}`]);
        results.push({ gate: gate.name, side, hz, ...s });
        console.log(
          `${side.toUpperCase().padEnd(4)} x ${hz.padEnd(6)} | symbols=${String(s.symbolsAllowed).padStart(3)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`
        );
      }
    }
    console.log('');
  }

  const out = {
    runAt: new Date().toISOString(),
    windowBars: WINDOW,
    universeSize: tickers.length,
    symbolsWithData: loaded,
    symbolsSkipped: skipped,
    gates: GATES,
    results
  };
  const outPath = path.join(__dirname, 'backtest-expectancy-gated-results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
