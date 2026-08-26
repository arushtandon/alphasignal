'use strict';

/**
 * Scale the model's TP1 / SL (and therefore post-TP1 TSL) off the actual
 * fill, not the recommended entry. SNDK rec 1493 / TP1 1660 / SL 1374 that
 * opens at 1600 keeps the same percentages off 1600.
 *
 * TP2 on the live book is the runner TSL, not a second limit. Rebasing TP1
 * and SL off the fill makes that TSL inherit the same percentages.
 */

function rebaseExitsFromFill(input) {
  const modelEntry = Number(input && input.modelEntry);
  const fillPx = Number(input && input.fillPx);
  const modelTp1 = Number(input && input.modelTp1);
  const modelSl = Number(input && input.modelSl);
  if (!(modelEntry > 0) || !(fillPx > 0)) return null;
  const scale = fillPx / modelEntry;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  return {
    scale,
    tp1: modelTp1 > 0 ? modelTp1 * scale : 0,
    sl: modelSl > 0 ? modelSl * scale : 0
  };
}

module.exports = { rebaseExitsFromFill };
