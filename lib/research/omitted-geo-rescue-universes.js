'use strict';

// These additions are research-only. The runner records every successfully
// loaded symbol and never silently substitutes a current constituent list for
// a historical snapshot.
const COMMODITY_ADDITIONS = Object.freeze([
  'ZC=F', 'ZW=F', 'ZS=F', 'KC=F', 'CC=F', 'CT=F', 'SB=F',
  'LE=F', 'HE=F', 'RB=F', 'HO=F', 'LBS=F',
  'DBC', 'PDBC', 'GSG', 'USO', 'BNO', 'UNG', 'CPER', 'DBA',
  'WEAT', 'CORN', 'SOYB', 'GLD', 'SLV',
]);

const EXTERNAL_SNAPSHOT_REQUIREMENTS = Object.freeze({
  France: {
    target: 'SBF 120',
    requiredAsOfOnOrBefore: '2023-03-20',
    source: 'Euronext historical composition export',
    status: 'REQUIRES_DATED_SNAPSHOT',
    reason: 'A current component list would introduce survivorship bias into the 2023 holdout.',
  },
  Germany: {
    target: 'HDAX (DAX + MDAX + TecDAX, de-duplicated)',
    requiredAsOfOnOrBefore: '2023-03-20',
    source: 'STOXX/Deutsche Börse dated DAX, MDAX and TecDAX selection lists',
    status: 'REQUIRES_DATED_SNAPSHOT',
    reason: 'Public current HDAX membership cannot be used for a 2023 holdout.',
  },
  HK: {
    southboundFlow: {
      source: 'HKEX Stock Connect Historical Daily or licensed equivalent',
      status: 'REQUIRES_DATED_SERIES',
      reason: 'Historical daily Southbound net-flow data is subscription/licence gated.',
    },
    ahPremium: {
      source: 'point-in-time A/H security mapping plus both listed prices',
      status: 'REQUIRES_DATED_MAPPING',
      reason: 'A current dual-list mapping would leak post-holdout corporate actions/listings.',
    },
  },
  UK: {
    revenuePartition: {
      source: 'point-in-time annual-report geographic revenue classifications',
      status: 'REQUIRES_DATED_CLASSIFICATION',
      reason: 'Current domestic/overseas labels are not safe to apply historically.',
    },
  },
});

function dedupeCommodityUniverse(base) {
  return [...new Set([...(base || []), ...COMMODITY_ADDITIONS])];
}

module.exports = { COMMODITY_ADDITIONS, EXTERNAL_SNAPSHOT_REQUIREMENTS, dedupeCommodityUniverse };
