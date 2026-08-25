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

module.exports = {
  tslAfterTp1,
  ratchetTslOnOpen,
  ratchetTslFromDailyBar
};
