#!/usr/bin/env bun
/**
 * stackspot-skill — StackSpot collaborative stacking pot monitor and participant
 *
 * Reads pot state via Hiro read-only API and coordinates group STX stacking.
 * All write actions (join, claim, start, cancel) gated behind --confirm.
 *
 * Usage:
 *   bun stackspot-skill/stackspot-skill.ts doctor
 *   bun stackspot-skill/stackspot-skill.ts run --action=list-pots
 *   bun stackspot-skill/stackspot-skill.ts run --action=pot-state --pot-id=<id>
 *   bun stackspot-skill/stackspot-skill.ts run --action=join --pot-id=<id> --amount=<stx> [--confirm]
 *   bun stackspot-skill/stackspot-skill.ts run --action=claim --pot-id=<id> [--confirm]
 *   bun stackspot-skill/stackspot-skill.ts run --action=start --pot-id=<id> [--confirm]
 *   bun stackspot-skill/stackspot-skill.ts run --action=cancel --pot-id=<id> [--confirm]
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";

// StackSpot contract on Stacks mainnet
const STACKSPOT_ADDR = "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9";
const STACKSPOT_NAME = "stackspot-v1";
const STACKSPOT_CONTRACT = `${STACKSPOT_ADDR}.${STACKSPOT_NAME}`;
const READ_SENDER = "SP000000000000000000002Q6VF78";
const MICRO_STX = 1_000_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PotState {
  pot_id: string;
  name: string;
  status: "open" | "locking" | "stacking" | "settled" | "cancelled";
  current_stx: string;
  target_stx: string;
  fill_pct: string;
  participants: number;
  min_contribution_stx: string;
  cycle_start?: number;
  rewards_stx?: string;
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

// ─── Hiro helpers ─────────────────────────────────────────────────────────────

async function hiroGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HIRO_API}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Hiro API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function readOnly<T>(fnName: string, args: string[] = []): Promise<T> {
  const res = await fetch(
    `${HIRO_API}/v2/contracts/call-read/${STACKSPOT_ADDR}/${STACKSPOT_NAME}/${fnName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: READ_SENDER, arguments: args }),
    }
  );
  if (!res.ok) throw new Error(`read-only ${fnName} returned ${res.status}`);
  const json = await res.json() as { okay: boolean; result: T };
  if (!json.okay) throw new Error(`read-only ${fnName} not okay`);
  return json.result;
}

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(code: string, message: string, next: string): void {
  out({ status: "error", action: next, error: { code, message, next } });
}

function fmtStx(microStx: number): string {
  return (microStx / MICRO_STX).toFixed(2);
}

// ─── Pot parsing ──────────────────────────────────────────────────────────────

function parsePot(id: string, repr: string): PotState | null {
  try {
    const statusCode = parseInt(repr.match(/status u(\d)/)?.[1] ?? "99");
    const statusMap: Record<number, PotState["status"]> = {
      0: "open",
      1: "locking",
      2: "stacking",
      3: "settled",
      4: "cancelled",
    };
    const status = statusMap[statusCode] ?? "open";

    const name = repr.match(/name "([^"]+)"/)?.[1] ?? `Pot ${id}`;
    const currentMicroStx = parseInt(repr.match(/total-stx u(\d+)/)?.[1] ?? "0");
    const targetMicroStx = parseInt(repr.match(/target-stx u(\d+)/)?.[1] ?? "100000000000");
    const participants = parseInt(repr.match(/participant-count u(\d+)/)?.[1] ?? "0");
    const minContrib = parseInt(repr.match(/min-contribution u(\d+)/)?.[1] ?? "1000000");
    const rewards = repr.match(/rewards u(\d+)/)?.[1];

    const fillPct = targetMicroStx > 0
      ? ((currentMicroStx / targetMicroStx) * 100).toFixed(1)
      : "0.0";

    return {
      pot_id: id,
      name,
      status,
      current_stx: fmtStx(currentMicroStx),
      target_stx: fmtStx(targetMicroStx),
      fill_pct: fillPct,
      participants,
      min_contribution_stx: fmtStx(minContrib),
      rewards_stx: rewards ? fmtStx(parseInt(rewards)) : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  try {
    const info = await hiroGet<{ burn_block_height: number }>("/v2/info");
    const contract = await hiroGet<{ tx_id: string }>(
      `/extended/v1/contract/${STACKSPOT_CONTRACT}`
    );

    // Try to fetch pot count
    let potCount = 0;
    try {
      const countResult = await readOnly<string>("get-pot-count");
      potCount = parseInt(countResult.replace(/[^0-9]/g, "") || "0");
    } catch {
      // Pot count may not be available via this function name
    }

    out({
      status: "success",
      action: "StackSpot contract reachable — use run --action=list-pots to browse",
      data: {
        hiro_api: "ok",
        stacks_block: info.burn_block_height,
        stackspot_contract: STACKSPOT_CONTRACT,
        contract_deployed: !!contract.tx_id,
        pot_count: potCount,
      },
    });
  } catch (e) {
    errOut("hiro_api_unreachable", `Cannot reach Hiro API or StackSpot contract: ${e}`, "Check network connectivity");
  }
}

async function runListPots(): Promise<void> {
  try {
    // Fetch contract events to find pot creation events
    const events = await hiroGet<{
      results: Array<{ event_type: string; data: Record<string, unknown> }>;
    }>(`/extended/v1/contract/${STACKSPOT_CONTRACT}/events?limit=50`);

    const pots: PotState[] = [];
    const seen = new Set<string>();

    for (const event of events.results ?? []) {
      if (event.event_type !== "smart_contract_log") continue;
      const repr = String((event.data as Record<string, unknown>).repr ?? "");
      const idMatch = repr.match(/pot-id u(\d+)/);
      if (!idMatch) continue;
      const potId = idMatch[1];
      if (seen.has(potId)) continue;
      seen.add(potId);

      try {
        const detail = await readOnly<string>("get-pot", [`u${potId}`]);
        const pot = parsePot(potId, detail);
        if (pot) pots.push(pot);
      } catch {
        // skip
      }
    }

    pots.sort((a, b) => {
      // Open pots first, then by fill %
      if (a.status === "open" && b.status !== "open") return -1;
      if (b.status === "open" && a.status !== "open") return 1;
      return parseFloat(b.fill_pct) - parseFloat(a.fill_pct);
    });

    const openPots = pots.filter((p) => p.status === "open");

    out({
      status: "success",
      action: openPots.length > 0
        ? `${openPots.length} open pot(s) available — use run --action=pot-state --pot-id=<id> for details`
        : "No open pots currently — check back later",
      data: {
        pots,
        total_pots: pots.length,
        open_pots: openPots.length,
      },
    });
  } catch (e) {
    errOut("hiro_api_unreachable", `Failed to fetch pots: ${e}`, "Check Hiro API connectivity");
  }
}

async function runPotState(potId: string): Promise<void> {
  try {
    const detail = await readOnly<string>("get-pot", [`u${potId}`]);
    const pot = parsePot(potId, detail);
    if (!pot) {
      errOut("pot_not_found", `Pot ${potId} not found or could not be parsed`, "Check pot ID with run --action=list-pots");
      return;
    }

    const actionMsg = {
      open: `Pot is open — join with run --action=join --pot-id=${potId} --amount=<stx>`,
      locking: "Pot is locking for the stacking cycle",
      stacking: "Pot is actively stacking — await settlement",
      settled: `Pot settled — claim rewards with run --action=claim --pot-id=${potId} --confirm`,
      cancelled: "Pot was cancelled",
    }[pot.status];

    out({
      status: "success",
      action: actionMsg,
      data: pot,
    });
  } catch (e) {
    errOut("pot_not_found", `Pot ${potId} not found: ${e}`, "Use run --action=list-pots to see available pots");
  }
}

async function runJoin(potId: string, amountStx: number, confirm: boolean): Promise<void> {
  try {
    const detail = await readOnly<string>("get-pot", [`u${potId}`]);
    const pot = parsePot(potId, detail);

    if (!pot) {
      errOut("pot_not_found", `Pot ${potId} not found`, "Use run --action=list-pots to find open pots");
      return;
    }
    if (pot.status !== "open") {
      errOut("pot_not_open", `Pot ${potId} is ${pot.status} — can only join open pots`, "Use run --action=list-pots to find open pots");
      return;
    }
    if (amountStx < parseFloat(pot.min_contribution_stx)) {
      errOut("below_minimum", `Minimum contribution is ${pot.min_contribution_stx} STX`, `Provide at least ${pot.min_contribution_stx} STX with --amount`);
      return;
    }

    const remainingCapacity = parseFloat(pot.target_stx) - parseFloat(pot.current_stx);
    if (amountStx > remainingCapacity) {
      errOut("pot_full", `Pot only has ${remainingCapacity.toFixed(2)} STX capacity remaining`, "Reduce --amount or choose a different pot");
      return;
    }

    if (!confirm) {
      out({
        status: "preview",
        action: "Add --confirm to join this pot",
        data: {
          pot_id: potId,
          pot_name: pot.name,
          amount_stx: amountStx,
          current_fill: `${pot.current_stx} / ${pot.target_stx} STX (${pot.fill_pct}%)`,
          lock_warning: "STX will be locked for the stacking cycle duration",
          next_step: `Re-run with --confirm to join pot ${potId}`,
        },
        error: null,
      });
      return;
    }

    out({
      status: "success",
      action: "Join execution ready — parent agent should call stackspot_join_pot",
      data: {
        execution_intent: "stackspot_join_pot",
        params: {
          pot_id: potId,
          amount_micro_stx: String(Math.floor(amountStx * MICRO_STX)),
        },
        lock_warning: "STX will be locked for the stacking cycle — cannot withdraw after round starts",
      },
      error: null,
    });
  } catch (e) {
    errOut("join_failed", `Could not prepare join: ${e}`, "Check pot ID and connectivity");
  }
}

async function runClaim(potId: string, confirm: boolean): Promise<void> {
  try {
    const detail = await readOnly<string>("get-pot", [`u${potId}`]);
    const pot = parsePot(potId, detail);

    if (!pot) {
      errOut("pot_not_found", `Pot ${potId} not found`, "Check pot ID");
      return;
    }
    if (pot.status !== "settled") {
      errOut("pot_not_settled", `Pot ${potId} is ${pot.status} — can only claim from settled pots`, "Await pot settlement before claiming");
      return;
    }
    if (!pot.rewards_stx || parseFloat(pot.rewards_stx) === 0) {
      errOut("no_rewards", `No rewards available in pot ${potId}`, "Check pot status with run --action=pot-state");
      return;
    }

    if (!confirm) {
      out({
        status: "preview",
        action: "Add --confirm to claim your rewards",
        data: {
          pot_id: potId,
          pot_name: pot.name,
          rewards_stx: pot.rewards_stx,
          next_step: `Re-run with --confirm to claim rewards from pot ${potId}`,
        },
        error: null,
      });
      return;
    }

    out({
      status: "success",
      action: "Claim execution ready — parent agent should call stackspot_claim_rewards",
      data: {
        execution_intent: "stackspot_claim_rewards",
        params: { pot_id: potId },
        rewards_stx: pot.rewards_stx,
      },
      error: null,
    });
  } catch (e) {
    errOut("claim_failed", `Could not prepare claim: ${e}`, "Check pot ID and settlement status");
  }
}

async function runStart(potId: string, confirm: boolean): Promise<void> {
  if (!confirm) {
    out({
      status: "preview",
      action: "Add --confirm to start the stacking round",
      data: {
        pot_id: potId,
        next_step: `Re-run with --confirm to start pot ${potId}`,
        note: "Starting a round locks all contributions — this cannot be undone",
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "Start execution ready — parent agent should call stackspot_start_pot",
    data: {
      execution_intent: "stackspot_start_pot",
      params: { pot_id: potId },
    },
    error: null,
  });
}

async function runCancel(potId: string, confirm: boolean): Promise<void> {
  if (!confirm) {
    out({
      status: "preview",
      action: "Add --confirm to cancel your participation and withdraw STX",
      data: {
        pot_id: potId,
        next_step: `Re-run with --confirm to cancel pot ${potId}`,
        note: "Can only cancel before the stacking round starts",
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "Cancel execution ready — parent agent should call stackspot_cancel_pot",
    data: {
      execution_intent: "stackspot_cancel_pot",
      params: { pot_id: potId },
    },
    error: null,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("stackspot-skill")
  .description("StackSpot collaborative stacking pot monitor and participant");

program
  .command("doctor")
  .description("Check StackSpot contract connectivity")
  .action(async () => {
    await runDoctor();
  });

program
  .command("run")
  .description("Execute a skill action")
  .requiredOption(
    "--action <action>",
    "Action: list-pots | pot-state | join | claim | start | cancel"
  )
  .option("--pot-id <id>", "Pot ID")
  .option("--amount <stx>", "STX amount to contribute (human units)", parseFloat)
  .option("--confirm", "Confirm write actions")
  .action(async (opts) => {
    switch (opts.action) {
      case "list-pots":
        await runListPots();
        break;
      case "pot-state":
        if (!opts.potId) {
          errOut("missing_params", "pot-state requires --pot-id", "Example: run --action=pot-state --pot-id=1");
          break;
        }
        await runPotState(opts.potId);
        break;
      case "join":
        if (!opts.potId || !opts.amount) {
          errOut("missing_params", "join requires --pot-id and --amount", "Example: run --action=join --pot-id=1 --amount=500 --confirm");
          break;
        }
        await runJoin(opts.potId, opts.amount, !!opts.confirm);
        break;
      case "claim":
        if (!opts.potId) {
          errOut("missing_params", "claim requires --pot-id", "Example: run --action=claim --pot-id=1 --confirm");
          break;
        }
        await runClaim(opts.potId, !!opts.confirm);
        break;
      case "start":
        if (!opts.potId) {
          errOut("missing_params", "start requires --pot-id", "Example: run --action=start --pot-id=1 --confirm");
          break;
        }
        await runStart(opts.potId, !!opts.confirm);
        break;
      case "cancel":
        if (!opts.potId) {
          errOut("missing_params", "cancel requires --pot-id", "Example: run --action=cancel --pot-id=1 --confirm");
          break;
        }
        await runCancel(opts.potId, !!opts.confirm);
        break;
      default:
        errOut("unknown_action", `Unknown action: ${opts.action}`, "Valid: list-pots | pot-state | join | claim | start | cancel");
    }
  });

program.parse();
