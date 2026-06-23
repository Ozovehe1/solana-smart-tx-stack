/**
 * Agent differentiation harness (Spec §1.4/§6 — audit check A2).
 *
 * Runs three scenarios with MATERIALLY different inputs through the REAL Anthropic API,
 * prints each decision + verbatim reasoning, then checks the decisions actually diverge. A
 * genuine reasoning agent must produce different tips for different inputs; if all three
 * come back identical, the prompt isn't using the data and `promptBuilder.ts` needs tuning.
 *
 * Needs ANTHROPIC_API_KEY only — no Solana credentials. Run in a network-enabled session:
 *   npm run agent:diff
 */
import { config as loadDotenv } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { createAgent } from "../src/agent/agent.js";
import type { AgentContext, LeaderWindow, TipFloorData } from "../src/types.js";

loadDotenv();

function leaders(base: number): LeaderWindow[] {
  return Array.from({ length: 4 }, (_, i) => ({
    slot: base + i + 1,
    leader: `Leader${i}1111111111111111111111111111111111`,
    jitoEnabled: true,
  }));
}

function floor(p50: number, p75: number, p95: number, p99: number): TipFloorData {
  return {
    landedTipsLamports: { p25: Math.round(p50 / 2), p50, p75, p95, p99 },
    fetchedAt: Date.now(),
  };
}

const scenarios: { name: string; ctx: AgentContext }[] = [
  {
    name: "S1 — calm network, no failure",
    ctx: {
      failure: null,
      degradedMode: false,
      currentSlot: 100_000_000,
      tipFloor: floor(8_000, 12_000, 20_000, 40_000),
      leaderLookahead: leaders(100_000_000),
    },
  },
  {
    name: "S2 — expired_blockhash, elevated tip-floor",
    ctx: {
      failure: "expired_blockhash",
      degradedMode: false,
      currentSlot: 100_000_500,
      tipFloor: floor(50_000, 90_000, 150_000, 300_000),
      leaderLookahead: leaders(100_000_500),
    },
  },
  {
    name: "S3 — expired_blockhash, very high floor + degraded_mode, prior tip 200k",
    ctx: {
      failure: "expired_blockhash",
      degradedMode: true,
      currentSlot: 100_001_000,
      tipFloor: floor(120_000, 250_000, 500_000, 1_000_000),
      leaderLookahead: leaders(100_001_000),
      previousTipLamports: 200_000,
    },
  },
];

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("ANTHROPIC_API_KEY missing (.env). Cannot run the live differentiation test.");
    process.exitCode = 1;
    return;
  }

  const agent = createAgent(key);
  const results: Array<
    { name: string; tipLamports: number; parallelTargets: number; retry: boolean; reasoning: string }
  > = [];

  for (const s of scenarios) {
    console.log(`\n=== ${s.name} ===`);
    const d = await agent.decide(s.ctx);
    console.log(`  tipLamports=${d.tipLamports} parallelTargets=${d.parallelTargets} retry=${d.retry}`);
    console.log(`  reasoning: ${d.reasoning}`);
    results.push({ name: s.name, ...d });
  }

  const tips = results.map((r) => r.tipLamports);
  const allEqual = tips.every((t) => t === tips[0]);
  const monotonic = tips[0]! < tips[1]! && tips[1]! < tips[2]!;

  console.log("\n=== Differentiation check ===");
  console.log(`  tips: ${tips.join(", ")}`);
  if (allEqual) {
    console.log("  FAIL: all three tips identical — the agent is not using the inputs; tune promptBuilder.");
    process.exitCode = 1;
  } else if (monotonic) {
    console.log("  PASS: tips strictly increase with stress (calm < failure < very-stressed+degraded).");
  } else {
    console.log("  PARTIAL: tips differ but not monotonically — check the reasoning above to confirm the differences are justified.");
  }

  mkdirSync("logs", { recursive: true });
  writeFileSync("logs/agent-differentiation.json", JSON.stringify(results, null, 2));
  console.log("\nWrote logs/agent-differentiation.json");
}

main().catch((err) => {
  console.error("[agent:diff] fatal:", err);
  process.exitCode = 1;
});
