/**
 * §7.5 self-test: the silence / skipped-slot watchdog (Spec §2.3).
 * A bundle stuck at `Submitted` with a targetSlot; push synthetic slot ticks past
 * target + grace; assert the Tracker emits `bundle_skipped` with NO error object — the
 * verdict is synthesized from the absence of progression, not classified from an error.
 */
import { describe, it, expect, vi } from "vitest";
import { LifecycleTracker } from "../src/tracker/lifecycleTracker.js";
import type { BundleRecord, FailureCategory } from "../src/types.js";

function bundle(overrides: Partial<BundleRecord> = {}): BundleRecord {
  return {
    bundleId: "b1",
    setId: "s1",
    submitSlot: 100,
    targetSlots: [105],
    tipLamports: 50_000,
    transitions: [],
    stage: "Submitted",
    failure: null,
    superseded: false,
    ...overrides,
  };
}

describe("silence watchdog (Spec §2.3)", () => {
  it("synthesizes bundle_skipped once the live slot passes target + grace", async () => {
    const failures: Array<{ id: string; cat: FailureCategory }> = [];
    const tracker = new LifecycleTracker({
      graceSlots: 8,
      onFailure: (rec, cat) => failures.push({ id: rec.bundleId, cat }),
      onLanded: () => {},
      // No statusProbe → straight to the silence verdict (no error object exists).
    });
    tracker.track(bundle({ targetSlots: [105] }));

    await tracker.onSlotTick(110); // 105 + 8 = 113; not yet past grace
    expect(failures).toHaveLength(0);

    await tracker.onSlotTick(114); // now past 113 → silence verdict fires
    expect(failures).toEqual([{ id: "b1", cat: "bundle_skipped" }]);
    expect(tracker.getBundle("b1")?.failure).toBe("bundle_skipped");
  });

  it("does NOT fire if the bundle progressed past Submitted", async () => {
    const failures: FailureCategory[] = [];
    const tracker = new LifecycleTracker({
      graceSlots: 4,
      onFailure: (_r, cat) => failures.push(cat),
      onLanded: () => {},
    });
    tracker.track(bundle({ targetSlots: [105] }));
    tracker.onStageEvent({ bundleId: "b1", stage: "Processed", slot: 105, timestamp: 1 });

    await tracker.onSlotTick(200);
    expect(failures).toHaveLength(0);
  });

  it("uses one direct status probe to rule out a missed stream event (Spec §2.6)", async () => {
    const failures: FailureCategory[] = [];
    const probe = vi.fn(async () => ({ stage: "Confirmed" as const, slot: 106 }));
    const tracker = new LifecycleTracker({
      graceSlots: 2,
      onFailure: (_r, cat) => failures.push(cat),
      onLanded: () => {},
      statusProbe: probe,
    });
    tracker.track(bundle({ targetSlots: [105] }));

    await tracker.onSlotTick(120);
    expect(probe).toHaveBeenCalledOnce();
    // The probe found it actually landed → no silence verdict; bundle advanced instead.
    expect(failures).toHaveLength(0);
    expect(tracker.getBundle("b1")?.stage).toBe("Confirmed");
  });
});
