/**
 * Real Anthropic Agent exchange — evidence (Spec §7.5).
 *
 * This is the one external check that needs NO Solana credentials: construct a realistic
 * synthetic failure scenario with plausible (but fake) tip-floor/slot/leader data, send
 * the actual prompt to Claude via the real API, and verify a substantive reasoning text
 * comes back and parses into the structured AgentDecision the Builder would act on.
 *
 * Writes the full exchange (prompt + verbatim reasoning + parsed decision) to
 * logs/agent-evidence.json (gitignored) and prints it.
 *
 * Reads ANTHROPIC_API_KEY from .env directly (not loadConfig — the Solana vars are still
 * PENDING and irrelevant here).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAgent } from "../src/agent/agent.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/agent/promptBuilder.js";
import type { AgentContext } from "../src/types.js";

const OUT_PATH = "./logs/agent-evidence.json";

/** A realistic synthetic scenario: an expired-blockhash failure on a stressed network. */
const scenario: AgentContext = {
  failure: "expired_blockhash",
  tipFloor: {
    landedTipsLamports: {
      p25: 1_000,
      p50: 12_000,
      p75: 48_000,
      p95: 210_000,
      p99: 540_000,
    },
    fetchedAt: Date.now(),
  },
  degradedMode: true,
  currentSlot: 312_456_789,
  leaderLookahead: [
    { slot: 312_456_790, leader: "Jito1AAA1111111111111111111111111111111111", jitoEnabled: true },
    { slot: 312_456_791, leader: "NonJ2BBB2222222222222222222222222222222222", jitoEnabled: false },
    { slot: 312_456_792, leader: "Jito3CCC3333333333333333333333333333333333", jitoEnabled: true },
    { slot: 312_456_793, leader: "Jito4DDD4444444444444444444444444444444444", jitoEnabled: true },
  ],
  previousTipLamports: 35_000,
};

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("ANTHROPIC_API_KEY not set in .env");
    process.exitCode = 1;
    return;
  }

  console.log("=== Real Anthropic Agent exchange (Spec §6/§7.5) ===");
  console.log("Scenario: expired_blockhash failure, degraded network, prior tip 35000.\n");

  const agent = createAgent(key);
  const t0 = Date.now();
  const decision = await agent.decide(scenario);
  const elapsedMs = Date.now() - t0;

  console.log("--- Claude's reasoning (verbatim) ---");
  console.log(decision.reasoning);
  console.log("\n--- Parsed decision (what the Builder would act on) ---");
  console.log(`  tipLamports:     ${decision.tipLamports}`);
  console.log(`  parallelTargets: ${decision.parallelTargets}`);
  console.log(`  retry:           ${decision.retry}`);
  console.log(`\n(round-trip ${elapsedMs}ms)`);

  const evidence = {
    capturedAt: new Date().toISOString(),
    model: "claude-opus-4-8",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(scenario),
    scenario,
    decision,
    roundTripMs: elapsedMs,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`\nEvidence written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
