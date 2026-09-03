'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RESERVED_CLIENT_IDS,
  buildExecPoolIds,
  orderIdFloor,
  pickLeastBusy,
  rememberOrderClient,
  clientForOrder,
  rowOwningOrder,
  runWithConcurrency
} = require('../lib/ibkr/exec-client-pool');

test('pool includes manager and skips reserved one-shot ids', () => {
  const ids = buildExecPoolIds(27, 20, 30);
  assert.equal(ids[0], 27);
  assert.equal(ids.length, 20);
  assert.equal(ids[1], 30);
  for (const r of RESERVED_CLIENT_IDS) assert.equal(ids.includes(r), false);
  assert.equal(ids.includes(27), true);
});

test('pool size 1 is manager only; size caps at 25', () => {
  assert.deepEqual(buildExecPoolIds(27, 1, 30), [27]);
  assert.equal(buildExecPoolIds(27, 99, 30).length, 25);
});

test('order id floors are disjoint across clients', () => {
  const now = Date.UTC(2026, 7, 28);
  const a = orderIdFloor(27, 10, now);
  const b = orderIdFloor(30, 10, now);
  assert.ok(b - a === 300000);
  assert.ok(a >= 10);
});

test('least-busy then round-robin among ties', () => {
  const slots = [
    { clientId: 27, ready: true, api: {}, inflight: 2 },
    { clientId: 30, ready: true, api: {}, inflight: 0 },
    { clientId: 31, ready: true, api: {}, inflight: 0 }
  ];
  assert.equal(pickLeastBusy(slots, 0).clientId, 30);
  assert.equal(pickLeastBusy(slots, 1).clientId, 31);
  assert.equal(pickLeastBusy(slots.filter(s => s.clientId === 27), 0).clientId, 27);
  assert.equal(pickLeastBusy([], 0), null);
});

test('clientForOrder prefers map, then row, then manager', () => {
  const orderClients = rememberOrderClient({}, 100, 30);
  assert.equal(clientForOrder(100, { orderClients, managerId: 27 }), 30);
  assert.equal(clientForOrder(200, {
    orderClients, managerId: 27,
    row: { parentId: 200, parentClientId: 31 }
  }), 31);
  assert.equal(clientForOrder(9, { orderClients, managerId: 27 }), 27);
});

test('rowOwningOrder finds parent/stop/tp1/close', () => {
  const byKey = {
    a: { parentId: 1, stopId: 2, tp1Id: 3, closeIds: [4] }
  };
  assert.equal(rowOwningOrder(byKey, 1), byKey.a);
  assert.equal(rowOwningOrder(byKey, 4), byKey.a);
  assert.equal(rowOwningOrder(byKey, 99), null);
});

test('runWithConcurrency keeps a cap and awaits all', async () => {
  const seen = [];
  let live = 0;
  let maxLive = 0;
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    live++;
    maxLive = Math.max(maxLive, live);
    seen.push(n);
    await new Promise(r => setTimeout(r, 20));
    live--;
  });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  assert.ok(maxLive <= 2);
});

test('manager all-open snapshot does not stamp manager id when IB omits clientId', () => {
  const { tagOpenOrderClientId, preferWorkerOpenOrder } = require('../lib/ibkr/exec-client-pool');
  assert.equal(tagOpenOrderClientId({ clientId: 0 }, { manager: true, clientId: 27 }, 27), 0);
  assert.equal(tagOpenOrderClientId({}, { manager: true, clientId: 27 }, 27), 0);
  assert.equal(tagOpenOrderClientId({ clientId: 0 }, { manager: false, clientId: 35 }, 27), 35);
  assert.equal(tagOpenOrderClientId({ clientId: 42 }, { manager: true, clientId: 27 }, 27), 42);
  const mgrRow = { orderId: 9, clientId: 0, aux: 123.8 };
  const workerRow = { orderId: 9, clientId: 35, aux: 123.8 };
  assert.equal(preferWorkerOpenOrder(mgrRow, workerRow, 27).clientId, 35);
  assert.equal(preferWorkerOpenOrder(workerRow, { orderId: 9, clientId: 27 }, 27).clientId, 35);
});
