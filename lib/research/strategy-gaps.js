'use strict';

const EULER = 0.5772156649015329;

function compound(values) {
  let equity = 1;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    equity *= 1 + value;
  }
  return equity - 1;
}

function maxDrawdown(values) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
  }
  return maxDd;
}

function meanStd(values) {
  const clean = values.filter(value => Number.isFinite(value));
  const n = clean.length;
  if (!n) return { n: 0, mean: null, stdev: null };
  const mean = clean.reduce((sum, value) => sum + value, 0) / n;
  if (n < 2) return { n, mean, stdev: null };
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  return { n, mean, stdev: Math.sqrt(variance) };
}

function tStat(values) {
  const { n, mean, stdev } = meanStd(values);
  if (!(n >= 2) || !(stdev > 0)) return { n, t: null };
  return { n, t: mean / (stdev / Math.sqrt(n)) };
}

function tradeStats(values) {
  const clean = values.filter(value => Number.isFinite(value));
  const gains = clean.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = clean.filter(value => value < 0).reduce((sum, value) => sum + value, 0);
  const wins = clean.filter(value => value > 0).length;
  let pf = null;
  if (clean.length && losses < 0) pf = gains / Math.abs(losses);
  else if (gains > 0) pf = Infinity;
  else if (clean.length) pf = 0;
  return {
    n: clean.length,
    win: clean.length ? wins / clean.length : null,
    pf,
  };
}

function sharpe(values) {
  const { n, mean, stdev } = meanStd(values);
  if (!(stdev > 0)) return { n, sharpe: null };
  return { n, sharpe: mean / stdev };
}

function skewKurt(values) {
  const clean = values.filter(value => Number.isFinite(value));
  const { n, mean, stdev } = meanStd(clean);
  if (!(n >= 4) || !(stdev > 0)) return { skew: 0, kurt: 3 };
  let m3 = 0;
  let m4 = 0;
  for (const value of clean) {
    const z = (value - mean) / stdev;
    m3 += z ** 3;
    m4 += z ** 4;
  }
  return { skew: m3 / n, kurt: m4 / n };
}

function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function normInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  if (!(p > 0 && p < 1)) return null;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function deflatedSharpe(trials, selectedReturns) {
  const sharpes = (trials || []).map(row => row.sharpe).filter(value => Number.isFinite(value));
  const nTrials = sharpes.length;
  const selected = sharpe(selectedReturns || []);
  if (nTrials < 2 || selected.sharpe == null || !(selected.n >= 4)) {
    return { nTrials, probability: null, sharpe: selected.sharpe, annualized: selected.sharpe == null ? null : selected.sharpe * Math.sqrt(12) };
  }
  const trialStd = meanStd(sharpes).stdev;
  const z1 = normInv(1 - 1 / nTrials);
  const z2 = normInv(1 - 1 / (nTrials * Math.E));
  const sr0 = (trialStd || 0) * ((1 - EULER) * z1 + EULER * z2);
  const { skew, kurt } = skewKurt(selectedReturns);
  const denom = 1 - skew * selected.sharpe + ((kurt - 1) / 4) * selected.sharpe ** 2;
  if (!(denom > 0)) return { nTrials, probability: null, sharpe: selected.sharpe, annualized: selected.sharpe * Math.sqrt(12), sr0 };
  const z = (selected.sharpe - sr0) * Math.sqrt(selected.n - 1) / Math.sqrt(denom);
  return {
    nTrials,
    probability: normCdf(z),
    sharpe: selected.sharpe,
    annualized: selected.sharpe * Math.sqrt(12),
    sr0,
  };
}

