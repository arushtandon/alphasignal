'use strict';

const EPSILON = 1e-12;

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return number;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return number;
}

function normalizeCounts(winsOrOptions, losses, prior) {
  if (winsOrOptions && typeof winsOrOptions === 'object') {
    const value = winsOrOptions;
    return {
      wins: finiteNonNegative(value.wins == null ? value.successes : value.wins, 'wins'),
      losses: finiteNonNegative(value.losses == null ? value.failures : value.losses, 'losses'),
      alpha: positive(value.alpha == null ? (value.priorAlpha == null ? 1 : value.priorAlpha) : value.alpha, 'alpha'),
      beta: positive(value.beta == null ? (value.priorBeta == null ? 1 : value.priorBeta) : value.beta, 'beta'),
    };
  }
  return {
    wins: finiteNonNegative(winsOrOptions, 'wins'),
    losses: finiteNonNegative(losses, 'losses'),
    alpha: positive(prior && prior.alpha == null ? 1 : prior && prior.alpha, 'alpha'),
    beta: positive(prior && prior.beta == null ? 1 : prior && prior.beta, 'beta'),
  };
}

function betaPosterior(winsOrOptions, losses, prior) {
  const counts = normalizeCounts(winsOrOptions, losses, prior);
  const alpha = counts.alpha + counts.wins;
  const beta = counts.beta + counts.losses;
  return { alpha, beta, mean: alpha / (alpha + beta), wins: counts.wins, losses: counts.losses };
}

function betaPosteriorMean(winsOrOptions, losses, prior) {
  return betaPosterior(winsOrOptions, losses, prior).mean;
}

// Lanczos log-gamma, followed by a continued-fraction incomplete beta. This
// computes an exact beta quantile numerically (to the requested tolerance);
// it does not use the inaccurate normal approximation for small samples.
function logGamma(z) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const shifted = z - 1;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 300;
  const fpMin = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x / (a + 1));
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let term = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + term * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + term / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    result *= d * c;
    term = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + term * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + term / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return result;
}

function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) return factor * betaContinuedFraction(a, b, x) / a;
  return 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

function betaQuantile(probability, alpha, beta, options = {}) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError('probability must be between 0 and 1');
  const a = positive(alpha, 'alpha');
  const b = positive(beta, 'beta');
  if (p === 0 || p === 1) return p;
  const tolerance = positive(options.tolerance == null ? 1e-10 : options.tolerance, 'tolerance');
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200 && high - low > tolerance; i++) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function betaLowerBound(winsOrOptions, losses, priorOrOptions, maybeOptions) {
  let posterior;
  let options;
  if (winsOrOptions && typeof winsOrOptions === 'object') {
    posterior = betaPosterior(winsOrOptions);
    options = winsOrOptions;
  } else {
    posterior = betaPosterior(winsOrOptions, losses, priorOrOptions);
    options = maybeOptions || priorOrOptions || {};
  }
  const credibility = Number(options.credibility == null ? 0.95 : options.credibility);
  if (!Number.isFinite(credibility) || credibility <= 0 || credibility >= 1) {
    throw new RangeError('credibility must be between 0 and 1');
  }
  const tailProbability = options.tailProbability == null ? 1 - credibility : Number(options.tailProbability);
  return betaQuantile(tailProbability, posterior.alpha, posterior.beta, options);
}

function levelCounts(level) {
  if (!level) return null;
  const wins = Number(level.wins == null ? level.successes : level.wins);
  const losses = Number(level.losses == null ? level.failures : level.losses);
  if (!Number.isFinite(wins) || wins < 0 || !Number.isFinite(losses) || losses < 0) return null;
  return { wins, losses, sampleSize: wins + losses };
}

/**
 * Blends global -> region -> geography -> cell evidence into a Beta prior.
 * Each level contributes its observed mean with a capped pseudo-count
 * (`weights`, default 4/6/10/14), so a huge parent sample cannot swamp a cell.
 */
