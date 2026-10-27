'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-book-runtime-'));
process.env.SETUP_BOOK_RUNTIME_FILE = path.join(tmp, 'runtime.json');
delete require.cache[require.resolve('../lib/strategy/setup-book-runtime')];
const {
  isSetupPaused,
  resumeSetup,
  evaluateSetupBookPauses,
  copyPublicationFields,
  shouldPause,
} = require('../lib/strategy/setup-book-runtime');
const { SETUPS } = require('../lib/strategy/evidence-setup-book');

test('auto-pause fires after enough closed trades below breakeven', () => {
  const setup = SETUPS.JAPAN_MEDIUM_MR;
  const history = Array.from({ length: 16 }, (_, index) => ({
    setupId: setup.id,
    hz: 'medium',
    mediumStatus: 'time_limit',
    mediumPnlPct: index < 8 ? 1 : -3,
    ibkrFilled: true,
  }));
  const { newlyPaused } = evaluateSetupBookPauses(history, { notify: false });
  assert.equal(newlyPaused.some(row => row.setupId === setup.id), true);
  assert.equal(isSetupPaused(setup.id), true);
  resumeSetup(setup.id);
  assert.equal(isSetupPaused(setup.id), false);
});

test('experimental setups use the 10-trade pause threshold', () => {
  const reason = shouldPause(SETUPS.US_SHORT_MR, {
    trades: 10, winRate: 40, profitFactor: 0.8,
  });
  assert.ok(reason.includes('PF'));
  assert.equal(shouldPause(SETUPS.US_SHORT_MR, {
    trades: 9, winRate: 40, profitFactor: 0.8,
  }), null);
});

test('publication fields are copied and not invented', () => {
  const target = { ticker: '7203.T' };
  copyPublicationFields(target, {
    setupId: 'JAPAN_MEDIUM_MR',
    setupPublication: { publicationId: 'pub_test' },
    expectedPf: 1.753,
  });
  assert.equal(target.setupId, 'JAPAN_MEDIUM_MR');
  assert.equal(target.setupPublication.publicationId, 'pub_test');
  assert.equal(target.expectedPf, 1.753);
});
