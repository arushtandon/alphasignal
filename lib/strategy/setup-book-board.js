'use strict';

const { evidenceTier } = require('./setup-book-execution');

const BUY_PANES = ['short', 'medium', 'long'];
const SELL_PANES = ['shortSell', 'medSell', 'longSell'];

function isEnginePlan(row) {
  if (!row) return false;
  const kind = row.setupKind || row.kind || '';
  if (kind === 'current_engine') return true;
  return /_ENGINE$/.test(String(row.setupId || ''));
}

/** A mean-reversion (or other non-engine) setup plan that already passed its tested gates. */
function isTestedSetupPlan(row) {
  if (!row || !row.setupId) return false;
  if (isEnginePlan(row)) return false;
  const kind = row.setupKind || row.kind || '';
  if (kind === 'mean_reversion' || kind === 'momentum' || kind === 'tom') return true;
  return kind !== 'current_engine';
}

function tierRank(row) {
  const tier = evidenceTier(row && row.setupId);
  return tier == null ? 9 : tier;
}

function topNEngine(rows, scoreKey, cooldown, normalize, cap) {
  const ratingKey = String(scoreKey || '').replace(/SellScore$/i, '').replace(/Score$/i, '') + 'Rating';
  const sorted = (rows || []).slice().sort((a, b) => {
    const as = /strong/i.test(String(a[ratingKey] || '')) ? 1 : 0;
    const bs = /strong/i.test(String(b[ratingKey] || '')) ? 1 : 0;
    if (bs !== as) return bs - as;
    return (Number(b[scoreKey]) || 0) - (Number(a[scoreKey]) || 0);
  });
  return sorted
    .filter(row => !cooldown.has(normalize(row.ticker)))
    .slice(0, cap)
    .map(row => ({ ...row }));
}

function layoutPane(rows, scoreKey, options) {
  const setup = [];
  const engine = [];
  for (const row of rows || []) {
    if (isTestedSetupPlan(row)) setup.push({ ...row });
    else engine.push(row);
  }
  setup.sort((a, b) => (
    tierRank(a) - tierRank(b)
    || String(a.setupId).localeCompare(String(b.setupId))
    || String(a.ticker).localeCompare(String(b.ticker))
  ));
  const capped = typeof options.capEngine === 'function'
    ? options.capEngine(engine, scoreKey)
    : topNEngine(engine, scoreKey, options.cooldown, options.normalize, options.cap);
  return setup.concat(capped || []);
}

/**
 * Setup-book plans skip the top-5 pane cap and the rotation cooldown.
 * Engine cells keep the cap.
 */
function layoutBoardPanes(assigns, options = {}) {
  const settings = {
    cooldown: options.cooldown || new Set(),
    normalize: options.normalize || (ticker => String(ticker || '').toUpperCase()),
    cap: Number.isFinite(options.cap) ? options.cap : 5,
  };
  const scoreKey = {
    short: 'shortScore',
    medium: 'mediumScore',
    long: 'longScore',
    shortSell: 'shortSellScore',
    medSell: 'mediumSellScore',
    longSell: 'longSellScore',
  };
  const panes = {};
  for (const pane of [...BUY_PANES, ...SELL_PANES]) {
    panes[pane] = layoutPane(assigns[pane], scoreKey[pane], settings);
  }
  return panes;
}

function entryEventsForPanes(panes) {
  const events = [];
  for (const pane of BUY_PANES) {
    for (const row of panes[pane] || []) {
      if (!isTestedSetupPlan(row)) continue;
      const entry = Number(row[pane + 'Entry'] || row.entry);
      const stop = Number(row[pane + 'StopLoss'] || row.stopLoss);
      const action = row[pane + 'Action'] || row.action;
      if (action !== 'Buy' || !(entry > 0) || !(stop > 0)) continue;
      events.push({
        type: 'entry',
        ticker: row.ticker,
        setupId: row.setupId,
        tier: row.setupTier || row.tierLabel || null,
        hz: pane,
        side: 'buy',
        entry,
        sl: stop,
      });
    }
  }
  return events;
}

module.exports = {
  isTestedSetupPlan,
  isEnginePlan,
  layoutBoardPanes,
  entryEventsForPanes,
};
