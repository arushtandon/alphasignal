'use strict';

/**
 * Analysis only — live trades still bank 50% at TP1 and 50% at TP2
 * (TSL is the backup if TP2 never prints). This walk compares that live
 * method against the same 50% TP1 bank with the runner riding TSL instead
 * of taking TP2, so we can judge whether recommended TP2 levels are right.
 *
 * TSL rules match lib/ibkr/tsl-policy.js:
 *   - At the TP1 print, shift the original SL by the entry→TP1 percent.
 *   - Each later session, a favorable cash open vs prior close moves TSL the
 *     same %. Adverse opens leave it. Never loosen. Never worse than breakeven.
 */

const { tslAfterTp1, ratchetTslFromDailyBar } = require('./tsl-policy');

const TSL_ONLY_ANALYTICS_V = 2; // v2: both methods use exact 50% / 50%
const NOTIONAL = 10000;

function barMs(b) {
  return (b && b.t ? Number(b.t) : 0) * 1000;
}

function retAt(px, entry, isSell) {
  if (!(entry > 0) || !(px > 0)) return 0;
  return isSell ? (entry - px) / entry : (px - entry) / entry;
}

function hitLevel(bar, level, isSell) {
  if (!(level > 0) || !bar) return false;
  return isSell ? Number(bar.l) <= level : Number(bar.h) >= level;
}

function hitTsl(bar, tsl, isSell) {
  if (!(tsl > 0) || !bar) return false;
  return isSell ? Number(bar.h) >= tsl : Number(bar.l) <= tsl;
}

function updatePeak(peak, bar, isSell) {
  if (!bar) return peak;
  const v = isSell ? Number(bar.l) : Number(bar.h);
  if (!(v > 0)) return peak;
  if (peak == null) return v;
  return isSell ? Math.min(peak, v) : Math.max(peak, v);
}

/** Giveback from favorable extreme → ref, as % of the extreme (same as live donation). */
function givebackPct(peak, ref, isSell) {
  if (!(peak > 0) || !(ref > 0)) return null;
  const d = isSell ? (ref - peak) / peak : (peak - ref) / peak;
  return +(Math.max(0, d) * 100).toFixed(2);
}

function roundPx(x) {
  if (x == null || Number.isNaN(Number(x))) return x;
  const n = Number(x);
  const a = Math.abs(n);
  const d = a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return +n.toFixed(d);
}

function dollarFromPct(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return +(Number(pct) / 100 * NOTIONAL).toFixed(0);
}

/**
 * Walk daily bars from the TP1 print. Ignore TP2. Exit only when the ratcheting
 * TSL is tagged (or mark-to-market if history runs out before a hit).
 *
 * @param {object} input
 * @param {Array<{t:number,o:number,h:number,l:number,c:number}>} input.bars
 * @param {number} input.entryMs
 * @param {number} input.entry
 * @param {number} input.tp1
 * @param {number} [input.tp2]
 * @param {number} input.sl  original stop (pre-TP1)
 * @param {boolean} input.isSell
 * @param {number} [input.partialFrac=0.5]  live split: 50% TP1 / 50% runner
 */
