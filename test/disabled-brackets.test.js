'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

delete process.env.DISABLED_BRACKETS;
const { bracketEnabled } = require('../lib/strategy/bracket-policy');

test('medium and long sells are paused while approved scopes remain enabled', () => {
  assert.equal(bracketEnabled('sell', 'medium'), false);
  assert.equal(bracketEnabled('sell', 'long'), false);
  assert.equal(bracketEnabled('sell', 'short'), true);
  assert.equal(bracketEnabled('buy', 'short'), true);
  assert.equal(bracketEnabled('buy', 'medium'), true);
  assert.equal(bracketEnabled('buy', 'long'), true);
});
