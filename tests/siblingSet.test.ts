/**
 * §7.5 self-test: parallel-bundle SET logic (Spec §3.3).
 * Simulate multiple synthetic sibling submissions, land one, and confirm the Tracker
 * resolves the whole set — marking the others resolved-as-SUPERSEDED, not independently
 * failed.
 */
import { describe, it, expect } from "vitest";
import { LifecycleTracker } from "../src/tracker/lifecycleTracker.js";
import type { BundleRecord, SiblingSet } from "../src/types.js";

function sibling(id: string, targetSlot: number): BundleRecord {
  return {
    bundleId: id,
    signatures: [`${id}-sig`],
    setId: "race-1",
    submitSlot: 200,
    targetSlots: [targetSlot],
    tipLamports: 50_000,
    transitions: [],
    stage: "Submitted",
    failure: null,
    superseded: false,
  };
}

describe("sibling set resolution (Spec §3.3)", () => {
  it("resolves the set on first landing and supersedes the rest", () => {
    let landed: SiblingSet | null = null;
    const tracker = new LifecycleTracker({
      graceSlots: 8,
      onFailure: () => {},
      onLanded: (_rec, set) => {
        landed = set;
      },
    });

    tracker.track(sibling("a", 205));
    tracker.track(sibling("b", 206));
    tracker.track(sibling("c", 207));

    // Sibling "b" lands first.
    tracker.onStageEvent({ bundleId: "b", stage: "Processed", slot: 206, timestamp: 10 });

    const set = tracker.getSet("race-1")!;
    expect(set.landedBundleId).toBe("b");
    expect(tracker.getBundle("b")!.superseded).toBe(false);
    expect(tracker.getBundle("a")!.superseded).toBe(true);
    expect(tracker.getBundle("c")!.superseded).toBe(true);
    // Superseded, NOT independently failed (Spec §3.3).
    expect(tracker.getBundle("a")!.failure).toBeNull();
    expect(landed).not.toBeNull();
  });

  it("does not double-resolve when a second sibling also progresses", () => {
    let landedCount = 0;
    const tracker = new LifecycleTracker({
      graceSlots: 8,
      onFailure: () => {},
      onLanded: () => {
        landedCount++;
      },
    });
    tracker.track(sibling("a", 205));
    tracker.track(sibling("b", 206));

    tracker.onStageEvent({ bundleId: "a", stage: "Processed", slot: 205, timestamp: 1 });
    tracker.onStageEvent({ bundleId: "b", stage: "Processed", slot: 206, timestamp: 2 });

    expect(landedCount).toBe(1);
    expect(tracker.getSet("race-1")!.landedBundleId).toBe("a");
  });
});
