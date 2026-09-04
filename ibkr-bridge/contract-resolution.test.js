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
  isAuctionEntryStyle,
  asiaUnfilledCarryActive,
  forceCashOpenActive,
  keepUnfilledWorking
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
assert.strictEqual(baePre.outsideRth, true);
assert.strictEqual(isAuctionEntryStyle('LMT-OPEN'), true);
const baeRth = parentEntrySpec(bae, 'BUY', 330, {
  side: 'buy', entryPx: 2230, quotePx: 2231, phaseOverride: 'rth'
});
assert.strictEqual(baeRth.entryStyle, 'MKT', 'LSE unfilled open orders convert to RTH MKT');
assert.strictEqual(baeRth.outsideRth, true);

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
const usRthMkt = parentEntrySpec(toContract('PH'), 'BUY', 11, {
  side: 'buy', entryPx: 1001.74, quotePx: 1001.74, phaseOverride: 'rth'
});
assert.strictEqual(usRthMkt.entryStyle, 'MKT');
assert.strictEqual(usRthMkt.outsideRth, true);
const mondi = toContract('MNDI.L');
assert.strictEqual(mondi.symbol, 'MNDI');
assert.strictEqual(mondi.localSymbol, undefined);
assert.strictEqual(mondi.primaryExch, 'LSE');
assert.strictEqual(toContract('0992.HK').lotHint, 2000, '0992 is a 2000-share board lot');
assert.strictEqual(toContract('0669.HK').lotHint, 500);

const rec = toContract('6098.T');
assert.strictEqual(rec.symbol, '6098');
assert.strictEqual(rec.market, 'JP');
assert.strictEqual(rec.localSymbol, undefined, 'Yahoo .T is not an IB localSymbol');
const recRth = parentEntrySpec(rec, 'BUY', 100, {
  side: 'buy', entryPx: 17155, quotePx: 17155, phaseOverride: 'rth'
});
assert.strictEqual(recRth.entryStyle, 'LMT-THROUGH');
assert.strictEqual(recRth.orderType, 'LMT');
assert.strictEqual(recRth.transmit, true);
assert.strictEqual(recRth.tif, 'DAY');
assert.strictEqual(recRth.outsideRth, true, 'trial: JP LMT-THROUGH also sends outsideRth');
assert.ok(recRth.lmtPrice > 17155, 'buy through-limit is above last');
assert.strictEqual(recRth.lmtPrice, 17500, '17155*1.02 rounds up to the 10-yen band');
const recWalk = parentEntrySpec(rec, 'BUY', 100, {
  side: 'buy', entryPx: 17155, quotePx: 17155, phaseOverride: 'rth',
  prevExtLmt: 17500, throughPct: 0.02
});
assert.ok(recWalk.lmtPrice > 17500, 'reprice walks the through-limit up from the parked LMT');
const recRthSell = parentEntrySpec(rec, 'SELL', 100, {
  side: 'sell', entryPx: 17155, quotePx: 17155, phaseOverride: 'rth'
});
assert.strictEqual(recRthSell.entryStyle, 'LMT-THROUGH');
assert.ok(recRthSell.lmtPrice < 17155);
assert.strictEqual(recRthSell.lmtPrice, 16810);
const recPre = parentEntrySpec(rec, 'BUY', 100, {
  side: 'buy', entryPx: 17155, phaseOverride: 'pre'
});
assert.strictEqual(recPre.entryStyle, 'OPG');
assert.strictEqual(recPre.outsideRth, true);
assert.strictEqual(recPre.transmit, true, 'JP OPG parent transmits without STP child');

const recCarry = {
  closed: false, entryFilled: false, ticker: '6098.T', contract: rec
};
const recKey = '6098.T|medium|Thu Aug 27 2026';
assert.strictEqual(asiaUnfilledCarryActive(recCarry, recKey, Date.parse('2026-08-27T19:00:00Z')), true,
  'Friday 03:00 SGT is still the next TSE session');
assert.strictEqual(asiaUnfilledCarryActive(recCarry, recKey, Date.parse('2026-08-28T00:00:00Z')), true,
  'Friday 08:00 SGT Tokyo open is still carry');
assert.strictEqual(asiaUnfilledCarryActive(recCarry, recKey, Date.parse('2026-08-28T07:00:00Z')), false,
  'after Friday TSE cash close the carry ends');
const recForce = {
  closed: false, entryFilled: false, ticker: '6098.T', contract: rec,
  admittedAt: '2026-08-26T22:01:09.812Z'
};
assert.strictEqual(forceCashOpenActive(recForce, Date.parse('2026-08-28T00:00:00Z')), true,
  '6098 stays pinned through Friday Tokyo open');
assert.strictEqual(keepUnfilledWorking(recForce, recKey, Date.parse('2026-08-28T07:00:00Z')), true,
  '6098 still works after Friday cash even if carry expired');
assert.strictEqual(forceCashOpenActive({ ...recForce, entryFilled: true }, Date.parse('2026-08-28T00:00:00Z')), false);

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
