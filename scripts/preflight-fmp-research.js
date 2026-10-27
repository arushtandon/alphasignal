#!/usr/bin/env node
'use strict';

const { assertFmpKey } = require('./research-env');

try {
  assertFmpKey();
  console.log('FMP research preflight passed.');
} catch (error) {
  console.error(`FMP research preflight failed: ${error.message}`);
  process.exitCode = 1;
}
