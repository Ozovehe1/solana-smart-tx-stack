/**
 * §7.5 MUST self-test: lifecycle log writer.
 * Feed synthetic stage-transition events; verify the resulting entry is well-formed,
 * contains every required §1.3 field, and is readable back from disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleLogWriter,
  buildLogEntry,
  makeTransition,
  REQUIRED_LOG_FIELDS,
} from "../src/tracker/logWriter.js";
import type { BundleRecord } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recordWithTransitions(): BundleRecord {
  // Synthetic Submitted→Processed→Confirmed→Finalized progression with fake slots/times.
  const t0 = makeTransition("Submitted", 1000, 0, undefined);
  const t1 = makeTransition("Processed", 1001, 450, t0);
  const t2 = makeTransition("Confirmed", 1003, 1800, t1);
  const t3 = makeTransition("Finalized", 1035, 14_800, t2);
  return {
    bundleId: "bundle-xyz",
    signatures: ["sig-xyz"],
    setId: "set-1",
    submitSlot: 1000,
    targetSlots: [1001, 1002],
    tipLamports: 75_000,
    transitions: [t0, t1, t2, t3],
    stage: "Finalized",
    failure: null,
    superseded: false,
  };
}

describe("lifecycle log writer (Spec §1.3)", () => {
  it("computes latency deltas between stages (null on the first)", () => {
    const r = recordWithTransitions();
    expect(r.transitions[0]!.latencyDeltaMs).toBeNull();
    expect(r.transitions[1]!.latencyDeltaMs).toBe(450);
    expect(r.transitions[2]!.latencyDeltaMs).toBe(1350); // 1800 - 450
    expect(r.transitions[3]!.latencyDeltaMs).toBe(13_000); // 14800 - 1800
  });

  it("builds an entry containing every required §1.3 field", () => {
    const entry = buildLogEntry(recordWithTransitions());
    for (const field of REQUIRED_LOG_FIELDS) {
      expect(entry).toHaveProperty(field);
    }
    expect(entry.slots.submit).toBe(1000);
    expect(entry.slots.target).toEqual([1001, 1002]);
    expect(entry.slots.perStage.Confirmed).toBe(1003);
    expect(entry.commitmentProgression).toEqual([
      "Submitted",
      "Processed",
      "Confirmed",
      "Finalized",
    ]);
    expect(entry.tipLamports).toBe(75_000);
    expect(entry.failure).toBeNull();
  });

  it("records the agent reasoning verbatim when provided (Spec §6)", () => {
    const entry = buildLogEntry(recordWithTransitions(), "because the network was calm");
    expect(entry.agentReasoning).toBe("because the network was calm");
  });

  it("writes durable JSONL and reads it back queryable", () => {
    const path = join(dir, "lifecycle.jsonl");
    const writer = new LifecycleLogWriter(path);
    writer.write(buildLogEntry(recordWithTransitions()));
    writer.write(
      buildLogEntry({ ...recordWithTransitions(), bundleId: "b2", failure: "fee_too_low" }),
    );

    const back = writer.readAll();
    expect(back).toHaveLength(2);
    expect(back[0]!.bundleId).toBe("bundle-xyz");
    expect(back[1]!.failure).toBe("fee_too_low");
  });
});
