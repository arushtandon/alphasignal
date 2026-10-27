# Mean-reversion win-rate study readout

Run: 2026-09-25T07:52:37.927Z

This is a backtest-only parallel buy book. No live rules, brackets, or sell books changed.

## Holdout results

| Geography | Horizon | Frozen model | n | Win % | PF | Net PnL ($10k/trade) | Result |
|---|---|---|---:|---:|---:|---:|---|
| US | short | rsi2_lt_5__prior_close__t3__sl2__full | 425 | 65.6 | 1.486 | 9917.82 | foldStability |
| US | medium | close_below_lower_bb20_2__one_atr__t21__sl2.5__partial | 66 | 68.2 | 1.181 | 2403.65 | holdoutProfitFactor, foldStability |
| HK | short | rsi2_lt_5__prior_close__t3__sl2__full | 136 | 32.4 | 0.163 | -10182.66 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| HK | medium | close_below_lower_bb20_2__one_atr__t21__sl2.5__full | 10 | 80 | 1.803 | 1004.41 | holdoutSample, multipleTesting |
| Japan | short | close_below_lower_bb20_2__one_atr__t10__sl2.5__partial | 92 | 77.2 | 3.097 | 21964.21 | foldStability |
| Japan | medium | close_below_lower_bb20_2__one_atr__t21__sl2.5__full | 96 | 84.4 | 2.794 | 21204.79 | foldStability |
| UK | short | rsi2_lt_5__prior_close__t3__sl2__full | 487 | 15.4 | 0.111 | -43828 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| UK | medium | rsi2_lt_5__prior_close__t10__sl2__full | 476 | 18.9 | 0.147 | -39199.89 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| Germany | short | williams_r10_lt_minus_95__one_atr__t10__sl2.5__full | 35 | 62.9 | 0.925 | -423.28 | holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| Germany | medium | williams_r10_lt_minus_95__one_atr__t21__sl2.5__full | 34 | 70.6 | 0.974 | -159.76 | holdoutProfitFactor, holdoutPnl, foldStability |
| France | short | rsi2_lt_5__prior_close__t3__sl2__full | 174 | 37.4 | 0.553 | -3245.41 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| France | medium | rsi2_lt_5__ma20__t21__sl2.5__full | 111 | 54.1 | 0.56 | -8102.41 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| Commodities | short | rsi2_lt_5__prior_close__t3__sl2__full | 51 | 31.4 | 0.227 | -3320.09 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |
| Commodities | medium | rsi2_lt_5__prior_close__t10__sl2__full | 50 | 34 | 0.19 | -4277.64 | holdoutWinRate, holdoutProfitFactor, holdoutPnl, foldStability, multipleTesting |

## Decision

No cell cleared every pre-registered gate. Nothing is eligible for promotion.

## High-win / low-PF rejections

- US medium: holdout win 68.2%, PF 1.181, PnL $2403.65; rejected because PF is below 1.3.
- Germany short: holdout win 62.9%, PF 0.925, PnL $-423.28; rejected because PF is below 1.3.
- Germany medium: holdout win 70.6%, PF 0.974, PnL $-159.76; rejected because PF is below 1.3.

## Interpretation

- Holdout-only strength is not sufficient: the development-fold stability rule prevents selection after a regime-specific lucky run.
- Germany and France have only 39 usable names, and commodities only 10, so those samples are below the requested 70–80-name breadth.
- FMP point-in-time capability was not locally verifiable because no FMP credential is configured; Part C was not run and no current fundamental data was substituted.
