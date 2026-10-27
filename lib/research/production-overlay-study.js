'use strict';

const { summarizeReturns } = require('./performance');
const {
  betaLowerBound,
  blendHierarchicalPrior,
  penalizedSelectionScore,
} = require('./bayesian-expectancy');
const { improvesWinRateAndPnl } = require('./walk-forward-optimizer');

const NOTIONAL_DEFAULT = 10000;

// Frozen before the production-overlay run. These are confirmation layers on
// production-eligible signals; none can manufacture a signal that production
// scoring rejected.
const CANDIDATES = Object.freeze([
  { id: 'production', factors: [] },
  { id: 'mtf', factors: ['mtf'] },
  { id: 'rs10', factors: ['rs10'] },
  { id: 'rs15', factors: ['rs15'] },
  { id: 'rs20', factors: ['rs20'] },
  { id: 'alignment', factors: ['alignment'] },
  { id: 'breadth', factors: ['breadth'] },
  { id: 'adx_vol', factors: ['adxVol'] },
  { id: 'retest', factors: ['retest'] },
  { id: 'ma_distance', factors: ['maDistance'] },
  { id: 'execution', factors: ['execution'] },
  { id: 'expectancy', factors: ['expectancy'] },
  { id: 'commodity', factors: ['commodity'] },
  { id: 'mtf_rs', factors: ['mtf', 'rs20'] },
  { id: 'mtf_alignment', factors: ['mtf', 'alignment'] },
  { id: 'rs_alignment', factors: ['rs20', 'alignment'] },
  { id: 'rs_breadth', factors: ['rs20', 'breadth'] },
  { id: 'trend_regime', factors: ['alignment', 'breadth', 'adxVol'] },
  { id: 'retest_quality', factors: ['retest', 'maDistance', 'execution'] },
  { id: 'rs_execution', factors: ['rs20', 'maDistance', 'execution'] },
  { id: 'expectancy_rs', factors: ['expectancy', 'rs20'] },
  { id: 'expectancy_quality', factors: ['expectancy', 'maDistance', 'execution'] },
  { id: 'mtf_quality', factors: ['mtf', 'maDistance', 'execution'] },
  { id: 'confirmation_core', factors: ['mtf', 'rs20', 'alignment', 'adxVol'] },
  { id: 'commodity_regime', factors: ['commodity', 'adxVol', 'execution'] },
  { id: 'commodity_expectancy', factors: ['commodity', 'expectancy', 'execution'] },
]);

function inRange(date, range) {
  return date && range && date >= range.from && date <= range.to;
}

function countResults(rows) {
  return {
    wins: rows.filter(row => row.ret > 0).length,
    losses: rows.filter(row => row.ret <= 0).length,
  };
}

function factorPass(candidate, event) {
  const features = event.features || {};
  const sell = event.side === 'sell';
  for (const factor of candidate.factors || []) {
    if (factor === 'expectancy') continue;
    if (factor === 'mtf' && features.mtf !== true) return false;
    if (factor === 'rs10' && !(sell ? features.rsPercentile <= 0.10 : features.rsPercentile >= 0.90)) return false;
    if (factor === 'rs15' && !(sell ? features.rsPercentile <= 0.15 : features.rsPercentile >= 0.85)) return false;
    if (factor === 'rs20' && !(sell ? features.rsPercentile <= 0.20 : features.rsPercentile >= 0.80)) return false;
    if (factor === 'alignment' && features.alignment !== true) return false;
    if (factor === 'breadth' && features.breadth !== true) return false;
    if (factor === 'adxVol' && features.adxVol !== true) return false;
    if (factor === 'retest' && features.retest !== true) return false;
    if (factor === 'maDistance' && features.maDistance !== true) return false;
    if (factor === 'execution' && features.execution !== true) return false;
    if (factor === 'commodity' && features.commodity !== true) return false;
  }
  return true;
}

function expectancyPass(symbolHistory, cellHistory, options = {}) {
  const closed = symbolHistory.slice(-(options.symbolWindow || 100));
  if (closed.length < (options.minSymbolTrades || 5)) return true;
  const prior = blendHierarchicalPrior({
    geography: countResults(cellHistory.slice(-(options.cellWindow || 500))),
    cell: countResults(closed),
  }, {
    baseAlpha: 10,
    baseBeta: 10,
  });
  const lower = betaLowerBound(0, 0, {
    alpha: prior.alpha,
    beta: prior.beta,
    credibility: 0.80,
  });
  const summary = summarizeReturns(closed.map(row => row.ret));
  return lower >= 0.45 && summary.profitFactor >= 1.05 && summary.avgReturnPct > 0;
}

