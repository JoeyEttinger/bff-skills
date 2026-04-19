---
name: styx-bridge-skill
description: "Styx sBTC bridge monitor and depositor for aibtc agents — checks bridge pools, live BTC/sBTC price, deposit status, and bridges BTC to sBTC via the Styx protocol on Stacks mainnet."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=pools | run --action=price | run --action=fees | run --action=status | run --action=history | run --action=deposit"
  entry: "styx-bridge-skill/styx-bridge-skill.ts"
  requires: "wallet"
  tags: "defi, bridge, sbtc, read, mainnet-only, l2, styx, stacks"
---

# styx-bridge-skill

## What it does

Real-time Styx bridge monitor and BTC→sBTC depositor for Stacks agents. Styx is a trust-minimized bridge that converts native BTC into sBTC on the Stacks layer. This skill reads live pool capacities, bridge rates, and fee schedules — then optionally executes deposits gated behind `--confirm`.

| Action | What it reads | Output |
|---|---|---|
| `pools` | All Styx bridge pools with capacity and utilization | Pool name, max liquidity, available capacity |
| `price` | Live BTC/sBTC conversion rate from Styx oracle | Rate, spread, confidence interval |
| `fees` | Current bridge fee schedule for deposit/withdrawal | Fee tier, min/max amounts, estimated cost |
| `status` | Full bridge health: pools + price + fees in one call | Combined view |
| `history` | Recent bridge activity for your address | Deposit/withdrawal history |
| `deposit` | Preview or execute a BTC→sBTC bridge deposit | Gated behind `--confirm` |

## Why agents need it

Styx is the primary trust-minimized bridge between BTC and Stacks' native sBTC. Agents holding BTC who want to deploy capital on Stacks (Zest supply, Pillar stacking, ALEX pools) must bridge first. Without this skill, agents cannot:

- Check whether the target pool has capacity before initiating a bridge
- See the live BTC/sBTC rate before committing to a conversion
- Estimate fees for the bridge transaction
- Monitor a pending deposit's confirmation status

## Safety notes

- `doctor`, `pools`, `price`, `fees`, `status`, and `history` are fully read-only — no wallet required, no funds moved.
- `deposit` **requires `--confirm`** to execute. Without `--confirm`, outputs a preview with rate, fees, and estimated sBTC received.
- Always shows capacity check before deposit — blocked if pool is at max utilization.
- Bridge deposits involve real BTC movement — always double-check the destination address shown in the preview.
- Mainnet only — Styx operates on Stacks mainnet.

| Control | Default | Enforced |
|---------|---------|----------|
| Deposit requires `--confirm` | Always | Hard gate |
| Pool capacity check | Before deposit | Pre-flight validation |
| Rate shown before execution | Always | In preview output |

## Commands

### `doctor`
Verify Styx API connectivity and pool health.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts doctor
```

Output:
```json
{
  "status": "ready",
  "checks": {
    "styx_api": "ok",
    "pools_available": 2,
    "main_pool_capacity_sats": 2600000
  }
}
```

### `run --action=pools`
List all Styx bridge pools with current capacity.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=pools
```

Output:
```json
{
  "status": "success",
  "action": "Check capacity before depositing — use run --action=deposit to bridge BTC to sBTC",
  "data": {
    "pools": [
      {
        "name": "main",
        "liquidity_sats": 3000000,
        "max_sats": 3000000,
        "available_sats": 2600000,
        "utilization_pct": "13.3"
      }
    ]
  }
}
```

### `run --action=price`
Get the live BTC/sBTC conversion rate from Styx.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=price
```

### `run --action=fees`
Get the current bridge fee schedule.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=fees
```

### `run --action=status`
Full bridge overview: pools + price + fees combined.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=status
```

### `run --action=history`
Check recent bridge activity for your wallet.

```bash
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=history
```

### `run --action=deposit --amount=<sats> --pool=<name> [--confirm]`
Preview or execute a BTC→sBTC bridge deposit. Without `--confirm`, shows what you'll receive.

```bash
# Preview
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=deposit --amount=100000 --pool=main

# Execute
bun run styx-bridge-skill/styx-bridge-skill.ts run --action=deposit --amount=100000 --pool=main --confirm
```

Output (preview):
```json
{
  "status": "preview",
  "action": "Add --confirm to execute this bridge deposit",
  "data": {
    "from": { "asset": "BTC", "amount_sats": 100000 },
    "to": { "asset": "sBTC", "amount_sats": 99200 },
    "fee_sats": 800,
    "pool": "main",
    "available_capacity_sats": 2600000,
    "next_step": "Re-run with --confirm to initiate bridge"
  }
}
```

## Output contract

All commands output structured JSON to stdout:

```json
{
  "status": "success | error | preview | blocked",
  "action": "Human-readable next step",
  "data": {},
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `styx_api_unreachable` | Styx API not responding |
| `pool_not_found` | Pool name does not exist |
| `pool_at_capacity` | Pool has no available capacity |
| `amount_too_small` | Below bridge minimum |
| `amount_too_large` | Exceeds pool capacity |
| `confirm_required` | Run again with `--confirm` to execute |
| `no_wallet_address` | Wallet address required for history/deposit |
