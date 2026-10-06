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

function capacityFor(setupId) {
  const base = DEFAULT_CAPACITY[setupId];
  if (!base) return null;
  const prefix = `SETUP_CAPACITY_${setupId}`;
  const positions = Number(process.env[`${prefix}_POSITIONS`]);
  const nlvPct = Number(process.env[`${prefix}_NLV_PCT`]);
  return {
    ...base,
    maxPositions: Number.isFinite(positions) && positions >= 0 ? positions : base.maxPositions,
    maxNlvPct: Number.isFinite(nlvPct) && nlvPct >= 0 ? nlvPct : base.maxNlvPct,
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

const MODEL_POOL_USD = 700_000;
const MODEL_SLOTS = Math.floor(MODEL_POOL_USD / SETUP_TICKET_USD);
const DEDICATED_SLOTS = Object.freeze({
  JAPAN_MEDIUM_MR: 5,
  JAPAN_SHORT_MR: 3,
  UK_LONG_MOMENTUM: 6,
  FRANCE_LONG_MOMENTUM: 6,
});
const SHARED_PRIORITY = Object.freeze({
  COMMODITIES_MEDIUM_MR: 30,
  JAPAN_LONG_ENGINE: 40,
  HK_MEDIUM_ENGINE: 40,
  HK_LONG_ENGINE: 40,
  GERMANY_MEDIUM_ENGINE: 40,
  GERMANY_LONG_ENGINE: 40,
  FRANCE_LONG_ENGINE: 40,
  COMMODITIES_LONG_ENGINE: 40,
  US_SHORT_MR: 50,
});
const SHARED_SLOTS = 3;

function capitalPoolEnabled() {
  return String(process.env.CAPITAL_POOL_ENABLED || '').trim() === '1';
}

function openBookRows(rows) {
  return (rows || []).filter(row => row && row.entryFilled === true && row.closed !== true);
}

function capitalSlotPlan(openRows) {
  const open = openBookRows(openRows);
  const counts = {};
  let shared = 0;
  let other = 0;
  for (const row of open) {
    const id = row.setupId || '';
    if (DEDICATED_SLOTS[id] != null) counts[id] = (counts[id] || 0) + 1;
    else if (SHARED_PRIORITY[id] != null) shared += 1;
    else other += 1;
  }
  return {
    poolUsd: MODEL_POOL_USD,
    slots: MODEL_SLOTS,
    open: open.length,
    free: Math.max(0, MODEL_SLOTS - open.length),
    over: Math.max(0, open.length - MODEL_SLOTS),
    dedicated: counts,
    shared,
    sharedSlots: SHARED_SLOTS,
    other,
  };
}

function evaluateCapitalPool(setupId, openRows, candidateNotionalUsd, account) {
  if (!capitalPoolEnabled()) return { applied: false, allowed: true };
  const plan = capitalSlotPlan(openRows);
  const notional = Math.max(0, Number(candidateNotionalUsd) || 0);
  const available = Number(account?.availableFunds);
  const buyingPower = Number(account?.buyingPower);
  const marginRoom = [available, buyingPower].filter(value => Number.isFinite(value) && value >= 0);
  if (!marginRoom.length || notional > Math.min(...marginRoom)) {
    return { applied: true, allowed: false, reason: 'margin', log: 'skipped: margin', plan, notional };
  }
  if (plan.open >= MODEL_SLOTS) {
    return { applied: true, allowed: false, reason: 'gross-cap', log: 'skipped: slots', plan };
  }
  const dedicated = DEDICATED_SLOTS[setupId];
  if (dedicated != null) {
    const used = plan.dedicated[setupId] || 0;
    if (used >= dedicated) {
      return { applied: true, allowed: false, reason: 'group-cap', log: 'skipped: slots', plan, used, dedicated };
    }
  } else if (SHARED_PRIORITY[setupId] != null) {
    if (plan.shared >= SHARED_SLOTS) {
      return { applied: true, allowed: false, reason: 'shared-cap', log: 'skipped: slots', plan };
    }
  }
  return { applied: true, allowed: true, plan };
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
  if (rows.length >= capacity.maxPositions) {
    return {
      allowed: false,
      reason: 'position-count',
      openPositions: rows.length,
      openNotionalUsd,
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
  evaluateCapitalPool,
};
