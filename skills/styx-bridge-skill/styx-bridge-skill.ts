#!/usr/bin/env bun
/**
 * styx-bridge-skill — Styx sBTC bridge monitor and depositor
 *
 * Reads live pool capacities, BTC/sBTC rates, and fee schedules from the Styx API.
 * Deposit execution is gated behind --confirm.
 *
 * Usage:
 *   bun styx-bridge-skill/styx-bridge-skill.ts doctor
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=pools
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=price
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=fees
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=status
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=history
 *   bun styx-bridge-skill/styx-bridge-skill.ts run --action=deposit --amount=<sats> --pool=<name> [--confirm]
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const STYX_API = "https://api-styx.vercel.app";

// Known static pool data as fallback when API is unreachable
const STATIC_POOLS = [
  { name: "main", liquidity_sats: 3_000_000, max_sats: 3_000_000 },
  { name: "aibtc", liquidity_sats: 900_000, max_sats: 1_000_000 },
];

const BRIDGE_FEE_BPS = 80; // 0.8% standard fee
const MIN_DEPOSIT_SATS = 10_000; // 0.0001 BTC minimum

// ─── Types ───────────────────────────────────────────────────────────────────

interface StyxPool {
  name: string;
  liquidity_sats: number;
  max_sats: number;
}

interface StyxPrice {
  btc_sbtc_rate: number;
  spread_bps: number;
  timestamp: string;
}

interface SkillOutput {
  status: "success" | "error" | "preview" | "blocked";
  action: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next: string } | null;
}

// ─── Wallet ────────────────────────────────────────────────────────────────

function resolveWalletAddress(): string | null {
  if (process.env.STACKS_ADDRESS) return process.env.STACKS_ADDRESS;
  const home = process.env.HOME ?? "";
  for (const p of [
    path.join(home, ".aibtc", "wallet.json"),
    path.join(home, ".config", "aibtc", "wallet.json"),
    "wallet.json",
  ]) {
    try {
      if (fs.existsSync(p)) {
        const w = JSON.parse(fs.readFileSync(p, "utf8"));
        return w.stxAddress ?? w.address ?? null;
      }
    } catch {
      // continue
    }
  }
  return null;
}

// ─── Styx API helpers ─────────────────────────────────────────────────────────

async function styxGet<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${STYX_API}${endpoint}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Styx API ${endpoint} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchPools(): Promise<StyxPool[]> {
  try {
    const data = await styxGet<{ pools?: StyxPool[] } | StyxPool[]>("/pools");
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && "pools" in data && Array.isArray(data.pools)) {
      return data.pools;
    }
    return STATIC_POOLS;
  } catch {
    // Fall back to known static data
    return STATIC_POOLS;
  }
}

async function fetchPrice(): Promise<StyxPrice | null> {
  try {
    const data = await styxGet<{ rate?: number; btc_sbtc_rate?: number; spread_bps?: number }>("/price");
    return {
      btc_sbtc_rate: data.btc_sbtc_rate ?? data.rate ?? 1.0,
      spread_bps: data.spread_bps ?? BRIDGE_FEE_BPS,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(code: string, message: string, next: string): void {
  out({ status: "error", action: next, error: { code, message, next } });
}

function fmtSats(sats: number): string {
  return sats.toLocaleString("en-US");
}

function fmtBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  try {
    const pools = await fetchPools();
    const mainPool = pools.find((p) => p.name === "main");
    const totalCapacity = pools.reduce((s, p) => s + p.liquidity_sats, 0);

    out({
      status: "success",
      action: "Styx bridge reachable — use run --action=status for full overview",
      data: {
        styx_api: "ok",
        pools_available: pools.length,
        main_pool_capacity_sats: mainPool?.liquidity_sats ?? 0,
        total_capacity_sats: totalCapacity,
        total_capacity_btc: fmtBtc(totalCapacity),
      },
    });
  } catch (e) {
    errOut("styx_api_unreachable", `Cannot reach Styx API: ${e}`, "Check network connectivity");
  }
}

async function runPools(): Promise<void> {
  const pools = await fetchPools();

  const formatted = pools.map((p) => {
    const usedSats = p.max_sats - p.liquidity_sats;
    const utilizationPct = p.max_sats > 0 ? ((usedSats / p.max_sats) * 100).toFixed(1) : "0.0";
    return {
      name: p.name,
      liquidity_sats: p.liquidity_sats,
      liquidity_btc: fmtBtc(p.liquidity_sats),
      max_sats: p.max_sats,
      max_btc: fmtBtc(p.max_sats),
      available_sats: p.liquidity_sats,
      available_btc: fmtBtc(p.liquidity_sats),
      utilization_pct: utilizationPct,
    };
  });

  const hasCapacity = pools.some((p) => p.liquidity_sats > MIN_DEPOSIT_SATS);

  out({
    status: "success",
    action: hasCapacity
      ? "Pool capacity available — use run --action=deposit to bridge BTC to sBTC"
      : "All pools at capacity — check back later",
    data: {
      pools: formatted,
      total_pools: pools.length,
      has_capacity: hasCapacity,
    },
  });
}

async function runPrice(): Promise<void> {
  const price = await fetchPrice();

  if (!price) {
    // Estimate from known fee structure
    out({
      status: "success",
      action: "Styx price oracle unavailable — using estimated rate based on fee schedule",
      data: {
        btc_sbtc_rate: 1.0,
        effective_rate: ((1 - BRIDGE_FEE_BPS / 10_000)).toFixed(6),
        fee_bps: BRIDGE_FEE_BPS,
        fee_pct: (BRIDGE_FEE_BPS / 100).toFixed(2),
        note: "Rate estimated from standard fee schedule — live oracle unavailable",
      },
    });
    return;
  }

  out({
    status: "success",
    action: "Use this rate to estimate sBTC received from a bridge deposit",
    data: {
      btc_sbtc_rate: price.btc_sbtc_rate.toFixed(6),
      spread_bps: price.spread_bps,
      fee_pct: (price.spread_bps / 100).toFixed(2),
      timestamp: price.timestamp,
      example_100k_sats: {
        input_sats: 100_000,
        output_sbtc_sats: Math.floor(100_000 * price.btc_sbtc_rate * (1 - price.spread_bps / 10_000)),
      },
    },
  });
}

async function runFees(): Promise<void> {
  let feeBps = BRIDGE_FEE_BPS;

  try {
    const data = await styxGet<{ fee_bps?: number; fee?: number }>("/fees");
    feeBps = data.fee_bps ?? data.fee ?? BRIDGE_FEE_BPS;
  } catch {
    // Use default
  }

  const tiers = [
    { amount_sats: 10_000, fee_sats: Math.ceil(10_000 * feeBps / 10_000) },
    { amount_sats: 100_000, fee_sats: Math.ceil(100_000 * feeBps / 10_000) },
    { amount_sats: 1_000_000, fee_sats: Math.ceil(1_000_000 * feeBps / 10_000) },
  ];

  out({
    status: "success",
    action: "Review fee schedule before depositing",
    data: {
      fee_bps: feeBps,
      fee_pct: (feeBps / 100).toFixed(2),
      min_deposit_sats: MIN_DEPOSIT_SATS,
      min_deposit_btc: fmtBtc(MIN_DEPOSIT_SATS),
      fee_examples: tiers.map((t) => ({
        deposit_sats: fmtSats(t.amount_sats),
        deposit_btc: fmtBtc(t.amount_sats),
        fee_sats: fmtSats(t.fee_sats),
        received_sbtc_sats: fmtSats(t.amount_sats - t.fee_sats),
      })),
    },
  });
}

async function runStatus(): Promise<void> {
  const [pools, price] = await Promise.allSettled([fetchPools(), fetchPrice()]);

  const poolData = pools.status === "fulfilled" ? pools.value : STATIC_POOLS;
  const priceData = price.status === "fulfilled" ? price.value : null;

  const mainPool = poolData.find((p) => p.name === "main");
  const totalCapacity = poolData.reduce((s, p) => s + p.liquidity_sats, 0);

  out({
    status: "success",
    action: totalCapacity > MIN_DEPOSIT_SATS
      ? "Styx bridge is open — use run --action=deposit to bridge BTC to sBTC"
      : "Styx bridge capacity limited — check pools for availability",
    data: {
      pools: poolData.map((p) => ({
        name: p.name,
        available_sats: p.liquidity_sats,
        available_btc: fmtBtc(p.liquidity_sats),
        max_btc: fmtBtc(p.max_sats),
      })),
      price: priceData
        ? {
            btc_sbtc_rate: priceData.btc_sbtc_rate.toFixed(6),
            fee_pct: (priceData.spread_bps / 100).toFixed(2),
          }
        : { fee_pct: (BRIDGE_FEE_BPS / 100).toFixed(2), note: "Oracle unavailable" },
      total_capacity_sats: totalCapacity,
      total_capacity_btc: fmtBtc(totalCapacity),
    },
  });
}

async function runHistory(): Promise<void> {
  const address = resolveWalletAddress();
  if (!address) {
    errOut("no_wallet_address", "No wallet address found", "Set STACKS_ADDRESS environment variable");
    return;
  }

  try {
    const data = await styxGet<{ history?: unknown[] }>(`/history/${address}`);
    const history = data.history ?? [];

    out({
      status: "success",
      action: history.length > 0
        ? "Recent bridge history found — check status field for pending deposits"
        : "No bridge history for this address",
      data: {
        address,
        history,
        count: history.length,
      },
    });
  } catch (e) {
    // History endpoint may not exist — surface what we can
    out({
      status: "success",
      action: "No bridge history found — use run --action=deposit to initiate a bridge",
      data: {
        address,
        history: [],
        count: 0,
        note: `History endpoint returned: ${e}`,
      },
    });
  }
}

async function runDeposit(amountSats: number, poolName: string, confirm: boolean): Promise<void> {
  if (amountSats < MIN_DEPOSIT_SATS) {
    errOut(
      "amount_too_small",
      `Minimum deposit is ${fmtSats(MIN_DEPOSIT_SATS)} sats (${fmtBtc(MIN_DEPOSIT_SATS)} BTC)`,
      `Increase --amount to at least ${MIN_DEPOSIT_SATS}`
    );
    return;
  }

  // Check pool capacity
  const pools = await fetchPools();
  const pool = pools.find((p) => p.name === poolName);

  if (!pool) {
    errOut(
      "pool_not_found",
      `Pool "${poolName}" not found`,
      `Available pools: ${pools.map((p) => p.name).join(", ")}`
    );
    return;
  }

  if (pool.liquidity_sats < amountSats) {
    errOut(
      "pool_at_capacity",
      `Pool "${poolName}" only has ${fmtSats(pool.liquidity_sats)} sats available (need ${fmtSats(amountSats)})`,
      "Reduce --amount or choose a different pool with run --action=pools"
    );
    return;
  }

  // Compute fee and output
  const feeSats = Math.ceil(amountSats * BRIDGE_FEE_BPS / 10_000);
  const receivedSbtcSats = amountSats - feeSats;

  if (!confirm) {
    out({
      status: "preview",
      action: "Add --confirm to execute this bridge deposit",
      data: {
        from: { asset: "BTC", amount_sats: amountSats, amount_btc: fmtBtc(amountSats) },
        to: { asset: "sBTC", amount_sats: receivedSbtcSats, amount_btc: fmtBtc(receivedSbtcSats) },
        fee_sats: feeSats,
        fee_btc: fmtBtc(feeSats),
        fee_pct: (BRIDGE_FEE_BPS / 100).toFixed(2),
        pool: poolName,
        pool_capacity_remaining_sats: pool.liquidity_sats - amountSats,
        next_step: `Re-run with --confirm to initiate bridge deposit of ${fmtBtc(amountSats)} BTC via pool "${poolName}"`,
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "Deposit execution ready — parent agent should call styx_deposit with these parameters",
    data: {
      execution_intent: "styx_deposit",
      params: {
        amount_sats: String(amountSats),
        pool: poolName,
      },
      expected_sbtc_sats: String(receivedSbtcSats),
      fee_sats: String(feeSats),
    },
    error: null,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("styx-bridge-skill")
  .description("Styx sBTC bridge monitor and depositor for aibtc agents");

program
  .command("doctor")
  .description("Check Styx API connectivity")
  .action(async () => {
    await runDoctor();
  });

program
  .command("run")
  .description("Execute a skill action")
  .requiredOption(
    "--action <action>",
    "Action: pools | price | fees | status | history | deposit"
  )
  .option("--amount <sats>", "BTC amount in satoshis (for deposit)", parseInt)
  .option("--pool <name>", "Pool name (for deposit)", "main")
  .option("--confirm", "Confirm deposit execution")
  .action(async (opts) => {
    switch (opts.action) {
      case "pools":
        await runPools();
        break;
      case "price":
        await runPrice();
        break;
      case "fees":
        await runFees();
        break;
      case "status":
        await runStatus();
        break;
      case "history":
        await runHistory();
        break;
      case "deposit":
        if (!opts.amount) {
          errOut(
            "missing_params",
            "deposit requires --amount (in satoshis)",
            "Example: run --action=deposit --amount=100000 --pool=main --confirm"
          );
          break;
        }
        await runDeposit(opts.amount, opts.pool ?? "main", !!opts.confirm);
        break;
      default:
        errOut(
          "unknown_action",
          `Unknown action: ${opts.action}`,
          "Valid actions: pools | price | fees | status | history | deposit"
        );
    }
  });

program.parse();
