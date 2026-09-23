'use strict';

/**
 * One-shot 15 Sep 2026: paper stop-outs were printing then bouncing 1–4%.
 * Push every already-open lot's stop 1.5pts further (never tighter than the
 * new horizon floor) and stretch TP1/TP2 so R:R does not collapse.
 *
 * New board entries already use HORIZON_MIN_PCT 4.0/6.5/9.5 — do not run this
 * on keys dated after Tue Sep 15 2026 or they get the extra 1.5pts twice.
 */

const SL_WIDEN_PCT = 0.015;
const MIN_RR = 1.1;
const STAMP = '2026-09-15';
const CUTOFF_MS = Date.parse('Tue Sep 15 2026 23:59:59 GMT+0800');

const FLOORS = Object.freeze({
  short:  Object.freeze({ sl: 0.040, tp1: 0.044, tp2: 0.070 }),
  medium: Object.freeze({ sl: 0.065, tp1: 0.072, tp2: 0.110 }),
  long:   Object.freeze({ sl: 0.095, tp1: 0.105, tp2: 0.160 })
});

function recDayOnOrBeforeWidenCutoff(key) {
  const day = String(key || '').split('|')[2] || '';
  const t = Date.parse(day);
  if (!Number.isFinite(t)) return true;
  return t <= CUTOFF_MS;
}

function pctAway(entry, px, isSell, asStop) {
  const e = Number(entry);
  const p = Number(px);
  if (!(e > 0) || !(p > 0)) return 0;
  const raw = asStop
    ? (isSell ? (p - e) / e : (e - p) / e)
    : (isSell ? (e - p) / e : (p - e) / e);
  return raw > 0 ? raw : 0;
}

function pxFromPct(entry, pct, isSell, asStop) {
  const e = Number(entry);
  if (!(e > 0) || !(pct > 0)) return 0;
  if (asStop) return isSell ? e * (1 + pct) : e * (1 - pct);
  return isSell ? e * (1 - pct) : e * (1 + pct);
}

function widenOpenExits(input) {
  const entry = Number(input && input.entry);
  const isSell = !!(input && input.isSell);
  const hz = (input && input.hz) || 'short';
  const f = FLOORS[hz] || FLOORS.short;
  if (!(entry > 0)) return null;

  const slIn = Number(input && input.sl) || 0;
  const tp1In = Number(input && input.tp1) || 0;
  const tp2In = Number(input && input.tp2) || 0;

  const slPct = pctAway(entry, slIn, isSell, true);
  const extraWidenPct = input && input.addLegacyWiden === false ? 0 : SL_WIDEN_PCT;
  const newSlPct = Math.max(slPct + extraWidenPct, f.sl);

  const tp1Pct = pctAway(entry, tp1In, isSell, false);
  const tp2Pct = pctAway(entry, tp2In, isSell, false);
  const scale = slPct > 0 ? newSlPct / slPct : 1;

  let newTp1Pct = Math.max(f.tp1, newSlPct * MIN_RR);
  if (tp1Pct > 0) newTp1Pct = Math.max(newTp1Pct, tp1Pct * scale);

  let newTp2Pct = 0;
  if (tp2Pct > 0) {
    newTp2Pct = Math.max(f.tp2, tp2Pct * scale, newTp1Pct * 1.05);
  }

  const sl = pxFromPct(entry, newSlPct, isSell, true);
  const tp1 = newTp1Pct > 0 ? pxFromPct(entry, newTp1Pct, isSell, false) : 0;
  const tp2 = newTp2Pct > 0 ? pxFromPct(entry, newTp2Pct, isSell, false) : 0;

  const changed = (slIn > 0 && Math.abs(sl - slIn) > 1e-8)
    || (tp1In > 0 && tp1 > 0 && Math.abs(tp1 - tp1In) > 1e-8)
    || (tp2In > 0 && tp2 > 0 && Math.abs(tp2 - tp2In) > 1e-8)
    || !(slIn > 0);

  return {
    sl, tp1, tp2,
    slPct: newSlPct, tp1Pct: newTp1Pct, tp2Pct: newTp2Pct,
    changed
  };
}

module.exports = {
  SL_WIDEN_PCT,
  STAMP,
  FLOORS,
  recDayOnOrBeforeWidenCutoff,
  widenOpenExits
};
