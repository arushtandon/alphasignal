'use strict';
const assert = require('assert');
const {
  scheduledEntryReleaseAllowed,
  boardPublishedAtRelease
} = require('../lib/schedule/entry-release');

const friday3am = Date.parse('2026-08-20T19:00:00.000Z'); // 03:00 SGT 21 Aug
const friday5pm = Date.parse('2026-08-21T09:05:00.000Z'); // 17:05 SGT 21 Aug
const nwg = { entryDate: '2026-08-20T18:10:12.649Z' }; // 02:10 SGT
const sixAm = { entryDate: '2026-08-20T22:00:00.000Z' }; // 06:00 SGT

assert.strictEqual(scheduledEntryReleaseAllowed(nwg, friday3am), false);
assert.strictEqual(scheduledEntryReleaseAllowed(nwg, friday5pm), false,
  'a 02:10 SGT emit must not become tradable after 06:00');
assert.strictEqual(scheduledEntryReleaseAllowed(sixAm, friday3am), false,
  'a 06:00-stamped event must not place at 03:00');
assert.strictEqual(scheduledEntryReleaseAllowed(sixAm, friday5pm), true);
assert.strictEqual(scheduledEntryReleaseAllowed({ ...nwg, reason: 'rearm-model-entry' }, friday5pm), false,
  'rearm must not bypass a pre-release stamp');
assert.strictEqual(scheduledEntryReleaseAllowed({ ...nwg, userReentry: true }, friday3am), true);

const overnightBoard = Date.parse('2026-08-20T18:10:12.649Z');
const sixAmBoard = Date.parse('2026-08-20T22:00:00.000Z');
assert.strictEqual(boardPublishedAtRelease(overnightBoard, friday5pm), false,
  '02:10 scan is not the published Friday board');
assert.strictEqual(boardPublishedAtRelease(sixAmBoard, friday5pm), true);
assert.strictEqual(boardPublishedAtRelease(sixAmBoard, friday3am), false);

const restart = Date.parse('2026-10-12T09:24:00.000Z'); // 17:24 SGT 12 Oct
for (const ticker of ['INTC', 'BBY', 'PFG']) {
  assert.strictEqual(scheduledEntryReleaseAllowed({
    ticker,
    setupId: 'US_SHORT_MR',
    side: 'buy',
    entryDate: '2026-10-07T08:00:35.054Z',
    t: '2026-10-07T08:00:35.054Z',
  }, restart), false, ticker + ' from 7 Oct must not place on the 12 Oct restart');
}
assert.strictEqual(scheduledEntryReleaseAllowed({
  entryDate: '2026-10-11T02:00:00.000Z',
  t: '2026-10-11T02:00:00.000Z',
}, Date.parse('2026-10-12T00:30:00.000Z')), false,
  'an entry from the previous Singapore day is older than today\'s release');
assert.strictEqual(scheduledEntryReleaseAllowed({
  entryDate: '2026-10-11T22:00:00.000Z',
  t: '2026-10-11T22:00:00.000Z',
}, restart), true, 'today\'s 06:00 SGT release stays eligible');

console.log('PASS entry-release gate');
