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
const DEFAULT_MAX_GROSS_LEVERAGE = 2;
const ACCOUNT_SUMMARY_MAX_AGE_MS = 15 * 60 * 1000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function maxGrossLeverage() {
  const raw = finiteNumber(process.env.MAX_GROSS_LEVERAGE);
  if (raw == null || raw < 0) return DEFAULT_MAX_GROSS_LEVERAGE;
  return raw;
}

function singaporeDayKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function accountReadingFresh(account, now = Date.now()) {
  const ms = Date.parse(account && account.summaryAt);
  if (!Number.isFinite(ms)) return { fresh: false, detail: 'missing-summary' };
  if (singaporeDayKey(ms) !== singaporeDayKey(now)) return { fresh: false, detail: 'previous-day' };
  if (now - ms > ACCOUNT_SUMMARY_MAX_AGE_MS) return { fresh: false, detail: 'older-than-15m' };
  return { fresh: true, at: account.summaryAt, ageMs: now - ms };
}

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

function marginConsumption(excess, funds, notional) {
  const fraction = funds > 0 ? Math.min(1, Math.max(0, excess / funds)) : 1;
  return { fraction, projectedExcess: excess - notional * fraction };
}

function pendingWorkingNotional(openRows) {
  let sum = 0;
  for (const row of openRows || []) {
    if (!row || row.closed === true || row.entryFilled === true) continue;
    if (row.parentId == null) continue;
    const setup = Number(row.setupNotionalUsd);
    const sized = Number(row.riskSizing && row.riskSizing.notionalUsd);
    const amount = setup > 0 ? setup : (sized > 0 ? sized : 0);
    sum += amount;
  }
  return sum;
}

function marginDecision(notional, account, pendingNotional = 0) {
  const buyingPower = finiteNumber(account?.buyingPower);
  const excess = finiteNumber(account?.excessLiquidity);
  const nlv = finiteNumber(account?.netLiquidation);
  const availableFunds = finiteNumber(account?.availableFunds);
  const lookAheadFunds = finiteNumber(account?.lookAheadAvailableFunds);
  const lookAheadExcess = finiteNumber(account?.lookAheadExcessLiquidity);
  if (buyingPower == null || excess == null || !(nlv > 0)) {
    return { allowed: false, detail: 'missing-account' };
  }
  if (notional > buyingPower) {
    return { allowed: false, detail: 'buying-power', buyingPower, excess, nlv, availableFunds };
  }
  if (lookAheadFunds != null && notional > lookAheadFunds) {
    return {
      allowed: false,
      detail: 'lookahead-available-funds',
      buyingPower,
      excess,
      nlv,
      availableFunds,
      lookAheadFunds,
      lookAheadExcess,
    };
  }
  const committed = Math.max(0, Number(notional) || 0) + Math.max(0, Number(pendingNotional) || 0);
  const intra = marginConsumption(excess, buyingPower, committed);
  const floor = EXCESS_LIQUIDITY_FLOOR * nlv;
  if (intra.projectedExcess < floor) {
    return {
      allowed: false,
      detail: 'excess-liquidity-floor',
      projectedExcess: intra.projectedExcess,
      floor,
      buyingPower,
      excess,
      nlv,
      availableFunds,
    };
  }
  if (lookAheadExcess != null) {
    const aheadFunds = lookAheadFunds != null ? lookAheadFunds : buyingPower;
    const ahead = marginConsumption(lookAheadExcess, aheadFunds, committed);
    if (ahead.projectedExcess < floor) {
      return {
        allowed: false,
        detail: 'lookahead-excess-liquidity',
        projectedExcess: ahead.projectedExcess,
        floor,
        buyingPower,
        excess,
        nlv,
        availableFunds,
        lookAheadFunds,
        lookAheadExcess,
      };
    }
  }
  return {
    allowed: true,
    projectedExcess: intra.projectedExcess,
    floor,
    buyingPower,
    excess,
    nlv,
    availableFunds,
    lookAheadFunds,
    lookAheadExcess,
    headroomUsd: excess - floor,
  };
}

function leverageDecision(notional, account, pendingNotional = 0) {
  const gross = finiteNumber(account?.grossPositionValue);
  const nlv = finiteNumber(account?.netLiquidation);
  const cap = maxGrossLeverage();
  if (gross == null || !(nlv > 0)) return { allowed: false, detail: 'missing-gross', cap };
  const projectedGross = Math.abs(gross) + Math.max(0, Number(pendingNotional) || 0) + Math.max(0, Number(notional) || 0);
  const limit = cap * nlv;
  const leverage = projectedGross / nlv;
  if (projectedGross > limit) {
    return { allowed: false, detail: 'gross-leverage', projectedGross, limit, leverage, cap, gross };
  }
  return { allowed: true, projectedGross, limit, leverage, cap, gross };
}

function marginTicketCount(excess, funds, nlv, pendingNotional = 0) {
  if (!Number.isFinite(excess) || !Number.isFinite(funds) || !(nlv > 0)) return null;
  if (SETUP_TICKET_USD > funds) return 0;
  const floor = EXCESS_LIQUIDITY_FLOOR * nlv;
  const pending = marginConsumption(excess, funds, Math.max(0, Number(pendingNotional) || 0));
  const used = marginConsumption(excess, funds, SETUP_TICKET_USD);
  const room = pending.projectedExcess - floor;
  if (!(used.fraction > 0) || room < SETUP_TICKET_USD * used.fraction) return 0;
  return Math.floor(room / (SETUP_TICKET_USD * used.fraction));
}

