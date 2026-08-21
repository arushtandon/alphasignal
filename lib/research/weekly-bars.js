'use strict';

function weekKeyFromTs(t) {
  const d = new Date((t || 0) * 1000);
  return `${d.getUTCFullYear()}-W${Math.floor((d.getUTCDate() + 6) / 7)}-${d.getUTCMonth()}`;
}

/** Aggregate daily bars into weekly OHLCV. `t` is the week start; `endT` is the last
 *  included daily bar. Callers must treat a week as visible only when `endT` is known. */
function dailyToWeeklyBars(daily) {
  if (!daily || !daily.length) return null;
  const weeks = [];
  let w = null;
  for (const bar of daily) {
    const key = weekKeyFromTs(bar.t);
    if (!w || w.key !== key) {
      if (w) weeks.push(w);
      w = {
        key,
        t: bar.t,
        endT: bar.t,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v || 0
      };
    } else {
      w.h = Math.max(w.h, bar.h);
      w.l = Math.min(w.l, bar.l);
      w.c = bar.c;
      w.v = (w.v || 0) + (bar.v || 0);
      w.endT = bar.t;
    }
  }
  if (w) weeks.push(w);
  return weeks.length >= 10 ? weeks : null;
}

function weeklyBarsVisibleAt(weeklyAll, cutT, dailyThroughCut) {
  const completed = Array.isArray(weeklyAll)
    ? weeklyAll.filter(w => Number(w.endT || w.t || 0) <= Number(cutT || 0))
    : [];
  const rebuilt = dailyToWeeklyBars(dailyThroughCut);
  if (!rebuilt || !rebuilt.length) return completed.length >= 10 ? completed : null;
  const lastCompleted = completed[completed.length - 1];
  const lastRebuilt = rebuilt[rebuilt.length - 1];
  const needsPartial = lastRebuilt && (!lastCompleted || lastCompleted.endT !== lastRebuilt.endT);
  const merged = needsPartial ? completed.concat(lastRebuilt) : completed;
  const out = (merged.length ? merged : rebuilt).slice(-160);
  return out.length >= 10 ? out : rebuilt;
}

module.exports = { weekKeyFromTs, dailyToWeeklyBars, weeklyBarsVisibleAt };
