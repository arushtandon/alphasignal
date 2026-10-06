# One capital plan

Operator decision on 6 October 2026, revised the same day: one open pool of **50 slots × $30,000**. Every enabled book and market shares it. There is no per-book or per-market maximum. Old-engine positions that are still open count toward the 50.

`CAPITAL_POOL_ENABLED` is on for the paper supervisor and off for the live supervisor. Per-setup position caps stay off unless `SETUP_CAPACITY_<SETUP>_POSITIONS` is set.

When more same-day signals exist than free slots, the order is Tier 1 (Japan medium), then Tier 2 (Japan short and commodities medium), then Experimental (UK and France long momentum, current-engine cells, US short). Inside a tier the seeded hash breaks ties. One ticker is held by only one book.

Before an entry the bridge reads available funds, buying power, and excess liquidity. It skips the order, logs `skipped: margin`, and shows that skip on the dashboard if the notional exceeds buying power or the order would leave excess liquidity below 15% of net liquidation. Excess liquidity below 10% of net liquidation sends a Telegram alert.

UK long momentum and France long momentum are Experimental. Each month, on the first trading day after month-end, the book buys the top 12-1 name that is not already held, $30,000 or one lot if a lot costs more, and sells it six months later. There is no stop. The tag is `SETUP_BOOK:UK_LONG_MOMENTUM` or `SETUP_BOOK:FRANCE_LONG_MOMENTUM`, and the PnL view is against EWU or EWQ. After six monthly entries the book pauses new buys if it is more than 5 points behind its benchmark.
