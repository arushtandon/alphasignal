# Fund-style program — execution feasibility (write-up, no code)

2026-10-25. Research program: `docs/fund-program-readout-2026-10-25.md`.
Nothing below is implemented; this is the gap list for the bridge if any
F12/F13/F14 row were ever promoted. No row passed validation in this run,
so none of this is scheduled.

What the bridge has today (from `ibkr-bridge/bridge.js`,
`lib/ibkr/commodity-futures.js`, `lib/ibkr/futures-roll.js`,
`lib/ibkr/order-routing.js`, `docs/capital-plan-2026-10-06.md`):

- `toContract()` maps Yahoo `=F` roots to IB `FUT` stubs for the seven
  commodity micros (MGC, SIL, MCL, MHG, PLM, PAM, MNG with mini fallbacks)
  and the full-size index/rates roots ES, NQ, YM, RTY, ZN. Front month is
  resolved live by `reqContractDetails` (`needsFrontMonth`).
- `futuresDueForRoll` / `planFuturesRoll` roll a single held contract
  near expiry, with an IB-201 cash-settle fallback and exit rebasing.
- Crypto maps to IB `CRYPTO` on PAXOS spot (BTC, ETH), not CME MBT/MET.
- Pre-entry margin gate: fresh account summary (same Singapore day, ≤ 15
  min), buying power, excess liquidity ≥ 15% NLV, gross position value
  ≤ `MAX_GROSS_LEVERAGE` (2.0) × NLV, 50-slot pool.
- Short sales: IB 201 "short sale" rejects are recognised after the fact
  (`isShortSaleReject`); there is no pre-trade shortable or borrow-rate
  check. The live setup book has short mean-reversion books on US/Japan
  cash equities (`JAPAN_SHORT_MR`, `US_SHORT_MR`), so the sell-to-open
  path and stop handling exist.
- Entries are one-name tickets ($30k or one lot); there is no basket or
  multi-leg order primitive.

## (a) Micro futures across equity, rates, FX, crypto — rolls and margin

Needed:

1. **Contract table.** Add MES, MNQ, MYM, M2K (CME/CBOT), FDXS and FSXE
   (Eurex, EUR 1/pt), MNK (OSE, JPY 10/pt), MHI (HKFE, HKD 10/pt), the
   CAC 40 mini (Euronext, EUR 1/pt), M6E/M6J/M6B/M6A/MCD (CME FX micros,
   note M6J quotes JPY per USD inverted relative to `6J=F`), MBT/MET (CME
   crypto micros, 0.1 coin), and the micro Treasury yield contracts 10Y /
   30Y / 5YY. `IB_FUT_TO_YAHOO`, `IB_FUT_MULTIPLIER` and the
   `yahooFromContract` reverse map need every new root. No FTSE micro
   exists (Z is GBP 10/pt ≈ GBP 80k notional; too large for a $30k slot).
2. **Yield-quoted Treasuries.** The research signal is on ZN/ZB/ZF price.
   10Y/30Y/5YY move inversely in yield and have a fixed $10/bp DV01 per
   contract rather than a price multiplier. The bridge needs a sign flip
   and a DV01-based sizing path for these three roots, or the alternative
   is to trade the full-size ZF/ZN/ZB (one ZN ≈ $110k notional, over a
   $30k slot but inside the 2× gross cap for a single contract).
3. **Multi-contract rolls.** Today's roll handles one row at a time with
   model exits rebased on the new fill. A trend book holds 20+ contracts
   with monthly or quarterly expiries on different calendars (HSI and CAC
   monthly, CL monthly, equity quarterly). Needed: a per-root roll
   calendar (days before last trade date, exchange-specific), a batch
   roll job that rolls all held rows of a root in one pass, and spread
   (calendar) orders where IB supports them to avoid legging risk.
4. **Session and currency handling.** Eurex, OSE, HKFE, CME FX and CME
   crypto all trade outside the current entry window logic; the Asia
   lunch/overnight rules in `order-routing.js` are cash-equity specific.
   Each new exchange needs a session table and a currency bucket for
   margin (EUR, JPY, HKD variation margin is settled in that currency;
   IB will carry FX balances unless auto-converted).
5. **Margin.** Micro futures margin is initial-margin based, not
   notional. The pre-entry gate uses buying power and gross position
   value; for futures IB reports `GrossPositionValue` on notional, so the
   2× cap binds on notional even though margin usage is 3–12%. The gate
   needs a futures-aware branch that checks `InitMarginReq` /
   `MaintMarginReq` headroom and a separate notional cap for futures.
6. **Crypto.** MBT/MET are CME futures (Sun–Fri), while the current
   `CRYPTO` path is PAXOS spot. Either keep spot (no roll, 24×7, no
   leverage) and note the basis, or add MBT/MET as `FUT` with the roll
   machinery above. Spot cannot be shorted at IB; the short side of F13
   crypto needs the futures.

Effort: contract table and reverse maps ~1 day; yield-contract sizing and
sign flip ~1 day; batch roll with per-root calendars and tests ~3–4 days;
session/currency tables ~2 days; margin-aware gate ~2 days; MBT/MET as
futures ~1 day. **About 10–11 engineering days plus a paper month.**

