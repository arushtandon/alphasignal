/**
 * Experimental strategy harness for stricter buy/sell quality logic.
 *
 * This does not change production picks. It tests whether confirmation + minimum
 * reward/risk gates can produce >=60% win rate with average wins larger than losses.
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
  fetchOHLCV,
  fundCache,
  TECH_TTL,
  techAtBoundedIndex
} = require('../server');

const WINDOW = Math.min(360, Math.max(120, parseInt(process.env.WINDOW || '252', 10) || 252));
const HZS = ['short', 'medium', 'long'];
const SIDES = ['buy', 'sell'];
const VARIANTS = [
  { name: 'balanced_1.2R', minR: 1.2 },
  { name: 'strict_1.4R', minR: 1.4 }
];

const ohlcvCache = new Map();

async function loadSymbol(sym) {
  if (ohlcvCache.has(sym)) return ohlcvCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 170) {
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

function ret(data, i, lookback) {
  if (!data || i - lookback < 0 || !data[i]?.c || !data[i - lookback]?.c) return null;
  return (data[i].c - data[i - lookback].c) / data[i - lookback].c;
}

function candleFlags(data, i) {
  const b = data[i], p = data[i - 1];
  if (!b || !p) return {};
  const bearishReject = (b.h > p.h && b.c < b.o) || b.c < p.l || (b.o > p.c && b.c < p.o);
  const bullishReject = (b.l < p.l && b.c > b.o) || b.c > p.h || (b.o < p.c && b.c > p.o);
  return { bearishReject, bullishReject };
}

function regime(tech) {
  const price = tech.currentPrice || 0;
  const ma50 = tech.ma50 || price;
  const ma200 = tech.ma200 || price;
  const aboveMa200 = tech.aboveMa200 === true;
  const goldenCross = ma50 > 0 && ma200 > 0 && ma50 > ma200;
  const deathCross = ma50 > 0 && ma200 > 0 && ma50 < ma200;
  const weeklyTrend = tech.weeklyTrend || tech.trend20 || 'sideways';
  const macdBull = tech.macd?.trend === 'bullish';
  const obvBullish = tech.obvBullish;
  const rsi = tech.rsi ?? 50;
  const adx = tech.adx ?? 15;
  const bullPts = (aboveMa200 ? 2 : 0) + (goldenCross ? 2 : 0)
    + (weeklyTrend === 'uptrend' ? 1 : 0) + (adx > 22 ? 0.5 : 0)
    + (macdBull ? 0.5 : 0) + (obvBullish === true ? 0.5 : 0)
    + (rsi > 50 && rsi < 70 ? 0.5 : 0);
  const bearPts = (!aboveMa200 ? 2 : 0) + (deathCross ? 2 : 0)
    + (weeklyTrend === 'downtrend' ? 1 : 0)
    + (!macdBull ? 0.5 : 0) + (obvBullish === false ? 0.5 : 0)
    + (rsi < 40 ? 0.5 : 0);
  return bearPts >= 4 ? 'bear' : bullPts >= 4 ? 'bull' : 'neutral';
}

function rr(entry, stop, target, isSell) {
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return 0;
  const risk = isSell ? stop - entry : entry - stop;
  const reward = isSell ? entry - target : target - entry;
  if (!(risk > 0) || !(reward > 0)) return 0;
  return reward / risk;
}

function levels(entry, tech, data, i, hz, isSell, minR) {
  const b = data[i];
  const atr = tech.atr || entry * 0.02;
  if (isSell) {
    let stop = hz === 'short'
      ? Math.max(b.h + 0.5 * atr, entry + 0.8 * atr)
      : Math.max(b.h + 0.6 * atr, tech.ma20 || 0, entry + atr);
    let target = hz === 'short'
      ? Math.min(tech.ma20 || entry - minR * (stop - entry), entry - minR * (stop - entry))
      : entry - minR * (stop - entry);
    if (!(target > 0)) target = entry - minR * (stop - entry);
    return { stop, target, r: rr(entry, stop, target, true) };
  }
  let stop = hz === 'short'
    ? Math.min(b.l - 0.5 * atr, entry - 0.8 * atr)
    : Math.min(b.l - 0.6 * atr, tech.ma20 || Infinity, entry - atr);
  let target = hz === 'short'
    ? Math.max(tech.ma20 || entry + minR * (entry - stop), entry + minR * (entry - stop))
    : entry + minR * (entry - stop);
  return { stop, target, r: rr(entry, stop, target, false) };
}

function candidate(data, weekly, bench, i, hz, side, minR) {
  const entry = data[i + 1]?.o ?? data[i]?.c;
  if (!(entry > 0)) return null;

  const tech = techAtBoundedIndex(data, weekly, i);
  if (!tech || !(tech.currentPrice > 0)) return null;

  const b = data[i], p = data[i - 1];
  if (!b || !p) return null;

  const isSell = side === 'sell';
  const flags = candleFlags(data, i);
  const price = tech.currentPrice;
  const ma20 = tech.ma20 || price;
  const ma50 = tech.ma50 || price;
  const ma200 = tech.ma200 || price;
  const rsi = tech.rsi ?? 50;
  const rsi2 = tech.rsi2 ?? null;
  const stochK = tech.stoch?.k ?? null;
  const bbPct = tech.bb?.pct ?? null;
  const chanBuy = tech.channelPos?.buyQuality;
  const chanSell = tech.channelPos?.sellQuality;
  const weeklyTrend = tech.weeklyTrend || tech.trend20 || 'sideways';
  const st = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend || null;
  const stock20 = ret(data, i, 20);
  const stock60 = ret(data, i, 60);
  const bench20 = ret(bench, Math.min(i, bench.length - 1), 20);
  const bench60 = ret(bench, Math.min(i, bench.length - 1), 60);
  const rel20 = stock20 != null && bench20 != null ? stock20 - bench20 : 0;
  const rel60 = stock60 != null && bench60 != null ? stock60 - bench60 : rel20;
  const rgm = regime(tech);
  const atr = tech.atr || entry * 0.02;
  const stretch20 = ma20 ? (price - ma20) / ma20 : 0;
  const nearMa20 = ma20 && Math.abs(price - ma20) / price < 0.025;
  const nearMa50 = ma50 && Math.abs(price - ma50) / price < 0.035;

  const lv = levels(entry, tech, data, i, hz, isSell, minR);
  if (!lv || lv.r < minR) return null;

  if (hz === 'short' && isSell) {
    const overbought = (rsi2 != null && rsi2 > 90) || rsi > 70 || (stochK != null && stochK > 82);
    const extension = chanSell === 'excellent' || chanSell === 'good' || (bbPct != null && bbPct > 90) || stretch20 >= 0.05;
    if (overbought && extension && flags.bearishReject && !st?.flippedBull) return { entry, ...lv };
    return null;
  }

  if (hz === 'short' && !isSell) {
    const oversold = (rsi2 != null && rsi2 < 10) || rsi < 32 || (stochK != null && stochK < 18);
    const discount = chanBuy === 'excellent' || chanBuy === 'good' || (bbPct != null && bbPct < 10) || stretch20 <= -0.05;
    const fallingKnife = (tech.consecutiveLowerCloses || 0) >= 4 && tech.trend20 === 'downtrend';
    if (oversold && discount && flags.bullishReject && !fallingKnife) return { entry, ...lv };
    return null;
  }

  if (hz === 'medium' && isSell) {
    const structural = (tech.aboveMa200 === false || tech.aboveMa50 === false)
      && weeklyTrend !== 'uptrend' && rel20 < 0;
    const retestFail = (nearMa20 || nearMa50) && flags.bearishReject;
    const notOversold = rsi >= 35 && rsi <= 58 && price > ma200 * 0.78;
    const pressure = tech.obvBullish === false || tech.bearishStructure === true || tech.volume?.relativeVolume >= 1.1;
    if (structural && retestFail && notOversold && pressure) return { entry, ...lv };
    return null;
  }

  if (hz === 'medium' && !isSell) {
    const structural = tech.aboveMa200 === true && weeklyTrend !== 'downtrend' && rel20 > 0;
    const pullbackHold = (nearMa20 || nearMa50 || chanBuy === 'good' || chanBuy === 'excellent') && flags.bullishReject;
    const cleanRsi = rsi >= 38 && rsi <= 66;
    const demand = tech.obvBullish === true || tech.bullishStructure === true || tech.volume?.confirmation === 'bullish';
    if (structural && pullbackHold && cleanRsi && demand) return { entry, ...lv };
    return null;
  }

  if (hz === 'long' && isSell) {
    const structuralBear = tech.aboveMa200 === false && ma50 < ma200 && weeklyTrend === 'downtrend';
    const marketWeak = rel60 < 0 && rgm === 'bear';
    const notExhausted = rsi >= 32 && price > ma200 * 0.75;
    const momentum = st?.direction === 'bear' || b.c < ma20;
    if (structuralBear && marketWeak && notExhausted && momentum && flags.bearishReject) return { entry, ...lv };
    return null;
  }

  const structuralBull = tech.aboveMa200 === true && ma50 > ma200 && weeklyTrend === 'uptrend';
  const leader = rel60 > 0 && rgm === 'bull';
  const notExtended = rsi <= 68 && stretch20 < 0.08;
  const confirmation = flags.bullishReject || b.c > p.h || (chanBuy === 'good' || chanBuy === 'excellent');
  if (structuralBull && leader && notExtended && confirmation) return { entry, ...lv };
  return null;
}

function simulate(data, entryIdx, entry, stop, target, isSell, hz) {
  const hold = hz === 'short' ? 10 : hz === 'medium' ? 45 : 90;
  const maxJ = Math.min(data.length - 1, entryIdx + hold);
  const retAt = px => isSell ? (entry - px) / entry : (px - entry) / entry;
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    const b = data[j];
    if (!b) continue;
    if (isSell) {
      if (b.h >= stop) return { ret: retAt(stop), status: 'sl_hit' };
      if (b.l <= target) return { ret: retAt(target), status: 'tp_hit' };
    } else {
      if (b.l <= stop) return { ret: retAt(stop), status: 'sl_hit' };
      if (b.h >= target) return { ret: retAt(target), status: 'tp_hit' };
    }
  }
  return { ret: retAt(data[maxJ]?.c || entry), status: 'time_exit' };
}

function makeBucket() {
  return { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, total: 0, winCount: 0, lossCount: 0, byStatus: {} };
}

function addTrade(b, res) {
  b.trades++;
  b.total += res.ret;
  b.byStatus[res.status] = (b.byStatus[res.status] || 0) + 1;
  if (res.ret > 0) {
    b.wins++;
    b.winCount++;
    b.grossWin += res.ret;
  } else {
    b.lossCount++;
    b.grossLoss += Math.abs(res.ret);
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

async function main() {
  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '';
  const universe = await buildFullUniverse(global.fetch, fmpKey);
  const tickers = universe.map(u => u.t).filter(Boolean);
  const bench = await fetchOHLCV('SPY', '2y', '1d').catch(() => null);
  if (!bench || bench.length < 170) throw new Error('SPY benchmark OHLCV unavailable');

  const buckets = {};
  for (const v of VARIANTS) {
    buckets[v.name] = {};
    for (const hz of HZS) for (const side of SIDES) buckets[v.name][`${side}:${hz}`] = makeBucket();
  }

  let loaded = 0, skipped = 0;
  console.log(`Candidate quality-logic backtest: ${tickers.length} symbols | window=${WINDOW} bars\n`);

  for (let n = 0; n < tickers.length; n++) {
    const sym = tickers[n];
    process.stdout.write(`\r[${n + 1}/${tickers.length}] ${sym}`.padEnd(42));
    const row = await loadSymbol(sym);
    if (!row) { skipped++; continue; }
    loaded++;
    const weeklyAll = row.weekly;
    const start = Math.max(120, row.daily.length - WINDOW);
    for (let i = start; i < row.daily.length - 2; i += 2) {
      for (const v of VARIANTS) {
        for (const hz of HZS) {
          for (const side of SIDES) {
            const c = candidate(row.daily, weeklyAll, bench, i, hz, side, v.minR);
            if (!c) continue;
            const res = simulate(row.daily, i + 1, c.entry, c.stop, c.target, side === 'sell', hz);
            addTrade(buckets[v.name][`${side}:${hz}`], res);
          }
        }
      }
    }
  }

  console.log('\n');
  const results = [];
  for (const v of VARIANTS) {
    console.log(`=== ${v.name} ===`);
    for (const hz of HZS) {
      for (const side of SIDES) {
        const s = summarize(buckets[v.name][`${side}:${hz}`]);
        results.push({ variant: v.name, minR: v.minR, side, hz, ...s });
        console.log(
          `${side.toUpperCase().padEnd(4)} x ${hz.padEnd(6)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`
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
    results
  };
  const outPath = path.join(__dirname, 'backtest-candidate-quality-results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
