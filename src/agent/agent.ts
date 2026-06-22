/**
 * Agent — Decide (Spec §3.1, §6).
 *
 * The ONLY component that talks to Claude. It never touches the network or builds
 * transactions (clean AI/core separation, Spec §8). It receives real runtime data from
 * the Tracker, calls Claude via the Anthropic API, and returns a structured decision
 * WITH the verbatim reasoning text for the lifecycle log.
 *
 * The Anthropic client is injected so this is unit-testable with a mock (Spec §7.5: the
 * real API exchange is deferred this session per the user's choice).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentContext, AgentDecision, TipFloorData } from "../types.js";
import { calculateTip } from "../builder/tipCalculator.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./promptBuilder.js";
import { parseDecision } from "./responseParser.js";

/** Minimal shape we depend on — lets a mock stand in for the real SDK client. */
export interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      thinking?: { type: "adaptive" };
      messages: { role: "user"; content: string }[];
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export interface AgentOptions {
  client: AnthropicLike;
  /** Default: claude-opus-4-8 (most capable; per claude-api guidance). */
  model?: string;
}

/** Pull the concatenated text out of a Claude response. */
function responseText(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

export class Agent {
  private readonly model: string;
  constructor(private readonly opts: AgentOptions) {
    this.model = opts.model ?? "claude-opus-4-8";
  }

  /**
   * Make the one operational decision. The returned decision (tip, parallel targets,
   * retry y/n) is the literal output the Builder acts on — there is NO hardcoded override
   * in this path (Spec §6).
   */
  async decide(ctx: AgentContext): Promise<AgentDecision> {
    const resp = await this.opts.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" }, // adaptive thinking (claude-api guidance)
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    });
    return parseDecision(responseText(resp));
  }

  /**
   * Documented safe fallback for TOTAL API failure only (Spec §6). This still derives the
   * tip from live tip-floor data — it is NOT a hardcoded tip — but it bypasses the model's
   * reasoning, so it must never be the normal path. Callers should log loudly when it fires.
   */
  static deterministicFallback(ctx: AgentContext, tipFloor: TipFloorData): AgentDecision {
    const calc = calculateTip(tipFloor, {
      degradedMode: ctx.degradedMode,
      previousTipLamports: ctx.previousTipLamports,
      retryAfterFeeTooLow: ctx.failure === "fee_too_low",
    });
    return {
      tipLamports: calc.tipLamports,
      parallelTargets: 1,
      retry: ctx.failure !== null,
      reasoning:
        "[FALLBACK — Anthropic API unavailable] Tip derived directly from live tip-floor " +
        `data (no model reasoning). ${calc.rationale}`,
    };
  }
}

/** Construct an Agent backed by the real Anthropic SDK (used outside tests). */
export function createAgent(apiKey: string, model?: string): Agent {
  const client = new Anthropic({ apiKey }) as unknown as AnthropicLike;
  return new Agent({ client, model });
}
