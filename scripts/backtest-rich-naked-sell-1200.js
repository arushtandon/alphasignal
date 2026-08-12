/**
 * Experimental rich naked-short backtest on >1,000 US equities.
 *
 * Strategy concept:
 * - Only short when the stock, broad index, and sector/industry proxy align bearish.
 * - Include Supertrend, SD channel/retest timing, relative weakness, fundamentals,
 *   Piotroski/Altman/FMP quality where available.
 * - Naked short only: no pair hedge.
 *
 * This is analysis-only. It does not change production picks.
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
const {
  fetchOHLCV,
  fetchFundamentals,
  fetchFmpScore,
  fundCache,
  TECH_TTL,
  techAtBoundedIndex
} = require('../server');

const WINDOW = Math.min(360, Math.max(180, parseInt(process.env.WINDOW || '252', 10) || 252));
const LIMIT = Math.max(1000, parseInt(process.env.UNIVERSE_LIMIT || '1200', 10) || 1200);
const RR = Number(process.env.RR || 2.0);

const TECH_ETFS = ['SMH', 'SOXX', 'XLK', 'QQQ'];
const BROAD_ETFS = ['SPY', 'QQQ', 'IWM'];
const SECTOR_ETF = {
  technology: 'XLK',
  'information technology': 'XLK',
  semiconductors: 'SMH',
  semiconductor: 'SMH',
  chips: 'SMH',
  financial: 'XLF',
  financials: 'XLF',
  banks: 'KBE',
  energy: 'XLE',
  healthcare: 'XLV',
  'health care': 'XLV',
  industrials: 'XLI',
  'consumer cyclical': 'XLY',
  'consumer discretionary': 'XLY',
  'consumer defensive': 'XLP',
  'consumer staples': 'XLP',
  materials: 'XLB',
  'basic materials': 'XLB',
  utilities: 'XLU',
  'real estate': 'XLRE',
  communication: 'XLC',
  'communication services': 'XLC'
};

const ohlcvCache = new Map();
const fundLocalCache = new Map();
const fmpLocalCache = new Map();
const etfCache = new Map();

function hashSym(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function fetchExpandedUsUniverse(limit) {
  const url = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt';
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`NasdaqTrader universe HTTP ${r.status}`);
  const txt = await r.text();
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split('|');
  const idx = k => header.indexOf(k);
  const iSym = idx('NASDAQ Symbol');
  const iName = idx('Security Name');
  const iEtf = idx('ETF');
  const iTest = idx('Test Issue');
  const badName = /\b(WARRANT|RIGHT|UNIT|PREFERRED|PFD|DEPOSITARY|NOTE|BOND|ETF|ETN|FUND|TRUST|ACQUISITION CORP)/i;
  const badSym = /[\^\$]|\.W|\.U|\.R|\.P|\.PR|\/|=/i;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('File Creation Time')) continue;
    const cols = line.split('|');
    const sym = String(cols[iSym] || '').trim().toUpperCase();
    const name = String(cols[iName] || '').trim();
    if (!sym || cols[iTest] === 'Y' || cols[iEtf] === 'Y') continue;
    if (sym.length > 5 || badSym.test(sym) || badName.test(name)) continue;
    out.push({ t: sym, name });
  }
  return [...new Map(out.map(x => [x.t, x])).values()]
    .sort((a, b) => hashSym(a.t) - hashSym(b.t))
    .slice(0, limit);
}

async function loadBars(sym) {
  if (ohlcvCache.has(sym)) return ohlcvCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 190) {
    ohlcvCache.set(sym, null);
    return null;
  }
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  const row = { daily, weekly };
  ohlcvCache.set(sym, row);
  return row;
}

async function loadFund(sym) {
  if (fundLocalCache.has(sym)) return fundLocalCache.get(sym);
  const cached = fundCache.get(sym);
  if (cached && Date.now() - cached.ts < TECH_TTL * 4) {
    fundLocalCache.set(sym, cached.data);
    return cached.data;
  }
  const f = await fetchFundamentals(sym).catch(() => null);
  if (f) fundCache.set(sym, { ts: Date.now(), data: f });
  fundLocalCache.set(sym, f);
  return f;
}

async function loadFmp(sym) {
  if (fmpLocalCache.has(sym)) return fmpLocalCache.get(sym);
  const f = await fetchFmpScore(sym, { batchMode: true }).catch(() => null);
  fmpLocalCache.set(sym, f);
  return f;
}

async function loadEtf(sym) {
  if (etfCache.has(sym)) return etfCache.get(sym);
  const bars = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  etfCache.set(sym, bars);
  return bars;
}

function dateKey(bar) {
  const raw = bar?.date ?? bar?.d ?? bar?.t ?? bar?.time ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw > 1e12 ? raw : raw * 1000).toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

function dateIndex(data) {
  const m = new Map();
  for (let i = 0; i < (data || []).length; i++) {
    const k = dateKey(data[i]);
    if (k) m.set(k, i);
  }
  return m;
}

function alignedIndex(stockData, idxMap, i) {
  const k = dateKey(stockData[i]);
  return k ? idxMap.get(k) : null;
}

function trendState(bars, i) {
  if (!bars || i == null || i < 80) return 'unknown';
  const tech = techAtBoundedIndex(bars, null, i);
  const st = tech?.supertrendByHz?.medium || tech?.supertrend || null;
  let score = 0;
  if (tech?.aboveMa200 === false) score += 2;
  if (tech?.aboveMa50 === false) score += 1;
  if ((tech?.weeklyTrend || tech?.trend20) === 'downtrend') score += 1;
  if (st?.direction === 'bear') score += 1;
  if (tech?.rsi != null && tech.rsi < 45) score += 0.5;
  return score >= 3 ? 'bear' : score <= 1 ? 'bull_or_neutral' : 'mixed';
}

function ret(data, i, lookback) {
  if (!data || i == null || i - lookback < 0 || !data[i]?.c || !data[i - lookback]?.c) return null;
  return (data[i].c - data[i - lookback].c) / data[i - lookback].c;
}

function relRet(stockData, etfData, etfIndex, i, lookback) {
  const ei = alignedIndex(stockData, etfIndex, i);
  const sr = ret(stockData, i, lookback);
  const er = ret(etfData, ei, lookback);
  return sr != null && er != null ? sr - er : null;
}

function candle(data, i) {
  const b = data[i], p = data[i - 1];
  if (!b || !p) return {};
  const bearishReject = (b.h > p.h && b.c < b.o) || b.c < p.l || (b.o > p.c && b.c < p.o);
  const lowerHighLowerLow = b.h < p.h && b.l < p.l && b.c < p.c;
  return { bearishReject, lowerHighLowerLow };
}

function sectorEtfFor(sym, fund) {
  const sector = String(fund?._fmpSector || fund?.sector || '').toLowerCase();
  if (/semi|chip|semiconductor/.test(sector)) return 'SMH';
  for (const [k, v] of Object.entries(SECTOR_ETF)) {
    if (sector.includes(k)) return v;
  }
  // Symbol fallback for mega/liquid chip names when fundamentals are unavailable.
  if (/^(NVDA|AMD|AVGO|INTC|QCOM|MU|AMAT|LRCX|KLAC|MRVL|ON|TSM|ASML|ARM|MCHP|ADI|TXN)$/.test(sym)) return 'SMH';
  return 'SPY';
}

function makeBucket() {
  return { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, total: 0, winCount: 0, lossCount: 0, byStatus: {} };
}

function addTrade(b, ret, status) {
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

function simulateShort(data, entryIdx, entry, stop, target, holdDays) {
  const maxJ = Math.min(data.length - 1, entryIdx + holdDays);
  const retAt = px => (entry - px) / entry;
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    const b = data[j];
    if (!b) continue;
    if (b.h >= stop) return { ret: retAt(stop), status: 'sl_hit', exitIdx: j };
    if (b.l <= target) return { ret: retAt(target), status: 'tp_hit', exitIdx: j };
  }
  return { ret: retAt(data[maxJ]?.c || entry), status: 'time_exit', exitIdx: maxJ };
}

function candidateRichShort({ sym, data, weekly, fund, fmp, sectorBars, sectorIndex, broadBars, broadIndex, qqqBars, qqqIndex, i, mode }) {
  const entry = data[i + 1]?.o ?? data[i]?.c;
  if (!(entry > 0)) return null;
  const tech = techAtBoundedIndex(data, weekly, i);
  if (!tech || !(tech.currentPrice > 0)) return null;

  const sectorI = alignedIndex(data, sectorIndex, i);
  const broadI = alignedIndex(data, broadIndex, i);
  const qqqI = alignedIndex(data, qqqIndex, i);
  const sectorTrend = trendState(sectorBars, sectorI);
  const broadTrend = trendState(broadBars, broadI);
  const qqqTrend = trendState(qqqBars, qqqI);
  const sectorEtf = sectorBars?._symbol || null;

  const price = tech.currentPrice;
  const ma20 = tech.ma20 || price;
  const ma50 = tech.ma50 || price;
  const ma200 = tech.ma200 || price;
  const st = (tech.supertrendByHz && tech.supertrendByHz.medium) || tech.supertrend || null;
  const longSt = (tech.supertrendByHz && tech.supertrendByHz.long) || st;
  const c = candle(data, i);
  const rsi = tech.rsi ?? 50;
  const rsi2 = tech.rsi2 ?? null;
  const bbPct = tech.bb?.pct ?? null;
  const stretch20 = ma20 ? (price - ma20) / ma20 : 0;
  const rel20 = relRet(data, sectorBars, sectorIndex, i, 20);
  const rel60 = relRet(data, sectorBars, sectorIndex, i, 60);
  const relBroad60 = relRet(data, broadBars, broadIndex, i, 60);
  const chanSell = tech.channelPos?.sellQuality;
  const nearMa20 = ma20 && price <= ma20 * 1.015 && price >= ma20 * 0.955;
  const nearMa50 = ma50 && price <= ma50 * 1.02 && price >= ma50 * 0.93;
  const atr = tech.atr || entry * 0.025;
  const pio = fmp?.piotroski ?? null;
  const az = fmp?.altmanZ ?? null;
  const qs = fmp?.qualityScore ?? null;
  const epsG = fund?.earningsGrowth ?? null;
  const revG = fund?.revenueGrowth ?? null;
  const expensive = (fund?.trailingPE != null && fund.trailingPE > 35) || (fund?.forwardPE != null && fund.forwardPE > 32);
  const weakFund =
    (pio != null && pio <= 4) ||
    (az != null && az < 2.2) ||
    (qs != null && qs <= 4) ||
    (epsG != null && epsG < 0) ||
    (revG != null && revG < 2);
  const notStrongFund = !((epsG != null && epsG > 18) && (revG != null && revG > 12) && (pio == null || pio >= 6));
  const distribution = tech.obvBullish === false || tech.bearishStructure === true || tech.volume?.confirmation === 'bearish' || tech.volume?.relativeVolume >= 1.2;
  const activeDown = st?.direction === 'bear' || longSt?.direction === 'bear' || c.lowerHighLowerLow;
  const notOversold = rsi >= 34 && price > ma200 * 0.78;
  const extensionReject = ((rsi2 != null && rsi2 > 88) || rsi > 68 || bbPct > 88 || stretch20 > 0.045)
    && (chanSell === 'excellent' || chanSell === 'good' || bbPct > 88 || stretch20 > 0.045)
    && c.bearishReject;
  const retestReject = (nearMa20 || nearMa50) && c.bearishReject && price < ma200 * 1.02;

  let score = 0;
  if (tech.aboveMa200 === false) score += 2;
  if (tech.aboveMa50 === false) score += 1;
  if (ma50 < ma200) score += 1.5;
  if ((tech.weeklyTrend || tech.trend20) === 'downtrend') score += 1.5;
  if (activeDown) score += 1.5;
  if (distribution) score += 1;
  if (rel20 != null && rel20 < -0.025) score += 1;
  if (rel60 != null && rel60 < -0.06) score += 1.5;
  if (relBroad60 != null && relBroad60 < -0.04) score += 1;
  if (sectorTrend === 'bear') score += 2;
  else if (sectorTrend === 'mixed') score += 0.5;
  else score -= 1.5;
  if (broadTrend === 'bear') score += 1.2;
  if (qqqTrend === 'bear') score += sectorEtf === 'SMH' || sectorEtf === 'XLK' ? 1.2 : 0.3;
  if (weakFund) score += 1.5;
  if (expensive && (epsG == null || epsG < 8)) score += 0.8;
  if (notStrongFund) score += 0.7;
  if (extensionReject || retestReject) score += 1.5;
  if (!notOversold) score -= 2;
  if (tech.consecutiveHigherCloses >= 3) score -= 1.5;
  if (st?.flippedBull) score -= 3;

  const strict = mode === 'strict';
  const gateScore = strict ? 10.5 : 9;
  const requiresTape = strict
    ? (sectorTrend === 'bear' && (broadTrend === 'bear' || qqqTrend === 'bear'))
    : (sectorTrend === 'bear' || (sectorTrend === 'mixed' && broadTrend === 'bear'));
  const requiresEntry = strict ? (retestReject || extensionReject) : (retestReject || extensionReject || activeDown);
  const requiresFund = strict ? (weakFund || (expensive && notStrongFund)) : notStrongFund;
  if (score < gateScore || !requiresTape || !requiresEntry || !requiresFund || !notOversold) return null;

  const risk = strict ? Math.max(1.25 * atr, entry * 0.035) : Math.max(1.0 * atr, entry * 0.03);
  const stop = Math.max(data[i].h + 0.35 * atr, entry + risk);
  const target = entry - RR * (stop - entry);
  if (!(target > 0)) return null;
  return { entry, stop, target, holdDays: strict ? 35 : 45, score, sectorTrend, broadTrend, qqqTrend };
}

async function main() {
  const universe = await fetchExpandedUsUniverse(LIMIT);
  const spy = await loadEtf('SPY');
  const qqq = await loadEtf('QQQ');
  if (!spy || !qqq) throw new Error('SPY/QQQ benchmark unavailable');
  const spyIndex = dateIndex(spy);
  const qqqIndex = dateIndex(qqq);
  spy._symbol = 'SPY';
  qqq._symbol = 'QQQ';

  const totals = {
    rich_naked_sell_balanced: makeBucket(),
    rich_naked_sell_strict: makeBucket()
  };
  let loaded = 0, skipped = 0, candidatesNeedingFund = 0;
  console.log(`Rich naked-sell backtest: ${universe.length} US equities | window=${WINDOW} | RR=${RR}:1\n`);

  for (let n = 0; n < universe.length; n++) {
    const sym = universe[n].t;
    process.stdout.write(`\r[${n + 1}/${universe.length}] ${sym}`.padEnd(44));
    const row = await loadBars(sym);
    if (!row) { skipped++; continue; }
    loaded++;

    let fund = null, fmp = null, sectorBars = null, sectorIndex = null;
    const from = Math.max(120, row.daily.length - WINDOW);
    const to = row.daily.length - 2;
    const nextAllowed = { balanced: from, strict: from };

    for (let i = from; i < to; i += 2) {
      // Cheap prefilter before spending fundamentals/FMP calls.
      const tech = techAtBoundedIndex(row.daily, row.weekly, i);
      if (!tech || tech.aboveMa50 !== false || (tech.rsi ?? 50) < 30 || tech.consecutiveHigherCloses >= 4) continue;

      if (fund === null && !fundLocalCache.has(sym)) {
        candidatesNeedingFund++;
        fund = await loadFund(sym);
        fmp = await loadFmp(sym);
        const etf = sectorEtfFor(sym, fund);
        sectorBars = await loadEtf(etf);
        if (sectorBars) sectorBars._symbol = etf;
        sectorIndex = dateIndex(sectorBars || spy);
      } else if (fund === null) {
        fund = fundLocalCache.get(sym);
        fmp = fmpLocalCache.get(sym);
        const etf = sectorEtfFor(sym, fund);
        sectorBars = await loadEtf(etf);
        if (sectorBars) sectorBars._symbol = etf;
        sectorIndex = dateIndex(sectorBars || spy);
      }
      if (!sectorBars) { sectorBars = spy; sectorIndex = spyIndex; }

      if (i >= nextAllowed.balanced) {
        const c = candidateRichShort({
          sym,
          data: row.daily,
          weekly: row.weekly,
          fund,
          fmp,
          sectorBars,
          sectorIndex,
          broadBars: spy,
          broadIndex: spyIndex,
          qqqBars: qqq,
          qqqIndex,
          i,
          mode: 'balanced'
        });
        if (c) {
          const res = simulateShort(row.daily, i + 1, c.entry, c.stop, c.target, c.holdDays);
          addTrade(totals.rich_naked_sell_balanced, res.ret, res.status);
          nextAllowed.balanced = Math.max(i + 2, res.exitIdx + 1);
        }
      }

      if (i >= nextAllowed.strict) {
        const c = candidateRichShort({
          sym,
          data: row.daily,
          weekly: row.weekly,
          fund,
          fmp,
          sectorBars,
          sectorIndex,
          broadBars: spy,
          broadIndex: spyIndex,
          qqqBars: qqq,
          qqqIndex,
          i,
          mode: 'strict'
        });
        if (c) {
          const res = simulateShort(row.daily, i + 1, c.entry, c.stop, c.target, c.holdDays);
          addTrade(totals.rich_naked_sell_strict, res.ret, res.status);
          nextAllowed.strict = Math.max(i + 2, res.exitIdx + 1);
        }
      }
    }
  }

  console.log('\n\n=== RICH NAKED SELL RESULTS ===');
  const results = [];
  for (const [strategy, bucket] of Object.entries(totals)) {
    const s = summarize(bucket);
    results.push({ strategy, ...s });
    console.log(`${strategy.padEnd(30)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`);
  }

  const outPath = path.join(__dirname, 'backtest-rich-naked-sell-1200-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    universeSource: 'NasdaqTrader filtered common stocks',
    requestedUniverseLimit: LIMIT,
    universeSize: universe.length,
    symbolsWithData: loaded,
    symbolsSkipped: skipped,
    candidatesNeedingFundamentals: candidatesNeedingFund,
    rewardRisk: RR,
    windowBars: WINDOW,
    results
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
