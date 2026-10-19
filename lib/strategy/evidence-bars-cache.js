'use strict';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Cache benchmark/sector OHLCV briefly within one scan, never across daily
 * scans. A rejected fetch is evicted so the next symbol can retry.
 */
function cachedEvidenceBars(cache, symbol, fetcher, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const at = Number(now());
  const current = cache.get(symbol);
  if (current && current.promise && at - Number(current.at || 0) < ttlMs) {
    return current.promise;
  }

  const promise = Promise.resolve().then(() => fetcher(symbol));
  const entry = { at, promise };
  cache.set(symbol, entry);
  promise.catch(() => {
    if (cache.get(symbol) === entry) cache.delete(symbol);
  });
  return promise;
}

module.exports = {
  DEFAULT_TTL_MS,
  cachedEvidenceBars,
};
