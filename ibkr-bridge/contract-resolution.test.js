const assert = require('assert');
const { toContract, parentEntrySpec, riskFindingsFingerprint } = require('./bridge');

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
