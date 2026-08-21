'use strict';

const STAGES = Object.freeze(['historical', 'shadow', 'paper', 'canary25', 'canary50', 'full']);
const CAPITAL_SCALE = Object.freeze({
  historical: 0,
  shadow: 0,
  paper: 1,
  canary25: 0.25,
  canary50: 0.5,
  full: 1,
});

function normalizeStage(stage) {
  return STAGES.includes(stage) ? stage : 'paper';
}

function nextStage(stage) {
  const index = STAGES.indexOf(normalizeStage(stage));
  return STAGES[Math.min(STAGES.length - 1, index + 1)];
}

function evaluateStagePromotion(state, evidence) {
  const current = normalizeStage(state && state.stage);
  const target = nextStage(current);
  const checks = {
    canonicalReport: evidence.canonicalReportPass === true,
    reconciliation: evidence.reconciled === true,
    fillIntegrity: Number(evidence.integrityBreaches || 0) === 0,
    drawdown: Number(evidence.drawdownPct || 0) < 10,
  };
  if (target === 'paper') checks.shadowObserved = Number(evidence.shadowDecisions || 0) >= 20;
  if (target === 'canary25') {
    checks.paperSessions = Number(evidence.paperSessions || 0) >= 20;
    checks.paperFills = Number(evidence.paperFills || 0) >= 100;
    checks.shortfallCoverage = Number(evidence.shortfallCoverage || 0) >= 0.8;
    checks.shortfall = evidence.avgShortfallBps != null && evidence.avgShortfallBps !== ''
      && Number.isFinite(Number(evidence.avgShortfallBps))
      && Math.abs(Number(evidence.avgShortfallBps)) <= Number(evidence.modeledShortfallBps || 25);
  }
  if (target === 'canary50' || target === 'full') {
    checks.canarySessions = Number(evidence.canarySessions || 0) >= 10;
    checks.shortfallCoverage = Number(evidence.shortfallCoverage || 0) >= 0.8;
    checks.shortfall = evidence.avgShortfallBps != null && evidence.avgShortfallBps !== ''
      && Number.isFinite(Number(evidence.avgShortfallBps))
      && Math.abs(Number(evidence.avgShortfallBps)) <= Number(evidence.modeledShortfallBps || 25);
  }
  return { allowed: Object.values(checks).every(Boolean), current, target, checks };
}

function revertForIntegrityBreach(state, reason) {
  const current = normalizeStage(state && state.stage);
  if (!['canary25', 'canary50', 'full'].includes(current)) return { ...state, stage: current };
  return {
    ...state,
    stage: 'paper',
    revertedFrom: current,
    revertedAt: new Date().toISOString(),
    revertReason: String(reason || 'integrity-breach')
  };
}

module.exports = {
  STAGES,
  CAPITAL_SCALE,
  normalizeStage,
  nextStage,
  evaluateStagePromotion,
  revertForIntegrityBreach,
};
