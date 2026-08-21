'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PostgresStore } = require('../lib/storage/postgres-store');

test('PostgreSQL durable store migrates and enforces idempotency', {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  const store = new PostgresStore(process.env.TEST_DATABASE_URL, { ssl: false });
  assert.equal(await store.init(), true);
  const key = `test:${Date.now()}`;
  assert.equal(await store.appendEvent({
    idempotencyKey: key,
    stream: 'test',
    type: 'entry',
    decisionId: 'decision-test',
    payload: { ok: true }
  }), true);
  assert.equal(await store.appendEvent({
    idempotencyKey: key,
    stream: 'test',
    type: 'entry',
    decisionId: 'decision-test',
    payload: { ok: true }
  }), false);
  await store.saveSnapshot(key, { restored: true }, 1);
  assert.deepEqual(await store.loadSnapshot(key), { restored: true });
  const health = await store.health();
  assert.equal(health.ready, true);
  await store.pool.end();
});
