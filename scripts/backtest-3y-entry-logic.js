#!/usr/bin/env node
'use strict';

/**
 * Walk-forward backtest of the current entry engine (MA200 confirmed break,
 * index momentum, MA100/Fib S/R, close-call hold) over the last ~3 years.
 *
 * Usage: node scripts/backtest-3y-entry-logic.js
 */

process.env.PORT = process.env.PORT || '3995';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-3y-bt-'));

const { summarizeReturns, summarizeDatedPortfolio } = require('../lib/research/performance');
const {
  backtestSignal,
  fetchOHLCV,
  dailyToWeeklyBars,
  buildMarketRegime
} = require('../server');

const WINDOW = Math.max(500, parseInt(process.env.WINDOW || '756', 10) || 756);
const ENTRY_STEP = Math.max(1, parseInt(process.env.ENTRY_STEP || '3', 10) || 3);
const RANGE = '5y';
const HZS = ['short', 'medium', 'long'];
const SIDES = ['buy', 'sell'];

const CORE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'V', 'MA',
  'JNJ', 'UNH', 'PG', 'HD', 'AVGO', 'XOM', 'KO', 'NFLX', 'AMD', 'CRM',
  'FOX', 'FOXA', 'BX', 'CRL', 'SNDK',
  '7733.T', '4503.T', '2914.T', '5713.T', '6758.T', '6501.T',
  '0322.HK', '0316.HK',
  'BA.L', 'MNDI.L', 'SHEL.L', 'SAP.DE'
];
let shortlist = [];
try {
  const u = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'universe_shortlist.json'), 'utf8'));
  shortlist = (u.shortlist || []).map((r) => r.ticker).filter(Boolean);
} catch (_) {}
const TICKERS = [...new Set(CORE.concat(shortlist))];

function emptyAgg() {
  return { returns: [], results: [], perTicker: [], skipped: 0, errors: 0, rejections: {} };
}

