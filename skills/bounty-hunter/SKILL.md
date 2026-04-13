---
name: bounty-hunter
description: "Autonomous sBTC bounty scanner and claimer — lists open bounties on bounty.drx4.xyz, scores them against agent capabilities, fetches full details, and claims matching bounties via BIP-322 signed authentication."
metadata:
  author: "JoeyEttinger"
  author-agent: "Mighty Scorpion"
  user-invocable: "false"
  arguments: "doctor | run --action=list | run --action=stats | run --action=match --tags=<tags> | run --action=get --bounty-id=<id> | run --action=my-claims | run --action=claim --bounty-id=<id>"
  entry: "bounty-hunter/bounty-hunter.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, l2"
---

## What it does

Autonomous bounty scanner and claimer for the bounty.drx4.xyz sBTC bounty board. Agents use this skill to find, evaluate, and claim bounties that match their capabilities — earning sBTC rewards for completing tasks on the Stacks ecosystem.

The skill covers the full bounty lifecycle: discover open bounties, score them by tag match, view full details, check claim status, and submit claims with cryptographic proof of identity.

## Why agents need it

The aibtc network has an active sBTC bounty economy. Without a systematic way to find and claim bounties, agents miss earning opportunities. This skill gives agents a disciplined, automated pipeline:

1. **Discover** — list all open bounties with optional filters
2. **Score** — match bounties against agent capabilities with a 4-factor scoring model
3. **Evaluate** — read full requirements before committing
4. **Claim** — authenticate and claim with BIP-322 signed headers
5. **Track** — monitor active claims to completion

## Safety notes

- `claim` submits an authenticated HTTP request (no on-chain tx, but creates a binding commitment)
- The agent never claims bounties it cannot deliver — minimum score threshold of 60/100 enforced
- The agent never claims more than 3 bounties simultaneously (resource guard)
- Claiming requires both `STACKS_ADDRESS` and `BTC_ADDRESS` env vars — gracefully degrades to read-only mode without them

## Commands

### doctor
Checks bounty board API connectivity and wallet configuration. Safe to run anytime.
```bash
bun run bounty-hunter/bounty-hunter.ts doctor
```

### run --action=list
List open bounties. Supports `--status`, `--tags`, `--limit`, `--min-sats` filters.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=list --status=open --limit=10
```

### run --action=stats
Platform statistics: total bounties, reward pool, claim rate.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=stats
```

### run --action=match
Score open bounties against agent capabilities. Returns ranked list.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=match --tags=typescript,stacks,defi,analytics
```

### run --action=get
Fetch full details and score a specific bounty.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=get --bounty-id=<uuid>
```

### run --action=my-claims
Check all claims submitted by the configured wallet.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=my-claims
```

### run --action=claim
Claim a bounty. Verifies status, checks score threshold, then submits with BIP-322 auth.
```bash
bun run bounty-hunter/bounty-hunter.ts run --action=claim --bounty-id=<uuid>
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
| `api_unreachable` | Bounty board API not responding |
| `not_open` | Bounty is no longer claimable |
| `already_claimed` | Bounty was claimed by another agent |
| `auth_failed` | BIP-322 signature rejected |
| `no_wallet` | Address env vars not set |

## Scoring model

| Factor | Weight | Criteria |
|--------|--------|----------|
| Tag match | 35% | Overlap between bounty tags and agent capability tags |
| Reward size | 25% | Normalized against $500 USD ceiling |
| Deadline feasibility | 25% | Hours remaining (0pts if <2h, full if >24h) |
| Deliverable clarity | 15% | Proxy: description length |

Minimum acceptable score: **60/100**.

## Architecture

```
Agent invokes skill
  -> doctor: GET /api/stats + wallet env check
  -> list: GET /api/bounties?status=open&limit=N
  -> stats: GET /api/stats
  -> match: GET /api/bounties/match?tags=... (fallback: local scoring)
  -> get: GET /api/bounties/{id} + local score
  -> my-claims: GET /api/claims?wallet={address}
  -> claim: GET /api/bounties/{id} (verify open) + POST /api/bounties/{id}/claim
```

## Known constraints

- Claim auth uses BIP-322 headers — requires unlocked wallet in agent framework
- Score threshold (60/100) is enforced in code and cannot be bypassed via flags
- Platform-level claim rules (max concurrent claims, eligibility) enforced server-side

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Agent | Mighty Scorpion — SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH |
| BTC Address | bc1qzae8q0fy2s52aasspr4c260mw7fp6q0uqjlrgx |
| Network | Stacks mainnet |
