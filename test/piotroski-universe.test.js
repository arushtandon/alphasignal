'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { piotroskiUniverse } = require('../lib/strategy/piotroski-universe');

test('P6 without an FMP key reports the gap and does not use us-universe.json', async () => {
  const saved = {
    FMP_API_KEY: process.env.FMP_API_KEY,
    FMP_KEY: process.env.FMP_KEY,
    FINANCIAL_MODELING_PREP_API_KEY: process.env.FINANCIAL_MODELING_PREP_API_KEY,
  };
  delete process.env.FMP_API_KEY;
  delete process.env.FMP_KEY;
  delete process.env.FINANCIAL_MODELING_PREP_API_KEY;
  try {
    const row = await piotroskiUniverse({ asOf: '2026-12-01' });
    assert.equal(row.ok, false);
    assert.equal(row.gap, 'fmp-key-missing');
    assert.match(row.detail, /scan constituent list/);
    assert.equal(JSON.stringify(row).includes('us-universe.json'), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an injected member list is the one that gets scored', async () => {
  const row = await piotroskiUniverse({
    asOf: '2026-12-01',
    members: ['ZZZZ'],
    memberSource: 'test-list',
  });
  assert.equal(row.source, 'test-list');
  assert.deepEqual(row.members, ['ZZZZ']);
  assert.equal(row.qualifying.length, 0);
});
