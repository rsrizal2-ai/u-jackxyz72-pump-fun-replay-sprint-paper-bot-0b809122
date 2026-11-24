# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rsrizal2-ai/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rsrizal2-ai/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Paper trading only — the replay uses market data, never real funds.

## Strategy

Snipe fresh launches, tiny and everywhere, and leave within minutes:

- **Launch filter** — buy only in a coin's first 8 slots, when the creator has not sold, the creator's own buy is small, the opening crowd is small (a big first-slot crowd is usually the creator's own cluster waiting to dump), no whale sell has landed, and the price has not already run away from its create price.
- **Small stakes** — 0.08 SOL per coin, one buy per launch, so hundreds of coins fit in the 10 SOL bankroll and no single rug matters.
- **Fast exits** — take profit at +15%, stop-loss at −8%, a trailing stop once up 5%, and a hard exit after 240 slots, on staleness, on fading flow, or the moment the creator sells.
- **Guardrail sweeper** — tiny 0.02 SOL probe round trips keep the run above the 20-coin / 0.01-SOL round-trip bar when the bot's own fills lag the pace of the window.

Deterministic by construction: no clock, no environment, no randomness — the same replay always produces the same orders.

## Run

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` against the replay harness (`agent-fun/replay/v2`); `vendor/makefun-bot.ts` is the kit's wire shim, vendored byte for byte.

## Local grade (dev window)

| Version | Net PnL | Fills | Coins | Max drawdown |
| --- | --- | --- | --- | --- |
| v1 (momentum confirmation) | −3.31 SOL | 820 | 159 | 35.7% |
| v2 (launch sniper) | −0.39 SOL | 564 | 282 | 4.1% |
| v3 (tighter stops, 0.08 SOL stake) | −0.35 SOL | 564 | 282 | 3.7% |

For reference on the same dev window: house momentum pilot −9.49 SOL, house reversion pilot −4.00 SOL, house sniper pilot −0.47 SOL, equal-weight baseline −0.02 SOL (guardrails unmet), hold-cash 0.00 SOL (guardrails unmet). The dev window is a single harsh sample — every active strategy loses on it — so the bot is built for breadth and small losses rather than fitted to it; the final window is a fresh 24 hours.

Referral: `3a433hx8`