/**
 * Candidate-specific replay. Events are all production-eligible opportunities,
 * including overlaps. This function restores production non-overlap after the
 * candidate filter and only lets trades closed before the signal affect the
 * trailing expectancy gate.
 */
function evaluateCandidate(events, candidate, range, options = {}) {
  const selected = [];
  const blockedUntil = new Map();
  const pending = [];
  const symbolHistory = new Map();
  const cellHistory = [];
  const ordered = (events || []).slice().sort((left, right) =>
    left.entryDate.localeCompare(right.entryDate)
    || left.symbol.localeCompare(right.symbol));

  for (const event of ordered) {
    if (event.entryDate > range.to) break;
    for (let index = pending.length - 1; index >= 0; index--) {
      const trade = pending[index];
      if (trade.exitDate < event.entryDate) {
        pending.splice(index, 1);
        cellHistory.push(trade);
        const history = symbolHistory.get(trade.symbol) || [];
        history.push(trade);
        symbolHistory.set(trade.symbol, history);
      }
    }
    if (!factorPass(candidate, event)) continue;
    const blocked = blockedUntil.get(event.symbol);
    if (blocked && event.entryDate <= blocked) continue;
    if ((candidate.factors || []).includes('expectancy')
      && !expectancyPass(symbolHistory.get(event.symbol) || [], cellHistory, options)) continue;

    const row = { ...event, model: candidate.id };
    blockedUntil.set(event.symbol, event.exitDate);
    pending.push(row);
    if (inRange(event.entryDate, range)) selected.push(row);
  }
  return selected;
}

function metrics(rows, notional = NOTIONAL_DEFAULT) {
  const summary = summarizeReturns((rows || []).map(row => row.ret));
  const wins = (rows || []).filter(row => row.ret > 0).length;
  return {
    trades: summary.trades,
    wins,
    winRate: summary.winRate,
    avgReturnPct: summary.avgReturnPct,
    profitFactor: summary.profitFactor,
    pnlUsd: +((rows || []).reduce((sum, row) => sum + row.ret * notional, 0)).toFixed(2),
    maxDrawdownPct: summary.maxDrawdownPct,
  };
}

function selectionScore(result, factorCount) {
  if (result.trades < 12 || result.pnlUsd <= 0 || result.avgReturnPct <= 0
    || result.profitFactor < 1.3) return -Infinity;
  const lower = betaLowerBound(result.wins, result.trades - result.wins, {
    alpha: 15,
    beta: 15,
    credibility: 0.80,
  });
  return penalizedSelectionScore({
    lowerBound: lower,
    expectancy: result.avgReturnPct / 100,
    trades: result.trades,
    complexity: factorCount,
  }, {
    minSample: 30,
    complexityPenalty: 0.0005,
    smallSamplePenalty: 0.005,
  }).score + 0.02 * Math.log(result.profitFactor);
}

function freezeWinner(choices) {
  const grouped = new Map();
  for (const choice of choices) {
    const current = grouped.get(choice.candidate.id) || {
      candidate: choice.candidate,
      count: 0,
      score: 0,
    };
    current.count++;
    current.score += Number.isFinite(choice.score) ? choice.score : -999;
    grouped.set(choice.candidate.id, current);
  }
  return [...grouped.values()].sort((left, right) =>
    right.count - left.count
    || right.score - left.score
    || left.candidate.id.localeCompare(right.candidate.id))[0]?.candidate
    || CANDIDATES[0];
}

