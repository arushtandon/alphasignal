'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PAPER_ACCOUNT,
  resolveAccountId,
  isPaperAccountId,
  isLiveAccountId,
  fillAccountOf,
  filterRowsForAccount,
  wrapAccountStore,
  snapshotForAccount,
  putSnapshotForAccount,
  listKnownAccounts,
  postedAccountFromBody,
  resolveBookAccount,
  LIVE_BOOK_SENTINEL
} = require('../lib/ibkr/account-scope');

test('paper vs live account ids', () => {
  assert.equal(isPaperAccountId('DU1764495'), true);
  assert.equal(isPaperAccountId('du1764495'), true);
  assert.equal(isLiveAccountId('U1234567'), true);
  assert.equal(isLiveAccountId('DU1764495'), false);
  assert.equal(resolveAccountId(''), PAPER_ACCOUNT);
});

test('legacy untagged fills belong to the paper account', () => {
  const rows = [
    { execId: '1', account: 'U999' },
    { execId: '2' }
  ];
  assert.equal(fillAccountOf(rows[1]), PAPER_ACCOUNT);
  assert.equal(filterRowsForAccount(rows, 'U999').length, 1);
  assert.equal(filterRowsForAccount(rows, PAPER_ACCOUNT).length, 1);
});

test('legacy flat snapshot wraps under its account id', () => {
  const wrapped = wrapAccountStore({ account: 'DU1764495', netLiquidation: 470000 });
  assert.equal(wrapped.defaultAccount, PAPER_ACCOUNT);
  assert.equal(snapshotForAccount(wrapped, PAPER_ACCOUNT).netLiquidation, 470000);
  const next = putSnapshotForAccount(wrapped, 'U1234567', { netLiquidation: 200000 });
  assert.equal(snapshotForAccount(next, 'U1234567').netLiquidation, 200000);
  assert.equal(snapshotForAccount(next, PAPER_ACCOUNT).netLiquidation, 470000);
  assert.deepEqual(listKnownAccounts(next, [{ account: 'U1234567' }]), [PAPER_ACCOUNT, 'U1234567']);
});

test('posted body prefers accountSnapshot.account', () => {
  assert.equal(postedAccountFromBody({ accountSnapshot: { account: 'U1' } }), 'U1');
  assert.equal(postedAccountFromBody({ account: 'DU1764495' }), PAPER_ACCOUNT);
  assert.equal(postedAccountFromBody({}), PAPER_ACCOUNT);
});

test('book=live never resolves to paper; book=paper never uses live', () => {
  assert.equal(resolveBookAccount('live', [PAPER_ACCOUNT], PAPER_ACCOUNT), LIVE_BOOK_SENTINEL);
  assert.equal(resolveBookAccount('live', [PAPER_ACCOUNT, 'U1234567'], PAPER_ACCOUNT), 'U1234567');
  assert.equal(resolveBookAccount('live', [PAPER_ACCOUNT, 'U1234567'], 'U999'), 'U999');
  assert.equal(resolveBookAccount('paper', [PAPER_ACCOUNT, 'U1234567'], 'U1234567'), PAPER_ACCOUNT);
  assert.equal(resolveBookAccount('paper', [PAPER_ACCOUNT], ''), PAPER_ACCOUNT);
});
