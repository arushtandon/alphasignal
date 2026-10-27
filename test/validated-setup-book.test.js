'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  setupRegistry,
  dedupeTrades,
  metricSummary,
  exactBinomialP,
  applyBenjaminiHochberg,
  classifyVerdict,
  rejectionReason,
  bhFamilyManifest,
  assertsFullUniverse,
} = require('../lib/research/validated-setup-book');

function trades(count, wins) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `S${index}`,
    signalDate: `2025-01-${String(index % 28 + 1).padStart(2, '0')}`,
    entryDate: `2025-01-${String(index % 28 + 1).padStart(2, '0')}`,
    ret: index < wins ? 0.02 : -0.01,
  }));
}

test('registry is frozen, complete, and does not silently reintroduce FMP tier variants', () => {
  const registry = setupRegistry();
  assert.equal(registry.length, 37);
  assert.equal(new Set(registry.map(row => row.id)).size, registry.length);
  assert.equal(registry.some(row => /fmp_tier|danelfin/i.test(row.id)), false);
  assert.equal(registry.filter(row => row.control).length, 13);
  assert.equal(registry.filter(row => row.market === 'Japan' && row.kind === 'mean_reversion').length, 12);
  assert.equal(registry.some(row => row.id === 'mr_bb_atr_t21_partial__us__medium__vol30_ma50'), true);
});

test('pooled development rows are counted once', () => {
  const duplicate = { symbol: 'A', signalDate: '2025-01-03', entryDate: '2025-01-04', ret: 0.02 };
  const unique = dedupeTrades([duplicate, { ...duplicate }, {
    symbol: 'B', signalDate: '2025-01-03', entryDate: '2025-01-04', ret: -0.01,
  }], 'setup');
  assert.equal(unique.length, 2);
  assert.equal(metricSummary(unique, 2).trades, 2);
  assert.equal(metricSummary(unique, 2).picksPerMonth, 1);
});

test('one BH family assigns monotonic q values to every registered test', () => {
  const cells = setupRegistry().map((row, index) => ({
    ...row,
    holdoutWinRatePValue: index < 2 ? 0.0001 * (index + 1) : 0.5,
  }));
  applyBenjaminiHochberg(cells);
  assert.equal(cells.every(cell => cell.bhFamilySize === cells.length), true);
  assert.equal(cells.every(cell => Number.isFinite(cell.bhQValue)), true);
  assert.equal(cells[0].bhPass, true);
});

test('large losing samples cannot underflow into a false significant result', () => {
  assert.equal(exactBinomialP(trades(1400, 280)), 1);
  assert.ok(exactBinomialP(trades(1400, 980)) < 0.05);
});

test('overlap-risk holdout can only be candidate, never validated', () => {
  const holdoutRows = trades(40, 30);
  const holdout = metricSummary(holdoutRows, 6);
  const base = {
    holdout,
    stableDevelopmentFolds: 3,
    holdoutWinRatePValue: 0.001,
    beatsControl: true,
    bhPass: true,
  };
  assert.equal(classifyVerdict({ ...base, holdoutStatus: 'OVERLAP_RISK' }), 'CANDIDATE');
  assert.equal(classifyVerdict({ ...base, holdoutStatus: 'CLEAN' }), 'VALIDATED');
});

test('holdout does not define measured confidence', () => {
  const development = metricSummary(trades(40, 24), 6);
  const holdout = metricSummary(trades(40, 36), 6);
  const measuredConfidence = development.winRate;
  assert.equal(measuredConfidence, 60);
  assert.notEqual(measuredConfidence, holdout.winRate);
});

test('BH family manifest lists every registered control and setup exactly once', () => {
  const manifest = bhFamilyManifest();
  const registry = setupRegistry();
  assert.equal(manifest.length, registry.length);
  assert.deepEqual(manifest, registry.map(row => row.id));
  assert.equal(manifest.includes('v0_live__us__medium'), true);
  assert.equal(manifest.some(id => /fmp_tier|danelfin|__v[123]__/.test(id)), false);
});

test('runner source does not silently cap the universe at 80 names', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-validated-setup-book.js'), 'utf8');
  assert.equal(assertsFullUniverse(runner), true);
  assert.match(runner, /Full available cached universe/);
});

test('high-win low-PF holdouts are labelled bleeders, not candidates', () => {
  const holdout = metricSummary(Array.from({ length: 40 }, (_, index) => ({
    symbol: `S${index}`,
    signalDate: `2025-01-${String(index % 28 + 1).padStart(2, '0')}`,
    entryDate: `2025-01-${String(index % 28 + 1).padStart(2, '0')}`,
    ret: index < 28 ? 0.01 : -0.05,
  })), 6);
  assert.ok(holdout.winRate >= 60);
  assert.ok(holdout.profitFactor < 1.3);
  const cell = {
    holdout,
    stableDevelopmentFolds: 3,
    holdoutWinRatePValue: 0.001,
    beatsControl: true,
    bhPass: true,
    holdoutStatus: 'OVERLAP_RISK',
  };
  assert.equal(classifyVerdict(cell), 'REJECTED');
  assert.equal(rejectionReason({ ...cell, verdict: 'REJECTED' }), 'REJECTED_BLEEDER');
});
