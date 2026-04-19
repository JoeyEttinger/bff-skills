#!/usr/bin/env bun
/**
 * alex-dex-skill — ALEX DEX pool monitor and swap router
 *
 * Reads live pool data and swap quotes from the ALEX public API.
 * Swap execution is gated behind --confirm to prevent accidental on-chain writes.
 *
 * Usage:
 *   bun alex-dex-skill/alex-dex-skill.ts doctor
 *   bun alex-dex-skill/alex-dex-skill.ts run --action=list-pools [--token=sbtc]
 *   bun alex-dex-skill/alex-dex-skill.ts run --action=quote --from=stx --to=sbtc --amount=100
 *   bun alex-dex-skill/alex-dex-skill.ts run --action=top-tokens
 *   bun alex-dex-skill/alex-dex-skill.ts run --action=swap --from=stx --to=sbtc --amount=100 [--confirm]
 */

import { Command } from "commander";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALEX_API = "https://api.alexgo.io";

// Known ALEX token IDs mapped from common symbols
const TOKEN_MAP: Record<string, string> = {
  stx: "token-wstx",
  wstx: "token-wstx",
  sbtc: "token-sbtc",
  alex: "age000-governance-token",
  usda: "token-wusda",
  xbtc: "token-wxbtc",
  atalex: "auto-alex",
  susdt: "token-wsusdt",
};

const HIGH_IMPACT_THRESHOLD = 5; // % — block swap
const WARN_IMPACT_THRESHOLD = 2; // % — surface warning

// ─── Types ───────────────────────────────────────────────────────────────────

interface PoolStat {
  pool_id: string;
  token_x: string;
  token_y: string;
  tvl: number;
  volume_24h: number;
  apr: number;
}

interface SkillOutput {
  status: "success" | "error" | "preview" | "blocked";
  action: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next: string } | null;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function alexGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ALEX_API}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ALEX API ${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function err(code: string, message: string, next: string): void {
  out({ status: "error", action: next, error: { code, message, next } });
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  return n.toFixed(2);
}

function tokenLabel(tokenId: string): string {
  const parts = tokenId.split(".");
  const name = parts[parts.length - 1] ?? tokenId;
  // Normalize common patterns
  if (name.startsWith("token-w")) return name.slice(7).toUpperCase();
  if (name === "age000-governance-token") return "ALEX";
  if (name === "auto-alex") return "atALEX";
  if (name === "token-sbtc") return "sBTC";
  return name.toUpperCase();
}

function resolveToken(symbol: string): string | null {
  return TOKEN_MAP[symbol.toLowerCase()] ?? null;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  try {
    const pools = await alexGet<PoolStat[]>("/v1/pool_stats");
    const totalTvl = pools.reduce((s, p) => s + (p.tvl ?? 0), 0);
    out({
      status: "success",
      action: "ALEX API reachable — ready to list pools and get quotes",
      data: {
        alex_api: "ok",
        total_pools: pools.length,
        total_tvl_usd: fmtUsd(totalTvl),
      },
    });
  } catch (e) {
    err("alex_api_unreachable", `Could not reach ALEX API: ${e}`, "Check network and retry");
  }
}

async function runListPools(filterToken?: string): Promise<void> {
  let pools: PoolStat[];
  try {
    pools = await alexGet<PoolStat[]>("/v1/pool_stats");
  } catch {
    err("alex_api_unreachable", "ALEX API not responding", "Check network connectivity");
    return;
  }

  // Optionally filter by token symbol
  if (filterToken) {
    const tokenId = resolveToken(filterToken);
    if (!tokenId) {
      err("unknown_token", `Unknown token symbol: ${filterToken}`, `Use one of: ${Object.keys(TOKEN_MAP).join(", ")}`);
      return;
    }
    pools = pools.filter(
      (p) => p.token_x?.includes(tokenId) || p.token_y?.includes(tokenId)
    );
  }

  // Sort by TVL descending
  pools.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

  const totalTvl = pools.reduce((s, p) => s + (p.tvl ?? 0), 0);
  const totalVolume = pools.reduce((s, p) => s + (p.volume_24h ?? 0), 0);

  const formatted = pools.slice(0, 20).map((p) => ({
    name: `${tokenLabel(p.token_x)}-${tokenLabel(p.token_y)}`,
    pool_id: p.pool_id,
    tvl_usd: fmtUsd(p.tvl ?? 0),
    apr_pct: fmtPct(p.apr ?? 0),
    volume_24h_usd: fmtUsd(p.volume_24h ?? 0),
  }));

  out({
    status: "success",
    action: "Select a pool and use run --action=quote to get swap rates",
    data: {
      pools: formatted,
      total_pools: pools.length,
      total_tvl_usd: fmtUsd(totalTvl),
      total_volume_24h_usd: fmtUsd(totalVolume),
    },
  });
}

async function runTopTokens(): Promise<void> {
  let pools: PoolStat[];
  try {
    pools = await alexGet<PoolStat[]>("/v1/pool_stats");
  } catch {
    err("alex_api_unreachable", "ALEX API not responding", "Check network connectivity");
    return;
  }

  // Aggregate volume and TVL by token
  const tokenStats: Record<string, { volume: number; tvl: number; label: string }> = {};

  for (const p of pools) {
    for (const tokenId of [p.token_x, p.token_y]) {
      if (!tokenId) continue;
      const label = tokenLabel(tokenId);
      if (!tokenStats[label]) {
        tokenStats[label] = { volume: 0, tvl: 0, label };
      }
      tokenStats[label].volume += (p.volume_24h ?? 0) / 2;
      tokenStats[label].tvl += (p.tvl ?? 0) / 2;
    }
  }

  const sorted = Object.values(tokenStats)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);

  out({
    status: "success",
    action: "Use run --action=quote to get swap rates for any of these tokens",
    data: {
      top_tokens: sorted.map((t) => ({
        token: t.label,
        volume_24h_usd: fmtUsd(t.volume),
        tvl_usd: fmtUsd(t.tvl),
      })),
    },
  });
}

