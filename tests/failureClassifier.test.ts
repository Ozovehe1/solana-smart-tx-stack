/**
 * §7.5 MUST self-test: failure classifier.
 * Construct synthetic error objects/strings for each error-borne category and assert the
 * classifier labels each one correctly. (The fourth category, silence/skipped, has no
 * error object and is covered by silenceWatchdog.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { classifyError } from "../src/tracker/failureClassifier.js";

describe("classifyError — the three error-borne categories (Spec §1.1/§2.3)", () => {
  it("classifies expired blockhash from a real-shaped RPC error", () => {
    expect(classifyError(new Error("Blockhash not found"))).toBe("expired_blockhash");
    expect(
      classifyError("Transaction simulation failed: Blockhash not found"),
    ).toBe("expired_blockhash");
    expect(
      classifyError({ message: "block height exceeded for this transaction" }),
    ).toBe("expired_blockhash");
  });

  it("classifies fee/tip too low", () => {
    expect(classifyError(new Error("Priority fee too low"))).toBe("fee_too_low");
    expect(classifyError("tip is too low to be included")).toBe("fee_too_low");
    expect(classifyError({ message: "insufficient fee for inclusion" })).toBe(
      "fee_too_low",
    );
  });

  it("classifies compute budget exceeded", () => {
    expect(
      classifyError(new Error("Computational budget exceeded")),
    ).toBe("compute_exceeded");
    expect(
      classifyError("Program failed: exceeded compute unit limit"),
    ).toBe("compute_exceeded");
    expect(classifyError({ err: "compute budget exhausted" })).toBe("compute_exceeded");
  });

  it("falls back to generic bundle_failure for unrecognized Jito errors", () => {
    expect(classifyError(new Error("bundle dropped by block engine"))).toBe(
      "bundle_failure",
    );
    expect(classifyError("simulation failure: custom program error 0x1")).toBe(
      "bundle_failure",
    );
    expect(classifyError(null)).toBe("bundle_failure");
  });

  it("never returns the silence category (that path is not error-borne)", () => {
    const labels = [
      classifyError(new Error("blockhash not found")),
      classifyError("fee too low"),
      classifyError("compute exceeded"),
      classifyError("whatever"),
    ];
    expect(labels).not.toContain("bundle_skipped");
  });
});
