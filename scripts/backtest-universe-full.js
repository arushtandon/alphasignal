/**
 * Full-universe walk-forward backtest (all markets in universe.js).
 * Suppresses HTTP listen, caches OHLCV per symbol across all 6 brackets.
 *
 * Usage: node scripts/backtest-universe-full.js
 * Env:   WINDOW=252  FMP_API_KEY=...  (optional, for US constituent list)
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

const { buildFullUniverse } = require('../universe');
const { backtestSignal, fetchOHLCV, fundCache, TECH_TTL } = require('../server');

const WINDOW = Math.min(360, Math.max(60, parseInt(process.env.WINDOW || '252', 10) || 252));
const HZS = ['short', 'medium', 'long'];
const SIDES = ['buy', 'sell'];

const ohlcvCache = new Map();

async function loadSymbol(sym) {
  if (ohlcvCache.has(sym)) return ohlcvCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 150) {
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

function mergeTickerBt(tTrades, tWins, tRet, gW, gL, bt) {
  if (!bt || !bt.trades) return { tTrades, tWins, tRet, gW, gL };
  tTrades += bt.trades;
  tWins += Math.round((bt.winRate / 100) * bt.trades);
  tRet += bt.avgReturnPct * bt.trades;
  if (bt.profitFactor && bt.profitFactor < 99) { gW += bt.profitFactor; gL += 1; }
  return { tTrades, tWins, tRet, gW, gL };
}

function toAggregate(tTrades, tWins, tRet, gW, gL) {
  return {
    totalTrades: tTrades,
    winRate: tTrades ? Math.round(tWins / tTrades * 100) : null,
    avgReturnPct: tTrades ? +(tRet / tTrades).toFixed(2) : null,
    meanProfitFactor: gL ? +(gW / gL).toFixed(2) : null
  };
}

async function main() {
  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '';
  const uni = await buildFullUniverse(global.fetch, fmpKey);
  const tickers = uni.map(u => u.t).filter(Boolean);
  console.log(`Full universe: ${tickers.length} symbols | window=${WINDOW} bars\n`);

  const bracketTotals = {};
  for (const hz of HZS) {
    for (const side of SIDES) {
      bracketTotals[`${side}:${hz}`] = { tTrades: 0, tWins: 0, tRet: 0, gW: 0, gL: 0, symbolsWithTrades: 0 };
    }
  }

  let loaded = 0;
  let skipped = 0;

  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    process.stdout.write(`\r[${i + 1}/${tickers.length}] ${sym}`.padEnd(40));
    const row = await loadSymbol(sym);
    if (!row) { skipped++; continue; }
    loaded++;

    for (const hz of HZS) {
      for (const side of SIDES) {
        const key = `${side}:${hz}`;
        const bt = await backtestSignal(row.daily, hz, row.weekly, row.fund, { windowBars: WINDOW, side });
        const b = bracketTotals[key];
        const m = mergeTickerBt(b.tTrades, b.tWins, b.tRet, b.gW, b.gL, bt);
        Object.assign(b, m);
        if (bt && bt.trades) b.symbolsWithTrades++;
      }
    }
  }

  console.log('\n');
  const results = [];
  for (const hz of HZS) {
    for (const side of SIDES) {
      const b = bracketTotals[`${side}:${hz}`];
      const aggregate = toAggregate(b.tTrades, b.tWins, b.tRet, b.gW, b.gL);
      results.push({
        bracket: `${side} × ${hz}`,
        hz,
        side,
        universeSize: tickers.length,
        symbolsWithData: loaded,
        symbolsSkipped: skipped,
        symbolsWithTrades: b.symbolsWithTrades,
        aggregate
      });
      const a = aggregate;
      console.log(
        `${side.toUpperCase().padEnd(4)} × ${hz.padEnd(6)} | trades=${String(a.totalTrades).padStart(5)} | WR=${String(a.winRate ?? '—').padStart(3)}% | avg=${String(a.avgReturnPct ?? '—').padStart(6)}% | PF=${a.meanProfitFactor ?? '—'}`
      );
    }
  }

  const outPath = path.join(__dirname, 'backtest-universe-results.json');
  require('fs').writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    windowBars: WINDOW,
    universeSize: tickers.length,
    symbolsWithData: loaded,
    symbolsSkipped: skipped,
    results
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
