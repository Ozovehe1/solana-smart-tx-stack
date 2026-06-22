/**
 * §7.5 self-test: agent prompt construction + response parsing (MOCKED client).
 * Per the user's choice this session, the real Anthropic API call is deferred — here we
 * inject a mock client and assert: (a) the prompt carries the REAL injected data, and
 * (b) the model's response parses into a valid AgentDecision the Builder can act on.
 */
import { describe, it, expect, vi } from "vitest";
import { Agent, type AnthropicLike } from "../src/agent/agent.js";
import { buildUserPrompt } from "../src/agent/promptBuilder.js";
import { parseDecision, AgentParseError } from "../src/agent/responseParser.js";
import type { AgentContext } from "../src/types.js";

const ctx: AgentContext = {
  failure: "expired_blockhash",
  tipFloor: {
    landedTipsLamports: { p25: 1000, p50: 12345, p75: 50000, p95: 222222, p99: 500000 },
    fetchedAt: Date.UTC(2026, 5, 22),
  },
  degradedMode: true,
  currentSlot: 987_654,
  leaderLookahead: [
    { slot: 987_655, leader: "JitoLeaderAAA11111111111111111111111111111", jitoEnabled: true },
    { slot: 987_656, leader: "NonJitoBBB2222222222222222222222222222222", jitoEnabled: false },
  ],
  previousTipLamports: 40_000,
};

describe("prompt construction (Spec §6) — carries real injected data", () => {
  it("includes the failure, slot, degraded flag, tip-floor and leader data", () => {
    const prompt = buildUserPrompt(ctx);
    expect(prompt).toContain("expired_blockhash");
    expect(prompt).toContain("987654");
    expect(prompt).toContain("degraded_mode: true");
    expect(prompt).toContain("12345"); // p50 from the live snapshot
    expect(prompt).toContain("40000"); // previous tip
    expect(prompt).toContain("1 are Jito-enabled"); // only one window is Jito-enabled
  });
});

describe("response parsing (Spec §6) — into a Builder-actionable decision", () => {
  it("parses a clean JSON response", () => {
    const decision = parseDecision(
      JSON.stringify({
        reasoning: "Blockhash expired; refresh and bump tip above prior 40k.",
        tipLamports: 60000,
        parallelTargets: 2,
        retry: true,
      }),
    );
    expect(decision.tipLamports).toBe(60000);
    expect(decision.parallelTargets).toBe(2);
    expect(decision.retry).toBe(true);
    expect(decision.reasoning).toContain("Blockhash expired");
  });

  it("parses JSON wrapped in prose / a fenced code block", () => {
    const text =
      "Here is my decision based on the data.\n\n```json\n" +
      '{ "reasoning": "calm network", "tipLamports": 12345, "parallelTargets": 1, "retry": false }\n' +
      "```\nThat is my recommendation.";
    const decision = parseDecision(text);
    expect(decision.tipLamports).toBe(12345);
    expect(decision.retry).toBe(false);
  });

  it("rejects a response missing the required reasoning text", () => {
    expect(() =>
      parseDecision(JSON.stringify({ tipLamports: 1, parallelTargets: 1, retry: true })),
    ).toThrow(AgentParseError);
  });

  it("rejects an invalid tip / parallelTargets", () => {
    expect(() =>
      parseDecision(
        JSON.stringify({ reasoning: "x", tipLamports: -5, parallelTargets: 1, retry: true }),
      ),
    ).toThrow(AgentParseError);
    expect(() =>
      parseDecision(
        JSON.stringify({ reasoning: "x", tipLamports: 1, parallelTargets: 0, retry: true }),
      ),
    ).toThrow(AgentParseError);
  });
});

describe("Agent.decide — end to end with a MOCK Anthropic client", () => {
  it("sends the real prompt and returns the parsed decision", async () => {
    const create = vi.fn(async (args: { messages: { content: string }[] }) => {
      // The agent must pass the real injected data through to the model.
      expect(args.messages[0]!.content).toContain("expired_blockhash");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reasoning: "Expired blockhash on a stressed network; bump tip, retry, 2 targets.",
              tipLamports: 90000,
              parallelTargets: 2,
              retry: true,
            }),
          },
        ],
      };
    });
    const client = { messages: { create } } as unknown as AnthropicLike;

    const agent = new Agent({ client });
    const decision = await agent.decide(ctx);

    expect(create).toHaveBeenCalledOnce();
    expect(decision.tipLamports).toBe(90000);
    expect(decision.reasoning).toContain("Expired blockhash");
  });

  it("deterministicFallback derives a tip from live data, not a hardcode (Spec §6)", () => {
    const decision = Agent.deterministicFallback(ctx, ctx.tipFloor);
    expect(decision.reasoning).toContain("FALLBACK");
    expect(decision.tipLamports).toBeGreaterThan(0);
    expect(decision.retry).toBe(true); // there was a failure to retry
  });
});