function capitalEntryFit(openRows, account) {
  const plan = capitalSlotPlan(openRows);
  const nlv = finiteNumber(account?.netLiquidation);
  const gross = finiteNumber(account?.grossPositionValue);
  const cap = maxGrossLeverage();
  const pending = pendingWorkingNotional(openRows);
  const leverageNow = nlv > 0 && gross != null ? Math.abs(gross) / nlv : null;
  const leverageRoom = nlv > 0 && gross != null ? cap * nlv - Math.abs(gross) - pending : null;
  const leverageEntries = leverageRoom == null ? null : Math.max(0, Math.floor(leverageRoom / SETUP_TICKET_USD));
  const excessEntries = marginTicketCount(
    finiteNumber(account?.excessLiquidity),
    finiteNumber(account?.buyingPower),
    nlv,
    pending,
  );
  const lookAheadFunds = finiteNumber(account?.lookAheadAvailableFunds);
  const lookAheadExcess = finiteNumber(account?.lookAheadExcessLiquidity);
  let overnight = null;
  if (lookAheadExcess != null || lookAheadFunds != null) {
    const aheadExcess = marginTicketCount(
      lookAheadExcess != null ? lookAheadExcess : finiteNumber(account?.excessLiquidity),
      lookAheadFunds != null ? lookAheadFunds : finiteNumber(account?.buyingPower),
      nlv,
      pending,
    );
    const aheadFunds = lookAheadFunds != null ? Math.floor(lookAheadFunds / SETUP_TICKET_USD) : null;
    const ahead = [aheadExcess, aheadFunds].filter(value => value != null);
    overnight = ahead.length ? Math.min(...ahead) : null;
  }
  const excessFit = [excessEntries, overnight].filter(value => value != null);
  const counts = [plan.free, leverageEntries, excessFit.length ? Math.min(...excessFit) : null]
    .filter(value => value != null);
  return {
    slots: plan.free,
    leverage: leverageEntries,
    excessLiquidity: excessEntries,
    overnight,
    strictest: counts.length ? Math.min(...counts) : null,
    grossPositionValue: gross == null ? null : Math.abs(gross),
    leverageNow,
    maxGrossLeverage: cap,
  };
}

function evaluateCapitalPool(setupId, openRows, candidateNotionalUsd, account, options = {}) {
  if (!capitalPoolEnabled()) return { applied: false, allowed: true };
  const ignoreKey = String(options.key || '');
  const rows = ignoreKey
    ? (openRows || []).filter(row => String(row && row.key || '') !== ignoreKey)
    : (openRows || []);
  const plan = capitalSlotPlan(rows);
  const notional = Math.max(0, Number(candidateNotionalUsd) || 0);
  const fresh = accountReadingFresh(account, options.now || Date.now());
  if (!fresh.fresh) {
    return {
      applied: true, allowed: false, reason: 'margin-data-stale', detail: fresh.detail,
      log: 'skipped: margin data stale', plan, notional,
    };
  }
  const pending = pendingWorkingNotional(rows);
  const margin = marginDecision(notional, account, pending);
  if (!margin.allowed) {
    return { applied: true, allowed: false, reason: 'margin', detail: margin.detail, log: 'skipped: margin', plan, margin, notional, pending };
  }
  const leverage = leverageDecision(notional, account, pending);
  if (!leverage.allowed) {
    return {
      applied: true, allowed: false, reason: 'leverage', detail: leverage.detail,
      log: 'skipped: leverage', plan, margin, leverage, notional,
    };
  }
  const ticker = String(options.ticker || '').toUpperCase();
  if (ticker && plan.positions.some(row => String(row.ticker || '').toUpperCase() === ticker)) {
    return { applied: true, allowed: false, reason: 'capacity', detail: 'one-position-per-ticker', log: 'skipped: capacity', plan };
  }
  if (plan.open >= MODEL_SLOTS) {
    return { applied: true, allowed: false, reason: 'capacity', detail: 'gross-cap', log: 'skipped: capacity', plan };
  }
  return { applied: true, allowed: true, plan, margin, leverage };
}

function capitalDashboard(openRows, account, skips) {
  const plan = capitalSlotPlan(openRows);
  const excess = Number(account?.excessLiquidity);
  const nlv = Number(account?.netLiquidation);
  const buyingPower = Number(account?.buyingPower);
  const floor = nlv > 0 ? EXCESS_LIQUIDITY_FLOOR * nlv : null;
  const fit = capitalEntryFit(openRows, account);
  const fresh = accountReadingFresh(account);
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
    fit,
    margin: {
      netLiquidation: Number.isFinite(nlv) ? nlv : null,
      availableFunds: Number.isFinite(Number(account?.availableFunds)) ? Number(account.availableFunds) : null,
      buyingPower: Number.isFinite(buyingPower) ? buyingPower : null,
      excessLiquidity: Number.isFinite(excess) ? excess : null,
      grossPositionValue: fit.grossPositionValue,
      leverage: fit.leverageNow,
      maxGrossLeverage: fit.maxGrossLeverage,
      lookAheadAvailableFunds: finiteNumber(account?.lookAheadAvailableFunds),
      lookAheadExcessLiquidity: finiteNumber(account?.lookAheadExcessLiquidity),
      summaryAt: account?.summaryAt || null,
      fresh: fresh.fresh,
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
  capitalEntryFit,
  marginDecision,
  leverageDecision,
  evaluateCapitalPool,
  accountReadingFresh,
  maxGrossLeverage,
  evidenceTier,
  EXCESS_LIQUIDITY_FLOOR,
  EXCESS_LIQUIDITY_ALERT,
  ACCOUNT_SUMMARY_MAX_AGE_MS,
};
