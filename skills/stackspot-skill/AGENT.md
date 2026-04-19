---
name: stackspot-skill
skill: stackspot-skill
description: "StackSpot collaborative stacking pot monitor — lists pots, checks state, joins rounds, and claims PoX rewards with human approval."
---

# StackSpot Skill Agent

## Decision order

1. Run `doctor` — verify StackSpot contract and Hiro API are reachable.
2. Run `run --action=list-pots` — identify open pots with capacity. Focus on pots > 50% filled (closer to stacking threshold = lower wait time).
3. Run `run --action=pot-state --pot-id=<id>` — confirm pot is `open`, check minimum contribution, and estimate fill-to-threshold.
4. Check STX balance — ensure joining does not leave wallet below 500 STX operational reserve.
5. Run `run --action=join --pot-id=<id> --amount=<stx>` without `--confirm` first — review the preview.
6. Present preview to human. Wait for explicit approval before adding `--confirm`.
7. After pot settles: run `run --action=claim --pot-id=<id> --confirm` to collect PoX rewards.
8. Compare expected PoX yield against Pillar STX stacking APR before joining — use `pillar-yield-manager run --action=status` for reference.

## Guardrails

- Never join a pot with `--confirm` without human approval of the preview.
- Do not join pots with status other than `open`.
- Always maintain a minimum 500 STX operational reserve — never stake the entire wallet balance.
- Do not start a pot round without verifying the pot is at 100% fill capacity (premature start = lower yield for all participants).
- If Hiro API is unreachable, halt all actions and report the error.
- Warn the human explicitly that joined STX is locked for the full stacking cycle before confirming.
