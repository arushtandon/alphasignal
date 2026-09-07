'use strict';

const PAPER_ACCOUNT = 'DU1764495';

function normalizeAccountId(acct) {
  const a = String(acct || '').trim().toUpperCase();
  return a || '';
}

function resolveAccountId(acct, fallback = PAPER_ACCOUNT) {
  return normalizeAccountId(acct) || normalizeAccountId(fallback) || PAPER_ACCOUNT;
}

/** Paper demo accounts are DUxxxx / DFxxxx. Live is typically Uxxxx. */
function isPaperAccountId(acct) {
  return /^D[UF]\d+/i.test(normalizeAccountId(acct));
}

function isLiveAccountId(acct) {
  const a = normalizeAccountId(acct);
  return !!a && !isPaperAccountId(a);
}

function fillAccountOf(row, fallback = PAPER_ACCOUNT) {
  return resolveAccountId(row && row.account, fallback);
}

function filterRowsForAccount(rows, acct) {
  const want = resolveAccountId(acct);
  return (rows || []).filter(r => fillAccountOf(r) === want);
}

function wrapAccountStore(raw, fallback = PAPER_ACCOUNT) {
  if (raw && raw.byAccount && typeof raw.byAccount === 'object') {
    const defaultAccount = resolveAccountId(raw.defaultAccount, fallback);
    return {
      byAccount: { ...raw.byAccount },
      defaultAccount
    };
  }
  if (raw && typeof raw === 'object') {
    const id = resolveAccountId(raw.account, fallback);
    return { byAccount: { [id]: raw }, defaultAccount: id };
  }
  return { byAccount: {}, defaultAccount: resolveAccountId(fallback) };
}

function snapshotForAccount(store, acct) {
  const wrapped = wrapAccountStore(store);
  const id = resolveAccountId(acct, wrapped.defaultAccount);
  return wrapped.byAccount[id] || null;
}

function putSnapshotForAccount(store, acct, snap) {
  const wrapped = wrapAccountStore(store);
  const id = resolveAccountId(acct || (snap && snap.account), wrapped.defaultAccount);
  wrapped.byAccount[id] = Object.assign({}, snap || {}, { account: id });
  if (!wrapped.defaultAccount) wrapped.defaultAccount = id;
  return wrapped;
}

function listKnownAccounts(store, rows, extra) {
  const wrapped = wrapAccountStore(store);
  const set = new Set();
  if (wrapped.defaultAccount) set.add(wrapped.defaultAccount);
  for (const id of Object.keys(wrapped.byAccount || {})) {
    if (id) set.add(id);
  }
  for (const r of rows || []) {
    const id = fillAccountOf(r);
    if (id) set.add(id);
  }
  for (const x of extra || []) {
    const id = normalizeAccountId(x);
    if (id) set.add(id);
  }
  return [...set].sort((a, b) => {
    if (a === PAPER_ACCOUNT) return -1;
    if (b === PAPER_ACCOUNT) return 1;
    return a.localeCompare(b);
  });
}

function postedAccountFromBody(body, fallback = PAPER_ACCOUNT) {
  const b = body || {};
  return resolveAccountId(
    b.account || (b.accountSnapshot && b.accountSnapshot.account),
    fallback
  );
}

/** IBKR tab is always paper. Live trades tab never resolves to a DU/DF account. */
const LIVE_BOOK_SENTINEL = 'LIVE';
function resolveBookAccount(book, accounts, requested) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (String(book || '').toLowerCase() === 'live') {
    const req = normalizeAccountId(requested);
    if (req && isLiveAccountId(req)) return req;
    const found = list.find((id) => isLiveAccountId(id));
    return found || LIVE_BOOK_SENTINEL;
  }
  const req = normalizeAccountId(requested);
  if (req && isPaperAccountId(req)) return req;
  const paper = list.find((id) => isPaperAccountId(id));
  return paper || PAPER_ACCOUNT;
}

module.exports = {
  PAPER_ACCOUNT,
  LIVE_BOOK_SENTINEL,
  normalizeAccountId,
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
  resolveBookAccount
};
