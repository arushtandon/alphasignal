'use strict';

const SIZING_VERSION = 'nlv-stop-risk-v2-min-lot-liq';

const DEFAULT_LIMITS = Object.freeze({
  riskPct: Number(process.env.RISK_PER_TRADE_PCT || 0.003),
  maxPositionPct: Number(process.env.MAX_POSITION_NLV_PCT || 0.025),
  maxAdvPct: Number(process.env.MAX_POSITION_ADV_PCT || 0.01),
  gapBufferPct: Number(process.env.RISK_GAP_BUFFER_PCT || 0.0025),
  maxSpreadBps: Number(process.env.MAX_ENTRY_SPREAD_BPS || 50),
});

function remainingLiquidityOk(input, minNotionalUsd, nlv) {
  const avail = Number(input && input.netLiquidityAvailable);
  // 0 / missing = IB snapshot not in yet. Do not zero a published 1-lot on that.
  if (!(avail > 0)) return true;
  const raw = Number(input && input.liquidityFloorPct);
  const floorPct = Number.isFinite(raw) && raw >= 0 ? raw : 0.20;
  return (avail - Number(minNotionalUsd || 0)) > nlv * floorPct;
}

function floorToLot(quantity, lot) {
  const step = Math.max(Number(lot) || 1, 1e-8);
  const places = step >= 1 ? 0 : Math.min(8, (String(step).split('.')[1] || '').length);
  return +(Math.floor((Number(quantity) || 0) / step + 1e-12) * step).toFixed(places);
}

function drawdownRiskMultiplier(drawdownPct) {
  const dd = Math.max(0, Number(drawdownPct) || 0);
  if (dd >= 0.10) return 0;
  if (dd >= 0.075) return 0.25;
  if (dd >= 0.05) return 0.5;
  return 1;
}

function calculateRiskSize(input, limits = DEFAULT_LIMITS) {
  const nlv = Number(input.nlv);
  const entry = Number(input.entry);
  const stop = Number(input.stop);
  const fxToUsd = Number(input.fxToUsd) > 0 ? Number(input.fxToUsd) : 1;
  const multiplier = Math.max(1, Number(input.multiplier) || 1);
  const lot = Math.max(Number(input.lot) || 1, input.allowFractional ? 1e-8 : 1);
  if (!(nlv > 0) || !(entry > 0) || !(stop > 0)) {
    return { eligible: false, quantity: 0, reason: 'missing-nlv-entry-stop', version: SIZING_VERSION };
  }
  const spreadBps = Math.max(0, Number(input.spreadBps) || 0);
  if (spreadBps > limits.maxSpreadBps) {
    return { eligible: false, quantity: 0, reason: 'spread-limit', spreadBps, version: SIZING_VERSION };
  }
  const riskMultiplier = drawdownRiskMultiplier(input.drawdownPct);
  const capitalScale = Math.max(0, Math.min(1, Number(input.capitalScale ?? 1)));
  if (riskMultiplier <= 0 || capitalScale <= 0) {
    return {
      eligible: false, quantity: 0,
      reason: riskMultiplier <= 0 ? 'drawdown-pause' : 'capital-stage-blocked',
      version: SIZING_VERSION
    };
  }
  const gapBufferLocal = entry * Math.max(0, Number(input.gapBufferPct ?? limits.gapBufferPct));
  const unitRiskUsd = (Math.abs(entry - stop) + gapBufferLocal) * multiplier * fxToUsd;
  if (!(unitRiskUsd > 0)) {
    return { eligible: false, quantity: 0, reason: 'invalid-stop-distance', version: SIZING_VERSION };
  }
  const riskBudgetUsd = nlv * limits.riskPct * riskMultiplier * capitalScale;
  const riskQty = floorToLot(riskBudgetUsd / unitRiskUsd, lot);
  const maxNotionalUsd = nlv * limits.maxPositionPct;
  const notionalQty = floorToLot(maxNotionalUsd / (entry * multiplier * fxToUsd), lot);
  const adv = Number(input.advShares);
  const advQty = adv > 0 ? floorToLot(adv * limits.maxAdvPct, lot) : Number.POSITIVE_INFINITY;
  const quantity = floorToLot(Math.min(riskQty, notionalQty, advQty), lot);
  if (!(quantity >= lot)) {
    const minNotionalUsd = lot * entry * multiplier * fxToUsd;
    const minStopRiskUsd = lot * unitRiskUsd;
    if (input.allowMinLot === true && remainingLiquidityOk(input, minNotionalUsd, nlv)) {
      return {
        eligible: true,
        quantity: lot,
        riskBudgetUsd: +riskBudgetUsd.toFixed(2),
        stopRiskUsd: +minStopRiskUsd.toFixed(2),
        notionalUsd: +minNotionalUsd.toFixed(2),
        riskPctNlv: +(minStopRiskUsd / nlv).toFixed(6),
        notionalPctNlv: +(minNotionalUsd / nlv).toFixed(6),
        bindingLimit: 'min-lot-liquidity',
        reason: input.secType === 'FUT' ? 'min-contract-liquidity-override' : 'min-lot-liquidity-override',
        riskMultiplier,
        capitalScale,
        version: SIZING_VERSION,
      };
    }
    return {
      eligible: false,
      quantity: 0,
      reason: input.secType === 'FUT' ? 'minimum-contract-exceeds-risk-budget' : 'minimum-lot-exceeds-risk-budget',
      riskBudgetUsd,
      unitRiskUsd,
      version: SIZING_VERSION,
    };
  }
  const notionalUsd = quantity * entry * multiplier * fxToUsd;
  const stopRiskUsd = quantity * unitRiskUsd;
  return {
    eligible: true,
    quantity,
    riskBudgetUsd: +riskBudgetUsd.toFixed(2),
    stopRiskUsd: +stopRiskUsd.toFixed(2),
    notionalUsd: +notionalUsd.toFixed(2),
    riskPctNlv: +(stopRiskUsd / nlv).toFixed(6),
    notionalPctNlv: +(notionalUsd / nlv).toFixed(6),
    bindingLimit: quantity === riskQty ? 'stop-risk' : quantity === notionalQty ? 'notional' : 'adv',
    riskMultiplier,
    capitalScale,
    version: SIZING_VERSION,
  };
}

module.exports = {
  SIZING_VERSION,
  DEFAULT_LIMITS,
  floorToLot,
  drawdownRiskMultiplier,
  remainingLiquidityOk,
  calculateRiskSize,
};
