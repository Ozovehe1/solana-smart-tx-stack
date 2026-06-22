/**
 * Agent response parsing (Spec §6, §7.5).
 *
 * Turns Claude's text response into the structured AgentDecision the Builder acts on,
 * while preserving the full reasoning text verbatim for the lifecycle log. Robust to the
 * model wrapping the JSON in prose or a fenced code block. Pure → unit-testable.
 *
 * If parsing fails, the caller decides what to do (a documented safe fallback for total
 * API failure is allowed, but must NOT be the normal path — Spec §6).
 */
import type { AgentDecision } from "../types.js";

export class AgentParseError extends Error {}

/** Extract the first balanced top-level JSON object from arbitrary text. */
function extractJsonObject(text: string): string {
  // Prefer a fenced ```json block if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced?.[1] ?? text;

  const start = haystack.indexOf("{");
  if (start === -1) throw new AgentParseError("no JSON object found in response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  throw new AgentParseError("unbalanced JSON object in response");
}

/** Parse + validate Claude's response into an AgentDecision. */
export function parseDecision(responseText: string): AgentDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(responseText));
  } catch (e) {
    if (e instanceof AgentParseError) throw e;
    throw new AgentParseError(`response was not valid JSON: ${(e as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new AgentParseError("parsed JSON is not an object");
  }
  const obj = raw as Record<string, unknown>;

  const tipLamports = obj["tipLamports"];
  const parallelTargets = obj["parallelTargets"];
  const retry = obj["retry"];
  const reasoning = obj["reasoning"];

  if (typeof tipLamports !== "number" || !Number.isFinite(tipLamports) || tipLamports < 0) {
    throw new AgentParseError(`invalid tipLamports: ${String(tipLamports)}`);
  }
  if (
    typeof parallelTargets !== "number" ||
    !Number.isInteger(parallelTargets) ||
    parallelTargets < 1
  ) {
    throw new AgentParseError(`invalid parallelTargets: ${String(parallelTargets)}`);
  }
  if (typeof retry !== "boolean") {
    throw new AgentParseError(`invalid retry: ${String(retry)}`);
  }
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    throw new AgentParseError("missing reasoning text (required for the log, Spec §6)");
  }

  return {
    tipLamports: Math.round(tipLamports),
    parallelTargets,
    retry,
    reasoning,
  };
}
