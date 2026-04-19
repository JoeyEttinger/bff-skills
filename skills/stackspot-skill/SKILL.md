---
name: stackspot-skill
description: "StackSpot stacking pot monitor and participant for aibtc agents — lists active pots, checks pot state, joins collaborative stacking rounds, and claims PoX rewards on Stacks mainnet."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=list-pots | run --action=pot-state | run --action=join | run --action=claim | run --action=start | run --action=cancel"
  entry: "stackspot-skill/stackspot-skill.ts"
  requires: "wallet"
  tags: "defi, stacking, pox, write, mainnet-only, l2, stacks"
---

# stackspot-skill

## What it does

StackSpot collaborative stacking pot monitor and participant. Connects to the StackSpot smart contract on Stacks mainnet via the Hiro read-only API to list active pots, check round state, and coordinate group STX stacking for PoX rewards. All write actions (join, claim, start, cancel) require explicit `--confirm`.

| Action | What it does | Auth |
|---|---|---|
| `list-pots` | List all StackSpot pots with status and current STX | None |
| `pot-state` | Full state of a single pot: participants, STX, next payout | None |
| `join` | Join a pot with STX contribution | Wallet + `--confirm` |
| `claim` | Claim your PoX rewards from a settled pot | Wallet + `--confirm` |
| `start` | Start a new stacking round for a pot | Wallet + `--confirm` |
| `cancel` | Cancel participation and withdraw from a pot | Wallet + `--confirm` |

## Why agents need it

StackSpot allows agents with smaller STX balances to pool capital and participate in Proof-of-Transfer stacking — earning BTC yield without meeting the individual stacking minimum (currently ~100,000 STX).

Without this skill, agents cannot:
- Identify which pots have open capacity and are near the stacking threshold
- Calculate whether their STX contribution pushes a pot over minimum
- Time their `join` before the round locks
- Automatically claim BTC rewards after round settlement

## Safety notes

- `doctor`, `list-pots`, and `pot-state` are fully read-only — no wallet required, no funds moved.
- `join`, `claim`, `start`, and `cancel` **require `--confirm`** to execute on-chain.
- Pre-join validation: always checks pot status (must be `open`) and capacity before executing.
- Minimum contribution enforced by the contract — skill surfaces this before attempting.
- STX is locked for the duration of the stacking cycle — warn the human before joining.

| Control | Default | Enforced |
|---------|---------|----------|
| Write actions require `--confirm` | Always | Hard gate |
| Pot status must be `open` to join | Checked | Pre-flight validation |
| Lock-up warning | Before join | Surfaced in output |

## Commands

### `doctor`
Verify StackSpot contract connectivity.

```bash
bun run stackspot-skill/stackspot-skill.ts doctor
```

Output:
```json
{
  "status": "ready",
  "checks": {
    "hiro_api": "ok",
    "stackspot_contract": "reachable",
    "active_pots": 4
  }
}
```

### `run --action=list-pots`
List all StackSpot pots with status and fill level.

```bash
bun run stackspot-skill/stackspot-skill.ts run --action=list-pots
```

Output:
```json
{
  "status": "success",
  "action": "Pick an open pot and use run --action=pot-state --pot-id=<id> for full detail",
  "data": {
    "pots": [
      {
        "pot_id": "1",
        "name": "Community Pot Alpha",
        "status": "open",
        "current_stx": "45230.50",
        "target_stx": "100000.00",
        "fill_pct": "45.2",
        "participants": 12
      }
    ],
    "total_pots": 4,
    "open_pots": 2
  }
}
```

### `run --action=pot-state --pot-id=<id>`
Full detail on a single pot.

```bash
bun run stackspot-skill/stackspot-skill.ts run --action=pot-state --pot-id=1
```

### `run --action=join --pot-id=<id> --amount=<stx> [--confirm]`
Join a pot with an STX contribution. Without `--confirm`, outputs a preview.

```bash
# Preview
bun run stackspot-skill/stackspot-skill.ts run --action=join --pot-id=1 --amount=500

# Execute
bun run stackspot-skill/stackspot-skill.ts run --action=join --pot-id=1 --amount=500 --confirm
```

### `run --action=claim --pot-id=<id> [--confirm]`
Claim PoX rewards after pot settlement.

```bash
bun run stackspot-skill/stackspot-skill.ts run --action=claim --pot-id=1 --confirm
```

### `run --action=start --pot-id=<id> [--confirm]`
Trigger stacking round start when pot reaches threshold.

```bash
bun run stackspot-skill/stackspot-skill.ts run --action=start --pot-id=1 --confirm
```

### `run --action=cancel --pot-id=<id> [--confirm]`
Withdraw from an open pot before the round starts.

```bash
bun run stackspot-skill/stackspot-skill.ts run --action=cancel --pot-id=1 --confirm
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
| `hiro_api_unreachable` | Hiro Stacks API not responding |
| `pot_not_found` | Pot ID does not exist |
| `pot_not_open` | Pot is locked, stacking, or settled |
| `pot_full` | Pot has reached its STX target |
| `no_rewards` | No claimable rewards in this pot |
| `confirm_required` | Run again with `--confirm` to execute |
| `insufficient_stx` | Not enough STX to meet pot minimum |