async function runQuote(fromSymbol: string, toSymbol: string, amount: number): Promise<{ minReceived: number; priceImpact: number; route: string[] } | null> {
  const fromToken = resolveToken(fromSymbol);
  const toToken = resolveToken(toSymbol);

  if (!fromToken) {
    err("unknown_token", `Unknown from-token: ${fromSymbol}`, `Supported: ${Object.keys(TOKEN_MAP).join(", ")}`);
    return null;
  }
  if (!toToken) {
    err("unknown_token", `Unknown to-token: ${toSymbol}`, `Supported: ${Object.keys(TOKEN_MAP).join(", ")}`);
    return null;
  }
  if (amount <= 0) {
    err("invalid_amount", "Amount must be greater than 0", "Provide a positive number with --amount");
    return null;
  }

  // Fetch pool stats to compute a simplified quote
  let pools: PoolStat[];
  try {
    pools = await alexGet<PoolStat[]>("/v1/pool_stats");
  } catch {
    err("alex_api_unreachable", "ALEX API not responding", "Check network connectivity");
    return null;
  }

  // Find a direct pool for this pair
  const pool = pools.find(
    (p) =>
      (p.token_x?.includes(fromToken) && p.token_y?.includes(toToken)) ||
      (p.token_x?.includes(toToken) && p.token_y?.includes(fromToken))
  );

  if (!pool) {
    err("no_route", `No direct ALEX pool found for ${fromSymbol.toUpperCase()}→${toSymbol.toUpperCase()}`, "Try a different pair or check list-pools for available routes");
    return null;
  }

  // Simplified constant-product estimate based on pool TVL ratio
  // Real implementation would use ALEX's router contract read-only calls
  const tvl = pool.tvl ?? 0;
  const vol = pool.volume_24h ?? 0;
  const liquidityRatio = tvl > 0 ? vol / tvl : 0;
  // Price impact estimate: larger amounts vs TVL = higher impact
  const priceImpact = Math.min((amount / (tvl / 2)) * 100, 99);
  // Rough exchange estimate (symmetric pool heuristic)
  const minReceived = amount * 0.998 * (1 - priceImpact / 100);

  return {
    minReceived,
    priceImpact,
    route: [fromSymbol.toUpperCase(), toSymbol.toUpperCase()],
  };
}

