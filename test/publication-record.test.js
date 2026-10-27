'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicationCellRecord } = require('../lib/strategy/publication-record');

test('publication records are immutable and hash-stable', () => {
  const first = buildPublicationCellRecord({
    ticker: 'AAPL',
    market: 'US',
    horizon: 'medium',
    side: 'buy',
    asOfPublish: '2026-10-02',
    signalDate: '2026-10-01',
    score: 61,
    confidence: 55.6,
    setupId: null,
    verdict: 'NO_RECOMMENDATION',
    inputs: { piotroski: 6, barClose: 100 },
    levels: { entry: 101, stop: 95, target: 110 },
    policyVersions: { strategy: 'capital-readiness-v1' },
  });
  const second = buildPublicationCellRecord({
    policyVersions: { strategy: 'capital-readiness-v1' },
    ticker: 'AAPL',
    inputs: { barClose: 100, piotroski: 6 },
    market: 'US',
    horizon: 'medium',
    side: 'buy',
    asOfPublish: '2026-10-02',
    signalDate: '2026-10-01',
    score: 61,
    confidence: 55.6,
    setupId: null,
    verdict: 'NO_RECOMMENDATION',
    levels: { target: 110, stop: 95, entry: 101 },
  });
  assert.equal(first.publicationId, second.publicationId);
  assert.throws(() => { first.score = 99; });
});

test('revalidation cannot overwrite publication-time setup fields', () => {
  const { freezePublishedFields } = require('../lib/strategy/publication-record');
  const published = buildPublicationCellRecord({
    ticker: '7203.T',
    market: 'Japan',
    horizon: 'medium',
    side: 'buy',
    score: 100,
    confidence: 80.8,
    setupId: 'JAPAN_MEDIUM_MR',
  });
  const live = {
    setupId: 'JAPAN_MEDIUM_MR',
    setupPublication: published,
    shortScore: 100,
    mediumConf: 80.8,
  };
  const revalidated = { setupId: 'JAPAN_MEDIUM_MR', shortScore: 12, mediumConf: 40 };
  freezePublishedFields(revalidated, live);
  assert.equal(revalidated.shortScore, 100);
  assert.equal(revalidated.mediumConf, 80.8);
  assert.equal(revalidated.setupPublication.publicationId, published.publicationId);
});
