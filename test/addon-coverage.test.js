'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  adoptAddonIds,
  addonOcaSpec,
  foldAddonOnTp1,
  isAddonOrder,
  primaryStopTargetQty,
  refusePrimaryEnlarge,
  workingStopQty,
} = require('../lib/ibkr/addon-coverage');
const { clientForOrder, rowOwningOrder } = require('../lib/ibkr/exec-client-pool');

describe('addon coverage', () => {
  it('stores client 93 ids and will not enlarge the primary over them', () => {
    const row = { stopId: 60557740, tp1Id: 60557741 };
    const stops = [
      { orderId: 60557740, clientId: 30, qty: 800 },
      { orderId: 3, clientId: 93, qty: 800 },
    ];
    const targets = [
      { orderId: 60557741, clientId: 30, qty: 800 },
      { orderId: 4, clientId: 93, qty: 800 },
    ];
    const adopted = adoptAddonIds(row, stops, targets);
    assert.equal(adopted.stop, true);
    assert.equal(row.addonStopId, 3);
    assert.equal(row.addonStopClientId, 93);
    assert.equal(row.addonTp1Id, 4);
    assert.equal(isAddonOrder(row, 3), true);
    assert.equal(isAddonOrder(row, 60557740), false);
    assert.equal(primaryStopTargetQty({ positionQty: 1600, addonStopQty: 800 }), 800);
    assert.equal(refusePrimaryEnlarge({ currentQty: 800, targetQty: 1600, addonStopQty: 800 }), true);
    assert.equal(workingStopQty(stops), 1600);
  });

  it('TP1 fill on a row with an addon leaves stop qty equal to the remaining position', () => {
    const before = [
      { orderId: 60557740, qty: 800 },
      { orderId: 3, qty: 800 },
    ];
    assert.equal(workingStopQty(before), 1600);
    const fold = foldAddonOnTp1({ positionRemaining: 800, addonStopQty: 800 });
    assert.equal(fold.cancelAddon, true);
    const after = [{ orderId: 60557740, qty: fold.primaryStopQty }];
    assert.equal(workingStopQty(after), 800);
  });

  it('addon target and stop share one reduce OCA group', () => {
    const spec = addonOcaSpec('2503.T|medium|Thu Oct 29 2026');
    assert.equal(spec.ocaType, 2);
    assert.match(spec.ocaGroup, /^AS-addon-2503/);
    const other = addonOcaSpec('8411.T|medium|Wed Oct 21 2026');
    assert.notEqual(spec.ocaGroup, other.ocaGroup);
    assert.equal(other.ocaType, 2);
  });

  it('routes addon cancels to the master client when Gateway master is 27', () => {
    const row = {
      stopId: 60557740,
      stopClientId: 30,
      placeClientId: 30,
      addonStopId: 3,
      addonStopClientId: 93,
      addonTp1Id: 4,
      addonTp1ClientId: 93,
    };
    const byKey = { k: row };
    assert.equal(rowOwningOrder(byKey, 3), row);
    assert.equal(clientForOrder(3, {
      orderClients: {}, row, managerId: 27, masterClientId: 27,
    }), 27);
    assert.equal(clientForOrder(60557740, {
      orderClients: { 60557740: 30 }, row, managerId: 27, masterClientId: 27,
    }), 30);
    assert.equal(clientForOrder(3, {
      orderClients: {}, row, managerId: 27, masterClientId: 0,
    }), 93);
  });
});
