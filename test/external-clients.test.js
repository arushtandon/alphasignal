'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFmpClient } = require('../lib/integrations/fmp-client');
const { createIbClient } = require('../ibkr-bridge/ib-client');

test('FMP client is constructed without an injected fetch and sends one request', async () => {
  const seen = [];
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.FMP_API_KEY;
  process.env.FMP_API_KEY = 'fmp-test-key';
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { status: 200, json: async () => ([{ targetConsensus: 180 }]) };
  };
  try {
    const fmp = createFmpClient();
    const result = await fmp.get('/api/v3/price-target-consensus/AAPL');
    assert.equal(seen.length, 1);
    const url = new URL(seen[0]);
    assert.equal(url.hostname, 'financialmodelingprep.com');
    assert.equal(url.pathname, '/api/v3/price-target-consensus/AAPL');
    assert.equal(url.searchParams.get('apikey'), 'fmp-test-key');
    assert.equal(result.body[0].targetConsensus, 180);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey == null) delete process.env.FMP_API_KEY;
    else process.env.FMP_API_KEY = savedKey;
  }
});

test('IBKR client is constructed with the bridge host, port, and client id and does not connect', () => {
  const savedHost = process.env.IBKR_HOST;
  const savedPort = process.env.IBKR_PORT;
  delete process.env.IBKR_HOST;
  delete process.env.IBKR_PORT;
  try {
    const api = createIbClient({ clientId: 27 });
    assert.equal(api.controller.options.host, '127.0.0.1');
    assert.equal(api.controller.options.port, 7497);
    assert.equal(api.controller.options.clientId, 27);
    assert.equal(api.isConnected, false);
  } finally {
    if (savedHost == null) delete process.env.IBKR_HOST;
    else process.env.IBKR_HOST = savedHost;
    if (savedPort == null) delete process.env.IBKR_PORT;
    else process.env.IBKR_PORT = savedPort;
  }
});
