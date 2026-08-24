'use strict';

/**
 * IBKR-trade performance only (fill PnL). Never scale by the $1M history book.
 * Drawdown / Sharpe / % are vs the IBKR PnL high-water, not model equity.
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

function computeAccountPerformance(input) {
  const startDate = String((input && input.bookStart) || '').slice(0, 10) || null;
  const currentPnl = Number(input && input.netPnlUsd) || 0;

  const byDate = new Map();
  for (const row of (Array.isArray(input && input.eod) ? input.eod : [])) {
    const date = String(row && row.date || '').slice(0, 10);
    const pnl = ibkrPnlFromEodRow(row);
    if (!date || !Number.isFinite(pnl)) continue;
    byDate.set(date, pnl);
  }
  if (!byDate.size) {
    for (const row of (Array.isArray(input && input.daily) ? input.daily : [])) {
      const date = String(row && row.date || '').slice(0, 10);
      const cum = Number(row && row.cumUsd);
      if (!date || !Number.isFinite(cum)) continue;
      byDate.set(date, cum);
    }
  }

  const dates = [...byDate.keys()].sort();
  const points = dates.map(date => ({ date, pnl: +Number(byDate.get(date)).toFixed(2) }));
  const today = new Date().toISOString().slice(0, 10);
  const last = points[points.length - 1];
  if (!last || last.date !== today) points.push({ date: today, pnl: +currentPnl.toFixed(2) });
  else last.pnl = +currentPnl.toFixed(2);

  let peakPnl = 0;
  let troughPnl = 0;
  let peakAt = startDate;
  let troughAt = startDate;
  for (const p of points) {
    if (p.pnl > peakPnl) { peakPnl = p.pnl; peakAt = p.date; }
    if (p.pnl < troughPnl) { troughPnl = p.pnl; troughAt = p.date; }
  }
  peakPnl = +peakPnl.toFixed(2);
  troughPnl = +troughPnl.toFixed(2);

  const fromStartUsd = +currentPnl.toFixed(2);
  const stake = Math.max(peakPnl, Math.abs(troughPnl), 1);
  const fromStartPct = +(fromStartUsd / stake * 100).toFixed(2);
  const ddUsd = +Math.max(0, peakPnl - currentPnl).toFixed(2);
  const ddPct = peakPnl > 0 ? +(ddUsd / peakPnl * 100).toFixed(2)
    : (troughPnl < 0 && currentPnl <= troughPnl + 1e-9 ? 100 : 0);
  const recUsd = +(currentPnl - troughPnl).toFixed(2);
  const recPct = Math.abs(troughPnl) > 0 ? +(recUsd / Math.abs(troughPnl) * 100).toFixed(2) : null;
  const peakToTroughUsd = +(peakPnl - troughPnl).toFixed(2);
  const peakToTroughPct = stake > 0 ? +(peakToTroughUsd / stake * 100).toFixed(2) : 0;

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
        pnlPct: +(p.pnl / stake * 100).toFixed(2),
        moveUsd: p.pnl,
        movePct: +(p.pnl / stake * 100).toFixed(2)
      });
    }
    if (s) prevSign = s;
  }

  const dailyPnl = [];
  for (let i = 1; i < points.length; i++) {
    dailyPnl.push(points[i].pnl - points[i - 1].pnl);
  }
  const dailyReturns = dailyPnl.map(d => d / stake);
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
    source: 'ibkr-trades',
    bookStart: startDate,
    currentEquity: fromStartUsd,
    fromStartUsd,
    fromStartPct,
    stake: +stake.toFixed(2),
    peakEquity: peakPnl,
    peakAt,
    troughEquity: troughPnl,
    troughAt,
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

module.exports = { computeAccountPerformance, signOf, ibkrPnlFromEodRow };
