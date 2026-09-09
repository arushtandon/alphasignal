'use strict';

/**
 * Horizon mix for equities (US/UK included): technical engine + FMP quality +
 * Yahoo/FMP fundamentals, weighted by hold period.
 *
 * Short  (1d–1mo): mean-reversion timing. Fundamentals are a veto, FMP a light confirm.
 * Medium (1–3mo):  trend + FMP quality. Earnings/revenue must not contradict the hold.
 * Long   (4–12mo): structure + CANSLIM-style growth + FMP Piotroski/Altman.
 */

const HORIZON_BLEND = {
  short:  { technical: 0.75, fmp: 0.15, fund: 0.10 },
  medium: { technical: 0.50, fmp: 0.30, fund: 0.20 },
  long:   { technical: 0.35, fmp: 0.30, fund: 0.35 }
};

const HORIZON_WEIGHTING_LABELS = {
  short:  '75% technical · 15% FMP · 10% fundamentals',
  medium: '50% technical · 30% FMP · 20% fundamentals',
  long:   '35% technical · 30% FMP · 35% fundamentals'
};

const HZ_PERIOD = {
  short: '1 day–1 month',
  medium: '1–3 months',
  long: '4–12 months'
};

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/%/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pushUnique(arr, text) {
  if (!text) return;
  const list = arr || [];
  if (!list.includes(text)) list.push(text);
  return list;
}

/**
 * Yahoo / FMP quote fundamentals as extra gates (not FMP Piotroski/Altman).
 * Long horizon already scores EPS/rev/PEG inside computeQuantSignal — skip here.
 */
function applyYahooFundGates(hz, fund) {
  const out = { buyDelta: 0, sellDelta: 0, buyMult: 1, condBuy: [], condSell: [] };
  if (!fund || hz === 'long') return out;
  const epsG = num(fund.earningsGrowth);
  const revG = num(fund.revenueGrowth);
  const pegR = num(fund.pegRatio);
  const rec = String(fund.recommendationKey || '').toLowerCase();
  const target = num(fund.targetMeanPrice);
  const price = num(fund.price || fund.regularMarketPrice);

  if (hz === 'short') {
    if ((epsG != null && epsG < -12) || (revG != null && revG < -10)) {
      out.buyMult *= 0.55;
      if (epsG != null && epsG < -12) out.condBuy.push(`EPS ${epsG}% — collapsing earnings, dip-buy cut`);
      else out.condBuy.push(`Revenue ${revG}% — top-line contraction, dip-buy cut`);
    } else if (epsG != null && epsG >= 20 && revG != null && revG >= 10) {
      out.buyDelta += 0.4;
      out.condBuy.push(`EPS +${epsG}% / rev +${revG}% — quality dip, not a value trap`);
    }
    return out;
  }

  // medium
  if (epsG != null && epsG >= 15) {
    out.buyDelta += 1;
    out.condBuy.push(`EPS +${epsG}% supports a 1–3mo hold`);
  } else if (epsG != null && epsG >= 8) {
    out.buyDelta += 0.5;
    out.condBuy.push(`EPS +${epsG}%`);
  }
  if (revG != null && revG >= 12) {
    out.buyDelta += 0.7;
    out.condBuy.push(`Revenue +${revG}%`);
  } else if (revG != null && revG >= 8) {
    out.buyDelta += 0.4;
  }
  if (pegR != null && pegR > 0 && pegR < 1.5) {
    out.buyDelta += 0.4;
    out.condBuy.push(`PEG ${pegR.toFixed(1)} (growth not fully priced)`);
  }
  if ((rec === 'buy' || rec === 'strongbuy') && target != null && price > 0) {
    const up = ((target - price) / price) * 100;
    if (up > 10) {
      out.buyDelta += 0.4;
      out.condBuy.push(`Analyst target +${up.toFixed(0)}%`);
    }
  }
  if (epsG != null && epsG < -8) {
    out.sellDelta += 0.8;
    out.condSell.push(`EPS ${epsG}% — earnings deteriorating`);
  }
  if (revG != null && revG < -8) {
    out.sellDelta += 0.6;
    out.condSell.push(`Revenue ${revG}%`);
  }
  if ((epsG != null && epsG < -10) && (revG != null && revG < -5)) {
    out.buyMult *= 0.55;
    out.condBuy.push('EPS and revenue both contracting — medium buy cut');
  }
  return out;
}

/**
 * FMP Piotroski / quality / Altman overlay. Does not require the old
 * buy_track_record flag (that was a Danelfin leftover: qualityScore ≥ 7).
 */
