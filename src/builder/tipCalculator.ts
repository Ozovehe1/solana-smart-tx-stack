/**
 * Dynamic tip calculation (Spec §1.1, §8).
 *
 * HARD RULE: no hardcoded tip value, anywhere, ever — not as a target, not as a
 * fallback in the normal path. The tip is always derived from LIVE tip-floor data
 * (Jito's `tip_floor` endpoint) plus current network conditions.
 *
 * This module is pure given its inputs (a TipFloorData snapshot + signals), which is
 * exactly what makes it self-testable in-sandbox (Spec §7.5): feed a "high congestion"
 * and a "low congestion" snapshot and confirm the outputs differ meaningfully.
 */
import { JITO_MIN_TIP_LAMPORTS } from "../config/env.js";
import type { TipFloorData } from "../types.js";

/** Live signals that nudge the tip up/down relative to the floor data. */
export interface NetworkConditions {
  /** Watcher's self-regulation outcome (Spec §2.7). Congestion → tip higher. */
  degradedMode: boolean;
  /**
   * Observed processed→confirmed delta in ms (Spec §2.4/§5/README Q1). A widening delta
   * signals consensus stress / competition for block space → bias the tip upward.
   * Optional: absent on a first submission before any delta has been observed.
   */
  processedToConfirmedMs?: number;
  /** If this is a retry after losing a fee auction, escalate above the prior tip. */
  previousTipLamports?: number;
  retryAfterFeeTooLow?: boolean;
}

export interface TipCalculation {
  tipLamports: number;
  /** The base percentile chosen before adjustments (for logging/auditing). */
  basePercentileLamports: number;
  /** Human-readable trace of how the number was derived (logged, never hidden). */
  rationale: string;
}

/** Baseline "healthy" processed→confirmed delta (Spec §5 Q1: ~1-2s). */
const HEALTHY_CONFIRM_MS = 2000;

/**
 * Derive a tip from live data. Strategy:
 *   - Pick a base percentile from the live landed-tip distribution. Calm network → p50;
 *     stressed network (degraded mode or a widening confirm delta) → p75/p95.
 *   - Apply a congestion multiplier scaled by how far the confirm delta exceeds baseline.
 *   - On a fee-too-low retry, ensure we strictly exceed the previous tip.
 *   - Clamp to the Jito minimum floor (1000 lamports) — a FLOOR only, never a target.
 */
export function calculateTip(
  floor: TipFloorData,
  conditions: NetworkConditions,
): TipCalculation {
  const tips = floor.landedTipsLamports;
  const stressed =
    conditions.degradedMode ||
    (conditions.processedToConfirmedMs ?? 0) > HEALTHY_CONFIRM_MS * 2;

  // 1. Base percentile from live distribution.
  let base: number;
  let basisLabel: string;
  if (stressed) {
    base = tips.p95 ?? tips.p75 ?? tips.p50;
    basisLabel = tips.p95 != null ? "p95" : tips.p75 != null ? "p75" : "p50";
  } else {
    base = tips.p50;
    basisLabel = "p50";
  }

  // 2. Congestion multiplier from the real confirm delta (README Q1 signal).
  let multiplier = 1;
  const delta = conditions.processedToConfirmedMs;
  if (delta != null && delta > HEALTHY_CONFIRM_MS) {
    // Scale linearly: 2x baseline delta → 1.5x; 4x baseline → 2.5x, capped at 3x.
    multiplier = Math.min(3, 1 + (delta / HEALTHY_CONFIRM_MS - 1) * 0.5);
  } else if (conditions.degradedMode) {
    multiplier = 1.5;
  }

  let tip = Math.round(base * multiplier);

  // 3. Fee-too-low retry must strictly outbid the prior attempt.
  let retryNote = "";
  if (conditions.retryAfterFeeTooLow && conditions.previousTipLamports != null) {
    const escalated = Math.ceil(conditions.previousTipLamports * 1.25);
    if (escalated > tip) {
      tip = escalated;
      retryNote = ` Fee-too-low retry: escalated to 1.25x previous tip (${conditions.previousTipLamports}).`;
    }
  }

  // 4. Floor clamp (Spec §7 — 1000 lamports is a floor, not a target).
  let floorNote = "";
  if (tip < JITO_MIN_TIP_LAMPORTS) {
    tip = JITO_MIN_TIP_LAMPORTS;
    floorNote = ` Clamped up to Jito minimum (${JITO_MIN_TIP_LAMPORTS}).`;
  }

  const rationale =
    `Base ${basisLabel}=${base} lamports (${stressed ? "stressed" : "calm"} network); ` +
    `multiplier ${multiplier.toFixed(2)}` +
    (delta != null ? ` from processed→confirmed delta ${delta}ms` : "") +
    `.${retryNote}${floorNote}`;

  return { tipLamports: tip, basePercentileLamports: base, rationale };
}
