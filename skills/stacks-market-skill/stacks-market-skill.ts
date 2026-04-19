#!/usr/bin/env bun
/**
 * stacks-market-skill — Stacks prediction market monitor and trader
 *
 * Lists active prediction markets, checks positions, quotes trades,
 * and executes buy/sell/redeem via Stacks on-chain contracts.
 * All write actions gated behind --confirm.
 *
 * Usage:
 *   bun stacks-market-skill/stacks-market-skill.ts doctor
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=list [--search=<term>]
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=get --market-id=<id>
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=position --market-id=<id>
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=quote-buy --market-id=<id> --outcome=yes|no --shares=<n>
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=buy --market-id=<id> --outcome=yes|no --shares=<n> [--confirm]
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=sell --market-id=<id> --outcome=yes|no --shares=<n> [--confirm]
 *   bun stacks-market-skill/stacks-market-skill.ts run --action=redeem --market-id=<id> [--confirm]
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";

// Stacks Prediction Market contract
// Community prediction market on Stacks mainnet
const MARKET_CONTRACT_ADDR = "SP2C2YFP12AJZB4MABJMANXJAM4MV5RD5VCRCJ7KN";
const MARKET_CONTRACT_NAME = "stacks-market-v1";
const MARKET_CONTRACT = `${MARKET_CONTRACT_ADDR}.${MARKET_CONTRACT_NAME}`;
const READ_SENDER = "SP000000000000000000002Q6VF78";

const MAX_TRADE_WARNING_PCT = 10; // warn if trade > 10% of balance

// ─── Types ───────────────────────────────────────────────────────────────────

interface Market {
  market_id: string;
  title: string;
  yes_price: string;
  no_price: string;
  deadline: string;
  status: "active" | "resolved" | "expired";
  outcome?: "yes" | "no";
  total_shares: string;
  total_stx: string;
}

interface Position {
  yes_shares: number;
  no_shares: number;
  total_value_stx: number;
}

interface SkillOutput {
  status: "success" | "error" | "preview" | "blocked";
  action: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next: string } | null;
}

// ─── Wallet resolution ────────────────────────────────────────────────────────

function resolveWalletAddress(): string | null {
  if (process.env.STACKS_ADDRESS) return process.env.STACKS_ADDRESS;
  // Check standard wallet file locations
  const home = process.env.HOME ?? "";
  const walletPaths = [
    path.join(home, ".aibtc", "wallet.json"),
    path.join(home, ".config", "aibtc", "wallet.json"),
    "wallet.json",
  ];
  for (const p of walletPaths) {
    try {
      if (fs.existsSync(p)) {
        const w = JSON.parse(fs.readFileSync(p, "utf8"));
        if (w.stxAddress) return w.stxAddress;
        if (w.address) return w.address;
      }
    } catch {
      // continue
    }
  }
  return null;
}

// ─── Hiro API helpers ─────────────────────────────────────────────────────────

async function hiroGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HIRO_API}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Hiro API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function readOnly<T>(
  contractAddr: string,
  contractName: string,
  fnName: string,
  args: string[] = []
): Promise<T> {
  const body = JSON.stringify({
    sender: READ_SENDER,
    arguments: args,
  });
  const res = await fetch(
    `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fnName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    }
  );
  if (!res.ok) throw new Error(`read-only ${fnName} returned ${res.status}`);
  const json = await res.json() as { okay: boolean; result: T };
  if (!json.okay) throw new Error(`read-only ${fnName} returned error`);
  return json.result;
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(code: string, message: string, next: string): void {
  out({ status: "error", action: next, error: { code, message, next } });
}

function fmtStx(microStx: number): string {
  return (microStx / 1_000_000).toFixed(6);
}

// ─── Market data fetching ────────────────────────────────────────────────────
// Uses Hiro's contract events and token endpoints to enumerate markets

async function fetchMarkets(): Promise<Market[]> {
  // Fetch contract events to find market creation events
  const events = await hiroGet<{ results: Array<{ event_type: string; data: Record<string, unknown> }> }>(
    `/extended/v1/contract/${MARKET_CONTRACT}/events?limit=50`
  );

  // Parse market creation events
  const markets: Market[] = [];
  const seen = new Set<string>();

  for (const event of events.results ?? []) {
    if (event.event_type !== "smart_contract_log") continue;
    const data = event.data as Record<string, unknown>;
    const repr = String(data.repr ?? "");

    // Extract market IDs from event logs
    const idMatch = repr.match(/market-id u(\d+)/);
    if (!idMatch) continue;
    const marketId = idMatch[1];
    if (seen.has(marketId)) continue;
    seen.add(marketId);

    // Fetch market detail via read-only call
    try {
      const detail = await readOnly<string>(
        MARKET_CONTRACT_ADDR,
        MARKET_CONTRACT_NAME,
        "get-market",
        [`u${marketId}`]
      );

      // Parse Clarity response
      const market = parseMarket(marketId, detail);
      if (market) markets.push(market);
    } catch {
      // Skip markets that fail to parse
    }
  }

  return markets;
}

function parseMarket(id: string, clarityRepr: string): Market | null {
  // Parse Clarity tuple representation
  // (tuple (title "...") (status u0) (yes-shares u...) (no-shares u...) ...)
  try {
    const title = clarityRepr.match(/title "([^"]+)"/)?.[1] ?? `Market ${id}`;
    const status = clarityRepr.includes("status u0")
      ? "active"
      : clarityRepr.includes("status u1")
      ? "resolved"
      : "expired";
    const yesShares = parseInt(clarityRepr.match(/yes-shares u(\d+)/)?.[1] ?? "0");
    const noShares = parseInt(clarityRepr.match(/no-shares u(\d+)/)?.[1] ?? "0");
    const totalShares = yesShares + noShares;
    const yesPrice = totalShares > 0 ? (yesShares / totalShares).toFixed(3) : "0.500";
    const noPrice = totalShares > 0 ? (noShares / totalShares).toFixed(3) : "0.500";
    const deadline = clarityRepr.match(/deadline u(\d+)/)?.[1] ?? "0";
    const totalStx = clarityRepr.match(/total-stx u(\d+)/)?.[1] ?? "0";

    return {
      market_id: id,
      title,
      yes_price: yesPrice,
      no_price: noPrice,
      deadline,
      status: status as Market["status"],
      total_shares: String(totalShares),
      total_stx: fmtStx(parseInt(totalStx)),
    };
  } catch {
    return null;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  try {
    // Check Hiro API health
    const info = await hiroGet<{ burn_block_height: number }>("/v2/info");
    if (!info.burn_block_height) throw new Error("Missing block height");

    // Try to fetch contract info
    const contract = await hiroGet<{ tx_id: string }>(
      `/extended/v1/contract/${MARKET_CONTRACT}`
    );

    out({
      status: "success",
      action: "Stacks prediction market contract reachable — use run --action=list to browse markets",
      data: {
        hiro_api: "ok",
        stacks_block: info.burn_block_height,
        market_contract: MARKET_CONTRACT,
        contract_deployed: !!contract.tx_id,
      },
    });
  } catch (e) {
    errOut("hiro_api_unreachable", `Cannot reach Hiro API or market contract: ${e}`, "Check network connectivity");
  }
}

async function runList(searchTerm?: string): Promise<void> {
  let markets: Market[];
  try {
    markets = await fetchMarkets();
  } catch (e) {
    errOut("hiro_api_unreachable", `Failed to fetch markets: ${e}`, "Check Hiro API connectivity");
    return;
  }

  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    markets = markets.filter((m) => m.title.toLowerCase().includes(term));
  }

  // Sort: active first, then by total STX
  markets.sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (b.status === "active" && a.status !== "active") return 1;
    return parseFloat(b.total_stx) - parseFloat(a.total_stx);
  });

  const active = markets.filter((m) => m.status === "active");

  out({
    status: "success",
    action: "Pick a market and use run --action=get --market-id=<id> for full detail",
    data: {
      markets: markets.slice(0, 20),
      total_active: active.length,
      total_markets: markets.length,
    },
  });
}

async function runGet(marketId: string): Promise<void> {
  try {
    const detail = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-market",
      [`u${marketId}`]
    );
    const market = parseMarket(marketId, detail);
    if (!market) {
      errOut("market_not_found", `Market ${marketId} not found or could not be parsed`, "Check market ID with run --action=list");
      return;
    }
    out({
      status: "success",
      action:
        market.status === "active"
          ? "Use run --action=quote-buy to get trade price"
          : market.status === "resolved"
          ? "Market resolved — use run --action=redeem to claim winnings"
          : "Market has expired",
      data: market,
    });
  } catch (e) {
    errOut("market_not_found", `Market ${marketId} not found: ${e}`, "Check market ID with run --action=list");
  }
}

async function runPosition(marketId: string): Promise<void> {
  const address = resolveWalletAddress();
  if (!address) {
    errOut("no_wallet_address", "No wallet address found", "Set STACKS_ADDRESS environment variable");
    return;
  }

  try {
    // Check YES share balance
    const yesResult = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-shares",
      [`u${marketId}`, `'${address}`, `"yes"`]
    );
    const noResult = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-shares",
      [`u${marketId}`, `'${address}`, `"no"`]
    );

    const yesShares = parseInt(yesResult.replace(/[^0-9]/g, "") || "0");
    const noShares = parseInt(noResult.replace(/[^0-9]/g, "") || "0");

    if (yesShares === 0 && noShares === 0) {
      out({
        status: "success",
        action: "No position in this market — use run --action=buy to enter",
        data: {
          market_id: marketId,
          address,
          yes_shares: 0,
          no_shares: 0,
          has_position: false,
        },
      });
      return;
    }

    out({
      status: "success",
      action: yesShares > 0 || noShares > 0
        ? "You have an active position — use run --action=sell to exit or run --action=redeem after resolution"
        : "No active position",
      data: {
        market_id: marketId,
        address,
        yes_shares: yesShares,
        no_shares: noShares,
        has_position: true,
      },
    });
  } catch (e) {
    errOut("position_fetch_failed", `Could not fetch position: ${e}`, "Check market ID and wallet address");
  }
}

async function runQuoteBuy(marketId: string, outcome: string, shares: number): Promise<void> {
  if (outcome !== "yes" && outcome !== "no") {
    errOut("invalid_outcome", "Outcome must be 'yes' or 'no'", "Use --outcome=yes or --outcome=no");
    return;
  }

  try {
    const detail = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-market",
      [`u${marketId}`]
    );
    const market = parseMarket(marketId, detail);
    if (!market) {
      errOut("market_not_found", `Market ${marketId} not found`, "Check market ID with run --action=list");
      return;
    }
    if (market.status !== "active") {
      errOut("market_not_active", `Market ${marketId} is ${market.status}`, "Only active markets can be traded");
      return;
    }

    const price = parseFloat(outcome === "yes" ? market.yes_price : market.no_price);
    const totalCost = shares * price;
    const priceImpact = (shares / (parseFloat(market.total_shares) + shares)) * 100;

    out({
      status: "success",
      action: "Use run --action=buy --confirm to execute this trade",
      data: {
        market_id: marketId,
        outcome,
        shares,
        price_per_share: price.toFixed(4),
        cost_stx: totalCost.toFixed(4),
        price_impact_pct: priceImpact.toFixed(3),
        warning: priceImpact > 2 ? `High price impact: ${priceImpact.toFixed(2)}%` : null,
      },
    });
  } catch (e) {
    errOut("quote_failed", `Could not compute quote: ${e}`, "Check market ID and connectivity");
  }
}

async function runBuy(
  marketId: string,
  outcome: string,
  shares: number,
  confirm: boolean
): Promise<void> {
  if (outcome !== "yes" && outcome !== "no") {
    errOut("invalid_outcome", "Outcome must be 'yes' or 'no'", "Use --outcome=yes or --outcome=no");
    return;
  }

  try {
    const detail = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-market",
      [`u${marketId}`]
    );
    const market = parseMarket(marketId, detail);
    if (!market || market.status !== "active") {
      errOut("market_not_active", `Market ${marketId} is not active`, "Only active markets can be traded");
      return;
    }

    const price = parseFloat(outcome === "yes" ? market.yes_price : market.no_price);
    const totalCost = shares * price;

    if (!confirm) {
      out({
        status: "preview",
        action: "Add --confirm to execute this buy on-chain",
        data: {
          market_id: marketId,
          outcome,
          shares,
          cost_stx: totalCost.toFixed(4),
          price_per_share: price.toFixed(4),
          next_step: "Re-run with --confirm to broadcast transaction",
        },
        error: null,
      });
      return;
    }

    out({
      status: "success",
      action: "Buy execution ready — parent agent should call stacks_market_buy_yes or stacks_market_buy_no",
      data: {
        execution_intent: outcome === "yes" ? "stacks_market_buy_yes" : "stacks_market_buy_no",
        params: {
          market_id: marketId,
          shares: String(shares),
          max_cost_stx: String((totalCost * 1.01).toFixed(4)),
        },
      },
      error: null,
    });
  } catch (e) {
    errOut("buy_failed", `Could not prepare buy: ${e}`, "Check market ID and wallet connectivity");
  }
}

async function runSell(
  marketId: string,
  outcome: string,
  shares: number,
  confirm: boolean
): Promise<void> {
  if (!confirm) {
    out({
      status: "preview",
      action: "Add --confirm to execute this sell on-chain",
      data: {
        market_id: marketId,
        outcome,
        shares,
        next_step: "Re-run with --confirm to broadcast transaction",
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "Sell execution ready — parent agent should call stacks_market_sell_yes or stacks_market_sell_no",
    data: {
      execution_intent: outcome === "yes" ? "stacks_market_sell_yes" : "stacks_market_sell_no",
      params: {
        market_id: marketId,
        shares: String(shares),
      },
    },
    error: null,
  });
}

async function runRedeem(marketId: string, confirm: boolean): Promise<void> {
  try {
    const detail = await readOnly<string>(
      MARKET_CONTRACT_ADDR,
      MARKET_CONTRACT_NAME,
      "get-market",
      [`u${marketId}`]
    );
    const market = parseMarket(marketId, detail);
    if (!market) {
      errOut("market_not_found", `Market ${marketId} not found`, "Check market ID with run --action=list");
      return;
    }
    if (market.status !== "resolved") {
      errOut("market_not_resolved", `Market ${marketId} has not resolved yet (status: ${market.status})`, "Wait for market resolution before redeeming");
      return;
    }

    if (!confirm) {
      out({
        status: "preview",
        action: "Add --confirm to redeem your winning shares",
        data: {
          market_id: marketId,
          outcome: market.outcome ?? "unknown",
          next_step: "Re-run with --confirm to claim winnings",
        },
        error: null,
      });
      return;
    }

    out({
      status: "success",
      action: "Redeem execution ready — parent agent should call stacks_market_redeem",
      data: {
        execution_intent: "stacks_market_redeem",
        params: { market_id: marketId },
      },
      error: null,
    });
  } catch (e) {
    errOut("redeem_failed", `Could not prepare redeem: ${e}`, "Check market ID and resolution status");
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("stacks-market-skill")
  .description("Stacks prediction market monitor and trader for aibtc agents");

program
  .command("doctor")
  .description("Check Stacks market contract connectivity")
  .action(async () => {
    await runDoctor();
  });

program
  .command("run")
  .description("Execute a skill action")
  .requiredOption(
    "--action <action>",
    "Action: list | get | position | quote-buy | buy | sell | redeem"
  )
  .option("--search <term>", "Search markets by title keyword")
  .option("--market-id <id>", "Market ID")
  .option("--outcome <outcome>", "yes or no")
  .option("--shares <n>", "Number of shares", parseInt)
  .option("--confirm", "Confirm write actions")
  .action(async (opts) => {
    switch (opts.action) {
      case "list":
        await runList(opts.search);
        break;
      case "get":
        if (!opts.marketId) {
          errOut("missing_params", "get requires --market-id", "Example: run --action=get --market-id=1");
          break;
        }
        await runGet(opts.marketId);
        break;
      case "position":
        if (!opts.marketId) {
          errOut("missing_params", "position requires --market-id", "Example: run --action=position --market-id=1");
          break;
        }
        await runPosition(opts.marketId);
        break;
      case "quote-buy":
        if (!opts.marketId || !opts.outcome || !opts.shares) {
          errOut("missing_params", "quote-buy requires --market-id, --outcome, --shares", "Example: run --action=quote-buy --market-id=1 --outcome=yes --shares=100");
          break;
        }
        await runQuoteBuy(opts.marketId, opts.outcome, opts.shares);
        break;
      case "buy":
        if (!opts.marketId || !opts.outcome || !opts.shares) {
          errOut("missing_params", "buy requires --market-id, --outcome, --shares", "Example: run --action=buy --market-id=1 --outcome=yes --shares=100 --confirm");
          break;
        }
        await runBuy(opts.marketId, opts.outcome, opts.shares, !!opts.confirm);
        break;
      case "sell":
        if (!opts.marketId || !opts.outcome || !opts.shares) {
          errOut("missing_params", "sell requires --market-id, --outcome, --shares", "Example: run --action=sell --market-id=1 --outcome=yes --shares=50 --confirm");
          break;
        }
        await runSell(opts.marketId, opts.outcome, opts.shares, !!opts.confirm);
        break;
      case "redeem":
        if (!opts.marketId) {
          errOut("missing_params", "redeem requires --market-id", "Example: run --action=redeem --market-id=1 --confirm");
          break;
        }
        await runRedeem(opts.marketId, !!opts.confirm);
        break;
      default:
        errOut("unknown_action", `Unknown action: ${opts.action}`, "Valid: list | get | position | quote-buy | buy | sell | redeem");
    }
  });

program.parse();
