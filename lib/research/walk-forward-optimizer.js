'use strict';

function uniqueSortedDates(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).slice(0, 10)))].sort();
}

function buildDateAlignedFolds(dates, options = {}) {
  const timeline = uniqueSortedDates(dates);
  const folds = Math.max(2, Math.floor(options.folds || 4));
  const trainBars = Math.max(1, Math.floor(options.trainBars || 504));
  const validationBars = Math.max(1, Math.floor(options.validationBars || 126));
  const testBars = Math.max(1, Math.floor(options.testBars || 126));
  const embargoBars = Math.max(0, Math.floor(options.embargoBars || 0));
  const required = trainBars + validationBars + embargoBars + testBars + (folds - 1) * testBars;
  if (timeline.length < required) return [];
  const start = timeline.length - required;
  return Array.from({ length: folds }, (_, foldIndex) => {
    const trainStart = start + foldIndex * testBars;
    const trainEnd = trainStart + trainBars - 1;
    const validationStart = trainEnd + 1;
    const validationEnd = validationStart + validationBars - 1;
    const embargoStart = validationEnd + 1;
    const testStart = embargoStart + embargoBars;
    const testEnd = testStart + testBars - 1;
    return {
      fold: foldIndex + 1,
      finalHoldout: foldIndex === folds - 1,
      train: { from: timeline[trainStart], to: timeline[trainEnd] },
      validation: { from: timeline[validationStart], to: timeline[validationEnd] },
      embargo: embargoBars
        ? { from: timeline[embargoStart], to: timeline[testStart - 1], bars: embargoBars }
        : { from: null, to: null, bars: 0 },
      test: { from: timeline[testStart], to: timeline[testEnd] },
    };
  });
}

function commonTrailingDates(contexts, dateKey) {
  if (!contexts?.length) return [];
  const sets = contexts.map(context => new Set(context.bars.map(dateKey).filter(Boolean)));
  return uniqueSortedDates([...sets[0]].filter(date => sets.every(set => set.has(date))));
}

function assertFoldIsolation(folds) {
  for (const fold of folds) {
    if (!(fold.train.to < fold.validation.from)) {
      throw new Error(`fold ${fold.fold} train/validation overlap`);
    }
    if (!(fold.validation.to < fold.test.from)) {
      throw new Error(`fold ${fold.fold} validation/test overlap`);
    }
    if (fold.embargo.bars > 0
      && !(fold.validation.to < fold.embargo.from && fold.embargo.to < fold.test.from)) {
      throw new Error(`fold ${fold.fold} embargo is not isolated`);
    }
  }
  const finalFold = folds.at(-1);
  if (finalFold && !finalFold.finalHoldout) throw new Error('last fold must be final holdout');
  return true;
}

function chooseCandidate(candidates, evaluate, validationRange) {
  let best = null;
  for (const candidate of candidates) {
    const result = evaluate(candidate, validationRange);
    if (!result || !Number.isFinite(result.score)) continue;
    if (!best || result.score > best.score
      || (result.score === best.score && String(candidate.id) < String(best.candidate.id))) {
      best = { candidate, ...result };
    }
  }
  return best;
}

function improvesWinRateAndPnl(candidate, baseline, options = {}) {
  const allowEqual = options.allowEqual === true;
  const compare = allowEqual
    ? (left, right) => left >= right
    : (left, right) => left > right;
  return Number.isFinite(candidate?.winRate)
    && Number.isFinite(candidate?.pnlUsd)
    && Number.isFinite(baseline?.winRate)
    && Number.isFinite(baseline?.pnlUsd)
    && compare(candidate.winRate, baseline.winRate)
    && compare(candidate.pnlUsd, baseline.pnlUsd);
}

function freezeDevelopmentWinner(choices, fallback) {
  const grouped = new Map();
  for (const choice of choices.filter(Boolean)) {
    const key = choice.candidate.id;
    const current = grouped.get(key) || { candidate: choice.candidate, count: 0, score: 0 };
    current.count += 1;
    current.score += Number.isFinite(choice.score) ? choice.score : 0;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    right.count - left.count
    || right.score - left.score
    || String(left.candidate.id).localeCompare(String(right.candidate.id)))[0]?.candidate
    || fallback;
}

function runNestedSelection(options) {
  const folds = options.folds || [];
  assertFoldIsolation(folds);
  if (folds.length < 2) throw new Error('at least two folds are required');
  const development = [];
  const choices = [];
  for (const fold of folds.slice(0, -1)) {
    const choice = chooseCandidate(options.candidates, options.evaluateValidation, fold.validation)
      || { candidate: options.fallback, score: -Infinity, metrics: null };
    choices.push(choice);
    development.push({
      fold: fold.fold,
      candidate: choice.candidate,
      validation: choice.metrics,
      test: options.evaluateTest(choice.candidate, fold.test),
    });
  }
  const frozen = freezeDevelopmentWinner(choices, options.fallback);
  const holdoutFold = folds.at(-1);
  return {
    development,
    frozen,
    holdout: options.evaluateTest(frozen, holdoutFold.test),
    holdoutFold,
  };
}

module.exports = {
  uniqueSortedDates,
  buildDateAlignedFolds,
  commonTrailingDates,
  assertFoldIsolation,
  chooseCandidate,
  improvesWinRateAndPnl,
  freezeDevelopmentWinner,
  runNestedSelection,
};
