'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  deriveActionRating,
  evaluateSignalDecision,
  createDecisionSnapshot
} = require('../lib/strategy/decision-engine');
const { applyCosts } = require('../lib/research/cost-model');
const { summarizeReturns, summarizeDatedPortfolio, promotionDecision } = require('../lib/research/performance');
const { calculateRiskSize, drawdownRiskMultiplier } = require('../lib/risk/sizing');
const { evaluatePortfolioAddition } = require('../lib/risk/portfolio');
const { atomicWriteJsonSync } = require('../lib/storage/atomic-json');
const { BridgeSqliteStore } = require('../lib/storage/bridge-sqlite');
const { evaluateStagePromotion, revertForIntegrityBreach } = require('../lib/risk/promotion');

test('canonical decision engine applies one score/confidence/RR policy', () => {
  assert.deepEqual(deriveActionRating(78, 10), { action: 'Buy', rating: 'Strong Buy' });
  assert.deepEqual(deriveActionRating(10, 74), { action: 'Sell', rating: 'Strong Sell' });
  const accepted = evaluateSignalDecision({
    signal: { buyScore: 70, sellScore: 20, winRateHint: 65 },
    entry: 100, stop: 95, target: 107, requireLevels: true
  });
  assert.equal(accepted.eligible, true);
  const rejected = evaluateSignalDecision({
    signal: { buyScore: 70, sellScore: 20, winRateHint: 60 },
    entry: 100, stop: 95, target: 104, requireLevels: true
  });
  assert.equal(rejected.eligible, false);
  assert.deepEqual(rejected.rejectionReasons.sort(), ['confidence', 'rewardRisk']);
});

test('Strong Sell is tradable even when plain sells are disabled', () => {
  const { sellRecommendationAllowed } = require('../lib/strategy/decision-engine');
  assert.equal(sellRecommendationAllowed('Sell', 62, false), false);
  assert.equal(sellRecommendationAllowed('Strong Sell', 74, false), true);
  assert.equal(sellRecommendationAllowed('Sell', 80, false), true);
  assert.equal(sellRecommendationAllowed('Sell', 62, true), true);
});

test('decision snapshots are deterministic and versioned', () => {
  const input = {
    ticker: 'AAPL', horizon: 'short', asOf: '2026-08-20T00:00:00.000Z',
    signal: { buyScore: 70, sellScore: 10, winRateHint: 65 },
    entry: 100, stop: 95, target: 107
  };
  assert.deepEqual(createDecisionSnapshot(input), createDecisionSnapshot(input));
});

test('cost model reduces gross expectancy', () => {
  const result = applyCosts(0.02, { symbol: 'AAPL', side: 'buy', holdDays: 5 });
  assert.ok(result.costPct > 0);
  assert.ok(result.netReturn < result.grossReturn);
});

test('risk sizing respects NLV, stop, notional, lot, and drawdown', () => {
  const sized = calculateRiskSize({ nlv: 1_000_000, entry: 100, stop: 95, advShares: 1_000_000 });
  assert.equal(sized.eligible, true);
  assert.ok(sized.notionalPctNlv <= 0.025);
  assert.ok(sized.riskPctNlv <= 0.003);
  assert.equal(drawdownRiskMultiplier(0.05), 0.5);
  assert.equal(drawdownRiskMultiplier(0.075), 0.25);
  assert.equal(drawdownRiskMultiplier(0.10), 0);
  const future = calculateRiskSize({
    nlv: 100_000, entry: 5, stop: 4.5, multiplier: 25_000, lot: 1, secType: 'FUT'
  });
  assert.equal(future.eligible, false);
  assert.equal(future.reason, 'minimum-contract-exceeds-risk-budget');
});

test('published 1-lot still trades while leftover liquidity stays above 20% NLV', () => {
  const recruit = calculateRiskSize({
    nlv: 467_000, entry: 17155, stop: 14215, fxToUsd: 1 / 150, lot: 100,
    allowMinLot: true, netLiquidityAvailable: 374_000, liquidityFloorPct: 0.20
  });
  assert.equal(recruit.eligible, true);
  assert.equal(recruit.quantity, 100);
  assert.equal(recruit.bindingLimit, 'min-lot-liquidity');

  const brent = calculateRiskSize({
    nlv: 467_000, entry: 86.56, stop: 81.86, multiplier: 1000, lot: 1, secType: 'FUT',
    allowMinLot: true, netLiquidityAvailable: 374_000, liquidityFloorPct: 0.20
  });
  assert.equal(brent.eligible, true);
  assert.equal(brent.quantity, 1);
  assert.equal(brent.bindingLimit, 'min-lot-liquidity');

  const tight = calculateRiskSize({
    nlv: 467_000, entry: 17155, stop: 14215, fxToUsd: 1 / 150, lot: 100,
    allowMinLot: true, netLiquidityAvailable: 90_000, liquidityFloorPct: 0.20
  });
  assert.equal(tight.eligible, false);
  assert.equal(tight.reason, 'minimum-lot-exceeds-risk-budget');
});

