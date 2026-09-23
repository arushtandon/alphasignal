'use strict';

const DEFAULT_DISABLED_BRACKETS = 'sell:medium,sell:long';
const DISABLED_BRACKETS = new Set(
  String(process.env.DISABLED_BRACKETS || DEFAULT_DISABLED_BRACKETS)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

function bracketEnabled(side, horizon) {
  return !DISABLED_BRACKETS.has(
    `${String(side).toLowerCase()}:${String(horizon).toLowerCase()}`
  );
}

module.exports = {
  DEFAULT_DISABLED_BRACKETS,
  DISABLED_BRACKETS,
  bracketEnabled
};