function applyHorizonQualityBlend(sig, opts) {
  if (!sig || !opts || !opts.fmp) return sig;
  const hz = opts.hz || 'short';
  const fmp = opts.fmp;
  const pio = num(fmp.piotroski);
  const qs = num(fmp.qualityScore);
  const az = num(fmp.altmanZ);
  const cond = Array.isArray(sig.conditions) ? sig.conditions.slice() : [];
  let buy = Number(sig.buyScore) || 0;
  let sell = Number(sig.sellScore) || 0;

  if (hz === 'short') {
    if (pio != null && pio >= 7) {
      buy = Math.min(92, buy + 4 + Math.round((pio - 7) * 1.5));
      pushUnique(cond, `FMP Piotroski ${pio}/9 — quality confirm`);
    } else if (pio != null && pio <= 3) {
      buy = Math.round(buy * 0.55);
      sell = Math.min(88, sell + 4);
      pushUnique(cond, `FMP Piotroski ${pio}/9 weak — short buy cut`);
    } else if (qs != null && qs <= 3) {
      buy = Math.round(buy * 0.55);
      pushUnique(cond, `FMP quality ${qs}/10 weak — short buy cut`);
    }
  } else if (hz === 'medium') {
    if (qs != null && qs >= 7) {
      buy = Math.min(92, buy + 6 + Math.round((qs - 7) * 2));
      if (pio != null && pio >= 6) buy = Math.min(92, buy + 3);
      sig.tier = Math.max(sig.tier || 0, 1);
      sig.tierLabel = `FMP quality ${qs}/10`;
      sig.winRateHint = Math.max(sig.winRateHint || 0, 66);
      pushUnique(cond, `FMP quality ${qs}/10` + (pio != null ? `, Piotroski ${pio}/9` : ''));
    } else if (qs != null && qs >= 6) {
      buy = Math.min(92, buy + 3);
      pushUnique(cond, `FMP quality ${qs}/10 supports 1–3mo hold`);
    } else if (qs != null && qs <= 4) {
      buy = Math.round(buy * 0.45);
      pushUnique(cond, `FMP quality ${qs}/10 too weak for medium`);
    }
    if (az != null && az < 1.81) {
      buy = Math.round(buy * 0.70);
      pushUnique(cond, `Altman Z ${az.toFixed(1)} distress — medium buy cut`);
    } else if (az != null && az > 2.99) {
      buy = Math.min(92, buy + 3);
      pushUnique(cond, `Altman Z ${az.toFixed(1)} safe zone`);
    }
  } else {
    if (qs != null && qs >= 7 && az != null && az > 2.99) {
      buy = Math.min(92, buy + 8 + Math.round((qs - 7) * 2));
      sig.tier = Math.max(sig.tier || 0, 1);
      sig.tierLabel = `FMP ${qs}/10 + Altman Z ${az.toFixed(1)}`;
      sig.winRateHint = Math.max(sig.winRateHint || 0, 68);
      pushUnique(cond, `FMP quality ${qs}/10 + Altman Z ${az.toFixed(1)} (safe)`);
    } else if (qs != null && qs >= 6) {
      buy = Math.min(92, buy + 4);
      pushUnique(cond, `FMP quality ${qs}/10`);
    }
    if ((qs != null && qs <= 4) || (az != null && az <= 1.81)) {
      buy = Math.round(buy * 0.40);
      if (az != null && az <= 1.81) {
        pushUnique(cond, `Altman Z ${az.toFixed(1)} distress — long buy cut`);
      } else {
        pushUnique(cond, `FMP quality ${qs}/10 too weak for 4–12mo`);
      }
    }
    if (pio != null && pio >= 7) {
      buy = Math.min(92, buy + 3);
      pushUnique(cond, `Piotroski ${pio}/9`);
    } else if (pio != null && pio <= 3) {
      buy = Math.round(buy * 0.75);
      pushUnique(cond, `Piotroski ${pio}/9 weak`);
    }
  }

  sig.buyScore = buy;
  sig.sellScore = sell;
  sig.conditions = cond;
  sig.blend = HORIZON_BLEND[hz] || HORIZON_BLEND.short;
  return sig;
}

function fmtPct(from, to) {
  if (!(from > 0) || !(to > 0)) return '';
  const p = ((to - from) / from) * 100;
  const sign = p >= 0 ? '+' : '−';
  return ` (${sign}${Math.abs(p).toFixed(1)}%)`;
}

function formatTradeLevels(isSell, entry, tp1, tp2, sl) {
  const e = parseFloat(entry);
  const t1 = parseFloat(tp1);
  const t2 = parseFloat(tp2);
  const stop = parseFloat(sl);
  if (!(e > 0)) return '';
  const parts = [`${isSell ? 'Sell' : 'Buy'} @ ${e}`];
  if (t1 > 0) parts.push(`TP1 ${t1}${fmtPct(e, t1)}`);
  if (t2 > 0) parts.push(`TP2 ${t2}${fmtPct(e, t2)}`);
  if (stop > 0) {
    parts.push(`SL ${stop}${fmtPct(e, stop)}`);
    const risk = Math.abs(e - stop);
    const reward = t1 > 0 ? Math.abs(t1 - e) : 0;
    if (risk > 0 && reward > 0) parts.push(`R:R ${(reward / risk).toFixed(1)}x`);
  }
  return parts.join(' · ');
}

