'use strict';

/**
 * Runner TP2+stop OCA repair helpers.
 * On IB modify rejection (esp. 10327), leave live orders untouched and stop retrying.
 */

function isOcaRepairLabel(label) {
  return /OCA repair/i.test(String(label || ''));
}

/** IB codes that mean an in-place revise was refused (orders stay as they were). */
function isModifyRejectCode(code) {
  const n = Number(code);
  return n === 10327 || n === 103 || n === 104 || n === 201;
}

/**
 * Stop qty for a runner repair: never reduce below the live position or the
 * working stop size (protection-first).
 */
function safeRepairStopQty({ runnerQty, positionQty, currentStopQty } = {}) {
  const runner = Math.max(0, Number(runnerQty) || 0);
  const pos = Math.max(0, Number(positionQty) || 0);
  const cur = Math.max(0, Number(currentStopQty) || 0);
  return Math.max(runner, pos, cur);
}

function shouldSkipPairRepair(row) {
  return !!(row && row.repairLocked === true);
}

/**
 * Mark a runner pair so ensureWorkingTp2Children will not transmit more repairs.
 * Returns true if this call newly locked (caller should alert once).
 */
function markRepairLocked(row, { code, message, orderId } = {}) {
  if (!row) return false;
  const already = row.repairLocked === true;
  row.repairLocked = true;
  row.repairLockedAt = row.repairLockedAt || new Date().toISOString();
  row.repairLockedCode = Number(code) || row.repairLockedCode || null;
  row.repairLockedMessage = String(message || row.repairLockedMessage || '').slice(0, 240);
  if (orderId != null) row.repairLockedOrderId = Number(orderId);
  return !already;
}

module.exports = {
  isOcaRepairLabel,
  isModifyRejectCode,
  safeRepairStopQty,
  shouldSkipPairRepair,
  markRepairLocked,
};
