'use strict';

const { summarizeReturns } = require('./performance');

const STUDY_ID = 'consistency-first-all-markets-v1';
const MARKETS = Object.freeze([
  'US', 'Japan', 'Hong Kong', 'UK', 'Germany', 'France',
  'India', 'Commodities', 'Crypto',
]);
const HORIZONS = Object.freeze(['short', 'medium']);
const TREND_HORIZONS = Object.freeze(['medium', 'long']);
const TRIGGERS = Object.freeze([
  'rsi2_lt_5', 'close_below_lower_bb20_2', 'williams_r10_lt_minus_95',
]);
const REGIMES = Object.freeze([
  'none', 'vol_skip_top30', 'vol_skip_top30_and_ma50_flat_or_up',
]);
const STOPS = Object.freeze([1.5, 2, 2.5]);
const TIME_STOPS = Object.freeze({ short: [5, 10], medium: [10, 21] });
const REALISATIONS = Object.freeze([false, true]);
const EMBARGO = Object.freeze({ short: 20, medium: 63, long: 180 });
const FOLD_SPEC = Object.freeze({
  folds: 4, trainBars: 504, validationBars: 126, testBars: 126,
});
const NOTIONAL = 10_000;
const EXPECTED_BH_FAMILY_SIZE = 1982;

function variantId({ part, market, horizon, trigger, regime, stopAtr, timeStopBars, partial, sector }) {
  if (part === 'A') {
    return [
      'A', market, horizon, trigger, regime, `sl${stopAtr}`,
      `t${timeStopBars}`, partial ? 'partial' : 'full',
    ].join('__').replace(/\s+/g, '_');
  }
  if (part === 'B') return `B__${market.replace(/\s+/g, '_')}__${horizon}__sector_${sector ? 'on' : 'off'}`;
  return `C__us__long__${sector}`;
}

function registry() {
  const rows = [];
  for (const market of MARKETS) {
    for (const horizon of HORIZONS) {
      for (const trigger of TRIGGERS) {
        for (const regime of REGIMES) {
          for (const stopAtr of STOPS) {
            for (const timeStopBars of TIME_STOPS[horizon]) {
              for (const partial of REALISATIONS) {
                const row = {
                  part: 'A', market, horizon, side: 'buy', trigger, regime,
                  stopAtr, timeStopBars, partial, target: 'one_atr',
                };
                rows.push({ ...row, id: variantId(row) });
              }
            }
          }
        }
      }
    }
    for (const horizon of TREND_HORIZONS) {
      for (const sector of [false, true]) {
        const row = { part: 'B', market, horizon, side: 'buy', sector };
        rows.push({ ...row, id: variantId(row) });
      }
    }
  }
  rows.push(
    { id: 'C__us__long__old68', part: 'C', market: 'US', horizon: 'long', side: 'buy', universe: 'old68' },
    { id: 'C__us__long__pit_full', part: 'C', market: 'US', horizon: 'long', side: 'buy', universe: 'pit_full' },
  );
  if (rows.length !== EXPECTED_BH_FAMILY_SIZE) {
    throw new Error(`Frozen family drift: expected ${EXPECTED_BH_FAMILY_SIZE}, found ${rows.length}.`);
  }
  return rows;
}

function tradeDate(row) {
  return String(row.signalDate || row.entryDate || '').slice(0, 10);
}

function inRange(row, range) {
  const date = tradeDate(row);
  return date >= range.from && date <= range.to;
}

function nonOverlapping(trades, range) {
  const locked = new Map();
  return (trades || [])
    .filter(row => inRange(row, range))
    .sort((a, b) => tradeDate(a).localeCompare(tradeDate(b))
      || String(a.symbol).localeCompare(String(b.symbol)))
    .filter(row => {
      const symbol = row.symbol || row.ticker;
      const entry = String(row.entryDate || row.signalDate || '');
      const priorExit = locked.get(symbol);
      if (priorExit && entry <= priorExit) return false;
      locked.set(symbol, String(row.exitDate || entry));
      return true;
    });
}

function metric(trades, months = null) {
  const rows = trades || [];
  const summary = summarizeReturns(rows.map(row => row.ret));
  const wins = rows.filter(row => Number(row.ret) > 0);
  const losses = rows.filter(row => Number(row.ret) <= 0);
  const avg = list => list.length
    ? list.reduce((sum, row) => sum + Number(row.ret), 0) / list.length * 100
    : null;
  const avgWinPct = avg(wins);
  const avgLossPct = avg(losses);
  const absLoss = avgLossPct == null ? null : Math.abs(avgLossPct);
  const breakevenWinRate = avgWinPct > 0 && absLoss != null
    ? absLoss / (avgWinPct + absLoss) * 100 : null;
  return {
    ...summary,
    pnlUsd: +(rows.reduce((sum, row) => sum + Number(row.ret) * NOTIONAL, 0)).toFixed(2),
    avgWinPct: avgWinPct == null ? null : +avgWinPct.toFixed(3),
    avgLossPct: avgLossPct == null ? null : +avgLossPct.toFixed(3),
    breakevenWinRate: breakevenWinRate == null ? null : +breakevenWinRate.toFixed(3),
    breakevenMargin: breakevenWinRate == null || summary.winRate == null
      ? null : +(summary.winRate - breakevenWinRate).toFixed(3),
    picksPerMonth: months > 0 ? +(rows.length / months).toFixed(3) : null,
  };
}

