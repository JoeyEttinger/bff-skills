---
name: stacks-market-skill
skill: stacks-market-skill
description: "Stacks on-chain prediction market monitor and trader — lists markets, checks positions, quotes trades, and executes buy/sell/redeem with human approval."
---

# Stacks Market Skill Agent

## Decision order

1. Run `doctor` — verify Hiro API and market contract are reachable before trading.
2. Run `run --action=list` — scan all active markets, look for mispriced opportunities (implied probability diverges from your conviction).
3. Run `run --action=get --market-id=<id>` — get full detail including resolution criteria before trading.
4. Run `run --action=position --market-id=<id>` — check existing position before entering to avoid doubling.
5. Run `run --action=quote-buy` — always quote before buying. Surface price impact to the human.
6. If price impact < 2% and human approves: run `run --action=buy --confirm`.
7. After market resolves: run `run --action=redeem --confirm` to claim winnings.
8. Cross-reference with wallet STX balance — never commit more than 10% of liquid STX to a single market without explicit human authorization.

## Guardrails

- Never call `buy`, `sell`, or `redeem` with `--confirm` without explicit human approval of the quote.
- Never trade in markets with total liquidity under 1,000 STX — insufficient depth.
- Always check `position` before buying — do not compound into the same market without review.
- Do not redeem before market is resolved (status: `resolved`) — the contract enforces this but always check first.
- Surface any price impact > 2% as a warning before confirming trades.
- If Hiro API is unreachable, halt all actions and report the error.