(async () => {
  console.log(`3y entry-logic backtest | window=${WINDOW} bars (~3y) | step=${ENTRY_STEP} | tickers=${TICKERS.length} | range=${RANGE}`);
  const spy = await fetchOHLCV('SPY', RANGE, '1d').catch(() => null);
  const spySeries = spy && spy.length >= 60 ? buildMarketRegime(spy) : null;
  console.log(`SPY bars=${spy && spy.length || 0} regimeDays=${spySeries ? spySeries.size : 0}`);

  const dailyCache = new Map();
  const weeklyCache = new Map();
  const brackets = {};
  for (const hz of HZS) {
    for (const side of SIDES) brackets[`${side}:${hz}`] = emptyAgg();
  }

  for (let i = 0; i < TICKERS.length; i++) {
    const sym = TICKERS[i];
    process.stdout.write(`[${i + 1}/${TICKERS.length}] ${sym} … `);
    let daily = dailyCache.get(sym);
    if (!daily) {
      daily = await fetchOHLCV(sym, RANGE, '1d').catch(() => null);
      dailyCache.set(sym, daily);
    }
    if (!daily || daily.length < 280) {
      console.log('skip (bars)');
      for (const key of Object.keys(brackets)) brackets[key].skipped++;
      continue;
    }
    let weekly = weeklyCache.get(sym);
    if (!weekly) {
      weekly = dailyToWeeklyBars(daily);
      weeklyCache.set(sym, weekly);
    }
    const first = new Date((daily[Math.max(0, daily.length - WINDOW)].t > 1e12
      ? daily[Math.max(0, daily.length - WINDOW)].t
      : daily[Math.max(0, daily.length - WINDOW)].t * 1000)).toISOString().slice(0, 10);
    const last = new Date((daily[daily.length - 1].t > 1e12
      ? daily[daily.length - 1].t
      : daily[daily.length - 1].t * 1000)).toISOString().slice(0, 10);

    for (const hz of HZS) {
      for (const side of SIDES) {
        const key = `${side}:${hz}`;
        const b = brackets[key];
        try {
          const bt = await backtestSignal(daily, hz, weekly, null, {
            windowBars: WINDOW,
            side,
            symbol: sym,
            entryStep: ENTRY_STEP,
            marketSeries: spySeries,
            closedOnly: true
          });
          if (!bt || !bt.trades) {
            b.perTicker.push({ ticker: sym, trades: 0, rejectionCounts: bt && bt.rejectionCounts || {} });
            const rc = (bt && bt.rejectionCounts) || {};
            for (const [k, v] of Object.entries(rc)) b.rejections[k] = (b.rejections[k] || 0) + Number(v || 0);
            continue;
          }
          const rc = bt.rejectionCounts || {};
          for (const [k, v] of Object.entries(rc)) b.rejections[k] = (b.rejections[k] || 0) + Number(v || 0);
          b.perTicker.push({
            ticker: sym,
            trades: bt.trades,
            winRate: bt.winRate,
            avgReturnPct: bt.avgReturnPct,
            profitFactor: bt.profitFactor,
            range: first + ' → ' + last
          });
          if (Array.isArray(bt.tradeReturns)) b.returns.push(...bt.tradeReturns);
          if (Array.isArray(bt.tradeResults)) b.results.push(...bt.tradeResults);
        } catch (e) {
          b.errors++;
          b.perTicker.push({ ticker: sym, error: e.message });
        }
      }
    }
    console.log(`bars=${daily.length} ${first}→${last}`);
  }

  const outBrackets = [];
  for (const hz of HZS) {
    for (const side of SIDES) {
      const key = `${side}:${hz}`;
      const b = brackets[key];
      const summary = summarizeReturns(b.returns);
      const port = summarizeDatedPortfolio(b.results);
      const aggregate = {
        totalTrades: summary.trades,
        winRate: summary.winRate,
        avgReturnPct: summary.avgReturnPct,
        meanProfitFactor: summary.profitFactor,
        sharpe: port.sharpe,
        maxDrawdownPct: port.maxDrawdownPct,
        cvar95Pct: port.cvar95Pct,
        compoundedReturnPct: port.compoundedReturnPct,
        portfolioDays: port.days
      };
      const wrOk = aggregate.winRate != null && aggregate.winRate >= 55;
      const avgOk = aggregate.avgReturnPct != null && aggregate.avgReturnPct >= 0.30;
      const pfOk = aggregate.meanProfitFactor != null && aggregate.meanProfitFactor >= 1.5;
      const pass = (wrOk || avgOk) && pfOk;
      outBrackets.push({
        key, hz, side, aggregate, pass,
        tickersWithTrades: b.perTicker.filter((t) => t.trades > 0).length,
        skipped: b.skipped,
        errors: b.errors,
        rejections: b.rejections,
        top: b.perTicker.filter((t) => t.trades > 0).sort((a, c) => (c.avgReturnPct || 0) - (a.avgReturnPct || 0)).slice(0, 5),
        worst: b.perTicker.filter((t) => t.trades > 0).sort((a, c) => (a.avgReturnPct || 0) - (c.avgReturnPct || 0)).slice(0, 5)
      });
      console.log(
        `${side.toUpperCase().padEnd(4)} × ${hz.padEnd(6)} | trades=${String(aggregate.totalTrades || 0).padStart(5)} | WR=${String(aggregate.winRate ?? '—').padStart(3)}% | avg=${String(aggregate.avgReturnPct ?? '—').padStart(6)}% | PF=${aggregate.meanProfitFactor ?? '—'} | Sharpe=${aggregate.sharpe ?? '—'} | ${pass ? 'PASS' : 'FAIL'}`
      );
    }
  }

  const dest = path.join(__dirname, 'backtest-3y-entry-logic-results.json');
  fs.writeFileSync(dest, JSON.stringify({
    ranAt: new Date().toISOString(),
    windowBars: WINDOW,
    entryStep: ENTRY_STEP,
    range: RANGE,
    tickers: TICKERS,
    note: 'Current entry engine: confirmed MA200 break, index ROC momentum, MA100/Fib S/R, close-call hold. Sector overlay uses SPY series (same tide for every name in this run). Closed trades only.',
    brackets: outBrackets
  }, null, 2));
  console.log(`\nSaved ${dest}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
