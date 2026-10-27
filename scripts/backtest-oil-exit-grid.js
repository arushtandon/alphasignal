#!/usr/bin/env node
'use strict';

/**
 * Focused WTI/Brent long-horizon exit study.
 * Entries are next-open long-momentum signals; exits test fixed ATR structures.
 * Stop-first is assumed when TP and SL occur in the same daily bar.
 */
const fs = require('fs');
const path = require('path');
const { applyCosts } = require('../lib/research/cost-model');
const { summarizeReturns } = require('../lib/research/performance');

const ASSETS = ['CL=F', 'BZ=F'];
const MAX_HOLD = 180;
const NOTIONAL = 10000;
const PROFILES = [
  { id: 'current_model_geometry', label: 'Current model proportions', pct: { tp1: 0.37865, tp2: 0.46932, sl: 0.28122 } },
  { id: 'atr_1_2_1_5', label: 'TP1 1× / TP2 2× / SL 1.5× ATR', atr: { tp1: 1, tp2: 2, sl: 1.5 } },
  { id: 'atr_1_5_3_2', label: 'TP1 1.5× / TP2 3× / SL 2× ATR', atr: { tp1: 1.5, tp2: 3, sl: 2 } },
  { id: 'atr_2_4_2_5', label: 'TP1 2× / TP2 4× / SL 2.5× ATR', atr: { tp1: 2, tp2: 4, sl: 2.5 } },
  { id: 'atr_3_5_3', label: 'TP1 3× / TP2 5× / SL 3× ATR', atr: { tp1: 3, tp2: 5, sl: 3 } },
  { id: 'generic_long_atr', label: 'Generic long TP1 7× / TP2 11× / SL 5.5× ATR', atr: { tp1: 7, tp2: 11, sl: 5.5 } }
];