function fmpBits(fmp) {
  const bits = [];
  if (!fmp || typeof fmp !== 'object') return bits;
  const pio = num(fmp.piotroski);
  const qs = num(fmp.qualityScore);
  const az = num(fmp.altmanZ);
  if (pio != null) bits.push(`Piotroski ${pio}/9`);
  if (qs != null) bits.push(`quality ${qs}/10`);
  if (az != null) {
    const zone = az > 2.99 ? 'safe' : az > 1.81 ? 'grey' : 'distress';
    bits.push(`Altman Z ${az.toFixed(1)} (${zone})`);
  }
  return bits;
}

function fundBits(fund, row) {
  const bits = [];
  const src = fund && typeof fund === 'object' ? fund : {};
  const rowSrc = row && typeof row === 'object' ? row : {};
  const eps = num(src.earningsGrowth != null ? src.earningsGrowth : rowSrc.earningsGrowth);
  const rev = num(src.revenueGrowth != null ? src.revenueGrowth : rowSrc.revenueGrowth);
  const peg = num(src.pegRatio != null ? src.pegRatio : rowSrc.peg);
  const pe = src.forwardPE != null ? num(src.forwardPE) : (src.trailingPE != null ? num(src.trailingPE) : null);
  if (eps != null) bits.push(`EPS ${eps >= 0 ? '+' : ''}${eps}% YoY`);
  if (rev != null) bits.push(`rev ${rev >= 0 ? '+' : ''}${rev}% YoY`);
  if (peg != null && peg > 0) bits.push(`PEG ${peg.toFixed(1)}`);
  if (pe != null && pe > 0 && pe < 9000) bits.push(`P/E ${pe >= 99 ? Math.round(pe) : pe.toFixed(1)}`);
  return bits;
}

function invalidationLine(hz, isSell, regime) {
  if (isSell) {
    if (hz === 'short') return 'Invalid if RSI turns up with MACD, or the extension collapses back through the channel mean without follow-through.';
    return 'Invalid if price reclaims MA50 on a weekly close, or RSI/MACD turn up together (bear-rally / squeeze).';
  }
  if (hz === 'short') return 'Invalid if MA20 and MA50 both fail, or four more lower closes print (knife, not a dip).';
  if (hz === 'long') return 'Invalid if price closes back below MA200, or earnings growth turns negative.';
  if (regime === 'bull') return 'Invalid if weekly trend flips down or price closes below MA50.';
  return 'Invalid if the name loses MA200 or the SD-channel mean with rising volume.';
}

/**
 * One readable thesis: mix, setup (gates that actually fired), FMP/fund numbers,
 * levels, and what kills the trade. Replaces "levels locked at signal."
 */
function buildPreciseTradeThesis(opts) {
  opts = opts || {};
  const hz = opts.hz || 'short';
  const isSell = !!opts.isSell;
  const rating = opts.rating || (isSell ? 'Sell' : 'Buy');
  const score = opts.score;
  const regime = opts.regime || '';
  const mix = HORIZON_WEIGHTING_LABELS[hz] || HORIZON_WEIGHTING_LABELS.short;
  const hzLabel = hz.charAt(0).toUpperCase() + hz.slice(1);
  const period = HZ_PERIOD[hz] || hz;
  const conds = (opts.conditions || []).filter(Boolean).slice(0, 8);
  const levels = opts.levelsText || formatTradeLevels(isSell, opts.entry, opts.tp1, opts.tp2, opts.sl);

  const head = `${hzLabel} (${period}) ${rating}`
    + (score != null && score !== '' ? ` (${score}/100)` : '')
    + ` — ${mix}.`;

  const setupParts = [];
  if (regime && regime !== 'neutral') setupParts.push(`${regime} regime`);
  conds.forEach((c) => setupParts.push(c));
  const fmp = fmpBits(opts.fmp);
  const fund = fundBits(opts.fund, opts.row);
  let setup = 'Setup: ';
  if (setupParts.length) setup += setupParts.join('; ');
  else setup += isSell ? 'sell gates met on this horizon' : 'buy gates met on this horizon';
  if (fmp.length) setup += `. FMP: ${fmp.join(', ')}`;
  if (fund.length) setup += `. Fundamentals: ${fund.join(', ')}`;
  setup += '.';

  const trade = levels ? `Trade: ${levels}.` : '';
  const inv = invalidationLine(hz, isSell, regime);
  return [head, setup, trade, inv].filter(Boolean).join(' ');
}

function looksGenericReason(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^quant signal$/i.test(t) || /^setup note$/i.test(t)) return true;
  if (/levels locked at signal/i.test(t)) return true;
  if (/^Buy @ .+ \| (Strong )?Buy \(\d+\/100\)/i.test(t)) return true;
  if (/^Sell @ .+ \| (Strong )?Sell \(\d+\/100\)/i.test(t)) return true;
  return false;
}

module.exports = {
  HORIZON_BLEND,
  HORIZON_WEIGHTING_LABELS,
  HZ_PERIOD,
  applyYahooFundGates,
  applyHorizonQualityBlend,
  buildPreciseTradeThesis,
  formatTradeLevels,
  looksGenericReason
};
