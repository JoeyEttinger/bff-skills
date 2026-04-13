#!/usr/bin/env bun
/**
 * tenero-market-pulse — Stacks Ecosystem Market Intelligence
 *
 * Real-time market analytics for the Stacks ecosystem via the Tenero API
 * (api.tenero.io). Surfaces top gainers/losers, trending pools, whale trades,
 * and wallet portfolio data. All read-only — no authentication required.
 *
 * Author: Mighty Scorpion (JoeyEttinger)
 * Agent: SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
 */

import { Command } from "commander";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const TENERO_BASE = "https://api.tenero.io";
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT = 15_000;
const VERSION = "1.0.0";

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function out(status: "success" | "error" | "blocked", action: string, data: unknown, error: unknown = null) {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}

function outError(action: string, code: string, message: string, next: string) {
  out("error", action, {}, { code, message, next });
}

// ═══════════════════════════════════════════════════════════════════════════
// TENERO API CLIENT
// ═══════════════════════════════════════════════════════════════════════════
async function fetchTenero(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${TENERO_BASE}${path}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`Tenero API ${response.status}: ${text}`);
    }
    const json = await response.json() as { statusCode?: number; message?: string; data?: unknown };
    // Tenero wraps in { statusCode, message, data }
    return json.data !== undefined ? json.data : json;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHiro(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${HIRO_API}${path}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`Hiro API ${response.status}: ${text}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("tenero-market-pulse")
  .version(VERSION)
  .description("Stacks ecosystem market intelligence via Tenero API");

// ───────────────────────────────────────────────────────────────────────────
// DOCTOR
// ───────────────────────────────────────────────────────────────────────────
program.command("doctor").description("Check API connectivity and environment").action(async () => {
  const checks: Record<string, unknown> = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    wallet: process.env.STACKS_ADDRESS ?? null,
  };

  // Check Tenero API
  try {
    const stats = await fetchTenero("/v1/stacks/market/stats");
    checks.tenero_api = "ok";
    checks.tenero_sample = stats;
  } catch (err) {
    checks.tenero_api = "error";
    checks.tenero_error = String(err);
    out("error", "Tenero API is unreachable. Check https://api.tenero.io", checks, {
      code: "api_unreachable",
      message: String(err),
      next: "Verify network connectivity and retry.",
    });
    return;
  }

  // Check Hiro API
  try {
    await fetchHiro("/v2/info");
    checks.hiro_api = "ok";
  } catch (err) {
    checks.hiro_api = "degraded";
    checks.hiro_error = String(err);
  }

  out("success", "All systems operational. Ready to query market data.", checks);
});

// ───────────────────────────────────────────────────────────────────────────
// RUN
// ───────────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute a market intelligence action")
  .requiredOption("--action <action>", "Action to execute")
  .option("--limit <n>", "Result limit", "10")
  .option("--token <contractId>", "Token contract ID (PRINCIPAL.name)")
  .option("--address <addr>", "Stacks address to query")
  .option("--min-usd <n>", "Minimum USD value for whale trades", "10000")
  .option("--chain <chain>", "Chain: stacks | spark | sportsfun", "stacks")
  .action(async (opts) => {
    const limit = parseInt(opts.limit, 10);
    const chain = opts.chain as string;
    const minUsd = parseFloat(opts.minUsd ?? "10000");

    switch (opts.action) {

      // ── market-stats ────────────────────────────────────────────────────
      case "market-stats": {
        try {
          const data = await fetchTenero(`/v1/${chain}/market/stats`);
          out("success", "Market stats fetched. Review volume and netflow for trend direction.", {
            chain,
            timestamp: new Date().toISOString(),
            stats: data,
          });
        } catch (err) {
          outError("Fetch market stats", "api_error", String(err), "Check Tenero API status.");
        }
        break;
      }

      // ── top-gainers ──────────────────────────────────────────────────────
      case "top-gainers": {
        try {
          const data = await fetchTenero(`/v1/${chain}/market/top_gainers?limit=${limit}`);
          out("success", `Top ${limit} gainers fetched. Tokens with >20% gain and pool depth >$50k warrant attention.`, {
            chain,
            limit,
            timestamp: new Date().toISOString(),
            gainers: data,
          });
        } catch (err) {
          outError("Fetch top gainers", "api_error", String(err), "Retry or check Tenero API.");
        }
        break;
      }

      // ── top-losers ───────────────────────────────────────────────────────
      case "top-losers": {
        try {
          const data = await fetchTenero(`/v1/${chain}/market/top_losers?limit=${limit}`);
          out("success", `Top ${limit} losers fetched. Oversold tokens with strong fundamentals may present contrarian entries.`, {
            chain,
            limit,
            timestamp: new Date().toISOString(),
            losers: data,
          });
        } catch (err) {
          outError("Fetch top losers", "api_error", String(err), "Retry or check Tenero API.");
        }
        break;
      }

      // ── trending-pools ───────────────────────────────────────────────────
      case "trending-pools": {
        try {
          const data = await fetchTenero(`/v1/${chain}/pools/trending/1h?limit=${limit}`);
          out("success", `Top ${limit} trending pools (1h volume) fetched. High-volume pools generate more LP fees.`, {
            chain,
            limit,
            window: "1h",
            timestamp: new Date().toISOString(),
            pools: data,
          });
        } catch (err) {
          outError("Fetch trending pools", "api_error", String(err), "Retry or check Tenero API.");
        }
        break;
      }

      // ── whale-trades ─────────────────────────────────────────────────────
      case "whale-trades": {
        try {
          const data = await fetchTenero(`/v1/${chain}/market/whale_trades?min_usd=${minUsd}&limit=${limit}`);
          out("success", `Whale trades >${minUsd} USD fetched. Multiple buys in same token signal coordinated accumulation.`, {
            chain,
            min_usd_threshold: minUsd,
            limit,
            timestamp: new Date().toISOString(),
            trades: data,
          });
        } catch (err) {
          outError("Fetch whale trades", "api_error", String(err), "Retry or check Tenero API.");
        }
        break;
      }

      // ── token-info ───────────────────────────────────────────────────────
      case "token-info": {
        if (!opts.token) {
          outError("Token info", "missing_param", "--token is required", "Provide token as PRINCIPAL.contract-name");
          break;
        }
        try {
          const [info, summary] = await Promise.allSettled([
            fetchTenero(`/v1/${chain}/tokens/${opts.token}`),
            fetchTenero(`/v1/${chain}/tokens/${opts.token}/market_summary`),
          ]);
          out("success", `Token info fetched for ${opts.token}. Review price, liquidity, and holder concentration.`, {
            chain,
            contractId: opts.token,
            timestamp: new Date().toISOString(),
            token: info.status === "fulfilled" ? info.value : { error: String((info as PromiseRejectedResult).reason) },
            market_summary: summary.status === "fulfilled" ? summary.value : { error: String((summary as PromiseRejectedResult).reason) },
          });
        } catch (err) {
          outError("Fetch token info", "api_error", String(err), "Verify contract ID format: PRINCIPAL.contract-name");
        }
        break;
      }

      // ── wallet-holdings ──────────────────────────────────────────────────
      case "wallet-holdings": {
        const addr = opts.address ?? process.env.STACKS_ADDRESS;
        if (!addr) {
          outError("Wallet holdings", "no_address", "--address required or STACKS_ADDRESS env must be set", "Provide --address flag");
          break;
        }
        try {
          const data = await fetchTenero(`/v1/${chain}/wallets/${addr}/holdings_value`);
          out("success", `Holdings fetched for ${addr}. Review concentration and USD value for rebalancing decisions.`, {
            chain,
            address: addr,
            timestamp: new Date().toISOString(),
            holdings: data,
          });
        } catch (err) {
          outError("Fetch wallet holdings", "api_error", String(err), "Verify address format and retry.");
        }
        break;
      }

      // ── wallet-trades ────────────────────────────────────────────────────
      case "wallet-trades": {
        const addr = opts.address ?? process.env.STACKS_ADDRESS;
        if (!addr) {
          outError("Wallet trades", "no_address", "--address required or STACKS_ADDRESS env must be set", "Provide --address flag");
          break;
        }
        try {
          const data = await fetchTenero(`/v1/${chain}/wallets/${addr}/trades?limit=${limit}`);
          out("success", `Trade history fetched for ${addr}. Review PnL patterns and token rotation strategy.`, {
            chain,
            address: addr,
            limit,
            timestamp: new Date().toISOString(),
            trades: data,
          });
        } catch (err) {
          outError("Fetch wallet trades", "api_error", String(err), "Verify address format and retry.");
        }
        break;
      }

      // ── holder-stats ─────────────────────────────────────────────────────
      case "holder-stats": {
        if (!opts.token) {
          outError("Holder stats", "missing_param", "--token is required", "Provide token as PRINCIPAL.contract-name");
          break;
        }
        try {
          const data = await fetchTenero(`/v1/${chain}/tokens/${opts.token}/holder_stats`);
          out("success", `Holder distribution fetched for ${opts.token}. High top-10 concentration = higher volatility risk.`, {
            chain,
            contractId: opts.token,
            timestamp: new Date().toISOString(),
            holder_stats: data,
          });
        } catch (err) {
          outError("Fetch holder stats", "api_error", String(err), "Verify contract ID and retry.");
        }
        break;
      }

      // ── search ───────────────────────────────────────────────────────────
      case "search": {
        if (!opts.token) {
          outError("Search", "missing_param", "--token is required as search query", "Provide --token <query>");
          break;
        }
        try {
          const data = await fetchTenero(`/v1/${chain}/search?q=${encodeURIComponent(opts.token)}&limit=${limit}`);
          out("success", `Search results for "${opts.token}" fetched.`, {
            chain,
            query: opts.token,
            limit,
            timestamp: new Date().toISOString(),
            results: data,
          });
        } catch (err) {
          outError("Search", "api_error", String(err), "Try a different search term.");
        }
        break;
      }

      default: {
        outError(
          `Unknown action: ${opts.action}`,
          "invalid_action",
          `Action "${opts.action}" is not supported`,
          "Valid actions: market-stats, top-gainers, top-losers, trending-pools, whale-trades, token-info, wallet-holdings, wallet-trades, holder-stats, search"
        );
      }
    }
  });

program.parse(process.argv);
