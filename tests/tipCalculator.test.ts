/**
 * §7.5 MUST self-test: dynamic tip calculation.
 * Feed synthetic high- vs low-congestion tip-floor inputs; confirm the tip is DERIVED
 * from that live data (not hardcoded) and that the two outputs differ meaningfully.
 */
import { describe, it, expect } from "vitest";
import { calculateTip } from "../src/builder/tipCalculator.js";
import { JITO_MIN_TIP_LAMPORTS } from "../src/config/env.js";
import type { TipFloorData } from "../src/types.js";

const floor: TipFloorData = {
  landedTipsLamports: { p25: 1_000, p50: 10_000, p75: 50_000, p95: 200_000, p99: 500_000 },
  fetchedAt: Date.now(),
};

describe("calculateTip — dynamic, from live data (Spec §1.1/§8)", () => {
  it("derives a calm-network tip from the p50 percentile", () => {
    const calm = calculateTip(floor, { degradedMode: false });
    expect(calm.basePercentileLamports).toBe(10_000); // p50
    expect(calm.tipLamports).toBe(10_000);
  });

  it("bids meaningfully higher under congestion than on a calm network", () => {
    const calm = calculateTip(floor, { degradedMode: false });
    const congested = calculateTip(floor, {
      degradedMode: true,
      processedToConfirmedMs: 9_000, // widening confirm delta = stress (README Q1)
    });
    // Stressed → higher base percentile AND a congestion multiplier.
    expect(congested.tipLamports).toBeGreaterThan(calm.tipLamports * 2);
  });

  it("escalates above the previous tip on a fee-too-low retry", () => {
    const retry = calculateTip(floor, {
      degradedMode: false,
      retryAfterFeeTooLow: true,
      previousTipLamports: 80_000, // higher than the calm p50 base
    });
    expect(retry.tipLamports).toBeGreaterThan(80_000);
  });

  it("clamps up to the Jito minimum floor but never hardcodes a target", () => {
    const tiny: TipFloorData = {
      landedTipsLamports: { p50: 100 },
      fetchedAt: Date.now(),
    };
    const calc = calculateTip(tiny, { degradedMode: false });
    expect(calc.tipLamports).toBe(JITO_MIN_TIP_LAMPORTS);
    expect(calc.rationale).toContain("minimum");
  });

  it("scales the tip with the magnitude of the confirm-delta signal", () => {
    const mild = calculateTip(floor, { degradedMode: false, processedToConfirmedMs: 4_000 });
    const severe = calculateTip(floor, { degradedMode: false, processedToConfirmedMs: 12_000 });
    expect(severe.tipLamports).toBeGreaterThan(mild.tipLamports);
  });
});