function invert3(matrix) {
  const rows = matrix.map(row => row.slice());
  const inverse = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    const swapped = rows[col];
    rows[col] = rows[pivot];
    rows[pivot] = swapped;
    const swappedInverse = inverse[col];
    inverse[col] = inverse[pivot];
    inverse[pivot] = swappedInverse;
    const divisor = rows[col][col];
    if (!(Math.abs(divisor) > 1e-14)) return null;
    for (let col2 = 0; col2 < 3; col2 += 1) {
      rows[col][col2] /= divisor;
      inverse[col][col2] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let col2 = 0; col2 < 3; col2 += 1) {
        rows[row][col2] -= factor * rows[col][col2];
        inverse[row][col2] -= factor * inverse[col][col2];
      }
    }
  }
  return inverse;
}

function twoFactor(y, x1, x2) {
  const n = Math.min(y?.length || 0, x1?.length || 0, x2?.length || 0);
  if (n < 6) return null;
  let s1 = 0;
  let s2 = 0;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let index = 0; index < n; index += 1) {
    const a = x1[index];
    const b = x2[index];
    const c = y[index];
    if (![a, b, c].every(Number.isFinite)) return null;
    s1 += a;
    s2 += b;
    s11 += a * a;
    s12 += a * b;
    s22 += b * b;
    t0 += c;
    t1 += a * c;
    t2 += b * c;
  }
  const inverse = invert3([
    [n, s1, s2],
    [s1, s11, s12],
    [s2, s12, s22],
  ]);
  if (!inverse) return null;
  const alpha = inverse[0][0] * t0 + inverse[0][1] * t1 + inverse[0][2] * t2;
  const betaSpy = inverse[1][0] * t0 + inverse[1][1] * t1 + inverse[1][2] * t2;
  const betaQqq = inverse[2][0] * t0 + inverse[2][1] * t1 + inverse[2][2] * t2;
  let sse = 0;
  for (let index = 0; index < n; index += 1) {
    const error = y[index] - alpha - betaSpy * x1[index] - betaQqq * x2[index];
    sse += error * error;
  }
  const variance = sse / (n - 3);
  const standardError = Math.sqrt(Math.max(0, variance) * inverse[0][0]);
  let t = null;
  if (standardError > 0) t = alpha / standardError;
  else if (Math.abs(alpha) > 1e-12) t = Infinity;
  return {
    n,
    alphaMonthly: alpha,
    alphaAnnual: alpha * 12,
    t,
    betaSpy,
    betaQqq,
  };
}

function inWindow(date, fold) {
  return date >= fold.test.from && date <= fold.test.to;
}

function pct(value) {
  return value == null || !Number.isFinite(value) ? null : +(value * 100).toFixed(2);
}

function shortExcessReturn(stockReturn, indexReturn) {
  const stock = Number(stockReturn);
  const index = Number(indexReturn);
  if (!Number.isFinite(stock) || !Number.isFinite(index)) return null;
  // A short earns the opposite of the stock. Shorting the index earns the
  // opposite of the index. Excess is the stock short minus that index short.
  return -stock - (-index);
}

function trialSharpes(cells, options = {}) {
  const trials = [];
  const executableKeys = options.includeExecutableK ? ['k1', 'k2', 'k5'] : [];
  for (const cell of cells || []) {
    if (Number.isFinite(cell?.full?.sharpe)) {
      trials.push({
        sharpe: cell.full.sharpe,
        id: cell.id || `${cell.market}|${cell.variant}|${cell.side || 'long'}`,
        returns: cell.monthlyReturns || [],
      });
    }
    for (const key of executableKeys) {
      const book = cell?.[key];
      if (!Number.isFinite(book?.full?.sharpe)) continue;
      trials.push({
        sharpe: book.full.sharpe,
        id: `${cell.market}|${cell.variant}|${key}`,
        returns: book.monthlyReturns || [],
      });
    }
  }
  return trials;
}