Fit within the 2× gross cap: a 10%-vol trend book with 27 instruments
runs at roughly 1.5–3× notional of capital (the portfolio scalar is
clipped at 4). On notional the 2× gross cap would bind in roughly half
the months; on initial margin the book uses well under 50% of NLV. The
cap definition has to change (margin-based for futures) or the book has
to run at a lower vol target (≈ 5–6%) to stay under 2× notional.

## (b) Single-stock shorts with IBKR shortable and borrow checks

Needed:

1. **Pre-trade shortable check.** Request `reqMktData` generic tick 236
   (shortable) and the `shortableShares` snapshot before any sell-to-open;
   skip when the value is below 2.5 (hard-to-borrow) or shares available
   are below the ticket's share count. Cache per symbol for the entry
   batch.
2. **Borrow rate.** IB publishes fee rates via the Stock Loan Borrow
   (SLB) data (FTP/web, not the API). The research assumes 1% (3% below
   $5). The bridge should refuse shorts whose indicated fee exceeds a
   configurable cap (say 5%) and log the fee with the fill so the ledger
   can accrue borrow.
3. **Locate and regulatory constraints.** US: Reg SHO uptick restriction
   after a 10% drop — an order type check (no marketable sells into a
   circuit breaker). UK: no stamp on the short sale, but SDRT applies to
   the buy-to-cover (`lib/ibkr/stamp-duty.js` handles buys; confirm
   covers route through the same path). France/Germany: IB short
   availability on SBF/IBIS names is thinner; several DAX/CAC names are
   routinely not shortable.
4. **Ledger.** Short P&L, borrow accrual and dividend-in-lieu charges need
   their own ledger fields; `AccruedCash` only aggregates. Dividends on
   short positions are debited by IB and would otherwise appear as
   unexplained cash moves.
5. **Risk.** Short rows need a hard stop (research used none) and a
   max-loss cap because losses are unbounded; the live short MR books
   already have stops, so the primitive exists.

Effort: shortable/borrow checks ~2 days; Reg SHO and cover routing ~1
day; ledger fields and reconciliation ~2 days; stop/risk defaults ~1 day.
**About 6 days plus a paper month.** Fits the 2× cap: a $30k short plus a
$30k long is 2× gross on $30k of capital, so a 10-pair book needs $300k
NLV to stay at 2×; with the current ~1× long book in place, F14 k=5 per
side fits only if the long momentum books are reduced.

## (c) Two-leg hedged baskets (short basket + long index future)

Needed:

1. **Basket primitive.** A "book" object whose rows share an entry batch,
   a target weight vector and a single P&L view; entries are placed as
   parallel single-name orders (IB's basket order is a client-side
   convenience, so legging risk is unavoidable). Partial fills must be
   reconciled: if 7 of 10 shorts fill and the hedge fills in full, the
   hedge has to be trimmed to the filled beta.
2. **Hedge sizing.** Beta × short notional ÷ (index level × multiplier),
   rounded to whole micros. At $30k × 5 names ≈ $150k of shorts with beta
   1.2, the hedge is ≈ $180k ≈ 6 MES — fine. For UK/France/Germany the
   hedge contract is FDXS (≈ EUR 24k), the CAC mini (≈ EUR 8k) or, for
   the UK, no micro at all (Z ≈ GBP 80k) — the UK hedge would have to be
   ISF.L shares.
3. **Rebalance.** Monthly/quarterly rebalance of weights and beta; the
   current book logic is "enter a slot, exit after N months" with no
   re-weighting. Needs a diff-and-trade step (sell what left, buy what
   entered, adjust hedge).
4. **Reporting.** Spread P&L (short + hedge) and combined L/S against
   zero, not against an ETF; the PnL view is per-book today.

Effort: basket object and partial-fill reconciliation ~4 days; hedge
sizing and rebalance ~2 days; reporting ~1 day; plus (a) item 1 for the
hedge contracts and (b) items 1–2 for the shorts. **About 7 days on top of
(a) and (b).** Gross: a hedged short basket is 2× gross by construction
(short notional + hedge notional); adding the long leg makes the combined
F14 book 3× gross of its capital. Under a 2× NLV cap the combined book
cannot run at full size alongside the existing long books; it would run
at one-third of the slot budget or the cap has to be redefined to net or
margin-based exposure.

## Summary

| Item | Depends on | Effort | Under 2× gross cap? |
|---|---|---|---|
| (a) micro futures, rolls, margin | — | ~10–11 days | Only with a margin-based cap or a ~5% vol target |
| (b) single-stock shorts | — | ~6 days | Yes at k=5 if long books shrink |
| (c) hedged baskets | (a), (b) | ~7 days | No at full size; 3× gross by construction |

None of this is warranted by the research: no F12/F13/F14 row reached
VALIDATION_PASS. The incubation-eligible rows (F14 US L/S, F12-A FTSE
and S&P turn-of-month) would first need a paper incubation under the
existing single-name path before any of (a)–(c) is built.
