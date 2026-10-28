'use strict';

function createIbClient(options = {}) {
  const { IBApi } = require('@stoqey/ib');
  return new IBApi({
    host: options.host || process.env.IBKR_HOST || '127.0.0.1',
    port: options.port != null ? Number(options.port) : parseInt(process.env.IBKR_PORT || '7497', 10),
    clientId: Number(options.clientId),
  });
}

module.exports = { createIbClient };
