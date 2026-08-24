'use strict';

/**
 * Paper-book performance from $1M starting capital + fill PnL (not IB NLV).
 * Sign flips = cumulative PnL crossing from profit to loss or the reverse.
 */

function signOf(pnl, eps = 0.5) {
  if (pnl > eps) return 1;
  if (pnl < -eps) return -1;
  return 0;
}

function computeAccountPerformance(input) {
  const start = Number(input && input.startingCapital) || 0;
  const startDate = String((input && input.bookStart) || '').slice(0, 10) || null;
  const netPnl = Number(input && input.netPnlUsd) || 0;
  const currentEq = Number(input && input.bookEquity);
  const equity = Number.isFinite(currentEq) ? currentEq : start + netPnl;
  const peak = Number(input && input.peakBookEquity);
  const trough = Number(input && input.troughBookEquity);
  const peakEq = Number.isFinite(peak) ? Math.max(peak, equity, start) : Math.max(equity, start);
  const troughEq = Number.isFinite(trough) ? Math.min(trough, equity, start) : Math.min(equity, start);

  const fromStartUsd = +(equity - start).toFixed(2);
  const fromStartPct = start > 0 ? +((equity - start) / start * 100).toFixed(2) : null;
  const ddUsd = +(peakEq - equity).toFixed(2);
  const ddPct = peakEq > 0 ? +((peakEq - equity) / peakEq * 100).toFixed(2) : 0;
  const recUsd = +(equity - troughEq).toFixed(2);
  const recPct = troughEq > 0 ? +((equity - troughEq) / troughEq * 100).toFixed(2) : null;
  const peakToTroughUsd = +(peakEq - troughEq).toFixed(2);
  const peakToTroughPct = peakEq > 0 ? +((peakEq - troughEq) / peakEq * 100).toFixed(2) : 0;

  const points = [];
  const eod = Array.isArray(input && input.eod) ? input.eod : [];
  if (eod.length) {
    for (const row of eod) {
      const date = String(row && row.date || '').slice(0, 10);
      if (!date) continue;
      let eq = null;
      if (row.bookEquity != null && Number.isFinite(Number(row.bookEquity))) eq = Number(row.bookEquity);
      else if (row.netPnlUsd != null && Number.isFinite(Number(row.netPnlUsd))) eq = start + Number(row.netPnlUsd);
      else if (row.currentBalance != null && Number.isFinite(Number(row.currentBalance))
        && Math.abs(Number(row.currentBalance) - start) < start * 0.5) {
        eq = Number(row.currentBalance);
      }
      if (!(eq > 0)) continue;
      points.push({ date, equity: eq, pnl: +(eq - start).toFixed(2) });
    }
  }
  if (!points.length) {
    for (const row of (Array.isArray(input && input.daily) ? input.daily : [])) {
      const date = String(row && row.date || '').slice(0, 10);
      if (!date) continue;
      const cum = Number(row.cumUsd);
      if (!Number.isFinite(cum)) continue;
      points.push({ date, equity: start + cum, pnl: +cum.toFixed(2) });
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const last = points[points.length - 1];
  if (!last || last.date !== today) {
    points.push({ date: today, equity, pnl: fromStartUsd });
  } else {
    last.equity = equity;
    last.pnl = fromStartUsd;
  }

  const signFlips = [];
  let prevSign = 0;
  let daysPositive = 0;
  let daysNegative = 0;
  for (const p of points) {
    const s = signOf(p.pnl);
    if (s > 0) daysPositive++;
    else if (s < 0) daysNegative++;
    if (prevSign && s && s !== prevSign) {
      signFlips.push({
        date: p.date,
        from: prevSign > 0 ? 'profit' : 'loss',
        to: s > 0 ? 'profit' : 'loss',
        pnlUsd: p.pnl,
        pnlPct: start > 0 ? +(p.pnl / start * 100).toFixed(2) : null,
        moveUsd: p.pnl,
        movePct: start > 0 ? +(p.pnl / start * 100).toFixed(2) : null
      });
    }
    if (s) prevSign = s;
  }

  const dailyReturns = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].equity;
    const cur = points[i].equity;
    if (prev > 0 && Number.isFinite(cur)) dailyReturns.push((cur - prev) / prev);
  }
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
  else if (ddPct >= 5 || (sharpe != null && sharpe < 0)) riskLevel = 'Moderate';

  return {
    startingCapital: start,
    bookStart: startDate,
    currentEquity: +equity.toFixed(2),
    fromStartUsd,
    fromStartPct,
    peakEquity: +peakEq.toFixed(2),
    peakAt: (input && input.peakBookEquityAt) || null,
    troughEquity: +troughEq.toFixed(2),
    troughAt: (input && input.troughBookEquityAt) || null,
    drawdownUsd: ddUsd,
    drawdownPct: ddPct,
    recoveryFromTroughUsd: recUsd,
    recoveryFromTroughPct: recPct,
    peakToTroughUsd,
    peakToTroughPct,
    signFlips,
    daysPositive,
    daysNegative,
    alwaysProfit: daysNegative === 0 && fromStartUsd >= 0,
    alwaysLoss: daysPositive === 0 && fromStartUsd < 0,
    sharpe,
    sharpeDays: dailyReturns.length,
    riskLevel,
    riskOff,
    pausePct: Number(input && input.pausePct) || 15
  };
}

module.exports = { computeAccountPerformance, signOf };
