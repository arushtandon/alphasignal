/**
 * Experimental backtest:
 * - New institutional-style sell playbooks: failed retest, relative weakness,
 *   risk-off breakdown, and pair-trade variants.
 * - Current production buy logic with realised avg win vs avg loss.
 *
 * This is analysis-only. It does not modify production picks.
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
const RR = Number(process.env.RR || 2.0);

const BENCH_BY_MARKET = {
  US: 'SPY',
  DAX: 'EWG',
  CAC40: 'EWQ',
  FTSE100: 'EWU',
  NIFTY50: 'INDA',
  HSI: 'EWH',
  NIKKEI225: 'EWJ',
  COMMODITIES: 'DBC'
};

const ohlcvCache = new Map();
const benchCache = new Map();

function makeBucket() {
  return {
    trades: 0,
    wins: 0,
    grossWin: 0,
    grossLoss: 0,
    total: 0,
    winCount: 0,
    lossCount: 0,
    byStatus: {}
  };
}

function addTrade(b, ret, status = 'exit') {
  if (!Number.isFinite(ret)) return;
  b.trades++;
  b.total += ret;
  b.byStatus[status] = (b.byStatus[status] || 0) + 1;
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
    winRate: b.trades ? +(b.wins / b.trades * 100).toFixed(1) : null,
    avgReturnPct: b.trades ? +(b.total / b.trades * 100).toFixed(2) : null,
    avgWinPct: avgWin == null ? null : +avgWin.toFixed(2),
    avgLossPct: avgLoss == null ? null : +avgLoss.toFixed(2),
    winLossRatio: avgWin != null && avgLoss ? +(avgWin / avgLoss).toFixed(2) : null,
    profitFactor: b.grossLoss ? +(b.grossWin / b.grossLoss).toFixed(2) : null,
    byStatus: b.byStatus
  };
}

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

async function loadBench(market) {
  const sym = BENCH_BY_MARKET[market] || 'SPY';
  if (benchCache.has(sym)) return benchCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  benchCache.set(sym, daily);
  return daily;
}

function dateKey(bar) {
  const raw = bar?.date ?? bar?.d ?? bar?.t ?? bar?.time ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw > 1e12 ? raw : raw * 1000).toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

function makeDateIndex(data) {
  const m = new Map();
  for (let i = 0; i < (data || []).length; i++) {
    const k = dateKey(data[i]);
    if (k) m.set(k, i);
  }
  return m;
}

function ret(data, i, lookback) {
  if (!data || i - lookback < 0 || !data[i]?.c || !data[i - lookback]?.c) return null;
  return (data[i].c - data[i - lookback].c) / data[i - lookback].c;
}

function benchRet(stockData, benchData, benchIndex, stockIdx, lookback) {
  if (!benchData || !benchIndex) return null;
  const k = dateKey(stockData[stockIdx]);
  const bi = k ? benchIndex.get(k) : null;
  if (bi == null) return null;
  return ret(benchData, bi, lookback);
}

function pairBenchMove(stockData, benchData, benchIndex, entryIdx, exitIdx) {
  if (!benchData || !benchIndex) return 0;
  const ek = dateKey(stockData[entryIdx]);
  const xk = dateKey(stockData[exitIdx]);
  const ei = ek ? benchIndex.get(ek) : null;
  const xi = xk ? benchIndex.get(xk) : null;
  if (ei == null || xi == null || !benchData[ei]?.c || !benchData[xi]?.c) return 0;
  return (benchData[xi].c - benchData[ei].c) / benchData[ei].c;
}

function candle(data, i) {
  const b = data[i], p = data[i - 1];
  if (!b || !p) return {};
  const bearishReject = (b.h > p.h && b.c < b.o) || b.c < p.l || (b.o > p.c && b.c < p.o);
  const bullishReject = (b.l < p.l && b.c > b.o) || b.c > p.h || (b.o < p.c && b.c > p.o);
  return { bearishReject, bullishReject };
}

function fixedShortLevels(data, i, entry, tech, horizon) {
  const atr = tech.atr || entry * 0.02;
  const b = data[i];
  const baseRisk = horizon === 'short' ? 1.0 * atr : horizon === 'medium' ? 1.4 * atr : 1.8 * atr;
  const stop = Math.max(b.h + 0.4 * atr, entry + baseRisk);
  const target = entry - RR * (stop - entry);
  return target > 0 ? { stop, target } : null;
}

function simulateShort(data, entryIdx, entry, stop, target, horizon) {
  const hold = horizon === 'short' ? 10 : horizon === 'medium' ? 45 : 90;
  const maxJ = Math.min(data.length - 1, entryIdx + hold);
  const retAt = px => (entry - px) / entry;
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    const b = data[j];
    if (!b) continue;
    if (b.h >= stop) return { ret: retAt(stop), status: 'sl_hit', exitIdx: j };
    if (b.l <= target) return { ret: retAt(target), status: 'tp_hit', exitIdx: j };
  }
  return { ret: retAt(data[maxJ]?.c || entry), status: 'time_exit', exitIdx: maxJ };
}

function isRiskOff(benchData, benchIndex, stockData, i) {
  const k = dateKey(stockData[i]);
  const bi = k ? benchIndex.get(k) : null;
  if (bi == null) return false;
  const bt = techAtBoundedIndex(benchData, null, bi);
  return bt?.aboveMa200 === false || bt?.weeklyTrend === 'downtrend' || bt?.trend20 === 'downtrend';
}

function sellCandidates(data, weekly, benchData, benchIndex, i) {
  const entry = data[i + 1]?.o ?? data[i]?.c;
  if (!(entry > 0)) return [];
  const tech = techAtBoundedIndex(data, weekly, i);
  if (!tech || !(tech.currentPrice > 0)) return [];

  const flags = candle(data, i);
  const price = tech.currentPrice;
  const ma20 = tech.ma20 || price;
  const ma50 = tech.ma50 || price;
  const ma200 = tech.ma200 || price;
  const rsi = tech.rsi ?? 50;
  const rsi2 = tech.rsi2 ?? null;
  const stochK = tech.stoch?.k ?? null;
  const bbPct = tech.bb?.pct ?? null;
  const weeklyTrend = tech.weeklyTrend || tech.trend20 || 'sideways';
  const st = (tech.supertrendByHz && tech.supertrendByHz.medium) || tech.supertrend || null;
  const stock20 = ret(data, i, 20);
  const stock60 = ret(data, i, 60);
  const b20 = benchRet(data, benchData, benchIndex, i, 20);
  const b60 = benchRet(data, benchData, benchIndex, i, 60);
  const rel20 = stock20 != null && b20 != null ? stock20 - b20 : null;
  const rel60 = stock60 != null && b60 != null ? stock60 - b60 : null;
  const nearMa20FromBelow = ma20 && price <= ma20 * 1.015 && price >= ma20 * 0.965;
  const nearMa50FromBelow = ma50 && price <= ma50 * 1.02 && price >= ma50 * 0.94;
  const belowPrimary = tech.aboveMa50 === false || tech.aboveMa200 === false;
  const notOversold = rsi >= 35 && rsi <= 60 && price > ma200 * 0.78;
  const distribution = tech.obvBullish === false || tech.bearishStructure === true || tech.volume?.confirmation === 'bearish' || tech.volume?.relativeVolume >= 1.15;
  const out = [];

  // 1) Short-horizon rejected extension fade.
  const stretch20 = ma20 ? (price - ma20) / ma20 : 0;
  const extension = tech.channelPos?.sellQuality === 'excellent' || tech.channelPos?.sellQuality === 'good'
    || (bbPct != null && bbPct > 92) || stretch20 >= 0.06;
  const overbought = (rsi2 != null && rsi2 > 92) || rsi > 72 || (stochK != null && stochK > 85);
  if (overbought && extension && flags.bearishReject && !st?.flippedBull) {
    const lv = fixedShortLevels(data, i, entry, tech, 'short');
    if (lv) out.push({ name: 'short_rejected_extension', horizon: 'short', entry, ...lv, paired: false });
  }

  // 2) Failed retest breakdown: short the bounce into resistance, not the hole.
  if (belowPrimary && weeklyTrend !== 'uptrend' && (nearMa20FromBelow || nearMa50FromBelow)
    && flags.bearishReject && notOversold && distribution) {
    const lv = fixedShortLevels(data, i, entry, tech, 'medium');
    if (lv) out.push({ name: 'failed_retest_breakdown', horizon: 'medium', entry, ...lv, paired: false });
  }

  // 3) Relative weakness: weakest names versus benchmark, with structure confirming.
  if (belowPrimary && rel20 != null && rel60 != null && rel20 < -0.03 && rel60 < -0.06
    && notOversold && distribution && (flags.bearishReject || st?.direction === 'bear')) {
    const lv = fixedShortLevels(data, i, entry, tech, 'medium');
    if (lv) {
      out.push({ name: 'relative_weakness_short', horizon: 'medium', entry, ...lv, paired: false });
      out.push({ name: 'pair_relative_weakness', horizon: 'medium', entry, ...lv, paired: true });
    }
  }

  // 4) Risk-off breakdown: only short when the benchmark tape is also weak.
  const riskOff = isRiskOff(benchData, benchIndex, data, i);
  if (riskOff && tech.aboveMa200 === false && ma50 < ma200 && weeklyTrend === 'downtrend'
    && rel60 != null && rel60 < -0.04 && rsi >= 32 && price > ma200 * 0.75
    && (flags.bearishReject || st?.direction === 'bear')) {
    const lv = fixedShortLevels(data, i, entry, tech, 'long');
    if (lv) {
      out.push({ name: 'risk_off_breakdown', horizon: 'long', entry, ...lv, paired: false });
      out.push({ name: 'pair_risk_off_breakdown', horizon: 'long', entry, ...lv, paired: true });
    }
  }

  return out;
}

async function backtestProductionBuys(data, weekly, fund, from, to, totals) {
  for (const hz of ['short', 'medium', 'long']) {
    let nextAllowed = from;
    for (let i = from; i < Math.min(to, data.length - 2); i += 2) {
      if (i < nextAllowed) continue;
      const tech = techAtBoundedIndex(data, weekly, i);
      const sig = computeQuantSignal(tech, fund, hz);
      if (!(sig.buyScore >= 62 && sig.buyScore > sig.sellScore)) continue;
      const entry = data[i + 1]?.o ?? data[i].c;
      if (!(entry > 0)) continue;
      const res = await simulateHybridExit(data, i + 1, entry, hz, false, weekly, fund);
      if (!res || res.exitIdx == null) continue;
      addTrade(totals[`buy_${hz}`], res.ret, res.status);
      nextAllowed = Math.max(i + 2, res.exitIdx + 1);
    }
  }
}

async function main() {
  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '';
  const universe = await buildFullUniverse(global.fetch, fmpKey);
  const items = universe.filter(u => u && u.t);
  console.log(`New sell strategies + buy-quality backtest: ${items.length} symbols | window=${WINDOW} bars | RR=${RR}:1\n`);

  const sellTotals = {};
  [
    'short_rejected_extension',
    'failed_retest_breakdown',
    'relative_weakness_short',
    'pair_relative_weakness',
    'risk_off_breakdown',
    'pair_risk_off_breakdown'
  ].forEach(k => { sellTotals[k] = makeBucket(); });

  const buyTotals = {
    buy_short: makeBucket(),
    buy_medium: makeBucket(),
    buy_long: makeBucket()
  };

  let loaded = 0, skipped = 0;
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    const sym = item.t;
    process.stdout.write(`\r[${n + 1}/${items.length}] ${sym}`.padEnd(44));
    const row = await loadSymbol(sym);
    if (!row) { skipped++; continue; }
    const bench = await loadBench(item.market);
    if (!bench || bench.length < 190) { skipped++; continue; }
    const benchIndex = makeDateIndex(bench);
    loaded++;

    const from = Math.max(120, row.daily.length - WINDOW);
    const to = row.daily.length - 2;

    await backtestProductionBuys(row.daily, row.weekly, row.fund, from, to, buyTotals);

    const nextAllowed = {};
    for (let i = from; i < to; i += 2) {
      const candidates = sellCandidates(row.daily, row.weekly, bench, benchIndex, i);
      for (const c of candidates) {
        if (nextAllowed[c.name] && i < nextAllowed[c.name]) continue;
        const res = simulateShort(row.daily, i + 1, c.entry, c.stop, c.target, c.horizon);
        let tradeRet = res.ret;
        if (c.paired) {
          tradeRet += pairBenchMove(row.daily, bench, benchIndex, i + 1, res.exitIdx);
        }
        addTrade(sellTotals[c.name], tradeRet, res.status);
        nextAllowed[c.name] = Math.max(i + 2, res.exitIdx + 1);
      }
    }
  }

  console.log('\n\n=== NEW SELL STRATEGIES ===');
  const sellResults = [];
  for (const [name, bucket] of Object.entries(sellTotals)) {
    const s = summarize(bucket);
    sellResults.push({ strategy: name, ...s });
    console.log(`${name.padEnd(28)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`);
  }

  console.log('\n=== CURRENT PRODUCTION BUY LOGIC ===');
  const buyResults = [];
  for (const [name, bucket] of Object.entries(buyTotals)) {
    const s = summarize(bucket);
    buyResults.push({ bracket: name, ...s });
    console.log(`${name.padEnd(28)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`);
  }

  const outPath = path.join(__dirname, 'backtest-new-sell-strategies-and-buy-quality-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    windowBars: WINDOW,
    rewardRisk: RR,
    universeSize: items.length,
    symbolsWithData: loaded,
    symbolsSkipped: skipped,
    sellResults,
    buyResults
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
