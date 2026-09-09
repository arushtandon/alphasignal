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

function companyHealthLine(fmp, fund, row) {
  const bits = [];
  const pio = fmp ? num(fmp.piotroski) : null;
  const qs = fmp ? num(fmp.qualityScore) : null;
  const az = fmp ? num(fmp.altmanZ) : null;
  if (pio != null) {
    bits.push(
      pio >= 7
        ? `company finances look healthy (${pio}/9 on the standard 9-point score)`
        : pio >= 5
          ? `company finances are average (${pio}/9)`
          : `company finances look weak (${pio}/9)`
    );
  }
  if (qs != null && pio == null) {
    bits.push(
      qs >= 7
        ? `overall quality score is strong (${qs}/10)`
        : qs <= 4
          ? `overall quality score is weak (${qs}/10)`
          : `overall quality score is moderate (${qs}/10)`
    );
  }
  if (az != null) {
    bits.push(
      az > 2.99
        ? `low bankruptcy-risk reading (${az.toFixed(1)})`
        : az > 1.81
          ? `mixed bankruptcy-risk reading (${az.toFixed(1)})`
          : `high bankruptcy-risk reading (${az.toFixed(1)})`
    );
  }
  const src = fund && typeof fund === 'object' ? fund : {};
  const rowSrc = row && typeof row === 'object' ? row : {};
  const eps = num(src.earningsGrowth != null ? src.earningsGrowth : rowSrc.earningsGrowth);
  const rev = num(src.revenueGrowth != null ? src.revenueGrowth : rowSrc.revenueGrowth);
  if (eps != null) bits.push(`earnings ${eps >= 0 ? 'grew' : 'fell'} ${Math.abs(eps)}% vs last year`);
  if (rev != null) bits.push(`sales ${rev >= 0 ? 'grew' : 'fell'} ${Math.abs(rev)}% vs last year`);
  return bits;
}

function isCompanyCondition(text) {
  return /Piotroski|FMP quality|Altman|EPS |Revenue /i.test(String(text || ''));
}

function plainEnglishCondition(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  let m;
  if (/SD channel: below lower band/i.test(t)) {
    return 'the share price has dropped below its usual recent range (a discount)';
  }
  if (/SD channel: near lower band/i.test(t)) {
    return 'the share price is near the cheap end of its recent range';
  }
  if (/SD channel: above upper band/i.test(t) || /SD top/i.test(t)) {
    return 'the share price has stretched above its usual recent range';
  }
  if (/SD channel pullback in uptrend/i.test(t) || /SD channel VCP/i.test(t)) {
    return 'this is a pullback inside an uptrend, not a breakdown';
  }
  if (/At MA50 support/i.test(t)) return 'it is holding at the 50-day average (a common bounce level)';
  if (/At MA20 support/i.test(t)) return 'it is holding at the 20-day average';
  m = t.match(/At support\s+\$?([\d.]+)/i);
  if (m) return `it is sitting on a known floor around ${m[1]}`;
  m = t.match(/At resistance\s+\$?([\d.]+)/i);
  if (m) return `it is hitting a known ceiling around ${m[1]}`;
  m = t.match(/RSI\(2\)\s*([\d.]+)\s*washed/i);
  if (m) return `very short-term selling looks exhausted (oversold reading ${m[1]})`;
  m = t.match(/RSI\(2\)\s*([\d.]+)\s*oversold/i);
  if (m) return `very short-term selling is stretched (oversold reading ${m[1]})`;
  m = t.match(/RSI\(2\)\s*([\d.]+)\s*overbought/i);
  if (m) return `very short-term buying is stretched (overbought reading ${m[1]})`;
  m = t.match(/RSI\s+([\d.]+)\s*oversold/i);
  if (m) return `the stock looks oversold on the usual 14-day reading (${m[1]})`;
  m = t.match(/RSI\s+([\d.]+)\s*overbought/i);
  if (m) return `the stock looks overbought on the usual 14-day reading (${m[1]})`;
  if (/Stochastic/i.test(t) && /oversold/i.test(t)) return 'another short-term oscillator also says the dip is stretched';
  if (/Stochastic/i.test(t) && /overbought/i.test(t)) return 'another short-term oscillator also says the rally is stretched';
  if (/lower Bollinger/i.test(t)) return 'price is hugging the lower statistical band';
  if (/upper Bollinger/i.test(t)) return 'price is hugging the upper statistical band';
  if (/MACD turning up/i.test(t)) return 'momentum has just started to turn up';
  if (/MACD bearish/i.test(t)) return 'momentum is still pointing down';
  if (/Golden Cross/i.test(t) || /MA200 bull regime/i.test(t)) {
    return 'the 50-day average is above the 200-day average (an uptrend)';
  }
  if (/Above MA200/i.test(t) || /primary uptrend/i.test(t)) {
    return 'price is still above the 200-day average (longer-term uptrend intact)';
  }
  if (/Below MA200/i.test(t) || /bear regime/i.test(t) || /BEAR BREAKDOWN/i.test(t)) {
    return 'price has broken below the 200-day average (longer-term downtrend)';
  }
  if (/Death Cross/i.test(t)) return 'the 50-day average has crossed below the 200-day (downtrend)';
  if (/Weekly uptrend/i.test(t)) return 'the weekly chart is still rising';
  if (/Weekly downtrend/i.test(t)) return 'the weekly chart is falling';
  m = t.match(/ADX\s+([\d.]+)/i);
  if (m) return `the trend is strong (ADX ${m[1]})`;
  if (/OBV/i.test(t)) return 'volume is confirming buying, not just a dead-cat bounce';
  if (/Supertrend .+ Strong Buy/i.test(t) || /fresh bull flip/i.test(t)) {
    return 'the trend filter has just flipped up';
  }
  if (/Supertrend .+ Strong Sell/i.test(t) || /fresh bear flip/i.test(t)) {
    return 'the trend filter has just flipped down';
  }
  if (/Supertrend .+ bullish/i.test(t)) return 'the trend filter is pointing up';
  if (/Supertrend .+ bearish/i.test(t)) return 'the trend filter is pointing down';
  if (/Piotroski\s+(\d+)\/9/i.test(t)) {
    m = t.match(/Piotroski\s+(\d+)\/9/i);
    const n = Number(m[1]);
    return n >= 7
      ? `company financial health is strong (${n}/9)`
      : n >= 5
        ? `company financial health is average (${n}/9)`
        : `company financial health is weak (${n}/9)`;
  }
  if (/FMP quality\s+([\d.]+)\/10/i.test(t)) {
    m = t.match(/FMP quality\s+([\d.]+)\/10/i);
    return `FMP overall quality is ${m[1]}/10`;
  }
  if (/Altman Z\s+([\d.]+)/i.test(t)) {
    m = t.match(/Altman Z\s+([\d.]+)/i);
    return `bankruptcy-risk score is ${m[1]}`;
  }
  if (/EPS \+(\d+)/i.test(t)) {
    m = t.match(/EPS \+(\d+)/i);
    return `earnings grew ${m[1]}% vs last year`;
  }
  if (/Revenue \+(\d+)/i.test(t)) {
    m = t.match(/Revenue \+(\d+)/i);
    return `sales grew ${m[1]}% vs last year`;
  }
  if (/Fade short/i.test(t)) return 'this is a fade of an overbought spike back toward average, not a long-term short';
  if (/Strict short/i.test(t)) return 'this is a breakdown short (trend already down, not a guess at a top)';
  if (/consecutive lower closes/i.test(t)) return t.toLowerCase();
  if (/FMP required/i.test(t) || /no company-quality numbers/i.test(t)) {
    return 'this listing returned no company-quality numbers from FMP, so we will not recommend it';
  }
  return t;
}

