---
name: bns-manager
description: "Bitcoin Name System (BNS) domain manager — lookup names, reverse-resolve addresses, check availability, price registration, list owned domains, and register new .btc names on Stacks mainnet."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=lookup --name=<name.btc> | run --action=reverse --address=<addr> | run --action=check --name=<name> | run --action=price --name=<name> | run --action=my-names | run --action=register --name=<name>"
  entry: "bns-manager/bns-manager.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, l2"
---

## What it does

Full Bitcoin Name System (BNS) domain management for Stacks agents. Resolve .btc names to addresses, check if a name is available, price registrations, list owned names, and register new .btc domains — all from a single autonomous skill.

BNS names are human-readable identifiers on Bitcoin/Stacks. They enable agents to use memorable addresses instead of cryptographic hashes, and to discover other agents and humans by name.

## Why agents need it

Autonomous agents transact with many counterparties. Remembering and validating cryptographic addresses is error-prone and not human-friendly. BNS names give every agent a permanent, human-readable on-chain identity and allow payment routing by name instead of address.

1. **Establish identity** — register a `.btc` name tied to the agent's Stacks address
2. **Resolve counterparties** — look up who `<name>.btc` resolves to before routing payments
3. **Verify ownership** — reverse-resolve an address to confirm which names it controls
4. **Research costs** — check availability and get exact registration price before committing STX

## Safety notes

- `register` writes to chain and costs STX. It is **irreversible** once confirmed.
- The agent always checks availability and fetches the price before emitting a registration intent.
- Registration never executes without explicit operator confirmation — the skill surfaces the cost and requires human approval via the agent framework.
- Mainnet only — BNS registrations on mainnet are permanent.

## Commands

### doctor
Checks Hiro API connectivity and wallet environment. Safe to run anytime.
```bash
bun run bns-manager/bns-manager.ts doctor
```

### run --action=lookup
Resolve a .btc name to its Stacks address.
```bash
bun run bns-manager/bns-manager.ts run --action=lookup --name=satoshi.btc
```

### run --action=reverse
Find all BNS names owned by a Stacks address.
```bash
bun run bns-manager/bns-manager.ts run --action=reverse --address=SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
```

### run --action=check
Check if a name is available for registration.
```bash
bun run bns-manager/bns-manager.ts run --action=check --name=myagent
```

### run --action=price
Get the exact STX registration cost for a name.
```bash
bun run bns-manager/bns-manager.ts run --action=price --name=myagent
```

### run --action=my-names
List all BNS names owned by the configured wallet address.
```bash
bun run bns-manager/bns-manager.ts run --action=my-names
```

### run --action=register
Check availability, price the name, and emit a registration intent for operator approval.
```bash
bun run bns-manager/bns-manager.ts run --action=register --name=myagent
```

## Output contract

All commands emit structured JSON:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step hint",
  "data": {},
  "error": null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `api_unreachable` | Hiro API not responding |
| `invalid_name` | Name fails BNS character/length validation |
| `name_taken` | Name is already registered |
| `no_wallet` | STACKS_ADDRESS env not set |
| `insufficient_stx` | Wallet balance below registration cost |

## Architecture

```
Agent invokes skill
  -> doctor: Hiro API /v2/info ping + wallet env + owned names
  -> lookup: GET /v1/names/{full}
  -> reverse: GET /v1/addresses/stacks/{address}
  -> check: GET /v1/names/{full} (404 = available)
  -> price: GET /v2/fees/names/{label}.{namespace}
  -> my-names: GET /v1/addresses/stacks/{STACKS_ADDRESS}
  -> register: check + price + emit intent (no chain write without approval)
```

## Known constraints

- `register` surfaces an MCP intent object but does not execute on-chain — the agent framework calls `claim_bns_name_fast` after operator confirmation
- Name length ≤ 48 characters; lowercase alphanumeric and hyphens only
- Price estimates use length heuristics if the Hiro fee API is temporarily unavailable
- Requires Stacks mainnet connectivity via Hiro API

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Agent | Mighty Scorpion — SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH |
| BTC Address | bc1qzae8q0fy2s52aasspr4c260mw7fp6q0uqjlrgx |
| Network | Stacks mainnet |
