'use strict';

/**
 * Scale the model's TP1 / SL (and therefore post-TP1 TSL) off the actual
 * fill, not the recommended entry. SNDK rec 1493 / TP1 1660 / SL 1374 that
 * opens at 1600 keeps the same percentages off 1600.
 *
 * TP2 on the live book is the runner TSL, not a second limit. Rebasing TP1
 * and SL off the fill makes that TSL inherit the same percentages.
 */

/**
 * IB portfolio avgCost for some LSE names is pounds while the model (and
 * execDetails) is pence. SGRO 4 Sep: fill import 9.51 vs model 944.2 rebased
 * TP1 to 10.7 — a marketable sell if the book is pence.
 */
function alignFillToModel(fillPx, modelEntry) {
  const fill = Number(fillPx);
  const model = Number(modelEntry);
  if (!(fill > 0) || !(model > 0)) return fill;
  const ratio = model / fill;
  if (ratio > 50 && ratio < 200) return fill * 100;
  if (ratio > 0.005 && ratio < 0.02) return fill / 100;
  return fill;
}

function rebaseExitsFromFill(input) {
  const modelEntry = Number(input && input.modelEntry);
  const fillPx = alignFillToModel(input && input.fillPx, modelEntry);
  const modelTp1 = Number(input && input.modelTp1);
  const modelSl = Number(input && input.modelSl);
  if (!(modelEntry > 0) || !(fillPx > 0)) return null;
  const scale = fillPx / modelEntry;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const modelTp2 = Number(input && input.modelTp2);
  return {
    scale,
    fillPx,
    tp1: modelTp1 > 0 ? modelTp1 * scale : 0,
    sl: modelSl > 0 ? modelSl * scale : 0,
    tp2: modelTp2 > 0 ? modelTp2 * scale : 0
  };
}

module.exports = { rebaseExitsFromFill, alignFillToModel };
