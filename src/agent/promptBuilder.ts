/**
 * Agent prompt construction (Spec §6).
 *
 * Composes the prompt from REAL runtime data pulled at call time — the failure
 * classification just detected, live tip-floor percentiles, the Watcher's degraded_mode
 * flag, current slot, and leader lookahead. Never synthetic/example data in production.
 *
 * Pure string-building, so it is unit-testable without any network access (Spec §7.5):
 * assert the prompt actually contains the injected real values.
 */
import type { AgentContext } from "../types.js";

export const SYSTEM_PROMPT = `You are the decision agent for a Solana Jito-bundle transaction stack.
You own exactly one operational decision per call: given real, current data from the running
system, decide the dynamic tip (in lamports), how many parallel sibling bundles to target,
and whether to retry at all.

Rules you must follow:
- Tips are NEVER hardcoded. Derive the tip from the live tip-floor percentiles provided,
  adjusted for the current network conditions (degraded mode, consensus-speed signals).
- Balance cost against landing probability: do not overpay on a calm network; bid up when
  the network is stressed or when a prior attempt lost a fee auction.
- For an expired-blockhash failure, the fix is a fresh blockhash + recalculated tip and a
  retry — the blockhash itself is refreshed by the Builder, not by you.
- Make your reasoning explicit. It is logged verbatim and judged.

Respond with a single JSON object and nothing else, matching exactly:
{
  "reasoning": "<your full reasoning, in prose>",
  "tipLamports": <integer>,
  "parallelTargets": <integer >= 1>,
  "retry": <boolean>
}`;

/** Build the user-turn content describing the current, real situation. */
export function buildUserPrompt(ctx: AgentContext): string {
  const tips = ctx.tipFloor.landedTipsLamports;
  const jitoLeaders = ctx.leaderLookahead.filter((w) => w.jitoEnabled);

  const lines = [
    `Current slot: ${ctx.currentSlot}`,
    `Failure just detected: ${ctx.failure ?? "none (proactive tip decision)"}`,
    `Watcher degraded_mode: ${ctx.degradedMode}`,
    ctx.previousTipLamports != null
      ? `Previous tip used: ${ctx.previousTipLamports} lamports`
      : `No previous tip (first attempt)`,
    "",
    "Live Jito tip-floor percentiles (lamports):",
    `  p25=${tips.p25 ?? "n/a"} p50=${tips.p50} p75=${tips.p75 ?? "n/a"} p95=${tips.p95 ?? "n/a"} p99=${tips.p99 ?? "n/a"}`,
    `  (snapshot fetched at ${new Date(ctx.tipFloor.fetchedAt).toISOString()})`,
    "",
    `Upcoming Jito-enabled leader windows (next ${ctx.leaderLookahead.length} slots): ${jitoLeaders.length} are Jito-enabled.`,
    ...jitoLeaders
      .slice(0, 8)
      .map((w) => `  slot ${w.slot} → leader ${w.leader.slice(0, 8)}…`),
    "",
    "Decide the tip, number of parallel targets, and whether to retry. Respond with the JSON object only.",
  ];
  return lines.join("\n");
}
