'use strict';

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function summarizeReturns(rawReturns) {
  const returns = (rawReturns || []).map(Number).filter(Number.isFinite);
  if (!returns.length) {
    return { trades: 0, winRate: null, avgReturnPct: null, profitFactor: null, sharpe: null, maxDrawdownPct: null, cvar95Pct: null };
  }
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
    if (r > 0) grossWin += r;
    else grossLoss += Math.abs(r);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + ((r - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const stdev = Math.sqrt(variance);
  const cutoff = percentile(returns, 0.05);
  const tail = returns.filter(r => r <= cutoff);
  const cvar = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : cutoff;
  return {
    trades: returns.length,
    winRate: +(returns.filter(r => r > 0).length / returns.length * 100).toFixed(1),
    avgReturnPct: +(mean * 100).toFixed(3),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : 99,
    sharpe: stdev > 0 ? +(mean / stdev * Math.sqrt(Math.min(252, returns.length))).toFixed(3) : null,
    maxDrawdownPct: +(maxDd * 100).toFixed(3),
    cvar95Pct: Number.isFinite(cvar) ? +(cvar * 100).toFixed(3) : null,
    compoundedReturnPct: +((equity - 1) * 100).toFixed(3),
  };
}

function summarizeDatedPortfolio(trades) {
  const byDay = new Map();
  for (const trade of trades || []) {
    const ret = Number(trade && trade.ret);
    const exitTs = Number(trade && trade.exitTs);
    if (!Number.isFinite(ret) || !Number.isFinite(exitTs)) continue;
    const day = new Date(exitTs).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ret);
  }
  const dailyReturns = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
  ));
  return { ...summarizeReturns(dailyReturns), days: dailyReturns.length, dailyReturns };
}

function promotionDecision(metrics, opts = {}) {
  const side = opts.side || 'buy';
  const horizon = opts.horizon || 'short';
  const minWinRate = side === 'buy' ? (horizon === 'short' ? 55 : 52) : 50;
  const minTrades = side === 'sell' ? 50 : Number(opts.minTrades || 100);
  const checks = {
    sample: Number(metrics.trades) >= minTrades,
    winRate: Number(metrics.winRate) >= minWinRate,
    expectancy: Number(metrics.avgReturnPct) > 0,
    profitFactor: Number(metrics.profitFactor) >= 1.5,
    sharpe: Number(metrics.sharpe) >= 1.2,
    drawdown: Number(metrics.maxDrawdownPct) <= 10,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    thresholds: { minTrades, minWinRate, minProfitFactor: 1.5, minSharpe: 1.2, maxDrawdownPct: 10 },
  };
}

module.exports = { percentile, summarizeReturns, summarizeDatedPortfolio, promotionDecision };
