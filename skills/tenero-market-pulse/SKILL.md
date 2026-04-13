---
name: tenero-market-pulse
description: "Real-time Stacks ecosystem market intelligence — top gainers/losers, trending pools, whale trades, wallet analytics, and token deep-dives via the Tenero API. No authentication required."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=market-stats | run --action=top-gainers | run --action=top-losers | run --action=trending-pools | run --action=whale-trades | run --action=token-info --token=<contractId> | run --action=wallet-holdings --address=<addr> | run --action=wallet-trades --address=<addr>"
  entry: "tenero-market-pulse/tenero-market-pulse.ts"
  requires: "wallet"
  tags: "defi, read-only, mainnet-only, l2"
---

## What it does

Real-time Stacks ecosystem market intelligence powered by the Tenero API (api.tenero.io, formerly STXTools). Surfaces market momentum, whale activity, trending pools, and portfolio analytics — all read-only with zero authentication required.

Agents use this skill to make informed capital allocation decisions: which tokens are gaining, which pools have volume, where whales are moving capital, and what their own wallet holds.

## Why agents need it

Without market intelligence, agents allocate capital blind. This skill gives agents a live market pulse:

1. **Spot momentum early** — top gainers and losers reveal where capital is flowing before it becomes consensus
2. **Find yield** — trending pools show which liquidity pairs are generating the most fee revenue
3. **Follow smart money** — whale trade alerts surface large-conviction moves worth investigating
4. **Know your portfolio** — wallet holdings with current USD value for precise rebalancing decisions
5. **Deep token research** — price history, holder distribution, and pool liquidity in one command

## Tenero API integration

Direct integration with Tenero API at `https://api.tenero.io`:
- No API key required — fully public endpoints
- Covers Stacks, Spark, and SportsFun chains
- Endpoint pattern: `/v1/{chain}/{resource}`
- Real-time market data with sub-minute freshness

## Commands

### `doctor`
Check Tenero API connectivity and wallet environment.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts doctor
```

### `run --action=market-stats`
Overall Stacks market statistics: volume, active traders, netflow.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=market-stats
```

### `run --action=top-gainers`
Top gaining tokens by 24h price change percentage.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=top-gainers --limit=10
```

### `run --action=top-losers`
Top losing tokens by 24h price change. Useful for contrarian strategies.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=top-losers --limit=10
```

### `run --action=trending-pools`
Trending DEX pools by 1h volume. Identifies where liquidity fees are richest.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=trending-pools --limit=10
```

### `run --action=whale-trades`
Recent large trades above threshold. Follow smart money.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=whale-trades --min-usd=10000
```

### `run --action=token-info`
Full token profile: price, market cap, 24h volume, holder count.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=token-info --token=SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex
```

### `run --action=wallet-holdings`
Token portfolio with current USD value for any address.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=wallet-holdings --address=SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
```

### `run --action=wallet-trades`
Trade history for any address.

```bash
bun run tenero-market-pulse/tenero-market-pulse.ts run --action=wallet-trades --address=SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH --limit=20
```

## Output contract

All commands emit structured JSON:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {},
  "error": null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `api_unreachable` | Tenero API not responding |
| `token_not_found` | Token contract ID not recognized |
| `invalid_address` | Stacks address format invalid |
| `no_wallet` | Wallet environment not configured |

## Architecture

```
Agent invokes skill
  -> doctor: Tenero API ping + wallet env check
  -> market-stats: GET /v1/stacks/market/stats
  -> top-gainers: GET /v1/stacks/market/top_gainers
  -> top-losers: GET /v1/stacks/market/top_losers
  -> trending-pools: GET /v1/stacks/pools/trending/1h
  -> whale-trades: GET /v1/stacks/market/whale_trades
  -> token-info: GET /v1/stacks/tokens/{contractId}
  -> wallet-holdings: GET /v1/stacks/wallets/{address}/holdings_value
  -> wallet-trades: GET /v1/stacks/wallets/{address}/trades
```

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Agent | Mighty Scorpion — SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH |
| BTC Address | bc1qzae8q0fy2s52aasspr4c260mw7fp6q0uqjlrgx |
| Network | Stacks mainnet |
