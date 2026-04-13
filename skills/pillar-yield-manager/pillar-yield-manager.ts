#!/usr/bin/env bun
/**
 * pillar-yield-manager — Pillar Protocol Yield Dashboard & Position Manager
 *
 * Monitors sBTC supply positions, STX stacking status, DCA leaderboard,
 * and live exchange quotes for the Pillar Protocol on Stacks.
 *
 * Author: Mighty Scorpion (JoeyEttinger)
 * Agent: Mighty Scorpion — SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
 */

import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const MIN_SBTC_RESERVE = 5_000; // Always keep at least 5,000 sats in wallet
const MAX_SUPPLY_PER_OP = 1_000_000; // 0.01 BTC hard cap per supply
const FETCH_TIMEOUT = 15_000;
const DEFAULT_QUOTE_SATS = 100_000; // Default quote amount: 0.001 sBTC

// ═══════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
const PILLAR_API_URL = process.env.PILLAR_API_URL || "https://pillar-be.vercel.app";
const PILLAR_API_KEY =
  process.env.PILLAR_API_KEY ||
  "jc_b058d7f2e0976bd4ee34be3e5c7ba7ebe45289c55d3f5e45f666ebc14b7ebfd0";
const HIRO_API = "https://api.hiro.so";

// Token contracts (mainnet)
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT TYPES
// ═══════════════════════════════════════════════════════════════════════════
interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

function out(result: SkillOutput): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(action: string, data: Record<string, unknown>): void {
  out({ status: "blocked", action, data, error: null });
}

