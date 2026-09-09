'use strict';

/**
 * Re-score today's US shortlist names against the live gates:
 * technical + FMP + fundamentals by horizon, Strong only, no short buys, RR 1.4.
 * Read-only: does not write the board, history, or IBKR.
 */
process.env.RESEARCH_MODE = '1';
process.env.IBKR_EVENTS_ENABLED = process.env.IBKR_EVENTS_ENABLED || '0';

const fs = require('fs');
const path = require('path');
const {
  isAngloSymbol,
  angloPickAllowed,
  minRrForSymbol,
  ANGLO_MIN_RR
} = require('../lib/strategy/market-tier');
const {
  fetchOHLCV,
  fetchFundamentals,
  fetchFmpScore,
  computeQuantSignal,
  buildFullTechResult,
  applyMarketTierOverlays,
  applyServerPriceLevels,
  levelsMeetMinRR,
  rewardRiskRatio
} = require('../server');

const SHORTLIST = path.join(__dirname, '..', 'data', 'universe_shortlist.json');
const OUT = path.join(__dirname, '..', 'data', 'us-reanalyze-today.json');

function usTickers() {
  const extra = process.argv.slice(2).filter((t) => t && !t.startsWith('-'));
  if (extra.length) return [...new Set(extra.map((t) => t.toUpperCase()))];
  const raw = JSON.parse(fs.readFileSync(SHORTLIST, 'utf8'));
  return (raw.shortlist || [])
    .filter((x) => x.market === 'US' || (isAngloSymbol(x.ticker) && !String(x.ticker).endsWith('.L')))
    .map((x) => x.ticker)
    .concat(['FAST', 'DASH']);
}

