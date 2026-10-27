'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cacheFileName,
  cacheIsComplete,
  lagDistributionByMarket,
} = require('../lib/research/fmp-statement-cache');

test('cache helpers produce safe names and resume only completed records', () => {
  assert.equal(cacheFileName('0700.HK'), '0700.HK');
  assert.equal(cacheFileName('BRK/B'), 'BRK_2FB');
  assert.equal(cacheIsComplete({ schemaVersion: 1, status: 'OK', rows: [] }), true);
  assert.equal(cacheIsComplete({ schemaVersion: 1, status: 'NO_DATA', rows: [] }), true);
  assert.equal(cacheIsComplete({ schemaVersion: 1, status: 'ERROR', rows: [] }), false);
  assert.equal(cacheIsComplete({ schemaVersion: 1, status: 'OK' }), false);
});

test('lag distribution reports per-market min median max and constant flag', () => {
  const distribution = lagDistributionByMarket([
    {
      market: 'US',
      status: 'OK',
      rows: [
        { date: '2024-03-31', acceptedDate: '2024-05-10' },
        { date: '2024-06-30', filingDate: '2024-08-14' },
        { date: '2024-09-30', acceptedDate: '2024-11-14' },
      ],
    },
    {
      market: 'Japan',
      status: 'OK',
      rows: [
        { date: '2024-03-31', acceptedDate: '2024-05-15' },
        { date: '2024-06-30', acceptedDate: '2024-08-14' },
      ],
    },
    { market: 'US', status: 'NO_DATA', rows: [{ date: '2024-12-31', acceptedDate: '2025-02-15' }] },
  ]);

  assert.deepEqual(distribution, [
    {
      market: 'Japan', observations: 2, minLagDays: 45, medianLagDays: 45,
      maxLagDays: 45, uniqueLagDays: 1, constantLag: true,
    },
    {
      market: 'US', observations: 3, minLagDays: 40, medianLagDays: 45,
      maxLagDays: 45, uniqueLagDays: 2, constantLag: false,
    },
  ]);
});
