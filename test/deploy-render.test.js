'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { refusalReason } = require('../scripts/deploy-render');

test('morning scan window and the 2 Nov momentum batch refuse a deploy', () => {
  assert.match(refusalReason(new Date('2026-10-27T20:30:00Z')), /04:30/);
  assert.match(refusalReason(new Date('2026-10-27T23:30:00Z')), /04:30/);
  assert.equal(refusalReason(new Date('2026-10-27T23:31:00Z')), null);
  assert.equal(refusalReason(new Date('2026-10-28T07:06:00Z')), null);
  assert.match(refusalReason(new Date('2026-11-01T23:00:00Z')), /momentum/);
  assert.match(refusalReason(new Date('2026-11-02T02:00:00Z')), /momentum/);
  assert.equal(refusalReason(new Date('2026-11-02T02:01:00Z')), null);
});
