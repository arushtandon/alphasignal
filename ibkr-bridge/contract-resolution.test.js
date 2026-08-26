const assert = require('assert');
const {
  toContract,
  parentEntrySpec,
  correctiveExtExitSpec,
  sessionPhase,
  minutesSinceUsRth,
  scheduledEntryReleaseAllowed,
  boardPublishedAtRelease,
  publishedBoardHasPick,
  shouldAlertReconFailure,
  riskFindingsFingerprint,
  isAuctionEntryStyle
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
assert.strictEqual(isAuctionEntryStyle('LMT-OPEN'), true);
const baeRth = parentEntrySpec(bae, 'BUY', 330, {
  side: 'buy', entryPx: 2230, quotePx: 2231, phaseOverride: 'rth'
});
assert.strictEqual(baeRth.entryStyle, 'MKT', 'LSE unfilled open orders convert to RTH MKT');

assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-18T16:52:14.688Z'
}, Date.parse('2026-08-18T22:05:00.000Z')), false, '00:52 SGT recommendation must be blocked');
assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-18T22:00:14.688Z'
}, Date.parse('2026-08-18T22:05:00.000Z')), true, '06:00 SGT recommendation must be allowed');
assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-19T05:00:00.000Z', userReentry: true
}, Date.parse('2026-08-18T19:00:00.000Z')), true, 'confirmed user re-entry bypasses the schedule gate');
assert.strictEqual(scheduledEntryReleaseAllowed({
  t: '2026-08-19T05:00:00.000Z', reason: 'rearm-model-entry'
}, Date.parse('2026-08-18T19:00:00.000Z')), false, 'rearm-model-entry must not bypass a pre-release clock');
assert.strictEqual(scheduledEntryReleaseAllowed({
  entryDate: '2026-08-20T18:10:12.649Z'
}, Date.parse('2026-08-21T09:05:00.000Z')), false, 'NWG.L 02:10 SGT Friday emit must stay blocked after 06:00');
assert.strictEqual(boardPublishedAtRelease(
  Date.parse('2026-08-20T18:10:12.649Z'),
  Date.parse('2026-08-21T09:05:00.000Z')
), false, 'overnight Friday scan is not the 06:00 board');
assert.strictEqual(publishedBoardHasPick({
  short: [{ ticker: 'FAST' }],
  medium: [{ ticker: 'DASH' }]
}, 'NWG.L', 'short', 'buy'), false, 'NWG.L is not a published short buy');
assert.strictEqual(publishedBoardHasPick({
  short: [{ ticker: 'FAST' }],
  medium: [{ ticker: 'DASH' }]
}, 'FAST', 'short', 'buy'), true);
assert.strictEqual(shouldAlertReconFailure({
  ok: false, error: 'HTTP 502', transient: true, failureMs: 60_000
}), false, 'brief deploy 502 must not page Telegram');
assert.strictEqual(shouldAlertReconFailure({
  ok: false, error: 'HTTP 502', transient: true, failureMs: 180_000
}), true, 'sustained 502 must still alert');
assert.strictEqual(shouldAlertReconFailure({
  ok: false, error: 'HTTP 401', transient: false, failureMs: 0
}), true, 'non-transient auth failures alert immediately');
const correctiveExit = correctiveExtExitSpec(toContract('COHR'), 'buy', 32, 309.17);
assert.strictEqual(correctiveExit.action, 'SELL');
assert.strictEqual(correctiveExit.orderType, 'LMT');
assert.strictEqual(correctiveExit.lmtPrice, 309.1);
assert.strictEqual(correctiveExit.outsideRth, true);
const correctiveReentry = parentEntrySpec(toContract('COHR'), 'BUY', 32, {
  side: 'buy', entryPx: 301, quotePx: 307.02, phaseOverride: 'pre', forceExt: true
});
assert.strictEqual(correctiveReentry.orderType, 'LMT');
assert.strictEqual(correctiveReentry.lmtPrice, 307.1);
assert.strictEqual(correctiveReentry.outsideRth, true);

const usPost = parentEntrySpec(toContract('NTAP'), 'BUY', 60, {
  side: 'buy', entryPx: 192.27, quotePx: 193.1, phaseOverride: 'post'
});
assert.strictEqual(usPost.entryStyle, 'DEFER-US-UNTIL-PRE', 'US post-market waits for next pre, not overnight OPG');
assert.strictEqual(usPost.defer, true);
const usPre = parentEntrySpec(toContract('PH'), 'BUY', 11, {
  side: 'buy', entryPx: 1001.74, quotePx: 990, phaseOverride: 'pre'
});
assert.strictEqual(usPre.entryStyle, 'LMT-EXT');
assert.strictEqual(usPre.outsideRth, true);
const mondi = toContract('MNDI.L');
assert.strictEqual(mondi.symbol, 'MNDI');
assert.strictEqual(mondi.localSymbol, undefined);
assert.strictEqual(mondi.primaryExch, 'LSE');
assert.strictEqual(toContract('0992.HK').lotHint, 2000, '0992 is a 2000-share board lot');
assert.strictEqual(toContract('0669.HK').lotHint, 500);

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

// DST and holiday boundaries use exchange-local clocks, not fixed UTC offsets.
const us = toContract('AAPL');
assert.strictEqual(sessionPhase(us, Date.parse('2026-03-09T13:00:00Z')), 'pre');
assert.strictEqual(sessionPhase(us, Date.parse('2026-03-09T14:00:00Z')), 'rth');
assert.strictEqual(sessionPhase(us, Date.parse('2026-01-05T14:00:00Z')), 'pre');
assert.strictEqual(sessionPhase(us, Date.parse('2026-01-05T15:00:00Z')), 'rth');
assert.strictEqual(minutesSinceUsRth(Date.parse('2026-03-09T14:00:00Z')), 30);
const sap = toContract('SAP.DE');
assert.strictEqual(sessionPhase(sap, Date.parse('2026-01-05T08:30:00Z')), 'rth');
assert.strictEqual(sessionPhase(sap, Date.parse('2026-08-20T07:30:00Z')), 'rth');
assert.strictEqual(sessionPhase(us, Date.parse('2026-12-25T15:00:00Z')), 'closed');

console.log('PASS BA.L contract identity and stable risk fingerprint');