function scoreCell({ monthly, grossMonthly, trades, benchmarkMonthly, daily, folds, tSource, tBasis, emptyWindow }) {
  const months = monthly || [];
  const bench = new Map((benchmarkMonthly || []).map(row => [row.date, row.ret]));
  const benchSeries = months.map(row => bench.has(row.date) ? bench.get(row.date) : 0);
  const gross = grossMonthly || months;
  const windows = (folds || []).map(fold => {
    const slice = months.filter(row => inWindow(row.date, fold));
    const curveValues = (daily || []).filter(row => inWindow(row.date, fold)).map(row => row.ret);
    const used = curveValues.length ? curveValues : slice.map(row => row.ret);
    const windowTrades = (trades || []).filter(row => inWindow(row.date, fold)).map(row => row.ret);
    const stats = tradeStats(windowTrades);
    const benchSlice = slice.map(row => bench.has(row.date) ? bench.get(row.date) : 0);
    return {
      fold: fold.fold,
      from: fold.test.from,
      to: fold.test.to,
      trades: stats.n,
      win: stats.win == null ? null : +(stats.win * 100).toFixed(1),
      pf: stats.pf == null ? null : (stats.pf === Infinity ? null : +stats.pf.toFixed(3)),
      pfInfinite: stats.pf === Infinity,
      returnPct: pct(compound(used.length ? used : slice.map(row => row.ret))),
      maxDrawdownPct: pct(maxDrawdown(used)),
      benchmarkReturnPct: pct(compound(benchSlice)),
    };
  });
  const net = compound(months.map(row => row.ret));
  const grossRet = compound(gross.map(row => row.ret));
  const benchRet = compound(benchSeries);
  const excessValues = months.map((row, index) => row.ret - benchSeries[index]);
  const tValues = tBasis === 'excess'
    ? excessValues
    : (tSource === 'trade' ? (trades || []).map(row => row.ret) : months.map(row => row.ret));
  const t = tStat(tValues);
  const fullStats = tradeStats((trades || []).map(row => row.ret));
  const positiveWindows = windows.filter(row => row.returnPct > 0 && (row.pfInfinite || row.pf >= 1.2) && row.trades > 0);
  const judged = windows.filter(row => row.trades > 0);
  const consistent = emptyWindow === 'neutral'
    ? windows.length === 4 && judged.length > 0 && judged.every(row => row.returnPct > 0)
    : windows.length === 4 && positiveWindows.length === 4;
  const fullBeat = net > 0 && benchRet != null && net > benchRet;
  const tPass = t.n >= 30 && t.t != null && t.t >= 3;
  let verdict = 'FAIL';
  if (emptyWindow === 'neutral') {
    const pf = fullStats.pf === Infinity || fullStats.pf >= 1.2;
    if (consistent && net > 0 && pf && fullStats.n >= 40 && tPass) verdict = 'PASS';
  } else if (fullBeat && consistent && tPass) verdict = 'PASS';
  else if (fullBeat && positiveWindows.length >= 3) verdict = 'CANDIDATE';
  return {
    verdict,
    windows,
    full: {
      returnPct: pct(net),
      grossReturnPct: pct(grossRet),
      costDragPp: pct(grossRet - net),
      maxDrawdownPct: pct(maxDrawdown((daily || months).map(row => row.ret))),
      benchmarkReturnPct: pct(benchRet),
      tStat: t.t == null ? null : +t.t.toFixed(2),
      tN: t.n,
      pf: fullStats.pf == null ? null : (fullStats.pf === Infinity ? null : +fullStats.pf.toFixed(3)),
      pfInfinite: fullStats.pf === Infinity,
      win: fullStats.win == null ? null : +(fullStats.win * 100).toFixed(1),
      trades: fullStats.n,
      sharpe: sharpe(months.map(row => row.ret)).sharpe,
    },
    monthlyReturns: months.map(row => row.ret),
  };
}

module.exports = {
  compound,
  maxDrawdown,
  tStat,
  tradeStats,
  sharpe,
  normInv,
  normCdf,
  deflatedSharpe,
  twoFactor,
  shortExcessReturn,
  trialSharpes,
  scoreCell,
};