function fail(
  code: string,
  message: string,
  next: string,
  data: Record<string, unknown> = {}
): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════
function resolveWalletAddress(): string | null {
  // 1. Explicit env var
  if (process.env.STACKS_ADDRESS) return process.env.STACKS_ADDRESS;

  // 2. AIBTC wallet file
  const walletsFile = join(homedir(), ".aibtc", "wallets.json");
  if (existsSync(walletsFile)) {
    try {
      const wallets = JSON.parse(readFileSync(walletsFile, "utf8"));
      // Find the active wallet — look for `active: true` or take the first entry
      if (Array.isArray(wallets)) {
        const active = wallets.find((w: { active?: boolean }) => w.active) || wallets[0];
        if (active?.address) return active.address;
      } else if (typeof wallets === "object" && wallets.activeWallet) {
        return wallets.activeWallet.address || wallets.activeWallet;
      }
    } catch {
      // Parse error — continue
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function pillarGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  let url = `${PILLAR_API_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    );
    url += `?${qs}`;
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${PILLAR_API_KEY}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Pillar API ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

async function pillarPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${PILLAR_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PILLAR_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Pillar API ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

async function hiroGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${HIRO_API}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Hiro API ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

// ═══════════════════════════════════════════════════════════════════════════
// DOCTOR
// ═══════════════════════════════════════════════════════════════════════════
async function runDoctor(): Promise<void> {
  const checks: Record<string, string> = {};
  let allOk = true;

  // 1. Wallet address
  const address = resolveWalletAddress();
  checks.wallet_address = address
    ? `✓ ${address}`
    : "✗ Not found — set STACKS_ADDRESS env var";
  if (!address) allOk = false;

  // 2. Pillar API
  try {
    await pillarGet("/api/pillar/quote", { sbtcAmount: 10000 });
    checks.pillar_api = "✓ Reachable";
  } catch (e) {
    checks.pillar_api = `✗ Unreachable: ${(e as Error).message}`;
    allOk = false;
  }

  // 3. Hiro API
  let stxBalance = 0;
  let sbtcBalance = 0;
  try {
    const balances = await hiroGet<{
      stx: { balance: string };
      fungible_tokens: Record<string, { balance: string }>;
    }>(`/v2/accounts/${address || "SP000000000000000000002Q6VF78"}/balances`);
    stxBalance = parseInt(balances.stx?.balance || "0", 10);
    const sbtcKey = Object.keys(balances.fungible_tokens || {}).find((k) =>
      k.startsWith(SBTC_CONTRACT)
    );
    sbtcBalance = sbtcKey
      ? parseInt(balances.fungible_tokens[sbtcKey]?.balance || "0", 10)
      : 0;
    checks.hiro_api = "✓ Reachable";
    checks.stx_balance = `${(stxBalance / 1_000_000).toFixed(6)} STX`;
    checks.sbtc_balance = `${sbtcBalance.toLocaleString()} sats`;
  } catch (e) {
    checks.hiro_api = `✗ Unreachable: ${(e as Error).message}`;
    allOk = false;
  }

  // 4. Pillar wallet name
  const walletName = process.env.PILLAR_WALLET_NAME;
  checks.pillar_wallet_name = walletName
    ? `✓ ${walletName} (set via env)`
    : "⚠ Not set — read-only mode (set PILLAR_WALLET_NAME for write actions)";

  if (allOk) {
    success("All checks passed. Run status to see your Pillar position.", {
      checks,
      stx_balance_ustx: stxBalance,
      sbtc_balance_sats: sbtcBalance,
      pillar_wallet_name: walletName || null,
    });
  } else {
    fail(
      "doctor_failed",
      "One or more health checks failed",
      "Fix the issues listed in checks and re-run doctor",
      { checks }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════
async function runStatus(): Promise<void> {
  const address = resolveWalletAddress();
  if (!address) {
    fail(
      "no_wallet_address",
      "No Stacks wallet address found",
      "Set STACKS_ADDRESS=SP... env var and retry"
    );
    return;
  }

  // Fetch on-chain balances
  let stxBalance = 0;
  let sbtcBalance = 0;
  try {
    const balances = await hiroGet<{
      stx: { balance: string };
      fungible_tokens: Record<string, { balance: string }>;
    }>(`/v2/accounts/${address}/balances`);
    stxBalance = parseInt(balances.stx?.balance || "0", 10);
    const sbtcKey = Object.keys(balances.fungible_tokens || {}).find((k) =>
      k.startsWith(SBTC_CONTRACT)
    );
    sbtcBalance = sbtcKey
      ? parseInt(balances.fungible_tokens[sbtcKey]?.balance || "0", 10)
      : 0;
  } catch (e) {
    fail(
      "hiro_api_unreachable",
      `Hiro API error: ${(e as Error).message}`,
      "Check Hiro API status and retry"
    );
    return;
  }

  // Fetch Pillar smart wallet position if configured
  let smartWalletData: Record<string, unknown> | null = null;
  const walletName = process.env.PILLAR_WALLET_NAME;
  if (walletName) {
    try {
      smartWalletData = await pillarGet(`/api/smart-wallet/${walletName}`);
    } catch (e) {
      // Non-fatal — wallet may not be deployed yet
      smartWalletData = {
        error: `Smart wallet '${walletName}' not found or not deployed: ${(e as Error).message}`,
      };
    }
  }

  // Fetch DCA status if wallet configured
  let dcaStatus: Record<string, unknown> | null = null;
  if (walletName && smartWalletData && !("error" in smartWalletData)) {
    try {
      const contractAddress =
        (smartWalletData as { data?: { contractAddress?: string } })?.data
          ?.contractAddress;
      if (contractAddress) {
        dcaStatus = await pillarPost("/api/pillar/dca-status", {
          walletAddress: contractAddress,
        });
      }
    } catch {
      // Non-fatal
    }
  }

  const data = {
    wallet_address: address,
    stx_balance_ustx: stxBalance,
    stx_balance_stx: (stxBalance / 1_000_000).toFixed(6),
    sbtc_balance_sats: sbtcBalance,
    sbtc_balance_btc: (sbtcBalance / 100_000_000).toFixed(8),
    pillar_wallet_name: walletName || null,
    smart_wallet: smartWalletData,
    dca_status: dcaStatus,
    summary: {
      has_pillar_wallet: !!walletName,
      liquid_sbtc_sats: sbtcBalance,
      available_to_supply: Math.max(0, sbtcBalance - MIN_SBTC_RESERVE),
    },
  };

  success(
    walletName
      ? "Status fetched. Review smart_wallet for Pillar position details."
      : "Status fetched. Set PILLAR_WALLET_NAME to see smart wallet position.",
    data
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// QUOTE
// ═══════════════════════════════════════════════════════════════════════════
async function runQuote(sbtcAmount: number): Promise<void> {
  if (sbtcAmount <= 0) {
    fail("invalid_amount", "sbtc-amount must be > 0", "Provide a positive sats amount");
    return;
  }

  let quoteData: Record<string, unknown>;
  try {
    quoteData = await pillarPost("/api/pillar/quote", { sbtcAmount });
  } catch (e) {
    fail(
      "pillar_api_unreachable",
      `Pillar quote failed: ${(e as Error).message}`,
      "Check Pillar API status and retry"
    );
    return;
  }

  success(
    `Quote fetched for ${sbtcAmount.toLocaleString()} sats sBTC`,
    {
      sbtc_amount_sats: sbtcAmount,
      sbtc_amount_btc: (sbtcAmount / 100_000_000).toFixed(8),
      quote: quoteData,
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DCA LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════
async function runDcaLeaderboard(): Promise<void> {
  let leaderboard: unknown[];
  try {
    const result = await pillarGet<{ data?: unknown[] } | unknown[]>(
      "/api/dca-partner/leaderboard"
    );
    leaderboard = Array.isArray(result) ? result : (result as { data?: unknown[] })?.data || [];
  } catch (e) {
    fail(
      "pillar_api_unreachable",
      `DCA leaderboard fetch failed: ${(e as Error).message}`,
      "Check Pillar API status and retry"
    );
    return;
  }

  success("DCA partner leaderboard fetched", {
    total_partners: leaderboard.length,
    leaderboard: leaderboard.slice(0, 20), // Top 20
    tip: "Invite agents using pillar_dca_invite MCP tool to earn referral rewards",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLY (write action — requires --confirm)
// ═══════════════════════════════════════════════════════════════════════════
async function runSupply(sbtcAmount: number, confirm: boolean): Promise<void> {
  const walletName = process.env.PILLAR_WALLET_NAME;
  if (!walletName) {
    fail(
      "no_wallet_name",
      "PILLAR_WALLET_NAME env var is required for supply operations",
      "Set PILLAR_WALLET_NAME=your-wallet-name and retry"
    );
    return;
  }

  const address = resolveWalletAddress();
  if (!address) {
    fail(
      "no_wallet_address",
      "No Stacks wallet address found",
      "Set STACKS_ADDRESS=SP... env var and retry"
    );
    return;
  }

  // Validate amount
  if (sbtcAmount <= 0) {
    fail("invalid_amount", "sbtc-amount must be > 0 sats", "Provide a positive sats amount");
    return;
  }
  if (sbtcAmount > MAX_SUPPLY_PER_OP) {
    fail(
      "exceeds_max_supply",
      `Amount ${sbtcAmount} sats exceeds hard cap of ${MAX_SUPPLY_PER_OP.toLocaleString()} sats per operation`,
      `Reduce amount to ≤ ${MAX_SUPPLY_PER_OP.toLocaleString()} sats`
    );
    return;
  }

  // Check sBTC balance
  let sbtcBalance = 0;
  try {
    const balances = await hiroGet<{
      fungible_tokens: Record<string, { balance: string }>;
    }>(`/v2/accounts/${address}/balances`);
    const sbtcKey = Object.keys(balances.fungible_tokens || {}).find((k) =>
      k.startsWith(SBTC_CONTRACT)
    );
    sbtcBalance = sbtcKey
      ? parseInt(balances.fungible_tokens[sbtcKey]?.balance || "0", 10)
      : 0;
  } catch (e) {
    fail(
      "hiro_api_unreachable",
      `Cannot verify sBTC balance: ${(e as Error).message}`,
      "Check Hiro API and retry"
    );
    return;
  }

  const afterReserve = sbtcBalance - MIN_SBTC_RESERVE;
  if (afterReserve < sbtcAmount) {
    fail(
      "insufficient_sbtc",
      `Need ${sbtcAmount.toLocaleString()} sats but only ${afterReserve.toLocaleString()} available after ${MIN_SBTC_RESERVE.toLocaleString()} sats reserve`,
      `Reduce amount to ≤ ${Math.max(0, afterReserve).toLocaleString()} sats or deposit more sBTC`
    );
    return;
  }

  // Preview mode (no --confirm)
  if (!confirm && !process.env.AIBTC_DRY_RUN) {
    blocked("Supply preview ready — re-run with --confirm to execute", {
      action: "supply",
      wallet_name: walletName,
      sbtc_amount_sats: sbtcAmount,
      sbtc_amount_btc: (sbtcAmount / 100_000_000).toFixed(8),
      current_sbtc_balance_sats: sbtcBalance,
      after_supply_balance_sats: sbtcBalance - sbtcAmount,
      reserve_kept_sats: MIN_SBTC_RESERVE,
      dry_run: !!process.env.AIBTC_DRY_RUN,
      confirm_command: `PILLAR_WALLET_NAME=${walletName} STACKS_ADDRESS=${address} bun run pillar-yield-manager/pillar-yield-manager.ts run --action=supply --sbtc-amount=${sbtcAmount} --confirm`,
    });
    return;
  }

  // Dry run
  if (process.env.AIBTC_DRY_RUN) {
    success("DRY RUN — no transaction broadcast", {
      dry_run: true,
      would_supply_sats: sbtcAmount,
      wallet_name: walletName,
    });
    return;
  }

  // Execute supply via Pillar API (direct add-collateral)
  // Note: This requires the smart wallet to be deployed and the agent's key to be registered.
  // The Pillar backend handles gas sponsorship.
  let supplyResult: Record<string, unknown>;
  try {
    supplyResult = await pillarPost("/api/pillar/add-collateral", {
      walletName,
      sbtcAmount,
    });
  } catch (e) {
    fail(
      "supply_failed",
      `Supply transaction failed: ${(e as Error).message}`,
      "Check smart wallet status, STX gas balance, and retry"
    );
    return;
  }

  success(
    `Supplied ${sbtcAmount.toLocaleString()} sats sBTC to Pillar smart wallet '${walletName}'`,
    {
      supplied_sats: sbtcAmount,
      wallet_name: walletName,
      result: supplyResult,
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARE — Cross-protocol yield benchmark (Pillar + Zest + Styx)
// ═══════════════════════════════════════════════════════════════════════════

// Zest v2 reserve-vault contract addresses (mainnet)
const ZEST_SBTC_RESERVE = "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y";
const ZEST_SBTC_CONTRACT = "reserve-vault-sbtc";
const STYX_API = "https://api-styx.vercel.app";

async function fetchZestSbtcPosition(address: string): Promise<Record<string, unknown>> {
  // Read sBTC supply balance from Zest reserve-vault via Hiro read-only call
  const url = `${HIRO_API}/v2/contracts/call-read/${ZEST_SBTC_RESERVE}/${ZEST_SBTC_CONTRACT}/get-collateral`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: address,
        arguments: [
          // Clarity principal encoding: 0x05 + version + 20-byte hash (simplified via address string)
          "0x" + Buffer.from(`'${address}`).toString("hex"),
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return { available: false, error: `Hiro ${res.status}` };
    const json = await res.json() as { result?: string; okay?: boolean };
    return { available: true, raw_result: json.result, okay: json.okay };
  } catch (e) {
    return { available: false, error: (e as Error).message };
  }
}

async function fetchStyxPools(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${STYX_API}/pools`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return { available: false, error: `Styx API ${res.status}` };
    return { available: true, pools: await res.json() };
  } catch (e) {
    // Styx API endpoint may differ — return the known static pool data from MCP tool discovery
    return {
      available: false,
      error: (e as Error).message,
      known_pools: [
        { name: "main", max_deposit_sats: 400_000, total_liquidity_sats: 3_000_000, note: "Static data from MCP discovery" },
        { name: "aibtc", max_deposit_sats: 1_000_000, total_liquidity_sats: 900_000, note: "Static data from MCP discovery" },
      ],
    };
  }
}

async function runCompare(): Promise<void> {
  const address = resolveWalletAddress();

  // Fetch all three protocols in parallel
  const [pillarQuote, zestPosition, styxPools] = await Promise.allSettled([
    pillarPost<Record<string, unknown>>("/api/pillar/quote", { sbtcAmount: DEFAULT_QUOTE_SATS }),
    address ? fetchZestSbtcPosition(address) : Promise.resolve({ available: false, error: "No wallet address — set STACKS_ADDRESS" }),
    fetchStyxPools(),
  ]);

  const pillarData = pillarQuote.status === "fulfilled" ? pillarQuote.value : { error: (pillarQuote as PromiseRejectedResult).reason?.message };
  const zestData = zestPosition.status === "fulfilled" ? zestPosition.value : { available: false, error: (zestPosition as PromiseRejectedResult).reason?.message };
  const styxData = styxPools.status === "fulfilled" ? styxPools.value : { available: false };

  // Determine recommended protocol based on available data
  const styxMainLiquidity = (styxData as { known_pools?: Array<{ name: string; total_liquidity_sats: number }> }).known_pools?.find(p => p.name === "main")?.total_liquidity_sats ?? 0;
  const styxAibtcLiquidity = (styxData as { known_pools?: Array<{ name: string; total_liquidity_sats: number }> }).known_pools?.find(p => p.name === "aibtc")?.total_liquidity_sats ?? 0;

  success("Cross-protocol yield comparison complete. Review each protocol's capacity before allocating.", {
    wallet_address: address ?? "not configured",
    timestamp: new Date().toISOString(),
    protocols: {
      pillar: {
        protocol: "Pillar",
        type: "sBTC supply → Zest collateral (via smart wallet)",
        quote_basis_sats: DEFAULT_QUOTE_SATS,
        quote: pillarData,
        action: "run --action=supply --sbtc-amount=<sats> --confirm",
        docs: "https://pillar.fi",
      },
      zest: {
        protocol: "Zest Protocol v2",
        type: "sBTC lending supply (direct)",
        assets: ["wSTX", "sBTC", "stSTX", "USDC", "USDH", "stSTXbtc"],
        user_sbtc_position: zestData,
        reserve_contract: `${ZEST_SBTC_RESERVE}.${ZEST_SBTC_CONTRACT}`,
        action: "Use zest_supply MCP tool or zest-yield-manager skill",
        docs: "https://zestprotocol.com",
      },
      styx: {
        protocol: "Styx",
        type: "BTC L1 → sBTC bridge + pool liquidity",
        pools: styxData,
        main_pool_liquidity_sats: styxMainLiquidity,
        aibtc_pool_liquidity_sats: styxAibtcLiquidity,
        action: "Use styx_deposit MCP tool",
        docs: "https://styx.fi",
      },
    },
    recommendation: "Compare Pillar quote rate vs Zest supply APY vs Styx pool capacity. Pillar automates Zest collateral management. Zest direct supply is simpler. Styx is BTC L1 bridge yield.",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI SETUP
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("pillar-yield-manager")
  .description("Pillar Protocol yield dashboard and position manager for aibtc agents")
  .version("1.0.0");

program
  .command("doctor")
  .description("Health check — verify Pillar API, Hiro API, wallet configuration, and balances")
  .action(async () => {
    try {
      await runDoctor();
    } catch (e) {
      fail("unexpected_error", (e as Error).message, "Check logs and retry");
    }
  });

program
  .command("run")
  .description("Execute a Pillar yield manager action")
  .requiredOption("--action <action>", "Action: status | quote | dca-leaderboard | supply | compare")
  .option("--sbtc-amount <sats>", "sBTC amount in sats (for quote and supply)", String(DEFAULT_QUOTE_SATS))
  .option("--confirm", "Confirm and execute write actions (required for supply)")
  .action(async (opts: { action: string; sbtcAmount: string; confirm?: boolean }) => {
    const sbtcAmount = parseInt(opts.sbtcAmount, 10);

    try {
      switch (opts.action) {
        case "status":
          await runStatus();
          break;
        case "quote":
          await runQuote(sbtcAmount || DEFAULT_QUOTE_SATS);
          break;
        case "dca-leaderboard":
          await runDcaLeaderboard();
          break;
        case "supply":
          await runSupply(sbtcAmount, !!opts.confirm);
          break;
        case "compare":
          await runCompare();
          break;
        default:
          fail(
            "unknown_action",
            `Unknown action: ${opts.action}`,
            "Use one of: status | quote | dca-leaderboard | supply | compare"
          );
      }
    } catch (e) {
      fail("unexpected_error", (e as Error).message, "Check logs and retry");
    }
  });

program.parse(process.argv);
