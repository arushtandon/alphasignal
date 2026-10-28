'use strict';

function fmpApiKey() {
  return String(
    process.env.FMP_API_KEY
    || process.env.FMP_KEY
    || process.env.FINANCIAL_MODELING_PREP_API_KEY
    || ''
  ).trim();
}

function createFmpClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey != null ? options.apiKey : fmpApiKey();
  return {
    async get(pathname, params = {}) {
      if (typeof fetchImpl !== 'function') throw new Error('no-fetch');
      const url = new URL(pathname, 'https://financialmodelingprep.com');
      for (const [name, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(name, String(value));
      }
      if (apiKey) url.searchParams.set('apikey', apiKey);
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      const body = await response.json();
      return { status: response.status, url: String(url), body };
    },
  };
}

module.exports = { createFmpClient, fmpApiKey };
