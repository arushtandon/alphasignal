# Fund-style program — step 0 data check (2026-10-25)

Report only; nothing substituted. Source: Yahoo chart v8 daily bars cached in `data/research/fund-program-prices/` (falls back to the strategy-/exit-amendment price caches). "OK" = continuous daily history from the first week of 2010 with no calendar gap > 14 days. Yahoo continuous futures (`=F`) are the front-month series — they contain roll jumps, which is why F13 costs charge an explicit roll per contract and signals are computed on this series as-is (documented limitation, not a substitution).

| Series | Name | Class | IBKR contract | Mult | Ccy | Verdict | First | Last | Bars | Gaps > 7d | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ES=F` | S&P 500 (E-mini series) | equity | MES | 5 | USD | OK | 2005-01-03 | 2026-10-26 | 5496 | 0 |  |
| `NQ=F` | Nasdaq 100 | equity | MNQ | 2 | USD | OK | 2005-01-03 | 2026-10-26 | 5496 | 0 |  |
| `YM=F` | Dow Jones | equity | MYM | 0.5 | USD | OK | 2005-01-03 | 2026-10-26 | 5489 | 0 |  |
| `RTY=F` | Russell 2000 | equity | M2K | 5 | USD | PARTIAL (missing 2010, 2011, 2012, 2013, 2014, 2015, 2016) | 2017-07-10 | 2026-10-26 | 2341 | 0 |  |
| `^STOXX50E` | Euro Stoxx 50 (index) | equity | FSXE | 1 | EUR | OK | 2007-03-30 | 2026-10-23 | 4906 | 0 | Micro-FESX; EUR 1 per point |
| `^GDAXI` | DAX (index) | equity | FDXS | 1 | EUR | OK | 2005-01-03 | 2026-10-23 | 5539 | 0 | Micro-DAX; EUR 1 per point |
| `^FTSE` | FTSE 100 (index) | equity | Z (ICE EU) — no micro; ISF.L ETF for TOM | 10 | GBP | OK | 1990-01-02 | 2026-10-06 | 9286 | 0 | No micro FTSE contract at IBKR; full Z is GBP 10/pt. TOM also run on ISF.L. |
| `ISF.L` | iShares Core FTSE 100 ETF | equity | ISF (LSE ETF) | 1 | GBp | OK | 2009-01-02 | 2026-10-23 | 4499 | 0 | UK stamp duty does not apply to ETF purchases. |
| `^N225` | Nikkei 225 (index) | equity | MNK (OSE Micro Nikkei 225) | 10 | JPY | OK | 2005-01-04 | 2026-10-26 | 5335 | 1 (longest 11d) | JPY 10 per point |
| `^HSI` | Hang Seng (index) | equity | MHI (HKFE Mini Hang Seng) | 10 | HKD | OK | 2005-01-03 | 2026-10-26 | 5372 | 0 | HKD 10 per point; monthly expiries |
| `^FCHI` | CAC 40 (index) | equity | CAC40 (Euronext mini; no micro) | 1 | EUR | OK | 2005-01-03 | 2026-10-23 | 5578 | 0 | EUR 1 per point mini; monthly expiries |
| `ZN=F` | US 10-year T-note | rates | 10Y (CBOT Micro 10-Year Yield) — price proxy ZN | 1000 | USD | OK | 2005-01-03 | 2026-10-26 | 5477 | 0 | Micro yield futures trade on yield, not price; sign of a price-trend signal is inverted when mapped |
| `ZB=F` | US 30-year T-bond | rates | 30Y (CBOT Micro 30-Year Yield) — price proxy ZB | 1000 | USD | OK | 2005-01-03 | 2026-10-26 | 5483 | 0 | As above |
| `ZF=F` | US 5-year T-note | rates | 5YY (CBOT Micro 5-Year Yield) — price proxy ZF | 1000 | USD | OK | 2005-01-03 | 2026-10-26 | 5489 | 0 | As above |
| `6E=F` | Euro FX | fx | M6E | 12500 | USD | OK | 2005-01-03 | 2026-10-26 | 5496 | 0 |  |
| `6J=F` | Japanese yen | fx | M6J | 1250000 | USD | OK | 2005-01-03 | 2026-10-26 | 5497 | 0 |  |
| `6B=F` | British pound | fx | M6B | 6250 | USD | OK | 2005-01-03 | 2026-10-26 | 5496 | 0 |  |
| `6A=F` | Australian dollar | fx | M6A | 10000 | USD | OK | 2005-01-03 | 2026-10-26 | 5497 | 0 |  |
| `6C=F` | Canadian dollar | fx | MCD | 10000 | USD | OK | 2005-01-03 | 2026-10-26 | 5496 | 0 | E-micro CAD/USD (MCD) |
| `GC=F` | Gold | commodity | MGC | 10 | USD | OK | 2005-01-03 | 2026-10-26 | 5484 | 0 |  |
| `SI=F` | Silver | commodity | SIL | 1000 | USD | OK | 2005-01-03 | 2026-10-26 | 5484 | 0 |  |
| `CL=F` | WTI crude | commodity | MCL | 100 | USD | OK | 2005-01-03 | 2026-10-26 | 5486 | 0 |  |
| `HG=F` | Copper | commodity | MHG | 2500 | USD | OK | 2005-01-03 | 2026-10-26 | 5487 | 0 |  |
| `PL=F` | Platinum | commodity | PLM | 10 | USD | OK | 2005-01-03 | 2026-10-26 | 4926 | 0 |  |
| `PA=F` | Palladium | commodity | PAM | 10 | USD | OK (gaps > 14d) | 2005-01-03 | 2026-10-26 | 5041 | 1 (longest 26d) |  |
| `NG=F` | Natural gas | commodity | MNG | 1000 | USD | OK | 2005-01-03 | 2026-10-26 | 5488 | 0 |  |
| `BTC-USD` | Bitcoin | crypto | MBT | 0.1 | USD | PARTIAL (missing 2010, 2011, 2012, 2013) | 2014-09-17 | 2026-10-26 | 4422 | 0 | Spot series as proxy; MBT is 0.1 BTC |
| `ETH-USD` | Ether | crypto | MET | 0.1 | USD | PARTIAL (missing 2010, 2011, 2012, 2013, 2014, 2015, 2016) | 2017-11-09 | 2026-10-26 | 3273 | 0 | Spot series as proxy; MET is 0.1 ETH |
| `SPY` | SPY (benchmark) | benchmark | — | 1 | USD | OK | 2010-01-04 | 2026-10-05 | 4214 | 0 |  |
| `AGG` | AGG (60/40 bond leg) | benchmark | — | 1 | USD | OK | 2005-01-03 | 2026-10-23 | 5487 | 0 |  |

## Gaps and caveats

- Missing entirely: none.
- Partial 2010+ coverage: `RTY=F` (PARTIAL (missing 2010, 2011, 2012, 2013, 2014, 2015, 2016)), `BTC-USD` (PARTIAL (missing 2010, 2011, 2012, 2013)), `ETH-USD` (PARTIAL (missing 2010, 2011, 2012, 2013, 2014, 2015, 2016)).
- `PA=F`: 1 gap(s) > 14 days — 2010-01-27→2010-02-22 (26d).
- Rates: IBKR micro Treasury contracts (10Y, 30Y, 5YY) are quoted in yield, not price. The research uses the price series (ZN/ZB/ZF) for signals and P&L; mapping to the micro yield contract inverts the sign and changes the DV01 per contract. Noted as an execution-feasibility item, not substituted here.
- FTSE 100 and CAC 40 have no micro at IBKR: Z is GBP 10/pt (~GBP 80k notional), the CAC 40 mini is EUR 1/pt (~EUR 8k). The FTSE turn-of-month variant is therefore also run on `ISF.L`.
- Crypto: `BTC-USD`/`ETH-USD` are spot series (7-day week). MBT/MET proxies trade CME hours (Sun–Fri); weekend bars are kept in the signal but trades are only opened on CME weekdays.
- `^HSI` and `^N225` TOM entries use the next local open; no currency hedging is modelled (returns in local currency).