function blendHierarchicalPrior(levels = {}, options = {}) {
  const names = ['global', 'region', 'geography', 'cell'];
  const defaults = { global: 4, region: 6, geography: 10, cell: 14 };
  const weights = { ...defaults, ...(options.weights || options.strengths || {}) };
  let alpha = positive(options.baseAlpha == null ? 1 : options.baseAlpha, 'baseAlpha');
  let beta = positive(options.baseBeta == null ? 1 : options.baseBeta, 'baseBeta');
  const contributions = [];
  for (const name of names) {
    const counts = levelCounts(levels[name]);
    if (!counts || counts.sampleSize === 0) continue;
    const requested = finiteNonNegative(weights[name] == null ? 0 : weights[name], `${name} weight`);
    const strength = Math.min(requested, counts.sampleSize);
    const mean = (counts.wins + alpha) / (counts.sampleSize + alpha + beta);
    alpha += mean * strength;
    beta += (1 - mean) * strength;
    contributions.push({ level: name, mean, strength, sampleSize: counts.sampleSize });
  }
  return { alpha, beta, mean: alpha / (alpha + beta), strength: alpha + beta, contributions };
}

function comparablePoint(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

/**
 * Returns only closed trades known before the signal, then applies a trailing
 * window. Exit equality is excluded deliberately to prevent same-bar leakage.
 */
function trailingClosedTrades(trades, signal, options = {}) {
  const source = Array.isArray(trades) ? trades : [];
  const signalPoint = comparablePoint(
    signal && typeof signal === 'object'
      ? signal.index ?? signal.signalIndex ?? signal.date ?? signal.signalDate ?? signal.ts
      : signal,
  );
  if (signalPoint == null) throw new TypeError('signal index/date is required');
  const exitField = options.exitField;
  const eligible = source.filter((trade) => {
    if (!trade || trade.closed === false || trade.isClosed === false) return false;
    const exit = exitField
      ? trade[exitField]
      : trade.exitIndex ?? trade.exitDate ?? trade.exitTs ?? trade.closedAt;
    if (exit == null) return false;
    return comparablePoint(exit) < signalPoint;
  }).sort((a, b) => {
    const aExit = comparablePoint(exitField ? a[exitField] : a.exitIndex ?? a.exitDate ?? a.exitTs ?? a.closedAt);
    const bExit = comparablePoint(exitField ? b[exitField] : b.exitIndex ?? b.exitDate ?? b.exitTs ?? b.closedAt);
    return aExit < bExit ? -1 : aExit > bExit ? 1 : 0;
  });
  const limit = options.limit == null ? options.window : options.limit;
  if (limit == null) return eligible;
  const size = Math.floor(finiteNonNegative(limit, 'limit'));
  return size === 0 ? [] : eligible.slice(-size);
}

function penalizedSelectionScore(candidate = {}, options = {}) {
  const bound = Number(candidate.lowerBound ?? candidate.bayesianLowerBound ?? candidate.bound ?? 0);
  const expectancy = Number(candidate.expectancy ?? candidate.avgPnl ?? candidate.avgReturn ?? 0);
  const sampleSize = finiteNonNegative(candidate.trades ?? candidate.sampleSize ?? 0, 'sample size');
  const complexity = finiteNonNegative(candidate.complexity ?? candidate.parameters ?? 0, 'complexity');
  const minSample = positive(options.minSample == null ? 30 : options.minSample, 'minSample');
  const complexityPenalty = finiteNonNegative(
    options.complexityPenalty == null ? 0.01 : options.complexityPenalty,
    'complexityPenalty',
  );
  const smallSamplePenalty = finiteNonNegative(
    options.smallSamplePenalty == null ? 0.1 : options.smallSamplePenalty,
    'smallSamplePenalty',
  );
  const expectancyWeight = Number(options.expectancyWeight == null ? 1 : options.expectancyWeight);
  const shortfall = Math.max(0, minSample - sampleSize) / minSample;
  const score = bound + expectancyWeight * expectancy
    - complexityPenalty * complexity
    - smallSamplePenalty * shortfall;
  return {
    score,
    components: {
      bound,
      expectancy: expectancyWeight * expectancy,
      complexityPenalty: complexityPenalty * complexity,
      smallSamplePenalty: smallSamplePenalty * shortfall,
    },
  };
}

module.exports = {
  betaPosterior,
  betaPosteriorMean,
  betaQuantile,
  betaLowerBound,
  conservativeLowerBound: betaLowerBound,
  blendHierarchicalPrior,
  hierarchicalPrior: blendHierarchicalPrior,
  trailingClosedTrades,
  trailingClosedTradeGate: trailingClosedTrades,
  penalizedSelectionScore,
  selectionScore: penalizedSelectionScore,
};
