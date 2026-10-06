# One capital plan

Operator decision on 6 October 2026, revised the same day: one open pool of **50 slots × $30,000**. Every enabled book and market shares it. There is no per-book or per-market maximum. Old-engine positions that are still open count toward the 50.

`CAPITAL_POOL_ENABLED` is on for the paper supervisor and off for the live supervisor. Per-setup position caps stay off unless `SETUP_CAPACITY_<SETUP>_POSITIONS` is set.

When more same-day signals exist than free slots, the order is Tier 1 (Japan medium), then Tier 2 (Japan short and commodities medium), then Experimental (UK and France long momentum, current-engine cells, US short). Inside a tier the seeded hash breaks ties. One ticker is held by only one book.

Before an entry batch the bridge requests a fresh account summary. The reading has to be from the same Singapore day and no older than 15 minutes. If none arrives, the entries are skipped and logged as `skipped: margin data stale`.

The order is skipped when any of these is tighter. Buying power, or overnight LookAheadAvailableFunds when IB sends it, cannot cover the notional. The order would leave excess liquidity, or LookAheadExcessLiquidity when IB sends it, below 15% of net liquidation (`skipped: margin`). Gross position value after the order would exceed `MAX_GROSS_LEVERAGE` times net liquidation, default 2.0 (`skipped: leverage`). The 50-slot pool is full (`skipped: capacity`). Excess liquidity below 10% of net liquidation sends a Telegram alert.

UK long momentum and France long momentum are Experimental. Each month, on the first trading day after month-end, the book buys the top 12-1 name that is not already held, $30,000 or one lot if a lot costs more, and sells it six months later. There is no stop. The tag is `SETUP_BOOK:UK_LONG_MOMENTUM` or `SETUP_BOOK:FRANCE_LONG_MOMENTUM`, and the PnL view is against EWU or EWQ. After six monthly entries the book pauses new buys if it is more than 5 points behind its benchmark.
