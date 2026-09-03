'use strict';

/**
 * Post-TP1 trailing stop.
 *
 * 1) When TP1 prints, move the original SL by the same % as entry → TP1.
 *    Short: SL comes down. Long: SL goes up.
 * 2) After that, once per session at the cash open: if the open is favorable
 *    vs the prior close by X%, the TSL moves the same X%. An adverse open
 *    leaves the TSL unchanged. Never loosen. Never worse than breakeven.
 */

function tslAfterTp1(input) {
  const entry = Number(input && input.entry);
  const tp1 = Number(input && input.tp1);
  const sl = Number(input && input.sl);
  const isSell = !!(input && input.isSell);
  if (!(entry > 0) || !(tp1 > 0) || !(sl > 0)) return 0;
  const movePct = isSell ? (entry - tp1) / entry : (tp1 - entry) / entry;
  if (!(movePct > 0)) {
    return isSell ? Math.min(sl, entry) : Math.max(sl, entry);
  }
  const shifted = sl * (isSell ? (1 - movePct) : (1 + movePct));
  return isSell
    ? Math.min(shifted, sl, entry)
    : Math.max(shifted, sl, entry);
}

function ratchetTslOnOpen(input) {
  const tsl = Number(input && input.tsl);
  const prevClose = Number(input && input.prevClose);
  const open = Number(input && (input.open != null ? input.open : input.todayOpen));
  const isSell = !!(input && input.isSell);
  const entry = Number(input && input.entry);
  if (!(tsl > 0)) return 0;
  if (!(prevClose > 0) || !(open > 0)) return tsl;
  const movePct = (open - prevClose) / prevClose;
  let next = tsl;
  if (!isSell && movePct > 0) next = tsl * (1 + movePct);
  if (isSell && movePct < 0) next = tsl * (1 + movePct);
  if (entry > 0) {
    next = isSell ? Math.min(next, entry) : Math.max(next, entry);
  }
  return isSell ? Math.min(next, tsl) : Math.max(next, tsl);
}

function ratchetTslFromDailyBar(tsl, prevBar, bar, isSell, entry) {
  const prevClose = prevBar ? Number(prevBar.c) : 0;
  const todayOpen = bar
    ? (Number(bar.o) > 0 ? Number(bar.o) : Number(bar.c))
    : 0;
  const next = ratchetTslOnOpen({ tsl, prevClose, open: todayOpen, isSell, entry });
  return next > 0 ? next : tsl;
}

/** Walk daily bars after TP1 so missed session ratchets are applied once. */
function catchUpTslFromDailyBars(tsl, bars, isSell, entry) {
  let cur = Number(tsl) || 0;
  if (!(cur > 0) || !Array.isArray(bars) || bars.length < 2) return cur;
  for (let i = 1; i < bars.length; i++) {
    const next = ratchetTslFromDailyBar(cur, bars[i - 1], bars[i], isSell, entry);
    if (next > 0) cur = next;
  }
  return cur;
}

/**
 * Choose a catch-up STP that never loosens and never prints through last.
 * If the full daily walk would dump the runner, keep the post-TP1 floor.
 */
function pickLiveTslCatchUp(input) {
  const isSell = !!(input && input.isSell);
  const current = Number(input && input.current) || 0;
  const floorTsl = Number(input && input.floorTsl) || 0;
  const caught = Number(input && input.caught) || 0;
  const lastPx = Number(input && input.lastPx) || 0;
  const better = (a, b) => {
    if (!(a > 0)) return b;
    if (!(b > 0)) return a;
    return isSell ? Math.min(a, b) : Math.max(a, b);
  };
  const through = (px) => lastPx > 0 && px > 0 && (isSell ? lastPx >= px : lastPx <= px);
  const floor = better(current, floorTsl);
  let want = caught > 0 ? better(floor, caught) : floor;
  if (through(want)) {
    want = through(floor) ? 0 : floor;
  }
  return want;
}

module.exports = {
  tslAfterTp1,
  ratchetTslOnOpen,
  ratchetTslFromDailyBar,
  catchUpTslFromDailyBars,
  pickLiveTslCatchUp
};
