#!/usr/bin/env bun
/**
 * bounty-hunter — Autonomous sBTC Bounty Scanner and Claimer
 *
 * Discovers, scores, and claims sBTC bounties from bounty.drx4.xyz.
 * Read operations require no auth. Claim requires BIP-322 signed headers
 * from an unlocked wallet.
 *
 * Author: Mighty Scorpion (JoeyEttinger)
 * Agent: SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
 */

import { Command } from "commander";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const BOUNTY_BASE = "https://bounty.drx4.xyz/api";
const FETCH_TIMEOUT = 15_000;
const VERSION = "1.0.0";

// Default agent capability tags (agents override via --tags flag)
const DEFAULT_AGENT_TAGS = [
  "typescript", "stacks", "defi", "read-only", "api-integration",
  "analytics", "yield", "bitcoin", "sbtc",
];

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
// BOUNTY API CLIENT
// ═══════════════════════════════════════════════════════════════════════════
interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function fetchBounty(path: string, options: FetchOptions = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${BOUNTY_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error(`Bounty API ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════
interface Bounty {
  id: string;
  title: string;
  description: string;
  tags?: string[];
  reward_sats?: number;
  reward_usd?: number;
  status: string;
  deadline?: string;
  created_at?: string;
}

function scoreBounty(bounty: Bounty, agentTags: string[]): number {
  const bountyTags = (bounty.tags ?? []).map(t => t.toLowerCase());
  const myTags = agentTags.map(t => t.toLowerCase());

  // Tag match score (35%)
  const matchCount = bountyTags.filter(t => myTags.includes(t)).length;
  const tagScore = bountyTags.length > 0 ? (matchCount / bountyTags.length) * 35 : 0;

  // Reward score (25%) — normalize up to $500 reward = full score
  const rewardUsd = bounty.reward_usd ?? (bounty.reward_sats ? bounty.reward_sats * 0.001 : 0);
  const rewardScore = Math.min(rewardUsd / 500, 1) * 25;

  // Deadline feasibility (25%) — deadlines >24h away get full score
  let deadlineScore = 25;
  if (bounty.deadline) {
    const hoursLeft = (new Date(bounty.deadline).getTime() - Date.now()) / 3_600_000;
    if (hoursLeft < 2) deadlineScore = 0;
    else if (hoursLeft < 6) deadlineScore = 10;
    else if (hoursLeft < 24) deadlineScore = 18;
    else deadlineScore = 25;
  }

  // Deliverable clarity (15%) — based on description length as proxy
  const descLength = (bounty.description ?? "").length;
  const clarityScore = descLength > 200 ? 15 : descLength > 100 ? 10 : descLength > 50 ? 6 : 3;

  return Math.round(tagScore + rewardScore + deadlineScore + clarityScore);
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("bounty-hunter")
  .version(VERSION)
  .description("Autonomous sBTC bounty scanner and claimer");

// ───────────────────────────────────────────────────────────────────────────
// DOCTOR
// ───────────────────────────────────────────────────────────────────────────
program.command("doctor").description("Check API connectivity and environment").action(async () => {
  const checks: Record<string, unknown> = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    stacks_address: process.env.STACKS_ADDRESS ?? null,
    btc_address: process.env.BTC_ADDRESS ?? null,
    default_tags: DEFAULT_AGENT_TAGS,
  };

  // Check Bounty API
  try {
    const stats = await fetchBounty("/stats");
    checks.bounty_api = "ok";
    checks.platform_stats = stats;
  } catch (err) {
    checks.bounty_api = "error";
    checks.bounty_error = String(err);
    out("error", "Bounty board API is unreachable.", checks, {
      code: "api_unreachable",
      message: String(err),
      next: "Check https://bounty.drx4.xyz and retry.",
    });
    return;
  }

  const walletReady = !!(process.env.STACKS_ADDRESS && process.env.BTC_ADDRESS);
  checks.wallet_ready_for_claims = walletReady;

  out(
    walletReady ? "success" : "blocked",
    walletReady
      ? "All systems ready. Use `run --action=list` to discover open bounties."
      : "API connected but wallet not configured. Read-only mode only. Set STACKS_ADDRESS and BTC_ADDRESS for claim capability.",
    checks
  );
});

// ───────────────────────────────────────────────────────────────────────────
// RUN
// ───────────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute a bounty hunting action")
  .requiredOption("--action <action>", "Action to execute")
  .option("--limit <n>", "Result limit", "20")
  .option("--status <s>", "Filter by status: open|claimed|submitted|approved|paid|cancelled")
  .option("--tags <t>", "Comma-separated capability tags (default: built-in agent tags)")
  .option("--bounty-id <id>", "Bounty UUID for get/claim actions")
  .option("--min-sats <n>", "Minimum reward in satoshis")
  .option("--min-usd <n>", "Minimum reward in USD equivalent")
  .action(async (opts) => {
    const limit = parseInt(opts.limit, 10);
    const agentTags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : DEFAULT_AGENT_TAGS;

    switch (opts.action) {

      // ── list ─────────────────────────────────────────────────────────────
      case "list": {
        try {
          const params = new URLSearchParams({ limit: String(limit) });
          if (opts.status) params.set("status", opts.status);
          if (opts.tags) params.set("tags", opts.tags);
          if (opts.minSats) params.set("min_amount", opts.minSats);

          const data = await fetchBounty(`/bounties?${params}`);
          const bounties = Array.isArray(data) ? data : (data as { bounties?: Bounty[] }).bounties ?? [];

          out("success", `Found ${bounties.length} bounties. Run \`match\` to score them against your capabilities.`, {
            count: bounties.length,
            filters: { status: opts.status, tags: opts.tags, limit },
            timestamp: new Date().toISOString(),
            bounties,
          });
        } catch (err) {
          outError("List bounties", "api_error", String(err), "Retry or check bounty board status.");
        }
        break;
      }

      // ── stats ─────────────────────────────────────────────────────────────
      case "stats": {
        try {
          const data = await fetchBounty("/stats");
          out("success", "Platform statistics fetched. Review total reward pool and claim rate.", {
            timestamp: new Date().toISOString(),
            stats: data,
          });
        } catch (err) {
          outError("Fetch stats", "api_error", String(err), "Retry or check bounty board status.");
        }
        break;
      }

      // ── match ─────────────────────────────────────────────────────────────
      case "match": {
        try {
          // Try API-native match first, fall back to local scoring
          let bounties: Bounty[];
          try {
            const params = new URLSearchParams({
              tags: agentTags.join(","),
              limit: String(limit),
              status: "open",
            });
            const matchData = await fetchBounty(`/bounties/match?${params}`);
            bounties = Array.isArray(matchData) ? matchData : (matchData as { bounties?: Bounty[] }).bounties ?? [];
          } catch {
            // Fall back: fetch all open and score locally
            const allData = await fetchBounty(`/bounties?status=open&limit=${limit * 2}`);
            const all: Bounty[] = Array.isArray(allData) ? allData : (allData as { bounties?: Bounty[] }).bounties ?? [];
            bounties = all;
          }

          const scored = bounties
            .map(b => ({ ...b, match_score: scoreBounty(b, agentTags) }))
            .sort((a, b) => b.match_score - a.match_score)
            .slice(0, limit);

          const top = scored[0];
          const recommendation = top
            ? `Top match: "${top.title}" (score: ${top.match_score}/100). Run \`get --bounty-id=${top.id}\` for full details.`
            : "No matching bounties found. Broaden your capability tags or check back later.";

          out("success", recommendation, {
            agent_tags: agentTags,
            timestamp: new Date().toISOString(),
            matched: scored,
          });
        } catch (err) {
          outError("Match bounties", "api_error", String(err), "Retry or check bounty board status.");
        }
        break;
      }

      // ── get ───────────────────────────────────────────────────────────────
      case "get": {
        if (!opts.bountyId) {
          outError("Get bounty", "missing_param", "--bounty-id is required", "Provide --bounty-id <uuid>");
          break;
        }
        try {
          const data = await fetchBounty(`/bounties/${opts.bountyId}`);
          const bounty = data as Bounty;
          const score = scoreBounty(bounty, agentTags);
          out(
            "success",
            score >= 60
              ? `Bounty score: ${score}/100 — CLAIMABLE. Run \`claim --bounty-id=${opts.bountyId}\` to proceed.`
              : `Bounty score: ${score}/100 — below threshold (60). Review requirements before claiming.`,
            {
              bounty_id: opts.bountyId,
              timestamp: new Date().toISOString(),
              match_score: score,
              agent_tags: agentTags,
              bounty: data,
            }
          );
        } catch (err) {
          outError("Get bounty", "api_error", String(err), "Verify bounty ID and retry.");
        }
        break;
      }

      // ── my-claims ─────────────────────────────────────────────────────────
      case "my-claims": {
        const addr = process.env.STACKS_ADDRESS ?? process.env.BTC_ADDRESS;
        if (!addr) {
          outError("My claims", "no_wallet", "STACKS_ADDRESS or BTC_ADDRESS env must be set", "Configure wallet environment.");
          break;
        }
        try {
          const data = await fetchBounty(`/claims?wallet=${encodeURIComponent(addr)}&limit=${limit}`);
          const claims = Array.isArray(data) ? data : (data as { claims?: unknown[] }).claims ?? [];
          out("success", `Found ${claims.length} claims for ${addr}.`, {
            address: addr,
            timestamp: new Date().toISOString(),
            claims,
          });
        } catch (err) {
          outError("My claims", "api_error", String(err), "Verify address and retry.");
        }
        break;
      }

      // ── claim ─────────────────────────────────────────────────────────────
      case "claim": {
        if (!opts.bountyId) {
          outError("Claim bounty", "missing_param", "--bounty-id is required", "Provide --bounty-id <uuid>");
          break;
        }

        const btcAddress = process.env.BTC_ADDRESS;
        const stxAddress = process.env.STACKS_ADDRESS;

        if (!btcAddress || !stxAddress) {
          out("blocked", "Wallet not configured for claim operations. Read-only mode only.", {
            bounty_id: opts.bountyId,
            required: ["BTC_ADDRESS env var", "STACKS_ADDRESS env var"],
            note: "The agent framework will inject BIP-322 auth headers when wallet is unlocked.",
          });
          break;
        }

        try {
          // Verify bounty is still open before claiming
          const bountyData = await fetchBounty(`/bounties/${opts.bountyId}`);
          const bounty = bountyData as Bounty;

          if (bounty.status !== "open") {
            outError(
              "Claim bounty",
              "not_open",
              `Bounty is in status "${bounty.status}" — can only claim open bounties`,
              "Find another open bounty with `run --action=list --status=open`."
            );
            break;
          }

          const score = scoreBounty(bounty, agentTags);
          if (score < 60) {
            out("blocked", `Match score ${score}/100 is below threshold (60). Claiming not recommended.`, {
              bounty_id: opts.bountyId,
              match_score: score,
              bounty_title: bounty.title,
              agent_tags: agentTags,
              note: "Override with explicit --tags if you have unreported capabilities.",
            });
            break;
          }

          // Build claim payload
          // Note: BIP-322 signing requires agent framework integration.
          // In production, the agent framework signs the auth headers.
          const timestamp = new Date().toISOString();
          const resource = `bounties/${opts.bountyId}`;
          const message = `agent-bounties | claim-bounty | ${btcAddress} | ${resource} | ${timestamp}`;

          // Submit claim — auth headers injected by agent framework
          const claimData = await fetchBounty(`/bounties/${opts.bountyId}/claim`, {
            method: "POST",
            headers: {
              "X-BTC-Address": btcAddress,
              "X-STX-Address": stxAddress,
              "X-Timestamp": timestamp,
              // X-Signature injected by agent framework in production
            },
            body: JSON.stringify({
              btc_address: btcAddress,
              stx_address: stxAddress,
              agent_tags: agentTags,
              message,
            }),
          });

          out("success", `Bounty "${bounty.title}" claimed successfully! Begin work on the deliverable immediately.`, {
            bounty_id: opts.bountyId,
            bounty_title: bounty.title,
            match_score: score,
            timestamp,
            claim_response: claimData,
          });
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes("claimed") || errStr.includes("409")) {
            outError("Claim bounty", "already_claimed", "This bounty was already claimed.", "Find another open bounty.");
          } else if (errStr.includes("401") || errStr.includes("403")) {
            outError("Claim bounty", "auth_failed", "BIP-322 auth failed — ensure wallet is unlocked.", "Run doctor and retry with unlocked wallet.");
          } else {
            outError("Claim bounty", "claim_failed", errStr, "Review bounty requirements and retry.");
          }
        }
        break;
      }

      default: {
        outError(
          `Unknown action: ${opts.action}`,
          "invalid_action",
          `Action "${opts.action}" is not supported`,
          "Valid actions: list, stats, match, get, my-claims, claim"
        );
      }
    }
  });

program.parse(process.argv);
