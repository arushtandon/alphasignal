'use strict';

const {
  setupBookEnabled,
  setupBookPaperExecutionEnabled,
} = require('./feature-flags');
const { SETUPS, CELL_SETUP } = require('./evidence-setup-book');
const { isSetupPaused } = require('./setup-book-runtime');

const MARKETS = [
  'US', 'Japan', 'Hong Kong', 'UK', 'Germany',
  'France', 'India', 'Commodities', 'Crypto',
];
const HORIZONS = ['short', 'medium', 'long'];
const CELLS = Object.freeze(Object.fromEntries(MARKETS.flatMap(market =>
  HORIZONS.map(horizon => {
    const setupId = CELL_SETUP[`${market}|${horizon}|buy`] || null;
    const setup = setupId ? SETUPS[setupId] : null;
    return [`${market}|${horizon}`, setup
      ? {
        verdict: setup.experimental ? 'EXPERIMENTAL' : 'EVIDENCE_BACKED',
        setupId,
        tier: setup.tier,
        paperOnly: true,
      }
      : {
        verdict: 'NO_VALIDATED_SETUP',
        setupId: null,
        paperOnly: false,
      }];
  }),
)));

function cellKey(market, horizon) {
  return `${market}|${horizon}`;
}

function resolveSetupBookCell({ market, horizon, side } = {}) {
  if (!setupBookEnabled()) {
    return { gated: false, recommendability: 'unchanged', setupId: null, verdict: null };
  }
  if (String(side || 'buy').toLowerCase() !== 'buy') {
    return {
      gated: true,
      recommendability: 'none',
      setupId: null,
      verdict: 'NO_RECOMMENDATION',
      reason: 'No validated setup: the evidence-backed setup book is buy-side only.',
    };
  }
  const row = CELLS[cellKey(market, horizon)] || {
    verdict: 'NO_RECOMMENDATION', setupId: null, paperOnly: false,
  };
  if ((row.verdict === 'EVIDENCE_BACKED' || row.verdict === 'EXPERIMENTAL') && row.setupId) {
    if (isSetupPaused(row.setupId)) {
      return {
        gated: true,
        recommendability: 'none',
        setupId: row.setupId,
        verdict: 'PAUSED',
        reason: 'Setup auto-paused; existing positions keep their exits.',
        paperOnly: true,
      };
    }
    return {
      gated: true,
      recommendability: row.verdict === 'EXPERIMENTAL' ? 'experimental' : 'published',
      setupId: row.setupId,
      verdict: row.verdict,
      tier: row.tier,
      paperOnly: true,
      signalsOnly: SETUPS[row.setupId]?.signalsOnly === true,
    };
  }
  return {
    gated: true,
    recommendability: 'none',
    setupId: null,
    verdict: row.verdict,
    reason: 'No validated setup',
  };
}

function ibkrSetupBookAllowed(resolution, options = {}) {
  if (!resolution || resolution.gated !== true) return true;
  const account = String(options.account || process.env.IBKR_ACCOUNT || '');
  const role = String(options.role || process.env.IBKR_BRIDGE_ROLE || 'paper').toLowerCase();
  if (resolution.signalsOnly === true) return false;
  if (resolution.setupId && isSetupPaused(resolution.setupId)) return false;
  return setupBookPaperExecutionEnabled()
    && /^DU/i.test(account)
    && role !== 'live'
    && resolution.paperOnly === true
    && ['published', 'experimental'].includes(resolution.recommendability);
}

module.exports = {
  MARKETS,
  HORIZONS,
  CELLS,
  resolveSetupBookCell,
  ibkrSetupBookAllowed,
};