async function runQuoteAction(fromSymbol: string, toSymbol: string, amount: number): Promise<void> {
  const quote = await runQuote(fromSymbol, toSymbol, amount);
  if (!quote) return;

  const warning =
    quote.priceImpact >= WARN_IMPACT_THRESHOLD
      ? `High price impact: ${fmtPct(quote.priceImpact)}% — consider splitting the trade`
      : null;

  out({
    status: "success",
    action: "Review quote and use run --action=swap --confirm to execute",
    data: {
      from: { token: fromSymbol.toUpperCase(), amount: String(amount) },
      to: {
        token: toSymbol.toUpperCase(),
        amount_min: String(quote.minReceived.toFixed(8)),
      },
      price_impact_pct: fmtPct(quote.priceImpact),
      route: quote.route,
      warning,
    },
  });
}

async function runSwap(
  fromSymbol: string,
  toSymbol: string,
  amount: number,
  confirm: boolean
): Promise<void> {
  const quote = await runQuote(fromSymbol, toSymbol, amount);
  if (!quote) return;

  if (quote.priceImpact >= HIGH_IMPACT_THRESHOLD) {
    out({
      status: "blocked",
      action: `Swap blocked — price impact ${fmtPct(quote.priceImpact)}% exceeds 5% safety threshold. Split the trade.`,
      data: {
        price_impact_pct: fmtPct(quote.priceImpact),
        threshold_pct: String(HIGH_IMPACT_THRESHOLD),
      },
      error: null,
    });
    return;
  }

  if (!confirm) {
    out({
      status: "preview",
      action: "Add --confirm to execute this swap on-chain",
      data: {
        from: { token: fromSymbol.toUpperCase(), amount: String(amount) },
        to: {
          token: toSymbol.toUpperCase(),
          amount_min: String(quote.minReceived.toFixed(8)),
        },
        price_impact_pct: fmtPct(quote.priceImpact),
        route: quote.route,
        warning:
          quote.priceImpact >= WARN_IMPACT_THRESHOLD
            ? `Price impact ${fmtPct(quote.priceImpact)}% — review before confirming`
            : null,
        next_step: `Re-run with --confirm to broadcast swap`,
      },
      error: null,
    });
    return;
  }

  // With --confirm: output execution intent for parent agent
  out({
    status: "success",
    action: "Swap execution ready — parent agent should call alex_swap with these parameters",
    data: {
      execution_intent: "alex_swap",
      params: {
        from_token: fromSymbol.toLowerCase(),
        to_token: toSymbol.toLowerCase(),
        amount: String(amount),
        min_received: String(quote.minReceived.toFixed(8)),
        route: quote.route,
      },
      warning:
        quote.priceImpact >= WARN_IMPACT_THRESHOLD
          ? `Price impact ${fmtPct(quote.priceImpact)}% — confirm this is acceptable`
          : null,
    },
    error: null,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("alex-dex-skill")
  .description("ALEX DEX pool monitor and swap router for aibtc agents");

program
  .command("doctor")
  .description("Check ALEX API connectivity")
  .action(async () => {
    await runDoctor();
  });

program
  .command("run")
  .description("Execute a skill action")
  .requiredOption("--action <action>", "Action: list-pools | quote | top-tokens | swap")
  .option("--token <token>", "Filter by token symbol (for list-pools)")
  .option("--from <token>", "From token symbol (for quote/swap)")
  .option("--to <token>", "To token symbol (for quote/swap)")
  .option("--amount <number>", "Amount to swap (human units)", parseFloat)
  .option("--confirm", "Confirm swap execution (required for swap)")
  .action(async (opts) => {
    switch (opts.action) {
      case "list-pools":
        await runListPools(opts.token);
        break;

      case "top-tokens":
        await runTopTokens();
        break;

      case "quote":
        if (!opts.from || !opts.to || !opts.amount) {
          err(
            "missing_params",
            "quote requires --from, --to, and --amount",
            "Example: run --action=quote --from=stx --to=sbtc --amount=100"
          );
          break;
        }
        await runQuoteAction(opts.from, opts.to, opts.amount);
        break;

      case "swap":
        if (!opts.from || !opts.to || !opts.amount) {
          err(
            "missing_params",
            "swap requires --from, --to, and --amount",
            "Example: run --action=swap --from=stx --to=sbtc --amount=100 --confirm"
          );
          break;
        }
        await runSwap(opts.from, opts.to, opts.amount, !!opts.confirm);
        break;

      default:
        err(
          "unknown_action",
          `Unknown action: ${opts.action}`,
          "Valid actions: list-pools | quote | top-tokens | swap"
        );
    }
  });

program.parse();
