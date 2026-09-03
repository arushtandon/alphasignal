'use strict';

/**
 * IBKR-equity performance. Dollar move is fill PnL; % and max drawdown use
 * IBKR NetLiquidation (the live account well), never the $1M history book
 * and never peak-PnL as the denominator.
 */

function signOf(pnl, eps = 0.5) {
  if (pnl > eps) return 1;
  if (pnl < -eps) return -1;
  return 0;
}

function ibkrPnlFromEodRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.netPnlUsd != null && Number.isFinite(Number(row.netPnlUsd))) return Number(row.netPnlUsd);
  const real = row.realizedUsd != null ? Number(row.realizedUsd) : null;
  const unrl = row.unrealizedUsd != null ? Number(row.unrealizedUsd) : null;
  if (Number.isFinite(real) && Number.isFinite(unrl)) return real + unrl;
  if (Number.isFinite(real)) return real;
  return null;
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return null;
  return +p.toFixed(Math.abs(p) >= 0.1 ? 2 : 3);
}

function capitalPct(usd, base) {
  if (!(base > 0) || !Number.isFinite(usd)) return null;
  return fmtPct(usd / base * 100);
}

/** Inclusive Mon–Fri UTC dates from startDate through endDate. */
function listWeekdays(startDate, endDate) {
  const out = [];
  const start = Date.parse(String(startDate || '') + 'T00:00:00.000Z');
  const end = Date.parse(String(endDate || '') + 'T00:00:00.000Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += 24 * 3600 * 1000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function looksLikeSyntheticMillion(x) {
  const n = Number(x);
  return Number.isFinite(n) && Math.abs(n - 1_000_000) < 25_000;
}

function isPlausibleIbkrEquity(eq, liveNlv) {
  if (!(eq > 0)) return false;
  if (!(liveNlv > 0)) return eq > 1000;
  if (looksLikeSyntheticMillion(eq) && Math.abs(liveNlv - 1_000_000) > 150_000) return false;
  return eq > liveNlv * 0.5 && eq < liveNlv * 2;
}

/** Persist IBKR NLV high/low from live NetLiquidation. Drop stale $1M book peaks. */
function applyIbkrNlvExtremes(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const nlv = Number(snap.netLiquidation != null ? snap.netLiquidation : snap.currentBalance);
  if (!(nlv > 0)) return snap;
  const at = snap.at || new Date().toISOString();
  let peak = Number(snap.peakNlv);
  let trough = Number(snap.troughNlv);
  const staleBook = looksLikeSyntheticMillion(peak) || looksLikeSyntheticMillion(trough);
  const nlvNotMillion = Math.abs(nlv - 1_000_000) > 150_000;
  if (staleBook && nlvNotMillion) {
    peak = nlv;
    trough = nlv;
    snap.peakNlvAt = at;
    snap.troughNlvAt = at;
    snap.maxDrawdownUsd = 0;
  }
  if (!Number.isFinite(peak) || peak <= 0) { peak = nlv; snap.peakNlvAt = at; }
  if (!Number.isFinite(trough) || trough <= 0) { trough = nlv; snap.troughNlvAt = at; }
  if (nlv > peak) { peak = nlv; snap.peakNlvAt = at; }
  snap.peakNlv = +peak.toFixed(2);
  const bias = Math.max(0, Number(snap.expiredFuturesMarkBiasUsd) || 0);
  if (bias > 0) {
    // Trough / max DD are owned by computeAccountPerformance after the
    // expired-month mark is added back. Do not ratchet a fake NLV hole here.
    return snap;
  }
  if (nlv < trough) { trough = nlv; snap.troughNlvAt = at; }
  snap.troughNlv = +trough.toFixed(2);
  const ddNow = (peak > nlv) ? +(peak - nlv).toFixed(2) : 0;
  let maxDd = Number(snap.maxDrawdownUsd);
  if (!Number.isFinite(maxDd) || maxDd < 0) maxDd = 0;
  if (ddNow > maxDd) maxDd = ddNow;
  snap.maxDrawdownUsd = +maxDd.toFixed(2);
  return snap;
}

function maxDrawdownFromPoints(points) {
  let peak = 0;
  let maxDd = 0;
  for (const p of points || []) {
    const equity = Number(p && p.equity);
    if (!(equity > 0) && equity !== 0) continue;
    if (!peak || equity > peak) peak = equity;
    const dd = +(peak - equity).toFixed(2);
    if (dd > maxDd) maxDd = dd;
  }
  return { maxDdUsd: maxDd, peak };
}

/** Size the leaked expired-month MTM hole (calendar gap, or the extra NLV drop). */
function effectiveExpiredMarkBiasUsd(fillBias, seriesDdClosed, peakNow, liveNlv) {
  const cal = Math.max(0, Number(fillBias) || 0);
  if (!(cal > 0)) return 0;
  const liveDd = (peakNow > 0 && liveNlv > 0) ? Math.max(0, peakNow - liveNlv) : 0;
  const extra = Math.max(0, liveDd - Math.max(0, Number(seriesDdClosed) || 0));
  if (extra > cal * 0.4) {
    return +Math.min(Math.max(cal, extra), cal * 1.5).toFixed(2);
  }
  return +cal.toFixed(2);
}

/** Once NLV gaps by the leaked mark, add it back on that day and after. */
function addBackExpiredMarkHoles(points, bias, fromDate) {
  if (!(bias > 0) || !Array.isArray(points) || points.length < 2) return;
  let armed = false;
  for (let i = 1; i < points.length; i++) {
    if (!armed) {
      if (fromDate && points[i].date < fromDate) continue;
      const drop = Number(points[i - 1].equity) - Number(points[i].equity);
      if (drop >= bias * 0.4) armed = true;
    }
    if (armed) points[i].equity = +(Number(points[i].equity) + bias).toFixed(2);
  }
}

function computeAccountPerformance(input) {
  const liveNlv = Number(input && input.ibkrEquity);
  const currentPnl = Number(input && input.netPnlUsd) || 0;
  const startDate = String((input && input.bookStart) || '').slice(0, 10) || null;
  const startEquity = (liveNlv > 0) ? +(liveNlv - currentPnl).toFixed(2) : null;

  const byDate = new Map();
  if (startDate && startEquity > 0) byDate.set(startDate, startEquity);

  const eodRows = Array.isArray(input && input.eod) ? input.eod : [];
  const hasEodNlv = eodRows.some((row) => {
    const bal = Number(row && row.currentBalance);
    return isPlausibleIbkrEquity(bal, liveNlv > 0 ? liveNlv : bal);
  });

  // Fill-PnL daily cum is a different well than IBKR NLV. Mixing them after the
  // first EOD NLV stamped a fake −$3.7k day on 27 Aug (null EOD + cumUsd) and
  // crushed Sharpe 3 → 0.9. Once we have NLV snapshots, fill-forward those.
  if (startEquity > 0 && !hasEodNlv) {
    for (const row of (Array.isArray(input && input.daily) ? input.daily : [])) {
      const date = String(row && row.date || '').slice(0, 10);
      const cum = Number(row && row.cumUsd);
      if (!date || !Number.isFinite(cum)) continue;
      byDate.set(date, +(startEquity + cum).toFixed(2));
    }
  }

  for (const row of eodRows) {
    const date = String(row && row.date || '').slice(0, 10);
    if (!date) continue;
    const bal = Number(row && row.currentBalance);
    if (isPlausibleIbkrEquity(bal, liveNlv > 0 ? liveNlv : bal)) {
      byDate.set(date, +bal.toFixed(2));
      continue;
    }
    if (hasEodNlv) continue;
    const pnl = ibkrPnlFromEodRow(row);
    if (startEquity > 0 && Number.isFinite(pnl) && !byDate.has(date)) {
      byDate.set(date, +(startEquity + pnl).toFixed(2));
    }
  }

  const snapPeak = Number(input && input.peakIbkrEquity);
  const snapTrough = Number(input && input.troughIbkrEquity);
  const snapPeakAt = String((input && input.peakIbkrEquityAt) || '').slice(0, 10) || null;
  const snapTroughAt = String((input && input.troughIbkrEquityAt) || '').slice(0, 10) || null;
  // Peak/trough are drawdown markers only. Stamping peak NLV onto the start
  // date made Sharpe start at the high-water mark while fill PnL was still
  // positive (468k peak on 6 Aug → Sharpe −0.8 with the book +$4k).

  const dates = [...byDate.keys()].sort();
  const points = dates.map(date => ({ date, equity: +Number(byDate.get(date)).toFixed(2) }));
  const today = String((input && input.today) || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const todayEq = liveNlv > 0 ? +liveNlv.toFixed(2)
    : (startEquity > 0 ? +(startEquity + currentPnl).toFixed(2) : null);
  const last = points[points.length - 1];
  if (todayEq != null) {
    if (!last || last.date !== today) points.push({ date: today, equity: todayEq });
    else last.equity = todayEq;
  }
  for (const p of points) {
    p.pnl = startEquity > 0 ? +(p.equity - startEquity).toFixed(2) : null;
  }

  const asOf = String((input && input.asOf) || today).slice(0, 10);
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && asOf >= startDate) {
    const weekdays = listWeekdays(startDate, asOf);
    let lastEq = startEquity > 0 ? startEquity : (points[0] && points[0].equity);
    const byEq = new Map(points.map(p => [p.date, p.equity]));
    const filled = [];
    for (const d of weekdays) {
      if (byEq.has(d)) lastEq = byEq.get(d);
      if (!(lastEq > 0) && lastEq !== 0) continue;
      filled.push({
        date: d,
        equity: +Number(lastEq).toFixed(2),
        pnl: startEquity > 0 ? +(lastEq - startEquity).toFixed(2) : null
      });
    }
    if (filled.length) {
      points.length = 0;
      for (const p of filled) points.push(p);
    }
  }

  const fillBias = Math.max(0, Number(input && input.expiredFuturesMarkBiasUsd) || 0);
  const biasFrom = String((input && input.expiredFuturesMarkBiasFrom) || '').slice(0, 10) || null;
  let markBiasUsd = 0;
  if (fillBias > 0) {
    const closedPts = points.filter((p) => p.date !== today);
    const closedDd = maxDrawdownFromPoints(closedPts).maxDdUsd;
    let peakNow = maxDrawdownFromPoints(points).peak;
    if (isPlausibleIbkrEquity(snapPeak, liveNlv > 0 ? liveNlv : snapPeak) && snapPeak > peakNow) {
      peakNow = snapPeak;
    }
    markBiasUsd = effectiveExpiredMarkBiasUsd(fillBias, closedDd, peakNow, liveNlv);
    addBackExpiredMarkHoles(points, markBiasUsd, biasFrom);
    for (const p of points) {
      p.pnl = startEquity > 0 ? +(p.equity - startEquity).toFixed(2) : null;
    }
  }

  let peakAccount = points.length ? points[0].equity : (liveNlv > 0 ? liveNlv : 0);
  let troughAccount = peakAccount;
  let peakAt = points.length ? points[0].date : startDate;
  let troughAt = peakAt;
  let runningPeak = peakAccount;
  let maxDdUsd = 0;
  let maxDdPeak = peakAccount;
  let maxDdTrough = peakAccount;
  for (const p of points) {
    const equity = p.equity;
    if (equity > peakAccount) { peakAccount = equity; peakAt = p.date; }
    if (equity < troughAccount) { troughAccount = equity; troughAt = p.date; }
    if (equity > runningPeak) runningPeak = equity;
    const dd = +(runningPeak - equity).toFixed(2);
    if (dd > maxDdUsd) {
      maxDdUsd = dd;
      maxDdPeak = runningPeak;
      maxDdTrough = equity;
    }
  }
  if (isPlausibleIbkrEquity(snapPeak, liveNlv > 0 ? liveNlv : snapPeak) && snapPeak > peakAccount) {
    peakAccount = +snapPeak.toFixed(2);
    peakAt = snapPeakAt || peakAt;
  }
  if (isPlausibleIbkrEquity(snapTrough, liveNlv > 0 ? liveNlv : snapTrough)) {
    const troughAdj = markBiasUsd > 0 ? snapTrough + markBiasUsd : snapTrough;
    if (troughAdj < troughAccount) {
      troughAccount = +troughAdj.toFixed(2);
      troughAt = snapTroughAt || troughAt;
      const fromPeak = +(peakAccount - troughAccount).toFixed(2);
      if (fromPeak > maxDdUsd) {
        maxDdUsd = fromPeak;
        maxDdPeak = peakAccount;
        maxDdTrough = troughAccount;
      }
    }
  }
  let persistedDd = Number(input && input.persistedMaxDrawdownUsd);
  if (markBiasUsd > 0 && Number.isFinite(persistedDd)) {
    persistedDd = Math.max(0, persistedDd - markBiasUsd);
  }
  if (Number.isFinite(persistedDd) && persistedDd > maxDdUsd) {
    maxDdUsd = +persistedDd.toFixed(2);
  }

  peakAccount = +peakAccount.toFixed(2);
  troughAccount = +troughAccount.toFixed(2);
  maxDdUsd = +maxDdUsd.toFixed(2);

  const currentAccount = todayEq != null ? todayEq : peakAccount;
  const fromStartUsd = +currentPnl.toFixed(2);
  const denom = startEquity > 0 ? startEquity : (liveNlv > 0 ? liveNlv : null);
  const fromStartPct = capitalPct(fromStartUsd, denom);
  const ddPct = capitalPct(maxDdUsd, maxDdPeak > 0 ? maxDdPeak : peakAccount) || 0;
  const recUsd = +(currentAccount - troughAccount).toFixed(2);
  const recPct = capitalPct(recUsd, troughAccount);
  const peakToTroughUsd = +(peakAccount - troughAccount).toFixed(2);
  const peakToTroughPct = capitalPct(peakToTroughUsd, peakAccount) || 0;
  const currentDdUsd = +Math.max(0, peakAccount - currentAccount).toFixed(2);

  const signFlips = [];
  let prevSign = 0;
  let daysPositive = 0;
  let daysNegative = 0;
  for (const p of points) {
    const pnl = p.pnl;
    if (pnl == null) continue;
    const s = signOf(pnl);
    if (s > 0) daysPositive++;
    else if (s < 0) daysNegative++;
    if (prevSign && s && s !== prevSign) {
      signFlips.push({
        date: p.date,
        from: prevSign > 0 ? 'profit' : 'loss',
        to: s > 0 ? 'profit' : 'loss',
        pnlUsd: pnl,
        pnlPct: capitalPct(pnl, denom),
        moveUsd: pnl,
        movePct: capitalPct(pnl, denom)
      });
    }
    if (s) prevSign = s;
  }

  // Sharpe is a closed-day statistic. Live NLV is still used for the equity
  // tile / drawdown, but treating an intra-day mark as a completed daily
  // return on ~2 weeks of data annualizes noise (2.3 → 1.1 in a few hours).
  const todayHasClosedEod = eodRows.some((row) => {
    const date = String(row && row.date || '').slice(0, 10);
    if (date !== today) return false;
    const bal = Number(row && row.currentBalance);
    if (!isPlausibleIbkrEquity(bal, liveNlv > 0 ? liveNlv : bal)) return false;
    const session = String(row.session || '');
    return session === 'us-post-close' || session === 'closed';
  });
  const sharpePoints = todayHasClosedEod
    ? points
    : points.filter((p) => p.date !== today);

  const dailyPnl = [];
  for (let i = 1; i < sharpePoints.length; i++) {
    dailyPnl.push(sharpePoints[i].equity - sharpePoints[i - 1].equity);
  }
  const dailyReturns = (denom > 0) ? dailyPnl.map(d => d / denom) : [];
  let sharpe = null;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + ((r - mean) ** 2), 0) / (dailyReturns.length - 1);
    const stdev = Math.sqrt(variance);
    if (stdev > 0) sharpe = +(mean / stdev * Math.sqrt(252)).toFixed(3);
  }

  const riskOff = !!(input && (input.riskOff || input.liquidityRiskOff || input.blocked));
  let riskLevel = 'Low';
  if (riskOff) riskLevel = 'Paused';
  else if (ddPct >= 10) riskLevel = 'Elevated';
  // Moderate is account drawdown only. A negative Sharpe on a short sample
  // must not recolor the tile while NLV is still inside the 5% band.
  else if (ddPct >= 5) riskLevel = 'Moderate';

  return {
    source: 'ibkr-equity',
    bookStart: startDate,
    currentEquity: currentAccount,
    fromStartUsd,
    fromStartPct,
    stake: denom,
    peakEquity: peakAccount,
    peakAt,
    troughEquity: troughAccount,
    troughAt,
    drawdownUsd: maxDdUsd,
    drawdownPct: ddPct,
    currentDrawdownUsd: currentDdUsd,
    recoveryFromTroughUsd: recUsd,
    recoveryFromTroughPct: recPct,
    peakToTroughUsd,
    peakToTroughPct,
    maxDdPeak,
    maxDdTrough,
    signFlips,
    daysPositive,
    daysNegative,
    alwaysProfit: daysNegative === 0 && fromStartUsd >= 0,
    alwaysLoss: daysPositive === 0 && fromStartUsd < 0,
    sharpe,
    sharpeDays: dailyReturns.length,
    sharpeSince: startDate,
    sharpeIncludesToday: !!todayHasClosedEod,
    sharpeMethod: 'nlv-daily-annualized',
    riskLevel,
    riskOff,
    pausePct: Number(input && input.pausePct) || 15
  };
}

module.exports = {
  computeAccountPerformance,
  applyIbkrNlvExtremes,
  listWeekdays,
  signOf,
  ibkrPnlFromEodRow,
  effectiveExpiredMarkBiasUsd,
  addBackExpiredMarkHoles
};
