#!/usr/bin/env bun
/**
 * bns-manager — Bitcoin Name System (BNS) Domain Manager
 *
 * Lookup, reverse-resolve, check availability, price, and register
 * .btc BNS names on Stacks mainnet via the Hiro API.
 *
 * Author: Mighty Scorpion (JoeyEttinger)
 * Agent: SP38GBJ8GCXNKNNC87R5AZEPW7K6A1SSD6E1D6VNH
 */

import { Command } from "commander";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT = 15_000;
const VERSION = "1.0.0";
const DEFAULT_NAMESPACE = "btc";
const MIN_GAS_RESERVE_USTX = 1_000_000; // 1 STX minimum gas reserve

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
// HIRO API CLIENT
// ═══════════════════════════════════════════════════════════════════════════
async function fetchHiro(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${HIRO_API}${path}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) {
      throw new Error(`Hiro API ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NAME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function normalizeName(name: string): { name: string; namespace: string; full: string } {
  const parts = name.includes(".") ? name.split(".") : [name, DEFAULT_NAMESPACE];
  return {
    name: parts[0],
    namespace: parts[1] ?? DEFAULT_NAMESPACE,
    full: `${parts[0]}.${parts[1] ?? DEFAULT_NAMESPACE}`,
  };
}

function validateName(name: string): string | null {
  const { name: label } = normalizeName(name);
  if (label.length < 1) return "Name must be at least 1 character";
  if (label.length > 48) return "Name must be 48 characters or fewer";
  if (!/^[a-z0-9-_]+$/.test(label)) return "Name can only contain lowercase letters, numbers, hyphens, and underscores";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("bns-manager")
  .version(VERSION)
  .description("Bitcoin Name System (BNS) domain manager for Stacks agents");

// ───────────────────────────────────────────────────────────────────────────
// DOCTOR
// ───────────────────────────────────────────────────────────────────────────
program.command("doctor").description("Check API connectivity and environment").action(async () => {
  const checks: Record<string, unknown> = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    wallet_address: process.env.STACKS_ADDRESS ?? null,
  };

  // Check Hiro API
  try {
    const info = await fetchHiro("/v2/info") as Record<string, unknown>;
    checks.hiro_api = "ok";
    checks.stacks_tip = info.stacks_tip_height ?? null;
    checks.network_id = info.network_id ?? null;
  } catch (err) {
    checks.hiro_api = "error";
    checks.hiro_error = String(err);
    out("error", "Hiro API is unreachable.", checks, {
      code: "api_unreachable",
      message: String(err),
      next: "Check https://api.hiro.so/v2/info and retry.",
    });
    return;
  }

  // If wallet configured, check their names
  if (process.env.STACKS_ADDRESS) {
    try {
      const names = await fetchHiro(`/v1/addresses/stacks/${process.env.STACKS_ADDRESS}`) as { names?: string[] };
      checks.owned_names = names.names ?? [];
      checks.owned_names_count = (names.names ?? []).length;
    } catch {
      checks.owned_names = "could not fetch";
    }
  }

  out("success", "BNS manager ready. Use `run --action=lookup --name=<name.btc>` to resolve a name.", checks);
});

// ───────────────────────────────────────────────────────────────────────────
// RUN
// ───────────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute a BNS management action")
  .requiredOption("--action <action>", "Action to execute")
  .option("--name <name>", "BNS name (with or without .btc suffix)")
  .option("--address <addr>", "Stacks address for reverse lookup")
  .option("--namespace <ns>", "Namespace (default: btc)", "btc")
  .action(async (opts) => {

    switch (opts.action) {

      // ── lookup ────────────────────────────────────────────────────────────
      case "lookup": {
        if (!opts.name) {
          outError("Lookup", "missing_param", "--name is required", "Provide --name <name.btc>");
          break;
        }
        const validationError = validateName(opts.name);
        if (validationError) {
          outError("Lookup", "invalid_name", validationError, "Check name format: lowercase, alphanumeric, hyphens allowed.");
          break;
        }
        const { full } = normalizeName(opts.name);
        try {
          const data = await fetchHiro(`/v1/names/${full}`) as Record<string, unknown>;
          out("success", `${full} resolves to ${data.address ?? "no address"}. Use this address for routing payments.`, {
            name: full,
            found: true,
            timestamp: new Date().toISOString(),
            ...data,
          });
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes("404") || errStr.includes("not found") || errStr.toLowerCase().includes("name not found")) {
            out("success", `${full} is not registered — available for registration.`, {
              name: full,
              found: false,
              available: true,
              timestamp: new Date().toISOString(),
            });
          } else {
            outError("Lookup", "api_error", errStr, "Verify name format and retry.");
          }
        }
        break;
      }

      // ── reverse ───────────────────────────────────────────────────────────
      case "reverse": {
        const addr = opts.address ?? process.env.STACKS_ADDRESS;
        if (!addr) {
          outError("Reverse lookup", "missing_param", "--address or STACKS_ADDRESS env required", "Provide --address <stacks-addr>");
          break;
        }
        try {
          const data = await fetchHiro(`/v1/addresses/stacks/${addr}`) as { names?: string[] };
          const names = data.names ?? [];
          out(
            "success",
            names.length > 0
              ? `${addr} owns ${names.length} BNS name(s): ${names.join(", ")}`
              : `${addr} does not own any BNS names.`,
            {
              address: addr,
              timestamp: new Date().toISOString(),
              names_count: names.length,
              names,
            }
          );
        } catch (err) {
          outError("Reverse lookup", "api_error", String(err), "Verify address format and retry.");
        }
        break;
      }

      // ── check ─────────────────────────────────────────────────────────────
      case "check": {
        if (!opts.name) {
          outError("Check availability", "missing_param", "--name is required", "Provide --name <name>");
          break;
        }
        const validationError = validateName(opts.name);
        if (validationError) {
          outError("Check", "invalid_name", validationError, "Use lowercase letters, numbers, hyphens only.");
          break;
        }
        const { full, name: label } = normalizeName(opts.name);
        try {
          // Try to look up the name — 404 means available
          await fetchHiro(`/v1/names/${full}`);
          // If we get here, name exists (taken)
          out("success", `${full} is already registered. Try a variation or different name.`, {
            name: full,
            label,
            available: false,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes("404") || errStr.toLowerCase().includes("not found")) {
            out("success", `${full} is AVAILABLE for registration. Run \`price --name=${label}\` to check cost.`, {
              name: full,
              label,
              available: true,
              timestamp: new Date().toISOString(),
              next_action: `run --action=price --name=${label}`,
            });
          } else {
            outError("Check", "api_error", errStr, "Retry or check Hiro API status.");
          }
        }
        break;
      }

      // ── price ─────────────────────────────────────────────────────────────
      case "price": {
        if (!opts.name) {
          outError("Price", "missing_param", "--name is required", "Provide --name <name>");
          break;
        }
        const validationError = validateName(opts.name);
        if (validationError) {
          outError("Price", "invalid_name", validationError, "Use lowercase letters, numbers, hyphens only.");
          break;
        }
        const { full, name: label, namespace } = normalizeName(opts.name);
        try {
          const data = await fetchHiro(`/v2/fees/names/${label}.${namespace}`) as Record<string, unknown>;
          const priceMicro = Number(data.amount ?? data.fee ?? 0);
          const priceStx = priceMicro / 1_000_000;

          out("success", `Registration price for ${full}: ${priceStx} STX. Confirm you have sufficient balance before registering.`, {
            name: full,
            label,
            namespace,
            price_ustx: priceMicro,
            price_stx: priceStx,
            timestamp: new Date().toISOString(),
            raw: data,
          });
        } catch (err) {
          // Fallback: estimate based on name length (BNS pricing heuristic)
          const { name: lbl } = normalizeName(opts.name);
          const estimatedStx = lbl.length <= 3 ? 100 : lbl.length <= 5 ? 10 : 1;
          out("success", `Could not fetch exact price. Estimated ~${estimatedStx} STX based on name length.`, {
            name: full,
            estimated_price_stx: estimatedStx,
            note: "Actual price may differ. Fetch error: " + String(err),
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }

      // ── my-names ──────────────────────────────────────────────────────────
      case "my-names": {
        const addr = process.env.STACKS_ADDRESS;
        if (!addr) {
          outError("My names", "no_wallet", "STACKS_ADDRESS env must be set", "Configure wallet environment.");
          break;
        }
        try {
          const data = await fetchHiro(`/v1/addresses/stacks/${addr}`) as { names?: string[] };
          const names = data.names ?? [];
          out(
            "success",
            names.length > 0
              ? `You own ${names.length} BNS name(s). Consider setting your primary name for on-chain identity.`
              : "You do not own any BNS names. Run `check --name=<your-name>` to find an available name.",
            {
              address: addr,
              timestamp: new Date().toISOString(),
              names_count: names.length,
              names,
            }
          );
        } catch (err) {
          outError("My names", "api_error", String(err), "Verify wallet address and retry.");
        }
        break;
      }

      // ── register ──────────────────────────────────────────────────────────
      case "register": {
        if (!opts.name) {
          outError("Register", "missing_param", "--name is required", "Provide --name <name>");
          break;
        }
        const validationError = validateName(opts.name);
        if (validationError) {
          outError("Register", "invalid_name", validationError, "Use lowercase letters, numbers, hyphens only.");
          break;
        }
        const { full, name: label, namespace } = normalizeName(opts.name);
        const addr = process.env.STACKS_ADDRESS;
        if (!addr) {
          out("blocked", "Wallet not configured for registration. Set STACKS_ADDRESS env.", {
            name: full,
            required: ["STACKS_ADDRESS env var"],
          });
          break;
        }

        // Check availability first
        let isAvailable = false;
        try {
          await fetchHiro(`/v1/names/${full}`);
          isAvailable = false;
        } catch (err) {
          if (String(err).includes("404") || String(err).toLowerCase().includes("not found")) {
            isAvailable = true;
          }
        }

        if (!isAvailable) {
          out("blocked", `${full} is already registered. Choose a different name.`, {
            name: full,
            available: false,
          });
          break;
        }

        // Get price
        let priceUstx = 0;
        try {
          const priceData = await fetchHiro(`/v2/fees/names/${label}.${namespace}`) as Record<string, unknown>;
          priceUstx = Number(priceData.amount ?? priceData.fee ?? 0);
        } catch {
          // Estimate
          priceUstx = label.length <= 3 ? 100_000_000 : label.length <= 5 ? 10_000_000 : 1_000_000;
        }

        // Emit registration intent — agent framework executes the on-chain tx
        out("success", `Name ${full} is available at ${priceUstx / 1_000_000} STX. The agent framework will execute BNS registration. Confirm before proceeding.`, {
          name: full,
          label,
          namespace,
          registrant: addr,
          price_ustx: priceUstx,
          price_stx: priceUstx / 1_000_000,
          timestamp: new Date().toISOString(),
          mcp_command: {
            tool: "claim_bns_name_fast",
            params: { name: label, namespace },
          },
          warning: "This action costs STX and is irreversible. Confirm with your human operator before executing.",
        });
        break;
      }

      default: {
        outError(
          `Unknown action: ${opts.action}`,
          "invalid_action",
          `Action "${opts.action}" is not supported`,
          "Valid actions: lookup, reverse, check, price, my-names, register"
        );
      }
    }
  });

program.parse(process.argv);
