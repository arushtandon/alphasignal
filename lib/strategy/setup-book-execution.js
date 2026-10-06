'use strict';

const { SETUPS, rebaseSetupLevels } = require('./evidence-setup-book');

const SETUP_TICKET_USD = 30_000;
const DEFAULT_CAPACITY = Object.freeze({
  JAPAN_MEDIUM_MR: Object.freeze({ priority: 10, maxPositions: 5, maxNlvPct: 1 }),
  JAPAN_SHORT_MR: Object.freeze({ priority: 20, maxPositions: 3, maxNlvPct: 1 }),
  COMMODITIES_MEDIUM_MR: Object.freeze({ priority: 30, maxPositions: 3, maxNlvPct: 1 }),
  JAPAN_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  HK_MEDIUM_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  HK_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  GERMANY_MEDIUM_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  GERMANY_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  FRANCE_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  INDIA_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  COMMODITIES_LONG_ENGINE: Object.freeze({ priority: 40, maxPositions: 3, maxNlvPct: 1 }),
  US_SHORT_MR: Object.freeze({ priority: 50, maxPositions: 2, maxNlvPct: 1 }),
});

const EVIDENCE_TIER = Object.freeze({
  JAPAN_MEDIUM_MR: 1,
  JAPAN_SHORT_MR: 2,
  COMMODITIES_MEDIUM_MR: 2,
});
const EXPERIMENTAL_SETUPS = new Set([
  'UK_LONG_MOMENTUM',
  'FRANCE_LONG_MOMENTUM',
  'JAPAN_LONG_ENGINE',
  'HK_MEDIUM_ENGINE',
  'HK_LONG_ENGINE',
  'GERMANY_MEDIUM_ENGINE',
  'GERMANY_LONG_ENGINE',
  'FRANCE_LONG_ENGINE',
  'INDIA_LONG_ENGINE',
  'COMMODITIES_LONG_ENGINE',
  'US_SHORT_MR',
]);

function evidenceTier(setupId) {
  if (EVIDENCE_TIER[setupId]) return EVIDENCE_TIER[setupId];
  if (EXPERIMENTAL_SETUPS.has(setupId)) return 3;
  return null;
}

function capacityFor(setupId) {
  const tier = evidenceTier(setupId);
  if (tier == null) return null;
  const prefix = `SETUP_CAPACITY_${setupId}`;
  const positions = Number(process.env[`${prefix}_POSITIONS`]);
  const nlvPct = Number(process.env[`${prefix}_NLV_PCT`]);
  return {
    priority: tier * 10,
    tier,
    maxPositions: Number.isFinite(positions) && positions >= 0 ? positions : null,
    maxNlvPct: Number.isFinite(nlvPct) && nlvPct >= 0 ? nlvPct : null,
  };
}

