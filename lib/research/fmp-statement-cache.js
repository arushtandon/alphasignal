'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function cacheFileName(symbol) {
  return encodeURIComponent(String(symbol || '').trim().toUpperCase()).replace(/%/g, '_');
}

function cacheIsComplete(record) {
  return Boolean(record)
    && Number(record.schemaVersion) === 1
    && ['OK', 'NO_DATA'].includes(record.status)
    && Array.isArray(record.rows);
}

function statementLagDays(row) {
  const periodEnd = row?.date || row?.fiscalDateEnding || row?.periodEnding;
  const availableOn = row?.acceptedDate || row?.filingDate;
  const periodMs = Date.parse(periodEnd);
  const availableMs = Date.parse(availableOn);
  if (!Number.isFinite(periodMs) || !Number.isFinite(availableMs)) return null;
  return Math.round((availableMs - periodMs) / DAY_MS);
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function lagDistributionByMarket(records) {
  const byMarket = new Map();
  for (const record of records || []) {
    if (record?.status !== 'OK' || !Array.isArray(record.rows)) continue;
    for (const row of record.rows) {
      const lagDays = statementLagDays(row);
      if (lagDays == null) continue;
      const market = record.market || 'UNKNOWN';
      if (!byMarket.has(market)) byMarket.set(market, []);
      byMarket.get(market).push(lagDays);
    }
  }
  return [...byMarket.entries()]
    .map(([market, lags]) => {
      const uniqueLagDays = new Set(lags);
      return {
        market,
        observations: lags.length,
        minLagDays: lags.reduce((min, value) => Math.min(min, value), Infinity),
        medianLagDays: median(lags),
        maxLagDays: lags.reduce((max, value) => Math.max(max, value), -Infinity),
        uniqueLagDays: uniqueLagDays.size,
        constantLag: uniqueLagDays.size === 1,
      };
    })
    .sort((left, right) => left.market.localeCompare(right.market));
}

module.exports = {
  cacheFileName,
  cacheIsComplete,
  statementLagDays,
  lagDistributionByMarket,
};
