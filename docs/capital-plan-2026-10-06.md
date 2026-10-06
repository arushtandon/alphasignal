# One capital plan

Not enabled. Operator decision on 6 October 2026: keep the **$700,000** model pool. IBKR margin covers the gap to net liquidation. The paper account's last logged net liquidation is **$461,315.62** (DU1764495, 5 October 2026, 20:45 UTC), with available funds **$315,984.25**.

The check lives behind `CAPITAL_POOL_ENABLED`. That flag defaults off. It is not set in the paper supervisor.

## Gross cap

Gross cap is $700,000. A $30,000 ticket gives **23 slots**. Old-engine positions that are still open count toward the 23. On 6 October 2026 the paper book has **25** open old-engine names, so **0 slots are free** and the book is 2 over the cap. While the flag is off those names are not blocked by this rule.

Before every entry the bridge also checks IBKR available funds and buying power. If either figure is missing, or the order's notional is larger than the smaller of the two, the order is skipped and logged `skipped: margin`. It is not sent for IBKR to reject.

## Slot maxima

Each figure is a maximum. An unused dedicated slot is not lent to another book. The shared group is the only place books borrow from each other.

| Book | Slots |
| --- | ---: |
| JAPAN_MEDIUM_MR | 5 |
| JAPAN_SHORT_MR | 3 |
| UK_LONG_MOMENTUM | 6 |
| FRANCE_LONG_MOMENTUM | 6 |
| Shared | 3 |

Shared priority: commodities medium mean reversion, then current-engine cells, then US short mean reversion. A tie inside one priority uses the existing seeded hash. UK and France long momentum are not placed: the executable k=1 re-test is a candidate, not a pass.
