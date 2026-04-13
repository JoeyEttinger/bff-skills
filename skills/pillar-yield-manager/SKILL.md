---
name: pillar-yield-manager
description: "Pillar Protocol yield dashboard and position manager for aibtc agents — monitors sBTC supply positions, STX stacking status, DCA leaderboard, and live exchange quotes. First Pillar integration in the bff-skills registry."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=quote | run --action=dca-leaderboard | run --action=supply"
  entry: "pillar-yield-manager/pillar-yield-manager.ts"
  requires: "wallet"
  tags: "defi, yield, stacking, read, mainnet-only, l2, pillar"
---

## What it does

Pillar Protocol position monitor and yield optimizer for aibtc agents on Stacks. Connects directly to the Pillar backend API and Hiro Stacks API to give a complete picture of an agent's Pillar ecosystem exposure: sBTC supply positions, STX stacking via Pillar fast-pool, DCA partner earnings, and live sBTC↔STX exchange quotes.

This is a **READ-first skill** with an optional **WRITE action** (`supply`) that is gated behind explicit `--confirm` to prevent accidental on-chain writes.

## Why agents need it

Pillar offers the highest-leverage yield operations on Stacks:
- **sBTC supply**: earn Zest yield on sBTC collateral without selling BTC exposure
- **STX stacking**: join Pillar's fast-pool for PoX stacking rewards without a 12-cycle lock
- **DCA partners**: earn referral fees by inviting other agents

Without a unified dashboard, agents cannot efficiently monitor their Pillar positions across these three distinct yield surfaces. This skill consolidates all Pillar data into a single JSON-structured command.

## Pillar Protocol integration

Direct integration with Pillar backend API (`https://pillar-be.vercel.app`):
- Reads smart wallet positions via `/api/smart-wallet/{name}`
- Fetches live sBTC↔STX quotes via `/api/pillar/quote`
- Reads DCA partner leaderboard via `/api/dca-partner/leaderboard`
- Checks stacking status via `/api/pillar/dca-status`
- On-chain balance verification via Hiro Stacks API

## Commands

### `doctor`
Health check — verifies Pillar API reachability, Hiro API connectivity, wallet configuration, and STX/sBTC balances.

```bash
bun run pillar-yield-manager/pillar-yield-manager.ts doctor
```

### `run --action=status`
Full position overview: STX balance, sBTC balance, active stacking status, smart wallet position (if configured), and DCA partner count.

```bash
bun run pillar-yield-manager/pillar-yield-manager.ts run --action=status
```

With a Pillar smart wallet:
```bash
PILLAR_WALLET_NAME=my-wallet bun run pillar-yield-manager/pillar-yield-manager.ts run --action=status
```

### `run --action=quote [--sbtc-amount=<sats>]`
Fetch a live sBTC→STX exchange quote from Pillar. Useful for evaluating whether to supply or swap.

```bash
# Default: quote for 100,000 sats (0.001 sBTC)
bun run pillar-yield-manager/pillar-yield-manager.ts run --action=quote

# Custom amount
bun run pillar-yield-manager/pillar-yield-manager.ts run --action=quote --sbtc-amount=500000
```

### `run --action=dca-leaderboard`
Show the top DCA partners by referral earnings. Identifies the highest-earning referral strategies.

```bash
bun run pillar-yield-manager/pillar-yield-manager.ts run --action=dca-leaderboard
```

### `run --action=supply --sbtc-amount=<sats> [--confirm]`
Supply sBTC to Pillar smart wallet to earn Zest yield. **Requires `--confirm`** to execute on-chain.

```bash
# Preview (no transaction)
PILLAR_WALLET_NAME=my-wallet bun run pillar-yield-manager/pillar-yield-manager.ts run --action=supply --sbtc-amount=10000

# Execute (requires PILLAR_WALLET_NAME and explicit confirmation)
PILLAR_WALLET_NAME=my-wallet bun run pillar-yield-manager/pillar-yield-manager.ts run --action=supply --sbtc-amount=10000 --confirm
```

## Safety notes

All limits are enforced in code, not just documented:

| Control | Default | Enforced |
|---------|---------|----------|
| Supply requires `--confirm` | Always | Hard gate — no `--confirm` = `blocked` status |
| Min wallet reserve (sBTC) | 5,000 sats | Never supply below this floor |
| Max supply per operation | 1,000,000 sats (0.01 BTC) | Cannot be overridden |
| PILLAR_WALLET_NAME required | For write actions | Error if missing for supply/unwind |

## Output contract

All commands output structured JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {},
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `no_wallet_address` | STACKS_ADDRESS not set and wallet file not found |
| `no_wallet_name` | PILLAR_WALLET_NAME required for this action |
| `pillar_api_unreachable` | Pillar backend not responding |
| `hiro_api_unreachable` | Hiro Stacks API not responding |
| `insufficient_sbtc` | Not enough sBTC to supply (after reserve) |
| `exceeds_max_supply` | Amount exceeds per-operation hard cap |
| `confirm_required` | Run again with --confirm to execute |
| `supply_failed` | On-chain supply transaction failed |

## Environment variables

| Variable | Description |
|----------|-------------|
| `STACKS_ADDRESS` | Your Stacks wallet address (SP...) |
| `PILLAR_WALLET_NAME` | Pillar smart wallet name (e.g. `my-wallet`) |
| `PILLAR_API_KEY` | Pillar API key (defaults to public rate-limited key) |
| `AIBTC_DRY_RUN=1` | Simulate all writes — no transactions broadcast |

## Architecture

```
Agent invokes skill
  -> doctor: check Pillar API + Hiro API + wallet balances
  -> status: fetch STX/sBTC balances + smart wallet position + stacking status
  -> quote: fetch live sBTC↔STX rate from Pillar backend
  -> dca-leaderboard: show top DCA partners by referral earnings
  -> supply: pre-flight checks -> confirm gate -> supply sBTC to smart wallet
```

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Agent | Mighty Scorpion |
| STX Address | `SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH` |
| BTC Address | `bc1qzae8q0fy2s52aasspr4c260mw7fp6q0uqjlrgx` |
| Explorer | [View on Hiro](https://explorer.hiro.so/address/SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH?chain=mainnet) |

## Known constraints

- Stacks mainnet only — no testnet
- `supply` action requires a deployed Pillar smart wallet (`PILLAR_WALLET_NAME`)
- Pillar backend API has rate limits on the public key; set `PILLAR_API_KEY` for higher throughput
- DCA leaderboard data may be delayed up to 5 minutes
- STX required for gas on all write operations (separate from sBTC supply amount)
