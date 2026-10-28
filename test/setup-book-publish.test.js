'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { layoutBoardPanes, entryEventsForPanes } = require('../lib/strategy/setup-book-board');
const { writeScanDiagnostic, readLatestScanDiagnostic, pruneScanDiagnostics } = require('../lib/strategy/scan-diagnostic-store');
const { morningRetryDecision, shouldAlertEmptyMorning } = require('../lib/schedule/morning-retry');
const { isSetupPaused, pauseReason } = require('../lib/strategy/setup-book-runtime');

function plan(setupId, ticker, horizon, kind) {
  return {
    ticker,
    setupId,
    setupKind: kind,
    setupTier: setupId === 'JAPAN_MEDIUM_MR' ? 'Tier 1' : 'Experimental',
    hz: horizon,
    action: 'Buy',
    [horizon + 'Action']: 'Buy',
    [horizon + 'Score']: 100,
    [horizon + 'Rating']: 'Strong Buy',
    [horizon + 'Entry']: '10',
    [horizon + 'StopLoss']: '9',
    entry: 10,
    stopLoss: 9,
  };
}

test('13 US_SHORT_MR and 7 JAPAN_MEDIUM_MR publish 20 cards and 20 entry events', () => {
  const assigns = { short: [], medium: [], long: [], shortSell: [], medSell: [], longSell: [] };
  for (let i = 0; i < 13; i++) assigns.short.push(plan('US_SHORT_MR', `U${i}`, 'short', 'mean_reversion'));
  for (let i = 0; i < 7; i++) assigns.medium.push(plan('JAPAN_MEDIUM_MR', `J${i}.T`, 'medium', 'mean_reversion'));
  for (let i = 0; i < 8; i++) {
    assigns.long.push(plan('JAPAN_LONG_ENGINE', `E${i}.T`, 'long', 'current_engine'));
  }
  const panes = layoutBoardPanes(assigns, { cooldown: new Set(['U0']) });
  const cards = [...panes.short, ...panes.medium, ...panes.long]
    .filter(row => row.setupKind === 'mean_reversion');
  const events = entryEventsForPanes(panes);
  assert.equal(cards.length, 20);
  assert.equal(events.length, 20);
  assert.equal(panes.short.length, 13);
  assert.equal(panes.medium.length, 7);
  assert.equal(panes.medium[0].setupId, 'JAPAN_MEDIUM_MR');
  assert.equal(panes.long.length, 5);
  assert.ok(panes.short.some(row => row.ticker === 'U0'));
});

test('scan diagnostic file keeps 90 days and status can read the latest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-diag-'));
  writeScanDiagnostic(root, '2026-10-28', { sgtDay: '2026-10-28', setups: { US_SHORT_MR: { plans: 13, board: 13 } } });
  fs.writeFileSync(path.join(root, 'diagnostics', 'scan-2026-07-01.json'), '{}\n');
  const removed = pruneScanDiagnostics(root, 90, Date.parse('2026-10-28T00:00:00Z'));
  assert.ok(removed.includes('scan-2026-07-01.json'));
  assert.equal(readLatestScanDiagnostic(root).sgtDay, '2026-10-28');
});

test('empty morning retries at 06:30 and 07:00, then alerts only after the 07:00 run', () => {
  const first = morningRetryDecision({
    minutes: 6 * 60 + 30,
    plans: 13,
    cards: 0,
    done: {},
  });
  assert.equal(first.retry, true);
  assert.equal(first.slot, '0630');
  assert.equal(first.alertAfter, false);
  const running = morningRetryDecision({
    minutes: 7 * 60,
    plans: 13,
    cards: 0,
    scanRunning: true,
    done: first.done,
  });
  assert.equal(running.retry, false);
  assert.equal(running.done['0700'], undefined);
  const second = morningRetryDecision({
    minutes: 7 * 60,
    plans: 13,
    cards: 0,
    done: first.done,
  });
  assert.equal(second.slot, '0700');
  assert.equal(second.alertAfter, true);
  assert.equal(shouldAlertEmptyMorning('morning-retry-0700', 13, 0), true);
  assert.equal(shouldAlertEmptyMorning('morning-retry-0700', 13, 13), false);
});

test('JAPAN_SHORT_MR stays in the book and is paused', () => {
  const runtime = path.join(os.tmpdir(), `setup-runtime-${process.pid}.json`);
  fs.writeFileSync(runtime, '{"version":1,"paused":{},"operatorResume":{},"alerts":[]}\n');
  process.env.SETUP_BOOK_RUNTIME_FILE = runtime;
  delete process.env.SETUP_BOOK_RESUME_IDS;
  assert.equal(isSetupPaused('JAPAN_SHORT_MR'), true);
  assert.match(pauseReason('JAPAN_SHORT_MR'), /identical entry to JAPAN_MEDIUM_MR/);
});
