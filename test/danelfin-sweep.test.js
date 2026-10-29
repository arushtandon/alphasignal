'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dailySweepDue, weeklySweepDue, sectorSplitCalls, orderMode, selectorBlocksOrder,
  applyStoredScores, viewScoreSource, namesFromBody, SECTORS,
} = require('../lib/strategy/danelfin-sweep');

test('daily AI 10 is due only after the US close on a weekday', () => {
  const before = dailySweepDue(new Date('2026-10-28T19:00:00Z'), new Set());
  const after = dailySweepDue(new Date('2026-10-28T20:15:00Z'), new Set());
  const stored = dailySweepDue(new Date('2026-10-28T20:15:00Z'), new Set(['2026-10-28']));
  assert.equal(before.due, false);
  assert.equal(after.due, true);
  assert.equal(after.calls.length, 1);
  assert.equal(after.calls[0].params.aiscore, 10);
  assert.equal(stored.due, false);
});

test('Saturday weekly sweep stays off until the sector probe re-enables it', () => {
  const blocked = weeklySweepDue(new Date('2026-10-31T15:00:00Z'), new Set());
  assert.equal(blocked.due, false);
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.reason, 'weekly-sector-sweep-disabled');
});

test('Saturday weekly sweep is 22 sector calls for AI 8 and 9 when enabled', () => {
  const due = weeklySweepDue(new Date('2026-10-31T15:00:00Z'), new Set(), { enabled: true });
  assert.equal(due.due, true);
  assert.equal(due.date, '2026-10-30');
  assert.equal(due.calls.length, 22);
  assert.equal(due.calls.filter(call => call.params.aiscore === 8).length, 11);
  assert.equal(new Set(due.calls.map(call => call.params.sector)).size, SECTORS.length);
  const again = weeklySweepDue(new Date('2026-10-31T15:00:00Z'), new Set(['2026-10-30']), { enabled: true });
  assert.equal(again.due, false);
});

test('a 100-name response is capped and splits into 11 sector calls', () => {
  const body = { '2026-10-28': {} };
  for (let index = 0; index < 100; index += 1) body['2026-10-28']['T' + index] = { aiscore: 10, fundamental: 7 };
  const parsed = namesFromBody(body);
  assert.equal(parsed.capped, true);
  assert.equal(sectorSplitCalls('2026-10-28', 10).length, 11);
});

test('no candidate file: US_SHORT_MR still orders and the board is not filtered', () => {
  const pick = { ticker: 'ALAB', market: 'US', setupId: 'US_SHORT_MR' };
  assert.equal(orderMode(pick, 'short', null), 'order');
  assert.equal(orderMode(pick, 'short', new Set()), 'order');
  assert.equal(selectorBlocksOrder(pick, 'short'), false);
  assert.equal(orderMode({ ticker: 'AAPL', market: 'US' }, 'medium'), 'unchanged');
  assert.equal(orderMode({ ticker: 'AAPL', market: 'US' }, 'long'), 'unchanged');
  assert.equal(orderMode({ ticker: '7203.T', market: 'Japan', setupId: 'JAPAN_MEDIUM_MR' }, 'medium'), 'unchanged');
  const board = applyStoredScores({
    short: [pick],
    medium: [{ ticker: 'AAPL', market: 'US' }],
    long: [{ ticker: 'MSFT', market: 'US' }],
  }, {});
  assert.equal(board.short.length, 1);
  assert.equal(board.short[0].setupId, 'US_SHORT_MR');
  assert.equal(board.short[0].danelfinAiScore, undefined);
  assert.equal(board.medium.length, 1);
  assert.equal(board.long.length, 1);
  const stamped = applyStoredScores({
    short: [{ ticker: 'ALAB', market: 'US', setupId: 'US_SHORT_MR' }],
  }, { ALAB: { aiscore: 9, fundamental: 8, technical: 7, sentiment: 6, low_risk: 5, date: '2026-10-28' } });
  assert.equal(stamped.short[0].danelfinAiScore, 9);
  assert.equal(stamped.short[0].danelfinFundamental, 8);
  assert.equal(stamped.short[0].danelfinTechnical, 7);
  assert.equal(stamped.short[0].danelfinSentiment, 6);
  assert.equal(stamped.short[0].danelfinLowRisk, 5);
  assert.equal(stamped.short[0].danelfinDate, '2026-10-28');
});

test('view scores prefer the sweep, then a 7-day cache, and never spend by themselves', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const sweep = viewScoreSource('AAPL', now, { sweep: { AAPL: { aiscore: 10, date: '2026-10-27' } } });
  assert.equal(sweep.action, 'free');
  const cached = viewScoreSource('MSFT', now, {
    cache: { MSFT: { savedAt: '2026-10-25T00:00:00Z', score: { aiscore: 8, date: '2026-10-24' } } },
  });
  assert.equal(cached.action, 'cache');
  const spend = viewScoreSource('NVDA', now, { cache: { NVDA: { savedAt: '2026-10-01T00:00:00Z', score: { aiscore: 9 } } } });
  assert.equal(spend.action, 'spend');
});
