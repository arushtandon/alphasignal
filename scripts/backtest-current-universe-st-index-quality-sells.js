/**
 * Experimental current-universe naked sell strategy.
 *
 * Universe: current app universe, excluding commodities/crypto.
 * Signals: Supertrend + market/index trend + sector/ETF trend + momentum +
 *          FMP/Piotroski/Altman/fundamental quality where available.
 * Exits: current production sell exit engine for short/medium/long horizons.
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
  fetchOHLCV,
  fetchFundamentals,
  fetchFmpScore,
  fundCache,
  simulateHybridExit,
  TECH_TTL,
  techAtBoundedIndex
} = require('../server');

const WINDOW = Math.min(360, Math.max(180, parseInt(process.env.WINDOW || '252', 10) || 252));
const HZS = ['short', 'medium', 'long'];
const VARIANTS = ['balanced', 'strict'];

const MARKET_ETF = {
  US: 'SPY',
  DAX: 'EWG',
  CAC40: 'EWQ',
  FTSE100: 'EWU',
  NIFTY50: 'INDA',
  HSI: 'EWH',
  NIKKEI225: 'EWJ'
};

const SECTOR_ETF = {
  technology: 'XLK',
  'information technology': 'XLK',
  semiconductors: 'SMH',
  semiconductor: 'SMH',
  chip: 'SMH',
  financial: 'XLF',
  financials: 'XLF',
  banks: 'KBE',
  energy: 'XLE',
  healthcare: 'XLV',
  'health care': 'XLV',
  industrials: 'XLI',
  industrial: 'XLI',
  'consumer cyclical': 'XLY',
  'consumer discretionary': 'XLY',
  retail: 'XRT',
  automobiles: 'CARZ',
  'consumer defensive': 'XLP',
  'consumer staples': 'XLP',
  materials: 'XLB',
  'basic materials': 'XLB',
  utilities: 'XLU',
  'real estate': 'XLRE',
  communication: 'XLC',
  'communication services': 'XLC',
  telecom: 'XLC'
};

const CHIP_SYMBOLS = new Set([
  'NVDA','AMD','AVGO','INTC','QCOM','MU','AMAT','LRCX','KLAC','MRVL','ON','MCHP',
  'ADI','TXN','ASML','TSM','ARM','MPWR','SWKS','QRVO','NXPI','TER','ENTG','LSCC'
]);

const barsCache = new Map();
const fundLocalCache = new Map();
const fmpLocalCache = new Map();

async function loadBars(sym) {
  if (barsCache.has(sym)) return barsCache.get(sym);
  const daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 190) {
    barsCache.set(sym, null);
    return null;
  }
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  const row = { daily, weekly };
  barsCache.set(sym, row);
  return row;
}

async function loadEtf(sym) {
  const row = await loadBars(sym);
  if (row?.daily) row.daily._symbol = sym;
  return row?.daily || null;
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

function alignedIndex(stockData, indexMap, i) {
  const k = dateKey(stockData[i]);
  return k ? indexMap.get(k) : null;
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

function trendScore(bars, i, hz) {
  if (!bars || i == null || i < 80) return { label: 'unknown', score: 0 };
  const tech = techAtBoundedIndex(bars, null, i);
  const st = (tech?.supertrendByHz && tech.supertrendByHz[hz]) || tech?.supertrend || null;
  let score = 0;
  if (tech?.aboveMa200 === false) score += 2;
  if (tech?.aboveMa50 === false) score += 1;
  if ((tech?.weeklyTrend || tech?.trend20) === 'downtrend') score += hz === 'short' ? 0.75 : 1.25;
  if (st?.direction === 'bear') score += 1.5;
  if (tech?.macd?.trend === 'bearish') score += 0.5;
  if ((tech?.rsi ?? 50) < 45) score += 0.5;
  const label = score >= 4 ? 'bear' : score >= 2.5 ? 'weak' : 'not_bear';
  return { label, score };
}

function sectorEtfFor(sym, fund) {
  if (CHIP_SYMBOLS.has(sym)) return 'SMH';
  const s = String(fund?._fmpSector || fund?.sector || fund?.industry || '').toLowerCase();
  if (/semi|chip/.test(s)) return 'SMH';
  for (const [k, v] of Object.entries(SECTOR_ETF)) {
    if (s.includes(k)) return v;
  }
  return null;
}

function candle(data, i) {
  const b = data[i], p = data[i - 1];
  if (!b || !p) return {};
  return {
    bearishReject: (b.h > p.h && b.c < b.o) || b.c < p.l || (b.o > p.c && b.c < p.o),
    lowerHighLowerLow: b.h < p.h && b.l < p.l && b.c < p.c,
    redClose: b.c < b.o
  };
}

function qualityProfile(fund, fmp) {
  const pio = fmp?.piotroski ?? null;
  const az = fmp?.altmanZ ?? null;
  const qs = fmp?.qualityScore ?? null;
  const epsG = fund?.earningsGrowth ?? null;
  const revG = fund?.revenueGrowth ?? null;
  const trailingPE = fund?.trailingPE ?? null;
  const forwardPE = fund?.forwardPE ?? null;
  const weak =
    (qs != null && qs <= 4) ||
    (pio != null && pio <= 4) ||
    (az != null && az < 2.1) ||
    (epsG != null && epsG < 0) ||
    (revG != null && revG < 0);
  const strong =
    (qs != null && qs >= 7) ||
    ((pio != null && pio >= 7) && (az == null || az > 2.5)) ||
    ((epsG != null && epsG > 15) && (revG != null && revG > 10));
  const valuationRisk =
    (trailingPE != null && trailingPE > 40) ||
    (forwardPE != null && forwardPE > 35);
  return { weak, strong, valuationRisk, pio, az, qs, epsG, revG };
}

function sellCandidate({ data, weekly, marketBars, marketIndex, sectorBars, sectorIndex, fund, fmp, i, hz, variant }) {
  const entry = data[i + 1]?.o ?? data[i]?.c;
  if (!(entry > 0)) return null;

  const tech = techAtBoundedIndex(data, weekly, i);
  if (!tech || !(tech.currentPrice > 0)) return null;

  const mi = alignedIndex(data, marketIndex, i);
  const si = alignedIndex(data, sectorIndex, i);
  const market = trendScore(marketBars, mi, hz);
  const sector = trendScore(sectorBars, si, hz);
  const st = (tech.supertrendByHz && tech.supertrendByHz[hz]) || tech.supertrend || null;
  const flags = candle(data, i);
  const q = qualityProfile(fund, fmp);

  const price = tech.currentPrice;
  const ma20 = tech.ma20 || price;
  const ma50 = tech.ma50 || price;
  const ma200 = tech.ma200 || price;
  const rsi = tech.rsi ?? 50;
  const rsi2 = tech.rsi2 ?? null;
  const bbPct = tech.bb?.pct ?? null;
  const rel20 = relRet(data, sectorBars, sectorIndex, i, 20);
  const rel60 = relRet(data, sectorBars, sectorIndex, i, 60);
  const relM60 = relRet(data, marketBars, marketIndex, i, 60);
  const chanSell = tech.channelPos?.sellQuality;
  const stretch20 = ma20 ? (price - ma20) / ma20 : 0;
  const nearMa20 = ma20 && price <= ma20 * 1.015 && price >= ma20 * 0.955;
  const nearMa50 = ma50 && price <= ma50 * 1.02 && price >= ma50 * 0.93;
  const distribution = tech.obvBullish === false || tech.bearishStructure === true || tech.volume?.confirmation === 'bearish' || tech.volume?.relativeVolume >= 1.15;
  const notOversold = hz === 'short'
    ? rsi >= 38
    : rsi >= 34 && price > ma200 * (hz === 'long' ? 0.75 : 0.78);
  const bearishMomentum =
    st?.direction === 'bear' ||
    tech.macd?.trend === 'bearish' ||
    tech.macdTurningDown === true ||
    flags.lowerHighLowerLow ||
    (tech.aboveMa20 === false && flags.redClose);
  const rejectedExtension =
    ((rsi2 != null && rsi2 > 88) || rsi > 68 || bbPct > 88 || stretch20 > 0.045) &&
    (chanSell === 'excellent' || chanSell === 'good' || bbPct > 88 || stretch20 > 0.045) &&
    flags.bearishReject;
  const failedRetest = (nearMa20 || nearMa50) && flags.bearishReject && price < ma200 * 1.03;
  const primaryDown = tech.aboveMa50 === false && (hz === 'short' || tech.aboveMa200 === false || ma50 < ma200);

  let score = 0;
  if (primaryDown) score += hz === 'short' ? 1.5 : 2.5;
  if (tech.aboveMa200 === false) score += hz === 'long' ? 2.2 : 1.2;
  if (ma50 < ma200) score += 1.2;
  if ((tech.weeklyTrend || tech.trend20) === 'downtrend') score += hz === 'short' ? 0.6 : 1.2;
  if (st?.direction === 'bear') score += 1.8;
  if (st?.flippedBear) score += 1.2;
  if (market.label === 'bear') score += hz === 'short' ? 0.8 : 1.5;
  else if (market.label === 'weak') score += 0.5;
  else score -= hz === 'short' ? 0.3 : 1.2;
  if (sector.label === 'bear') score += 2;
  else if (sector.label === 'weak') score += 0.8;
  else score -= 1.4;
  if (rel20 != null && rel20 < -0.02) score += 1;
  if (rel60 != null && rel60 < -0.05) score += 1.4;
  if (relM60 != null && relM60 < -0.04) score += 0.8;
  if (bearishMomentum) score += 1.2;
  if (distribution) score += 1;
  if (failedRetest) score += 1.5;
  if (rejectedExtension && hz === 'short') score += 1.6;
  if (q.weak) score += 1.2;
  if (q.valuationRisk && !q.strong) score += 0.5;
  if (q.strong) score -= variant === 'strict' ? 2.5 : 1.4;
  if (!notOversold) score -= 2.2;
  if ((tech.consecutiveHigherCloses || 0) >= 3) score -= 1.3;
  if (st?.flippedBull) score -= 3;

  const strict = variant === 'strict';
  const threshold = hz === 'short' ? (strict ? 9.5 : 8.2)
    : hz === 'medium' ? (strict ? 10.5 : 8.8)
    : (strict ? 11.2 : 9.4);
  const tapeOk = strict
    ? (sector.label === 'bear' && (market.label === 'bear' || hz === 'short'))
    : (sector.label !== 'not_bear' || market.label === 'bear');
  const entryOk = hz === 'short'
    ? (rejectedExtension || (failedRetest && bearishMomentum))
    : (failedRetest || (bearishMomentum && distribution));
  const qualityOk = strict ? (q.weak || (!q.strong && q.valuationRisk)) : !q.strong;

  if (score < threshold || !tapeOk || !entryOk || !qualityOk || !notOversold) return null;
  return { score, entry };
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

async function main() {
  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '';
  const rawUniverse = await buildFullUniverse(global.fetch, fmpKey);
  const universe = rawUniverse.filter(x => x && x.t && x.market !== 'COMMODITIES');
  console.log(`Current-universe ST/index/FMP/momentum sell backtest: ${universe.length} symbols | window=${WINDOW}\n`);

  const marketBars = {};
  const marketIndexes = {};
  for (const etf of [...new Set(Object.values(MARKET_ETF))]) {
    const bars = await loadEtf(etf);
    if (bars) {
      marketBars[etf] = bars;
      marketIndexes[etf] = dateIndex(bars);
    }
  }

  const totals = {};
  for (const variant of VARIANTS) {
    for (const hz of HZS) totals[`${variant}:${hz}`] = makeBucket();
  }

  let loaded = 0, skipped = 0, fmpHits = 0, fundHits = 0;
  for (let n = 0; n < universe.length; n++) {
    const { t: sym, market } = universe[n];
    process.stdout.write(`\r[${n + 1}/${universe.length}] ${sym}`.padEnd(44));
    const row = await loadBars(sym);
    if (!row) { skipped++; continue; }
    loaded++;

    const fund = await loadFund(sym);
    const fmp = await loadFmp(sym);
    if (fund) fundHits++;
    if (fmp && (fmp.qualityScore != null || fmp.piotroski != null || fmp.altmanZ != null)) fmpHits++;

    const mEtf = MARKET_ETF[market] || 'SPY';
    const mBars = marketBars[mEtf] || marketBars.SPY;
    const mIndex = marketIndexes[mEtf] || marketIndexes.SPY;
    const sEtf = sectorEtfFor(sym, fund) || mEtf;
    let sBars = marketBars[sEtf];
    let sIndex = marketIndexes[sEtf];
    if (!sBars) {
      sBars = await loadEtf(sEtf);
      if (sBars) {
        marketBars[sEtf] = sBars;
        sIndex = dateIndex(sBars);
        marketIndexes[sEtf] = sIndex;
      }
    }
    if (!sBars) { sBars = mBars; sIndex = mIndex; }

    const from = Math.max(120, row.daily.length - WINDOW);
    const to = row.daily.length - 2;
    const nextAllowed = {};
    for (const variant of VARIANTS) for (const hz of HZS) nextAllowed[`${variant}:${hz}`] = from;

    for (let i = from; i < to; i += 2) {
      for (const variant of VARIANTS) {
        for (const hz of HZS) {
          const key = `${variant}:${hz}`;
          if (i < nextAllowed[key]) continue;
          const c = sellCandidate({
            data: row.daily,
            weekly: row.weekly,
            marketBars: mBars,
            marketIndex: mIndex,
            sectorBars: sBars,
            sectorIndex: sIndex,
            fund,
            fmp,
            i,
            hz,
            variant
          });
          if (!c) continue;
          const res = await simulateHybridExit(row.daily, i + 1, c.entry, hz, true, row.weekly, fund);
          if (!res || res.exitIdx == null) continue;
          addTrade(totals[key], res.ret, res.status);
          nextAllowed[key] = Math.max(i + 2, res.exitIdx + 1);
        }
      }
    }
  }

  console.log('\n\n=== CURRENT-UNIVERSE SELL STRATEGY RESULTS ===');
  const results = [];
  for (const variant of VARIANTS) {
    console.log(`\n${variant.toUpperCase()}`);
    for (const hz of HZS) {
      const key = `${variant}:${hz}`;
      const s = summarize(totals[key]);
      results.push({ variant, hz, ...s });
      console.log(`${key.padEnd(18)} | trades=${String(s.trades).padStart(5)} | WR=${String(s.winRate ?? '-').padStart(5)}% | avg=${String(s.avgReturnPct ?? '-').padStart(6)}% | avgW=${String(s.avgWinPct ?? '-').padStart(5)}% | avgL=${String(s.avgLossPct ?? '-').padStart(5)}% | W/L=${s.winLossRatio ?? '-'} | PF=${s.profitFactor ?? '-'}`);
    }
  }

  const outPath = path.join(__dirname, 'backtest-current-universe-st-index-quality-sells-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    universe: 'buildFullUniverse excluding COMMODITIES',
    universeSize: universe.length,
    symbolsWithData: loaded,
    symbolsSkipped: skipped,
    fundHits,
    fmpHits,
    windowBars: WINDOW,
    results
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
