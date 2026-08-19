const assert = require('assert');
const {
  toContract,
  parentEntrySpec,
  scheduledEntryReleaseAllowed,
  riskFindingsFingerprint
} = require('./bridge');

const bae = toContract('BA.L');
assert.strictEqual(bae.symbol, 'BA.');
assert.strictEqual(bae.localSymbol, 'BA.');
assert.strictEqual(bae.primaryExch, 'LSE');
assert.strictEqual(bae.currency, 'GBP');
assert.strictEqual(bae.bloomberg, 'BA/ LN');
const baePre = parentEntrySpec(bae, 'BUY', 330, {
  side: 'buy', entryPx: 2230, quotePx: null, phaseOverride: 'pre'
});
assert.strictEqual(baePre.orderType, 'LMT');
assert.strictEqual(baePre.tif, 'DAY');
assert.strictEqual(baePre.lmtPrice, 2230);
assert.strictEqual(baePre.entryStyle, 'LMT-OPEN');

assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-18T16:52:14.688Z'
}), false, '00:52 SGT recommendation must be blocked');
assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-18T22:00:14.688Z'
}), true, '06:00 SGT recommendation must be allowed');
assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-19T05:00:00.000Z', reason: 'rearm-model-entry'
}), true, 'confirmed corrective/user re-entry bypasses the schedule gate');

const mondi = toContract('MNDI.L');
assert.strictEqual(mondi.symbol, 'MNDI');
assert.strictEqual(mondi.localSymbol, undefined);
assert.strictEqual(mondi.primaryExch, 'LSE');

const first = [{
  code: 'unfilled-rth',
  fingerprint: 'unfilled-rth:BA.L|long|Tue Aug 18 2026:MKT:buy',
  text: 'Order NOT executed (RTH 36m): BA.L|long|Tue Aug 18 2026 style=MKT side=buy'
}];
const second = [{
  code: 'unfilled-rth',
  fingerprint: 'unfilled-rth:BA.L|long|Tue Aug 18 2026:MKT:buy',
  text: 'Order NOT executed (RTH 37m): BA.L|long|Tue Aug 18 2026 style=MKT side=buy'
}];
assert.strictEqual(riskFindingsFingerprint(first), riskFindingsFingerprint(second));

console.log('PASS BA.L contract identity and stable risk fingerprint');
