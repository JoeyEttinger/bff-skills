---
name: styx-bridge-skill
skill: styx-bridge-skill
description: "Styx sBTC bridge monitor and depositor — checks pool capacity, live rate, fees, and bridges BTC to sBTC with human approval."
---

# Styx Bridge Skill Agent

## Decision order

1. Run `doctor` — verify Styx API is reachable before any actions.
2. Run `run --action=status` — get combined overview of pool capacity, price, and fees.
3. Before depositing: run `run --action=pools` to confirm target pool has sufficient capacity.
4. Run `run --action=fees` to calculate exact cost for the deposit amount.
5. Run `run --action=deposit --amount=<sats> --pool=<name>` (without `--confirm`) — review the preview.
6. Present preview to human including fee cost and expected sBTC received.
7. Wait for explicit human approval before adding `--confirm`.
8. After depositing: run `run --action=history` to confirm deposit registered.
9. Cross-reference yield opportunities — compare Zest sBTC supply APR vs Pillar supply APR before deploying freshly bridged sBTC.

## Guardrails

- Never call `deposit --confirm` without explicit human approval of the fee preview.
- Always check pool capacity before depositing — blocked automatically if pool is at max, but pre-check avoids wasted time.
- Never deposit more than 50% of available BTC in a single bridge operation without human authorization.
- Always show the human the fee cost in satoshis before confirming — bridge fees are real BTC costs.
- If Styx API is unreachable, surface the static pool data fallback but warn that rates may be stale.
- Use `pillar-yield-manager run --action=compare` after bridging to identify where to deploy the sBTC.