function harvestConditionsFromWhy(why) {
  const t = String(why || '');
  if (!t) return [];
  const out = [];
  const push = (s) => {
    const x = String(s || '').trim().replace(/[.;]+$/, '');
    if (x && !out.includes(x)) out.push(x);
  };
  const patterns = [
    /Piotroski\s+\d+\/9/i,
    /FMP quality\s+[\d.]+\/10/i,
    /Altman Z\s+[\d.]+(?:\s*\([^)]+\))?/i,
    /SD channel:[^;.]+/i,
    /SD channel pullback in uptrend/i,
    /At MA\d+ support/i,
    /At support\s+\$?[\d.]+/i,
    /At resistance\s+\$?[\d.]+/i,
    /RSI\(2\)\s*[\d.]+\s*(?:washed out|oversold|overbought)/i,
    /RSI\s+[\d.]+\s*(?:oversold|overbought)/i,
    /Stochastic[^;.]*(?:oversold|overbought)/i,
    /(?:lower|upper) Bollinger[^;.]*/i,
    /MACD turning up/i,
    /MACD bearish[^;.]*/i,
    /Golden Cross/i,
    /Death Cross/i,
    /MA200 bull regime[^;.]*/i,
    /Above MA200[^;.]*/i,
    /Below MA200[^;.]*/i,
    /Weekly (?:uptrend|downtrend)/i,
    /ADX\s+[\d.]+[^;.]*/i,
    /Supertrend[^;.]*/i,
    /EPS [+\-]?\d+%/i,
    /Revenue [+\-]?\d+%/i,
    /Fade short[^;.]*/i,
    /Strict short[^;.]*/i
  ];
  patterns.forEach((p) => {
    const m = t.match(p);
    if (m) push(m[0]);
  });
  t.split(';').forEach((chunk) => {
    const c = chunk.trim();
    if (!c || /^(Buy|Sell) @/i.test(c) || /TP1 |^SL |RR |R:R /.test(c)) return;
    if (c.length > 6 && c.length < 140) push(c);
  });
  return out;
}