function mean(xs) {
  const a = xs.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function sma(bars, i, n) {
  if (i - n + 1 < 0) return null;
  return mean(bars.slice(i - n + 1, i + 1).map(b => b.c));
}
function atr(bars, i, n = 14) {
  if (i - n + 1 < 1) return null;
  const xs = [];
  for (let j = i - n + 1; j <= i; j++) {
    const b = bars[j], p = bars[j - 1];
    xs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  return mean(xs);
}
function ret(bars, i, n) {
  return i >= n && bars[i - n].c > 0 ? bars[i].c / bars[i - n].c - 1 : null;
}
function signalAt(bars, i) {
  const ma50 = sma(bars, i, 50), ma200 = sma(bars, i, 200);
  const r126 = ret(bars, i, 126), r252 = ret(bars, i, 252);
  return ma50 > ma200 && bars[i].c > ma200 && r126 > 0.03 && r252 > 0.05;
}
function levels(entry, entryAtr, profile) {
  if (profile.pct) {
    return {
      tp1: entry * (1 + profile.pct.tp1),
      tp2: entry * (1 + profile.pct.tp2),
      sl: entry * (1 - profile.pct.sl)
    };
  }
  return {
    tp1: entry + profile.atr.tp1 * entryAtr,
    tp2: entry + profile.atr.tp2 * entryAtr,
    sl: entry - profile.atr.sl * entryAtr
  };
}

function simulate(bars, entryIndex, profile, mode) {
  const entry = bars[entryIndex]?.o || bars[entryIndex - 1]?.c;
  const entryAtr = atr(bars, entryIndex - 1);
  if (!(entry > 0) || !(entryAtr > 0)) return null;
  const lv = levels(entry, entryAtr, profile);
  if (!(lv.sl > 0 && lv.tp1 > entry && lv.tp2 > lv.tp1)) return null;
  const end = Math.min(bars.length - 1, entryIndex + MAX_HOLD);
  let tp1Done = false;
  let firstHalf = 0;
  let stop = lv.sl;
  let exitIndex = end;
  let status = 'time';
  let gross = null;

  for (let i = entryIndex; i <= end; i++) {
    const b = bars[i];
    if (b.l <= stop) {
      const fill = Math.min(b.o, stop);
      const stopRet = fill / entry - 1;
      gross = mode === 'split_runner' && tp1Done ? firstHalf + 0.5 * stopRet : stopRet;
      status = tp1Done ? 'tp1_then_stop' : 'stop';
      exitIndex = i;
      break;
    }
    if (!tp1Done && b.h >= lv.tp1) {
      if (mode === 'single_tp1') {
        const fill = Math.max(b.o, lv.tp1);
        gross = fill / entry - 1;
        status = 'tp1';
        exitIndex = i;
        break;
      }
      const fill = Math.max(b.o, lv.tp1);
      firstHalf = 0.5 * (fill / entry - 1);
      tp1Done = true;
      stop = entry; // remaining half moves to breakeven
    }
    if (tp1Done && b.h >= lv.tp2) {
      const fill = Math.max(b.o, lv.tp2);
      gross = firstHalf + 0.5 * (fill / entry - 1);
      status = 'tp2';
      exitIndex = i;
      break;
    }
  }
  if (gross == null) {
    const finalRet = bars[end].c / entry - 1;
    gross = mode === 'split_runner' && tp1Done ? firstHalf + 0.5 * finalRet : finalRet;
  }
  const entryMs = bars[entryIndex].t * 1000, exitMs = bars[exitIndex].t * 1000;
  const heldDays = Math.max(0, (exitMs - entryMs) / 86400000);
  const costed = applyCosts(gross, { symbol: bars.symbol, side: 'buy', holdDays: heldDays });
  return { ret: costed.netReturn, gross, status, entry, entryAtr, ...lv, entryIndex, exitIndex, heldDays };
}

function backtest(bars, profile, mode, fromIndex) {
  const rows = [];
  let i = Math.max(260, fromIndex);
  while (i < bars.length - 2) {
    if (!signalAt(bars, i)) { i += 2; continue; }
    const trade = simulate(bars, i + 1, profile, mode);
    if (!trade) { i += 2; continue; }
    rows.push(trade);
    i = Math.max(i + 2, trade.exitIndex + 1);
  }
  return rows;
}
function metrics(rows) {
  const s = summarizeReturns(rows.map(r => r.ret));
  return {
    trades: s.trades,
    winRate: s.winRate,
    avgReturnPct: s.avgReturnPct,
    profitFactor: s.profitFactor,
    pnlUsdAtFixedNotional: +(rows.reduce((sum, r) => sum + r.ret * NOTIONAL, 0)).toFixed(2),
    exits: rows.reduce((out, r) => ({ ...out, [r.status]: (out[r.status] || 0) + 1 }), {})
  };
}

async function fetchBars(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=10y&interval=1d&events=history`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${symbol} HTTP ${response.status}`);
  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const q = result?.indicators?.quote?.[0];
  const bars = (result?.timestamp || []).map((t, i) => ({
    t, o: Number(q.open[i]), h: Number(q.high[i]), l: Number(q.low[i]), c: Number(q.close[i]), v: Number(q.volume[i])
  })).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.c > 0 && b.l > 0);
  bars.symbol = symbol;
  return bars;
}

(async () => {
  const results = [];
  for (const symbol of ASSETS) {
    const bars = await fetchBars(symbol);
    const fiveYearStart = Math.max(260, bars.length - 1260);
    for (const profile of PROFILES) {
      for (const mode of ['single_tp1', 'split_runner']) {
        const rows = backtest(bars, profile, mode, fiveYearStart);
        results.push({ symbol, profile: profile.id, label: profile.label, mode, metrics: metrics(rows) });
      }
    }
  }
  const originalEntry = 102.02;
  const currentTrade = {
    originalEntry,
    currentModel: { tp1: 140.65, tp2: 149.90, modelTp2: 162.72, sl: 73.33 },
    distancesPct: {
      tp1: +((140.65 / originalEntry - 1) * 100).toFixed(2),
      tp2: +((149.90 / originalEntry - 1) * 100).toFixed(2),
      sl: +((73.33 / originalEntry - 1) * 100).toFixed(2)
    },
    note: 'One open contract means TP2 is not executable unless quantity is increased; current bridge routes the full lot to TP1.'
  };
  const out = { generatedAt: new Date().toISOString(), assets: ASSETS, years: 5, maxHoldBars: MAX_HOLD, profiles: PROFILES, currentTrade, results };
  const file = path.join(__dirname, 'backtest-oil-exit-grid-results.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  for (const r of results.filter(r => r.symbol === 'CL=F')) {
    const m = r.metrics;
    console.log(`${r.mode.padEnd(12)} ${r.profile.padEnd(24)} n=${m.trades} WR=${m.winRate}% avg=${m.avgReturnPct}% PF=${m.profitFactor} PnL=$${m.pnlUsdAtFixedNotional}`);
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