async function scoreSymbol(sym) {
  let daily = await fetchOHLCV(sym, '2y', '1d').catch(() => null);
  if (!daily || daily.length < 100) daily = await fetchOHLCV(sym, '1y', '1d').catch(() => null);
  if (!daily || daily.length < 20) return { ticker: sym, error: 'no ohlcv' };
  const weekly = await fetchOHLCV(sym, '2y', '1wk').catch(() => null);
  const tech = buildFullTechResult(sym, daily, weekly);
  const fund = await fetchFundamentals(sym).catch(() => null);
  tech.quantSignal = {
    short: computeQuantSignal(tech, fund, 'short'),
    medium: computeQuantSignal(tech, fund, 'medium'),
    long: computeQuantSignal(tech, fund, 'long')
  };
  const fmp = await fetchFmpScore(sym, { batchMode: true }).catch(() => null);
  await applyMarketTierOverlays(sym, tech, { batchMode: true, fundPre: fund, fmpPre: fmp });
  const row = { ticker: sym };
  for (const hz of ['short', 'medium', 'long']) {
    const sig = tech.quantSignal[hz] || {};
    row[hz + 'Score'] = sig.buyScore || 0;
    row[hz + 'SellScore'] = sig.sellScore || 0;
    row[hz + 'Action'] = sig.action || 'Hold';
    row[hz + 'Rating'] = sig.rating || 'Hold';
    row[hz + 'Conf'] = sig.winRateHint || Math.max(sig.buyScore || 0, sig.sellScore || 0);
  }
  row.action = row.shortAction;
  applyServerPriceLevels(row, tech.currentPrice, tech, fund);
  const verdicts = [];
  for (const hz of ['short', 'medium', 'long']) {
    const sig = tech.quantSignal[hz] || {};
    const buy = Number(sig.buyScore) || 0;
    const sell = Number(sig.sellScore) || 0;
    const buyAction = sig.action === 'Buy';
    const sellAction = sig.action === 'Sell';
    const entry = parseFloat(row[hz + 'Entry'] || row.entry);
    const tp1 = parseFloat(row[hz + 'Target1'] || row.target1);
    const sl = parseFloat(row[hz + 'StopLoss'] || row.stopLoss);
    const conf = Number(row[hz + 'Conf']) || Number(sig.winRateHint) || Math.max(buy, sell);
    const minRR = minRrForSymbol(sym, 1.1);

    function evalSide(side, actionOk, rating, score, e, t, s) {
      const anglo = angloPickAllowed(sym, { hz, side, rating });
      const rr = rewardRiskRatio(e, t, s, side === 'sell');
      const rrOk = levelsMeetMinRR(e, t, s, side === 'sell', minRR);
      const confOk = conf >= 62;
      const scoreOk = score >= 62;
      const reasons = [];
      if (!actionOk) reasons.push('action is not ' + (side === 'sell' ? 'Sell' : 'Buy'));
      if (!scoreOk) reasons.push('score ' + score + ' < 62');
      if (!confOk) reasons.push('conf ' + conf + ' < 62');
      if (!anglo.ok) reasons.push(anglo.reason);
      if (!rrOk) reasons.push('RR ' + (rr != null ? rr.toFixed(2) : 'n/a') + ' < ' + minRR);
      const pass = actionOk && scoreOk && confOk && anglo.ok && rrOk;
      return {
        hz, side, pass, rating, score, conf,
        rr: rr != null ? +rr.toFixed(2) : null,
        minRR, entry: e, tp1: t, sl: s,
        conditions: (sig.conditions || []).slice(0, 8),
        reasons: pass ? [] : reasons
      };
    }

    if (buyAction || buy >= 62) {
      verdicts.push(evalSide('buy', buyAction, sig.rating, buy, entry, tp1, sl));
    }
    if (sellAction || sell >= 62) {
      verdicts.push(evalSide('sell', sellAction, sig.rating, sell, entry, tp1, sl));
    }
    if (!buyAction && !sellAction && buy < 62 && sell < 62) {
      verdicts.push({
        hz, side: 'none', pass: false, rating: sig.rating, score: Math.max(buy, sell), conf,
        reasons: ['Hold — no Buy/Sell at 62']
      });
    }
  }
  return {
    ticker: sym,
    price: tech.currentPrice,
    fmp: fmp ? { piotroski: fmp.piotroski, qualityScore: fmp.qualityScore, altmanZ: fmp.altmanZ } : null,
    fund: fund ? {
      earningsGrowth: fund.earningsGrowth,
      revenueGrowth: fund.revenueGrowth,
      pegRatio: fund.pegRatio
    } : null,
    verdicts
  };
}

(async () => {
  const tickers = usTickers().filter((t) => isAngloSymbol(t) && !String(t).endsWith('.L'));
  console.log('Re-analysing', tickers.length, 'US names. Anglo min RR', ANGLO_MIN_RR);
  const rows = [];
  for (const t of tickers) {
    try {
      const r = await scoreSymbol(t);
      rows.push(r);
      const keep = (r.verdicts || []).filter((v) => v.pass);
      if (keep.length) {
        keep.forEach((v) => console.log('KEEP', t, v.hz, v.side, v.rating, v.score, 'RR', v.rr, (v.conditions || []).slice(0, 3).join('; ')));
      } else {
        const best = (r.verdicts || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
        console.log('DROP', t, best ? (best.hz + ' ' + (best.rating || '') + ' ' + (best.score || 0) + ' — ' + (best.reasons || []).join('; ')) : (r.error || 'no setup'));
      }
    } catch (e) {
      console.log('DROP', t, e.message);
      rows.push({ ticker: t, error: e.message, verdicts: [] });
    }
  }
  const keep = [];
  for (const r of rows) {
    for (const v of r.verdicts || []) {
      if (v.pass) keep.push({ ticker: r.ticker, ...v, fmp: r.fmp, fund: r.fund });
    }
  }
  const report = {
    ts: new Date().toISOString(),
    analysed: tickers,
    keep,
    rows
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nPass', keep.length, 'setups across', new Set(keep.map((k) => k.ticker)).size, 'names. Wrote', OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