function simulateTslOnlyAfterTp1(input) {
  const bars = input && input.bars;
  const entryMs = Number(input && input.entryMs) || 0;
  const entry = Number(input && input.entry);
  const tp1 = Number(input && input.tp1);
  const tp2 = Number(input && input.tp2) || 0;
  const slIn = Number(input && input.sl);
  const isSell = !!(input && input.isSell);
  let partial = Number(input && input.partialFrac);
  if (!(partial >= 0 && partial < 1)) partial = 0.5;
  if (!Array.isArray(bars) || !bars.length || !(entry > 0) || !(tp1 > 0)) return null;

  let tp1Idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (barMs(bars[i]) < entryMs) continue;
    if (hitLevel(bars[i], tp1, isSell)) { tp1Idx = i; break; }
  }
  if (tp1Idx < 0) return null;

  const sl = slIn > 0 ? slIn : entry;
  let tsl = tslAfterTp1({ entry, tp1, sl, isSell });
  if (!(tsl > 0)) tsl = entry;
  tsl = isSell ? Math.min(tsl, entry) : Math.max(tsl, entry);

  const remaining = 1 - partial;
  const realized = partial * retAt(tp1, entry, isSell);
  let peak = updatePeak(null, bars[tp1Idx], isSell);
  let tp2Idx = hitLevel(bars[tp1Idx], tp2, isSell) ? tp1Idx : -1;
  if (tp2Idx >= 0) peak = updatePeak(peak, bars[tp1Idx], isSell);

  const finish = (status, exitIdx, exitPx) => {
    const px = Number(exitPx);
    const tslPnl = realized + remaining * retAt(px, entry, isSell);
    const tslOnlyPnlPct = +(tslPnl * 100).toFixed(2);
    const tslOnlyRunnerPnlPct = +(retAt(px, entry, isSell) * 100).toFixed(2);
    const tp2Printed = tp2Idx >= 0 && tp2 > 0;
    const tp2Pnl = tp2Printed ? realized + remaining * retAt(tp2, entry, isSell) : null;
    const tp2ExitPnlPct = tp2Pnl != null ? +(tp2Pnl * 100).toFixed(2) : null;
    const peakToTp2DonPct = (tp2 > 0 && peak > 0)
      ? givebackPct(peak, tp2, isSell)
      : null;
    const peakToTslDonPct = givebackPct(peak, px, isSell);
    let tp2EarlyDays = null;
    if (tp2Printed && exitIdx != null && exitIdx >= 0 && status === 'tp1_then_sl') {
      tp2EarlyDays = Math.max(0, exitIdx - tp2Idx);
    }
    const tp2VsTslDeltaPct = (tp2ExitPnlPct != null)
      ? +(tslOnlyPnlPct - tp2ExitPnlPct).toFixed(2)
      : null;
    return {
      ok: true,
      tp1Hit: true,
      tp2Printed,
      status,
      tsl: roundPx(tsl),
      exitPx: roundPx(px),
      exitTs: (exitIdx != null && bars[exitIdx]) ? barMs(bars[exitIdx]) : null,
      peakPx: roundPx(peak),
      tp2EarlyDays,
      peakToTp2DonPct,
      peakToTslDonPct,
      tslOnlyPnlPct,
      tslOnlyRunnerPnlPct,
      tp2ExitPnlPct,
      tp2VsTslDeltaPct,
      tslOnlyPnlDollar: dollarFromPct(tslOnlyPnlPct),
      tp2ExitPnlDollar: dollarFromPct(tp2ExitPnlPct)
    };
  };

  // TSL is armed at the TP1 print; fills are checked from the NEXT session
  // (same as the live hybrid path — avoids same-bar TP1/TSL ambiguity).
  for (let j = tp1Idx + 1; j < bars.length; j++) {
    const bar = bars[j];
    tsl = ratchetTslFromDailyBar(tsl, bars[j - 1], bar, isSell, entry);
    if (!(tsl > 0)) tsl = entry;
    tsl = isSell ? Math.min(tsl, entry) : Math.max(tsl, entry);
    peak = updatePeak(peak, bar, isSell);
    if (tp2Idx < 0 && hitLevel(bar, tp2, isSell)) tp2Idx = j;
    if (hitTsl(bar, tsl, isSell)) return finish('tp1_then_sl', j, tsl);
  }

  const last = bars.length - 1;
  const mark = bars[last] && Number(bars[last].c) > 0 ? Number(bars[last].c) : entry;
  return finish('tp1_open', last, mark);
}

const FIELD_SUFFIXES = [
  'TslOnlyV',
  'TslOnlyExitPx',
  'TslOnlyExitTs',
  'TslOnlyStatus',
  'TslOnlyTslPx',
  'TslOnlyPeakPx',
  'TslOnlyPnlPct',
  'TslOnlyPnlDollar',
  'TslOnlyRunnerPnlPct',
  'Tp2ExitPnlPct',
  'Tp2ExitPnlDollar',
  'Tp2VsTslDeltaPct',
  'Tp2EarlyDays',
  'PeakToTp2DonPct',
  'PeakToTslDonPct'
];

/** Flat field map to stamp onto a history row (keys are suffixes; caller prefixes hz). */
function tslOnlyFieldsForTrade(trade, hz, bars, entryMs, isSell) {
  const prefix = hz || 'short';
  const entry = parseFloat(trade[prefix + 'Entry'] || trade.entry || 0);
  const tp1 = parseFloat(trade[prefix + 'Target1'] || trade.target1 || 0);
  const tp2 = parseFloat(trade[prefix + 'Target2'] || trade.target2 || 0);
  const sl = parseFloat(
    trade[prefix + 'StopLoss'] || trade.stopLoss || trade.sellStopLoss || 0
  );
  // Methodology comparison uses the live 50/50 split, not odd-lot floor.
  const sim = simulateTslOnlyAfterTp1({
    bars, entryMs, entry, tp1, tp2, sl, isSell, partialFrac: 0.5
  });
  if (!sim) {
    return { TslOnlyV: TSL_ONLY_ANALYTICS_V };
  }
  return {
    TslOnlyV: TSL_ONLY_ANALYTICS_V,
    TslOnlyExitPx: sim.exitPx,
    TslOnlyExitTs: sim.exitTs,
    TslOnlyStatus: sim.status,
    TslOnlyTslPx: sim.tsl,
    TslOnlyPeakPx: sim.peakPx,
    TslOnlyPnlPct: sim.tslOnlyPnlPct,
    TslOnlyPnlDollar: sim.tslOnlyPnlDollar,
    TslOnlyRunnerPnlPct: sim.tslOnlyRunnerPnlPct,
    Tp2ExitPnlPct: sim.tp2ExitPnlPct,
    Tp2ExitPnlDollar: sim.tp2ExitPnlDollar,
    Tp2VsTslDeltaPct: sim.tp2VsTslDeltaPct,
    Tp2EarlyDays: sim.tp2EarlyDays,
    PeakToTp2DonPct: sim.peakToTp2DonPct,
    PeakToTslDonPct: sim.peakToTslDonPct
  };
}

module.exports = {
  TSL_ONLY_ANALYTICS_V,
  FIELD_SUFFIXES,
  simulateTslOnlyAfterTp1,
  tslOnlyFieldsForTrade,
  givebackPct
};
