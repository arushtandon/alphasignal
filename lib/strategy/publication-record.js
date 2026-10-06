'use strict';

const crypto = require('crypto');

const PUBLICATION_SCHEMA_VERSION = 1;

function stable(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function buildPublicationCellRecord(input) {
  const record = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    ticker: input.ticker || null,
    market: input.market || null,
    horizon: input.horizon || null,
    side: input.side || null,
    asOfPublish: input.asOfPublish || null,
    signalDate: input.signalDate || null,
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
    setupId: input.setupId || null,
    verdict: input.verdict || null,
    inputs: input.inputs || null,
    levels: input.levels || null,
    exits: input.exits || null,
    policyVersions: input.policyVersions || null,
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(stable(record)))
    .digest('hex');
  return Object.freeze({ ...record, publicationId: `pub_${digest.slice(0, 24)}` });
}

function freezePublishedFields(target, source) {
  if (!target || !source) return target;
  if (source.setupPublication) target.setupPublication = source.setupPublication;
  for (const field of [
    'setupId', 'setupTestedId', 'setupTier', 'tierLabel', 'experimental',
    'expectedPf', 'backtestSampleSize', 'expectedPicksPerMonth',
    'backtestBreakevenWinRate', 'setupInputs', 'setupLevels', 'setupExits',
    'setupTag', 'setupPlanVersion', 'setupPublication',
    'shortScore', 'mediumScore', 'longScore', 'shortConf', 'mediumConf', 'longConf',
  ]) {
    if (source[field] !== undefined) target[field] = source[field];
  }
  return target;
}

module.exports = {
  PUBLICATION_SCHEMA_VERSION,
  buildPublicationCellRecord,
  freezePublishedFields,
};