function setupPriority(setupId) {
  return capacityFor(setupId)?.priority ?? 999;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareSetupEntries(left, right) {
  const priority = setupPriority(left?.setupId) - setupPriority(right?.setupId);
  if (priority) return priority;
  const seed = String(left?.signalDate || right?.signalDate || '');
  return hashSeed(`${left?.setupId}|${seed}|${left?.ticker}`)
    - hashSeed(`${right?.setupId}|${seed}|${right?.ticker}`)
    || String(left?.key || '').localeCompare(String(right?.key || ''));
}

function oneLotShape(total) {
  return {
    executable: true,
    oneLotRunner: true,
    fullExit: false,
    targetQuantity: 0,
    runnerQuantity: total,
    initialStopQuantity: total,
    targetStopOca: true,
    runnerStop: 'entry-after-tp1',
  };
}

function setupOrderShape(setupId, totalQuantity, lot = 1) {
  const setup = SETUPS[setupId];
  const total = Number(totalQuantity);
  const step = Math.max(1, Number(lot) || 1);
  if (!setup || !(total > 0)) return null;
  if (setup.kind === 'momentum') {
    return {
      executable: true,
      momentumNoStop: true,
      oneLotRunner: false,
      fullExit: true,
      targetQuantity: total,
      runnerQuantity: 0,
      initialStopQuantity: 0,
      targetStopOca: false,
      runnerStop: null,
    };
  }
  const lots = Math.floor(total / step);
  const singleLot = lots <= 1;
  if (setup.amendedExits && singleLot) return oneLotShape(total);
  if (!setup.partial) {
    return {
      executable: true,
      fullExit: true,
      targetQuantity: total,
      runnerQuantity: 0,
      initialStopQuantity: total,
      targetStopOca: true,
      runnerStop: null,
    };
  }
  const targetQuantity = Math.floor((total / 2) / step) * step;
  if (!(targetQuantity > 0) || !(total - targetQuantity > 0)) {
    if (setup.amendedExits) return oneLotShape(total);
    return { executable: false, reason: 'partial-setup-requires-two-lots' };
  }
  return {
    executable: true,
    fullExit: false,
    targetQuantity,
    runnerQuantity: total - targetQuantity,
    initialStopQuantity: total,
    targetStopOca: false,
    runnerStop: 'entry',
  };
}

function setupFillLevels(setupId, fill, atrValue) {
  return rebaseSetupLevels(setupId, fill, atrValue);
}

const MODEL_SLOTS = 50;
const MODEL_POOL_USD = MODEL_SLOTS * SETUP_TICKET_USD;
const EXCESS_LIQUIDITY_FLOOR = 0.15;
const EXCESS_LIQUIDITY_ALERT = 0.10;

function capitalPoolEnabled() {
  const role = String(process.env.IBKR_BRIDGE_ROLE || '').toLowerCase();
  if (role === 'live' || process.argv.includes('live')) return false;
  return String(process.env.CAPITAL_POOL_ENABLED || '').trim() === '1';
}

function occupiesSlot(row) {
  if (!row || row.closed === true) return false;
  return row.entryFilled === true || row.parentId != null;
}

function rowBook(row) {
  return row?.setupId || 'old-engine';
}

function rowMarket(row) {
  return row?.market || row?.country || row?.contract?.listingCountry || row?.contract?.market || 'Unknown';
}

function capitalSlotPlan(openRows) {
  const open = (openRows || []).filter(occupiesSlot);
  const byBook = {};
  const byMarket = {};
  const positions = [];
  for (const row of open) {
    const book = rowBook(row);
    const market = rowMarket(row);
    byBook[book] = (byBook[book] || 0) + 1;
    byMarket[market] = (byMarket[market] || 0) + 1;
    positions.push({
      ticker: row.ticker || null,
      book,
      market,
      filled: row.entryFilled === true,
    });
  }
  return {
    poolUsd: MODEL_POOL_USD,
    ticketUsd: SETUP_TICKET_USD,
    slots: MODEL_SLOTS,
    open: open.length,
    used: open.length,
    free: Math.max(0, MODEL_SLOTS - open.length),
    over: Math.max(0, open.length - MODEL_SLOTS),
    byBook,
    byMarket,
    positions,
  };
}

function marginDecision(notional, account) {
  const buyingPower = Number(account?.buyingPower);
  const excess = Number(account?.excessLiquidity);
  const nlv = Number(account?.netLiquidation);
  const availableFunds = Number(account?.availableFunds);
  if (!Number.isFinite(buyingPower) || !Number.isFinite(excess) || !(nlv > 0)) {
    return { allowed: false, detail: 'missing-account' };
  }
  if (notional > buyingPower) {
    return { allowed: false, detail: 'buying-power', buyingPower, excess, nlv, availableFunds };
  }
  const fraction = buyingPower > 0 ? Math.min(1, Math.max(0, excess / buyingPower)) : 1;
  const projectedExcess = excess - notional * fraction;
  const floor = EXCESS_LIQUIDITY_FLOOR * nlv;
  if (projectedExcess < floor) {
    return {
      allowed: false,
      detail: 'excess-liquidity-floor',
      projectedExcess,
      floor,
      buyingPower,
      excess,
      nlv,
      availableFunds,
    };
  }
  return {
    allowed: true,
    projectedExcess,
    floor,
    buyingPower,
    excess,
    nlv,
    availableFunds,
    headroomUsd: excess - floor,
  };
}

function evaluateCapitalPool(setupId, openRows, candidateNotionalUsd, account, options = {}) {
  if (!capitalPoolEnabled()) return { applied: false, allowed: true };
  const plan = capitalSlotPlan(openRows);
  const notional = Math.max(0, Number(candidateNotionalUsd) || 0);
  const margin = marginDecision(notional, account);
  if (!margin.allowed) {
    return { applied: true, allowed: false, reason: 'margin', detail: margin.detail, log: 'skipped: margin', plan, margin, notional };
  }
  const ticker = String(options.ticker || '').toUpperCase();
  if (ticker && plan.positions.some(row => String(row.ticker || '').toUpperCase() === ticker)) {
    return { applied: true, allowed: false, reason: 'capacity', detail: 'one-position-per-ticker', log: 'skipped: capacity', plan };
  }
  if (plan.open >= MODEL_SLOTS) {
    return { applied: true, allowed: false, reason: 'capacity', detail: 'gross-cap', log: 'skipped: capacity', plan };
  }
  return { applied: true, allowed: true, plan, margin };
}

function capitalDashboard(openRows, account, skips) {
  const plan = capitalSlotPlan(openRows);
  const excess = Number(account?.excessLiquidity);
  const nlv = Number(account?.netLiquidation);
  const buyingPower = Number(account?.buyingPower);
  const floor = nlv > 0 ? EXCESS_LIQUIDITY_FLOOR * nlv : null;
  return {
    enabled: capitalPoolEnabled(),
    slots: plan.slots,
    used: plan.used,
    free: plan.free,
    over: plan.over,
    poolUsd: plan.poolUsd,
    byBook: plan.byBook,
    byMarket: plan.byMarket,
    positions: plan.positions,
    margin: {
      netLiquidation: Number.isFinite(nlv) ? nlv : null,
      availableFunds: Number.isFinite(Number(account?.availableFunds)) ? Number(account.availableFunds) : null,
      buyingPower: Number.isFinite(buyingPower) ? buyingPower : null,
      excessLiquidity: Number.isFinite(excess) ? excess : null,
      floorPct: EXCESS_LIQUIDITY_FLOOR * 100,
      floorUsd: floor,
      headroomUsd: Number.isFinite(excess) && floor != null ? +(excess - floor).toFixed(2) : null,
      alertPct: EXCESS_LIQUIDITY_ALERT * 100,
      belowAlert: Number.isFinite(excess) && nlv > 0 ? excess < EXCESS_LIQUIDITY_ALERT * nlv : null,
    },
    skips: Array.isArray(skips) ? skips.slice(-50).reverse() : [],
  };
}

function evaluateSetupCapacity(setupId, openRows, candidateNotionalUsd, nlv, options = {}) {
  const capacity = capacityFor(setupId);
  if (!capacity) return { allowed: false, reason: 'unknown-setup' };
  const rows = (openRows || []).filter(row =>
    row && !row.closed && row.setupId === setupId);
  const openNotionalUsd = rows.reduce((sum, row) =>
    sum + Math.max(0, Number(row.setupNotionalUsd || row.riskSizing?.notionalUsd) || 0), 0);
  const candidate = Math.max(0, Number(candidateNotionalUsd) || 0);
  const netLiquidation = Number(nlv);
  if (capacity.maxPositions != null && rows.length >= capacity.maxPositions) {
    return {
      allowed: false,
      reason: 'position-count',
      openPositions: rows.length,
      openNotionalUsd,
      capacity,
    };
  }
  if (capacity.maxNlvPct == null) {
    return {
      allowed: true,
      openPositions: rows.length,
      openNotionalUsd,
      candidateNotionalUsd: candidate,
      capacity,
    };
  }
  if (!(netLiquidation > 0)) {
    return { allowed: false, reason: 'missing-paper-nlv', openPositions: rows.length, capacity };
  }
  if (capacity.maxNlvPct < 1 && openNotionalUsd + candidate > netLiquidation * capacity.maxNlvPct) {
    if (options.minimumLot === true) {
      return {
        allowed: true,
        exceedsTicket: true,
        reason: 'minimum-lot-exceeds-ticket',
        openPositions: rows.length,
        openNotionalUsd,
        candidateNotionalUsd: candidate,
        maxNotionalUsd: netLiquidation * capacity.maxNlvPct,
        capacity,
      };
    }
    return {
      allowed: false,
      reason: 'setup-notional',
      openPositions: rows.length,
      openNotionalUsd,
      candidateNotionalUsd: candidate,
      maxNotionalUsd: netLiquidation * capacity.maxNlvPct,
      capacity,
    };
  }
  return {
    allowed: true,
    openPositions: rows.length,
    openNotionalUsd,
    candidateNotionalUsd: candidate,
    maxNotionalUsd: netLiquidation * capacity.maxNlvPct,
    capacity,
  };
}

module.exports = {
  SETUP_TICKET_USD,
  DEFAULT_CAPACITY,
  capacityFor,
  setupPriority,
  hashSeed,
  compareSetupEntries,
  setupOrderShape,
  setupFillLevels,
  evaluateSetupCapacity,
  MODEL_POOL_USD,
  MODEL_SLOTS,
  capitalPoolEnabled,
  capitalSlotPlan,
  capitalDashboard,
  marginDecision,
  evaluateCapitalPool,
  evidenceTier,
  EXCESS_LIQUIDITY_FLOOR,
  EXCESS_LIQUIDITY_ALERT,
};
