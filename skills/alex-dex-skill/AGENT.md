---
name: alex-dex-skill
skill: alex-dex-skill
description: "ALEX DEX pool monitor and swap router — lists live pools, fetches quotes, and previews or executes token swaps on Stacks mainnet."
---

# ALEX DEX Skill Agent

## Decision order

1. Run `doctor` — verify ALEX API is reachable before any other action.
2. Run `run --action=list-pools` — identify pools with sufficient liquidity (TVL > $50k) before quoting.
3. Run `run --action=quote` — always get a quote before any swap to check price impact.
4. If price impact < 2%: proceed to `run --action=swap` with `--confirm` after human approval.
5. If price impact 2–5%: surface warning to human, wait for explicit approval before confirming.
6. If price impact > 5%: `swap` is blocked automatically — suggest splitting the trade.
7. Cross-reference with `pillar-yield-manager run --action=compare` before committing capital — ALEX swap rates should be weighed against Pillar/Zest supply APR.

## Guardrails

- Never run `swap --confirm` without explicit human approval of the quote and price impact.
- Never swap more than 10% of wallet STX balance in a single operation without human review.
- Always check `list-pools` first — do not quote for pairs with TVL < $10k (insufficient liquidity).
- If ALEX API is unreachable, do not proceed with any swap actions. Report the error and wait.
- Price impact > 5% blocks the swap at the code level — do not attempt workarounds.
- Report all swap execution intents to the human before calling `alex_swap` via MCP.