function monthsInRange(range) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  return Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + to.getUTCMonth() - from.getUTCMonth() + 1);
}

function scoreVariant(definition, trades, folds, survivorship) {
  const windows = folds.map(fold => {
    const rows = nonOverlapping(trades, fold.test);
    return {
      fold: fold.fold,
      final: fold.finalHoldout === true,
      range: fold.test,
      metrics: metric(rows, monthsInRange(fold.test)),
    };
  });
  const development = windows.filter(row => !row.final);
  const holdout = windows.find(row => row.final);
  const pooledRows = [];
  for (const window of development) {
    pooledRows.push(...nonOverlapping(trades, window.range));
  }
  const pooledMonths = development.reduce((sum, row) => sum + monthsInRange(row.range), 0);
  const consistency = consistencyFields(definition, windows);
  return {
    ...definition,
    survivorship,
    windows,
    pooledDevelopment: metric(pooledRows, pooledMonths),
    finalWindow: { ...holdout, status: 'OVERLAP_RISK' },
    ...consistency,
  };
}

function consistencyFields(definition, windows) {
  const consistent = windows.length === 4 && windows.every(row => {
    const metrics = row.metrics;
    if (!(metrics.pnlUsd > 0)) return false;
    return definition.part === 'A'
      ? Number(metrics.winRate) >= 60
      : Number(metrics.profitFactor) >= 1.2;
  });
  const worstWindowPf = windows.length
    ? Math.min(...windows.map(row => Number(row.metrics.profitFactor) || 0)) : 0;
  const averageLossMagnitude = windows
    .map(row => Math.abs(Number(row.metrics.avgLossPct)))
    .filter(Number.isFinite);
  return {
    consistent,
    worstWindowPf: +worstWindowPf.toFixed(3),
    averageLossMagnitude: averageLossMagnitude.length
      ? +(averageLossMagnitude.reduce((a, b) => a + b, 0) / averageLossMagnitude.length).toFixed(3)
      : null,
  };
}

function rescoreVariant(cell) {
  return { ...cell, ...consistencyFields(cell, cell.windows || []) };
}

function logCombination(n, k) {
  let total = 0;
  for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

function binomialTail(wins, n, probability) {
  if (!n || !(probability > 0 && probability < 1)) return 1;
  let total = 0;
  for (let k = wins; k <= n; k++) {
    total += Math.exp(logCombination(n, k)
      + k * Math.log(probability) + (n - k) * Math.log(1 - probability));
  }
  return Math.min(1, total);
}

function applyBh(cells, alpha = 0.05) {
  for (const cell of cells) {
    const metrics = cell.pooledDevelopment || {};
    const n = Number(metrics.trades) || 0;
    const wins = Math.round(n * (Number(metrics.winRate) || 0) / 100);
    const nullRate = Number(metrics.breakevenWinRate) > 0
      ? Number(metrics.breakevenWinRate) / 100 : 0.5;
    cell.pValue = +binomialTail(wins, n, nullRate).toFixed(8);
  }
  const ordered = cells.slice().sort((a, b) => a.pValue - b.pValue || a.id.localeCompare(b.id));
  let running = 1;
  for (let index = ordered.length - 1; index >= 0; index--) {
    running = Math.min(running, ordered[index].pValue * ordered.length / (index + 1));
    ordered[index].bhQValue = +Math.min(1, running).toFixed(8);
    ordered[index].bhPass = ordered[index].bhQValue <= alpha;
    ordered[index].bhFamilySize = ordered.length;
  }
  return cells;
}

function rankConsistent(cells) {
  return cells.filter(cell => cell.consistent).sort((a, b) =>
    b.worstWindowPf - a.worstWindowPf
    || Number(a.averageLossMagnitude ?? Infinity) - Number(b.averageLossMagnitude ?? Infinity)
    || a.id.localeCompare(b.id));
}

module.exports = {
  STUDY_ID, MARKETS, HORIZONS, TREND_HORIZONS, TRIGGERS, REGIMES, STOPS,
  TIME_STOPS, REALISATIONS, EMBARGO, FOLD_SPEC, EXPECTED_BH_FAMILY_SIZE,
  registry, nonOverlapping, metric, scoreVariant, applyBh, rankConsistent,
  rescoreVariant, monthsInRange,
};