test('portfolio gate rejects concentration and total risk breaches', () => {
  const result = evaluatePortfolioAddition({
    nlv: 1_000_000,
    positions: [{ ticker: 'MSFT', side: 'buy', notionalUsd: 90_000, stopRiskUsd: 10_000, sector: 'TECH' }],
    ticker: 'AAPL', side: 'buy', notionalUsd: 25_000, stopRiskUsd: 3_000, sector: 'TECH',
    dailyNewRiskUsd: 0
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('sector'));
});

test('06:00 board caps still allow a new name on an already-full book', () => {
  const { DEFAULT_CAPS } = require('../lib/risk/portfolio');
  const boardCaps = Object.assign({}, DEFAULT_CAPS, {
    grossPct: 1, netAbsPct: 1, sectorPct: 1,
    countryPct: 1, currencyPct: 1, clusterPct: 1
  });
  const result = evaluatePortfolioAddition({
    nlv: 465_000,
    positions: [{
      ticker: 'NVDA', side: 'buy', notionalUsd: 280_000, stopRiskUsd: 2_000,
      country: 'US', currency: 'USD', cluster: 'US'
    }],
    ticker: 'PLTR', side: 'buy', notionalUsd: 11_000, stopRiskUsd: 400,
    country: 'US', currency: 'USD', cluster: 'US',
    dailyNewRiskUsd: 0
  }, boardCaps);
  assert.equal(result.allowed, true);
});

test('performance promotion requires sample, PF, Sharpe, DD, and win rate', () => {
  const returns = Array.from({ length: 120 }, (_, i) => i % 3 === 0 ? -0.004 : 0.008);
  const metrics = summarizeReturns(returns);
  const promotion = promotionDecision(metrics, { side: 'buy', horizon: 'short' });
  assert.equal(promotion.checks.sample, true);
  assert.equal(promotion.checks.winRate, true);
});

test('portfolio drawdown is ordered by exit date, not ticker iteration', () => {
  const trades = [
    { ret: -0.02, exitTs: Date.parse('2026-01-03') },
    { ret: 0.01, exitTs: Date.parse('2026-01-01') },
    { ret: 0.01, exitTs: Date.parse('2026-01-02') }
  ];
  assert.deepEqual(
    summarizeDatedPortfolio(trades),
    summarizeDatedPortfolio(trades.slice().reverse())
  );
});

test('atomic JSON and SQLite WAL survive replay and deduplicate events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-store-'));
  const json = path.join(dir, 'state.json');
  atomicWriteJsonSync(json, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { ok: true });
  const db = new BridgeSqliteStore(path.join(dir, 'bridge.sqlite'));
  db.saveState({ since: 7, byKey: { A: { open: true } } }, 'checksum');
  assert.equal(db.loadState().since, 7);
  assert.equal(db.appendEvent('seq:7', 'entry', { ticker: 'AAPL' }), true);
  assert.equal(db.appendEvent('seq:7', 'entry', { ticker: 'AAPL' }), false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capital promotion is evidence-gated and auto-reverts on integrity breach', () => {
  const evidence = {
    canonicalReportPass: true,
    reconciled: true,
    integrityBreaches: 0,
    drawdownPct: 2,
    paperSessions: 20,
    paperFills: 100,
    avgShortfallBps: 10,
    shortfallCoverage: 0.9,
    modeledShortfallBps: 25
  };
  const result = evaluateStagePromotion({ stage: 'paper' }, evidence);
  assert.equal(result.allowed, true);
  assert.equal(result.target, 'canary25');
  assert.equal(evaluateStagePromotion({ stage: 'paper' }, {
    ...evidence, avgShortfallBps: null, shortfallCoverage: 0
  }).allowed, false);
  const reverted = revertForIntegrityBreach({ stage: 'full' }, 'duplicate-fill');
  assert.equal(reverted.stage, 'paper');
  assert.equal(reverted.revertReason, 'duplicate-fill');
});