function optimizeCell(events, folds, options = {}) {
  const notional = options.notional || NOTIONAL_DEFAULT;
  const candidates = (options.candidates || CANDIDATES).filter(candidate =>
    options.market === 'Commodities' || !(candidate.factors || []).includes('commodity'));
  const development = [];
  const choices = [];

  for (const fold of folds.slice(0, -1)) {
    const baselineValidation = metrics(
      evaluateCandidate(events, CANDIDATES[0], fold.validation), notional);
    let winner = null;
    for (const candidate of candidates.slice(1)) {
      const candidateRows = evaluateCandidate(events, candidate, fold.validation);
      const candidateMetrics = metrics(candidateRows, notional);
      if (!improvesWinRateAndPnl(candidateMetrics, baselineValidation)) continue;
      const score = selectionScore(candidateMetrics, candidate.factors.length);
      if (!winner || score > winner.score
        || (score === winner.score && candidate.id < winner.candidate.id)) {
        winner = { candidate, score, validation: candidateMetrics };
      }
    }
    winner = winner || {
      candidate: CANDIDATES[0],
      score: -Infinity,
      validation: baselineValidation,
    };
    choices.push(winner);
    const winnerRows = evaluateCandidate(events, winner.candidate, fold.test);
    const baselineRows = evaluateCandidate(events, CANDIDATES[0], fold.test);
    development.push({
      fold: fold.fold,
      model: winner.candidate.id,
      validation: winner.validation,
      test: metrics(winnerRows, notional),
      baseline: metrics(baselineRows, notional),
      rows: winnerRows,
      baselineRows,
    });
  }

  const frozen = freezeWinner(choices);
  const holdoutFold = folds.at(-1);
  const holdoutRows = evaluateCandidate(events, frozen, holdoutFold.test);
  const baselineHoldoutRows = evaluateCandidate(events, CANDIDATES[0], holdoutFold.test);
  const developmentRows = development.flatMap(row => row.rows);
  const baselineDevelopmentRows = development.flatMap(row => row.baselineRows);
  const result = {
    frozenModel: frozen.id,
    factors: frozen.factors,
    development: metrics(developmentRows, notional),
    baselineDevelopment: metrics(baselineDevelopmentRows, notional),
    holdout: metrics(holdoutRows, notional),
    baselineHoldout: metrics(baselineHoldoutRows, notional),
    folds: development.map(({ rows, baselineRows, ...row }) => row),
  };
  const stable = development.filter(row =>
    row.test.pnlUsd > 0 && row.test.profitFactor >= 1.3
    && improvesWinRateAndPnl(row.test, row.baseline)).length >= 2;
  result.checks = {
    nonBaseline: frozen.id !== 'production',
    developmentSample: result.development.trades >= 30,
    holdoutSample: result.holdout.trades >= 30,
    developmentProfitFactor: result.development.profitFactor >= 1.3,
    holdoutProfitFactor: result.holdout.profitFactor >= 1.3,
    positiveDevelopment: result.development.pnlUsd > 0,
    positiveHoldout: result.holdout.pnlUsd > 0,
    improvesDevelopment: improvesWinRateAndPnl(result.development, result.baselineDevelopment),
    improvesHoldout: improvesWinRateAndPnl(result.holdout, result.baselineHoldout),
    stable,
  };
  result.passBeforeMultiplicity = Object.values(result.checks).every(Boolean);
  result.reachesWinRateTarget = result.holdout.winRate >= 65;
  return result;
}

function normalTailPValue(wins, trades, nullRate = 0.5) {
  if (!(trades > 0)) return 1;
  const observed = wins / trades;
  const standardError = Math.sqrt(nullRate * (1 - nullRate) / trades);
  const z = standardError > 0 ? (observed - nullRate) / standardError : 0;
  const sign = z < 0 ? -1 : 1;
  const value = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * value);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-value * value));
  return 0.5 * (1 - erf);
}

function applyMultiplicity(cells, alpha = 0.05) {
  const ranked = cells.map((cell, index) => ({
    index,
    p: normalTailPValue(cell.holdout.wins, cell.holdout.trades),
  })).sort((left, right) => left.p - right.p);
  let largestPassingRank = 0;
  ranked.forEach((row, index) => {
    if (row.p <= alpha * (index + 1) / ranked.length) largestPassingRank = index + 1;
  });
  cells.forEach(cell => {
    cell.multiplicity = { rawP: null, significantAt05: false };
  });
  ranked.forEach((row, index) => {
    const significant = index < largestPassingRank;
    cells[row.index].multiplicity = { rawP: row.p, significantAt05: significant };
    cells[row.index].status = cells[row.index].passBeforeMultiplicity && significant
      ? 'PASS'
      : 'UNSUPPORTED';
  });
  return cells;
}

module.exports = {
  CANDIDATES,
  factorPass,
  expectancyPass,
  evaluateCandidate,
  metrics,
  selectionScore,
  optimizeCell,
  applyMultiplicity,
};