function walkAwayLine(hz, isSell, regime) {
  if (isSell) {
    if (hz === 'short') {
      return 'Walk away if buying comes back (momentum turns up) or the spike just dies without follow-through.';
    }
    return 'Walk away if the stock closes back above the 50-day average on a weekly basis, or momentum and buying turn up together.';
  }
  if (hz === 'short') {
    return 'Walk away if the 20-day and 50-day averages both break, or the stock prints four more lower closes — that is a fall, not a dip.';
  }
  if (hz === 'long') {
    return 'Walk away if price closes back below the 200-day average, or yearly earnings growth turns negative.';
  }
  if (regime === 'bull') {
    return 'Walk away if the weekly trend turns down or price closes below the 50-day average.';
  }
  return 'Walk away if it loses the 200-day average or the middle of its recent range on rising volume.';
}

function laymanLevels(isSell, entry, tp1, tp2, sl, levelsText) {
  const e = parseFloat(entry);
  const t1 = parseFloat(tp1);
  const t2 = parseFloat(tp2);
  const stop = parseFloat(sl);
  if (!(e > 0)) {
    return String(levelsText || '').replace(/^Trade:\s*/i, '');
  }
  const verb = isSell ? 'Sell' : 'Buy';
  const parts = [`${verb} at ${e}`];
  if (t1 > 0) parts.push(`first profit at ${t1}${fmtPct(e, t1)}`);
  if (t2 > 0) parts.push(`runner profit at ${t2}${fmtPct(e, t2)}`);
  if (stop > 0) {
    parts.push(`cut the trade at ${stop}${fmtPct(e, stop)}`);
    const risk = Math.abs(e - stop);
    const reward = t1 > 0 ? Math.abs(t1 - e) : 0;
    if (risk > 0 && reward > 0) {
      parts.push(`you stand to make about ${(reward / risk).toFixed(1)}× what you risk`);
    }
  }
  return parts.join('. ') + '.';
}

/**
 * Layman but precise: why we buy/sell, which checks fired, levels, walk-away.
 */
function buildPreciseTradeThesis(opts) {
  opts = opts || {};
  const hz = opts.hz || 'short';
  const isSell = !!opts.isSell;
  const rating = opts.rating || (isSell ? 'Sell' : 'Buy');
  const score = opts.score;
  const regime = opts.regime || '';
  const period = HZ_PERIOD[hz] || hz;
  const mix = HORIZON_BLEND[hz] || HORIZON_BLEND.short;
  const conds = [];
  (opts.conditions || []).concat(harvestConditionsFromWhy(opts.sourceWhy)).forEach((c) => {
    if (c && !conds.includes(c)) conds.push(c);
  });
  const health = companyHealthLine(opts.fmp, opts.fund, opts.row);
  if (!health.length) {
    conds.forEach((c) => {
      if (!isCompanyCondition(c)) return;
      const p = plainEnglishCondition(c);
      if (p && !health.includes(p)) health.push(p);
    });
  }
  const chartBits = [];
  if (regime === 'bull') chartBits.push('the broader trend on this name is still up');
  if (regime === 'bear') chartBits.push('the broader trend on this name is down');
  conds.forEach((c) => {
    if (isCompanyCondition(c) && health.length) return;
    const p = plainEnglishCondition(c);
    if (p && !chartBits.includes(p) && !health.includes(p)) chartBits.push(p);
  });
  const whyHead = isSell ? 'Why sell: ' : 'Why buy: ';
  const why = chartBits.length
    ? whyHead + chartBits.slice(0, 5).join('; ') + '.'
    : whyHead + (isSell
      ? 'The chart and company checks line up for a short on this timeframe.'
      : 'The chart and company checks line up for a dip-buy on this timeframe.');
  const based = 'Based on: the price chart (' + Math.round(mix.technical * 100) + '%)'
    + ', company quality from FMP (' + Math.round(mix.fmp * 100) + '%)'
    + ', and earnings/sales (' + Math.round(mix.fund * 100) + '%)'
    + ` — ${period} view`
    + (score != null && score !== '' ? `, conviction ${score}/100 (${rating})` : ` (${rating})`)
    + '.';
  const company = health.length ? ('Company check: ' + health.join('; ') + '.') : '';
  const levels = laymanLevels(isSell, opts.entry, opts.tp1, opts.tp2, opts.sl, opts.levelsText);
  const trade = levels ? ('Levels: ' + levels) : '';
  const inv = walkAwayLine(hz, isSell, regime);
  return [why, based, company, trade, inv].filter(Boolean).join(' ');
}

function looksGenericReason(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/Why (buy|sell):/i.test(t)) return false;
  if (/^quant signal$/i.test(t) || /^setup note$/i.test(t)) return true;
  if (/levels locked at signal/i.test(t)) return true;
  if (/^Buy @ .+ \| (Strong )?Buy \(\d+\/100\)/i.test(t)) return true;
  if (/^Sell @ .+ \| (Strong )?Sell \(\d+\/100\)/i.test(t)) return true;
  if (/Setup:/.test(t) && /Invalid if/.test(t)) return true;
  if (/TP1 /.test(t) && /SL /.test(t) && !/Why (buy|sell):/i.test(t)) return true;
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
  harvestConditionsFromWhy,
  looksGenericReason,
  plainEnglishCondition
};
