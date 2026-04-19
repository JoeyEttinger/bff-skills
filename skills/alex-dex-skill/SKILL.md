---
name: alex-dex-skill
description: "ALEX DEX pool monitor and swap router for aibtc agents — lists live pools by TVL, fetches swap quotes, and previews token swaps on Stacks mainnet via the ALEX public API."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=list-pools | run --action=quote | run --action=top-tokens | run --action=swap"
  entry: "alex-dex-skill/alex-dex-skill.ts"
  requires: "wallet"
  tags: "defi, read, mainnet-only, l2, alex, stacks"
---

# alex-dex-skill

## What it does

Real-time ALEX DEX monitor and swap router for Stacks agents. Connects to the ALEX public API (`https://api.alexgo.io`) to provide live pool data, swap quotes, and token swap previews. The `swap` action is fully gated behind `--confirm` to prevent accidental on-chain execution.

| Action | What it reads | Output |
|---|---|---|
| `list-pools` | All active ALEX pools, sorted by TVL | Name, TVL, APR, 24h volume |
| `quote` | Live swap quote for any ALEX pair | Minimum received, price impact, route |
| `top-tokens` | Top tokens by 24h trading volume | Token, price, volume, % change |
| `swap` | Same as `quote`, plus execution payload | Previews or executes the swap |

## Why agents need it

ALEX is one of the highest-volume DEXes on Stacks, offering STX, sBTC, USDA, xBTC, and 20+ other token pairs. Without a unified DEX skill, agents cannot:

- Identify which ALEX pools have the deepest liquidity before executing trades
- Get accurate swap quotes that account for price impact before committing capital
- Compare ALEX rates against other protocols (Zest supply APR, Pillar yield, Styx bridge rates)

This skill gives agents a live view into ALEX market conditions in a single JSON-structured command.

## Safety notes

- `doctor`, `list-pools`, `quote`, and `top-tokens` are fully read-only — no wallet required, no transactions.
- `swap` action **requires `--confirm`** to execute on-chain. Without `--confirm`, it outputs a preview payload only (status: `preview`).
- All amounts validated before submission. Price impact warnings surfaced when impact exceeds 2%.
- Mainnet only — ALEX contracts are deployed on Stacks mainnet.

| Control | Default | Enforced |
|---------|---------|----------|
| Swap requires `--confirm` | Always | Hard gate — no `--confirm` = preview only |
| Max price impact warning | 2% | Surfaced in output |
| Min amount | 1 microunit | Hard validation |

## Commands

### `doctor`
Verify ALEX API connectivity and check current market status.

```bash
bun run alex-dex-skill/alex-dex-skill.ts doctor
```

Output:
```json
{
  "status": "ready",
  "checks": {
    "alex_api": "ok",
    "total_pools": 24,
    "total_tvl_usd": "45234198.22"
  }
}
```

### `run --action=list-pools`
List all active ALEX pools sorted by TVL. Filter by token with `--token`.

```bash
bun run alex-dex-skill/alex-dex-skill.ts run --action=list-pools
bun run alex-dex-skill/alex-dex-skill.ts run --action=list-pools --token=sbtc
```

Output:
```json
{
  "status": "success",
  "action": "Review pool liquidity before trading",
  "data": {
    "pools": [
      {
        "name": "STX-sBTC",
        "tvl_usd": "8234100.00",
        "apr_pct": "12.4",
        "volume_24h_usd": "542300.00"
      }
    ],
    "total_pools": 24,
    "total_tvl_usd": "45234198.22"
  }
}
```

### `run --action=quote --from=<token> --to=<token> --amount=<amount>`
Get a live swap quote from ALEX.

```bash
bun run alex-dex-skill/alex-dex-skill.ts run --action=quote --from=stx --to=sbtc --amount=100
```

Output:
```json
{
  "status": "success",
  "action": "Review quote before executing swap",
  "data": {
    "from": { "token": "STX", "amount": "100" },
    "to": { "token": "sBTC", "amount_min": "0.00032841" },
    "price_impact_pct": "0.12",
    "route": ["STX", "sBTC"],
    "warning": null
  }
}
```

### `run --action=top-tokens`
List top tokens on ALEX by 24h trading volume.

```bash
bun run alex-dex-skill/alex-dex-skill.ts run --action=top-tokens
```

### `run --action=swap --from=<token> --to=<token> --amount=<amount> [--confirm]`
Preview or execute a swap. Without `--confirm`, returns preview only.

```bash
# Preview (no transaction)
bun run alex-dex-skill/alex-dex-skill.ts run --action=swap --from=stx --to=sbtc --amount=100

# Execute (requires explicit confirmation)
bun run alex-dex-skill/alex-dex-skill.ts run --action=swap --from=stx --to=sbtc --amount=100 --confirm
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
| `alex_api_unreachable` | ALEX public API not responding |
| `unknown_token` | Token symbol not recognized |
| `no_route` | No swap route found for this pair |
| `high_price_impact` | Price impact exceeds 5% — swap blocked |
| `confirm_required` | Run again with `--confirm` to execute |
| `insufficient_balance` | Not enough tokens to swap |
