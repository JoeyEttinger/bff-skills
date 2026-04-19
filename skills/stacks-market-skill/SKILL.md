---
name: stacks-market-skill
description: "Stacks prediction market monitor and trader for aibtc agents — lists active markets, checks positions, quotes YES/NO shares, and executes trades on the Stacks on-chain prediction market."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=list | run --action=get | run --action=position | run --action=quote-buy | run --action=buy | run --action=sell | run --action=redeem"
  entry: "stacks-market-skill/stacks-market-skill.ts"
  requires: "wallet"
  tags: "defi, prediction-market, write, mainnet-only, l2, stacks"
---

# stacks-market-skill

## What it does

Monitor and trade on Stacks on-chain prediction markets. Connects directly to the Stacks prediction market contracts via the Hiro API to list open markets, check your positions, price YES/NO shares, and execute trades. Write actions (buy, sell, redeem) are gated behind `--confirm`.

| Action | What it does | Auth required |
|---|---|---|
| `list` | List all active markets with titles, deadlines, and prices | None |
| `get` | Get full detail on a single market | None |
| `position` | Check your YES/NO share position in a market | Wallet |
| `quote-buy` | Get the cost to buy N shares of YES or NO | None |
| `buy` | Buy YES or NO shares in a market | Wallet + `--confirm` |
| `sell` | Sell YES or NO shares | Wallet + `--confirm` |
| `redeem` | Redeem winning shares after resolution | Wallet + `--confirm` |

## Why agents need it

Prediction markets are one of the highest-information yield sources in Web3 — they combine market-making income with information edge. No existing bff-skills entry covers this space.

An autonomous agent with this skill can:
- Scan all open markets and identify mispriced opportunities
- Buy YES/NO shares when confidence diverges from the market price
- Redeem winning positions automatically after resolution
- Build a track record of accurate predictions that compounds through on-chain reputation

## Safety notes

- `doctor`, `list`, `get`, `position`, and `quote-buy` are fully read-only — no funds moved.
- `buy`, `sell`, and `redeem` **require `--confirm`** to execute on-chain. Without `--confirm`, a preview is returned.
- All trades include slippage protection — transactions revert if share price moves adversely.
- Maximum trade size warning at 10% of wallet balance.
- Never redeem before market resolution — the contract prevents premature redemption.

| Control | Default | Enforced |
|---------|---------|----------|
| Write actions require `--confirm` | Always | Hard gate |
| Max trade size warning | 10% of balance | Warning surfaced |
| Slippage protection | Built into contract | Contract-enforced |

## Commands

### `doctor`
Verify connectivity to Stacks prediction market contracts.

```bash
bun run stacks-market-skill/stacks-market-skill.ts doctor
```

Output:
```json
{
  "status": "ready",
  "checks": {
    "hiro_api": "ok",
    "active_markets": 12
  }
}
```

### `run --action=list`
List all active prediction markets.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=list
bun run stacks-market-skill/stacks-market-skill.ts run --action=list --search="bitcoin"
```

Output:
```json
{
  "status": "success",
  "action": "Pick a market and use run --action=get for full details",
  "data": {
    "markets": [
      {
        "market_id": "1",
        "title": "Will Bitcoin hit $100k by end of 2025?",
        "yes_price": "0.72",
        "no_price": "0.28",
        "deadline": "2025-12-31",
        "status": "active",
        "total_shares": "45230"
      }
    ],
    "total_active": 12
  }
}
```

### `run --action=get --market-id=<id>`
Get full detail on a single market including resolution criteria.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=get --market-id=1
```

### `run --action=position --market-id=<id>`
Check your YES/NO share balance in a market.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=position --market-id=1
```

### `run --action=quote-buy --market-id=<id> --outcome=yes --shares=<n>`
Get the cost to buy N shares of YES or NO.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=quote-buy --market-id=1 --outcome=yes --shares=100
```

Output:
```json
{
  "status": "success",
  "action": "Review price before buying — use run --action=buy --confirm to execute",
  "data": {
    "market_id": "1",
    "outcome": "yes",
    "shares": 100,
    "cost_stx": "72.4",
    "price_per_share": "0.724",
    "price_impact_pct": "0.08"
  }
}
```

### `run --action=buy --market-id=<id> --outcome=yes|no --shares=<n> [--confirm]`
Buy YES or NO shares. Without `--confirm`, returns a preview.

```bash
# Preview
bun run stacks-market-skill/stacks-market-skill.ts run --action=buy --market-id=1 --outcome=yes --shares=100

# Execute
bun run stacks-market-skill/stacks-market-skill.ts run --action=buy --market-id=1 --outcome=yes --shares=100 --confirm
```

### `run --action=sell --market-id=<id> --outcome=yes|no --shares=<n> [--confirm]`
Sell shares back to the market.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=sell --market-id=1 --outcome=yes --shares=50 --confirm
```

### `run --action=redeem --market-id=<id> [--confirm]`
Redeem winning shares after market resolves.

```bash
bun run stacks-market-skill/stacks-market-skill.ts run --action=redeem --market-id=1 --confirm
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
| `market_not_found` | Market ID does not exist |
| `market_resolved` | Market already resolved — use redeem |
| `market_not_resolved` | Trying to redeem an unresolved market |
| `no_position` | No shares held in this market |
| `confirm_required` | Run again with `--confirm` to execute |
| `insufficient_stx` | Not enough STX to buy shares |
