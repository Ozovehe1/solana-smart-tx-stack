/**
 * Unit test for the stream tx-status extractor (Spec §1.1/§8 — landing confirmed from the
 * stream, not polling). Exercises the parsing of a synthetic Yellowstone SubscribeUpdate
 * into a normalized {signature, slot, commitment, err}. The assumed payload shape is the
 * one bit reconfirmed against a live LaserStream payload, but the extraction/coercion
 * logic is fully testable offline.
 */
import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { extractTransactionStatus } from "../src/watcher/watcher.js";

const sigBytes = Uint8Array.from([1, 2, 3, 4, 5]);
const sig = bs58.encode(sigBytes);

describe("extractTransactionStatus", () => {
  it("normalizes a transactionStatus update", () => {
    const evt = extractTransactionStatus(
      { transactionStatus: { signature: sigBytes, slot: 123, err: null } },
      "confirmed",
    );
    expect(evt).toEqual({
      signature: sig,
      slot: 123,
      commitment: "confirmed",
      err: null,
    });
  });

  it("normalizes a transaction update (signature nested under .transaction)", () => {
    const evt = extractTransactionStatus(
      { transaction: { slot: 200, transaction: { signature: sigBytes } } },
      "confirmed",
    );
    expect(evt?.signature).toBe(sig);
    expect(evt?.slot).toBe(200);
  });

  it("passes through a stream-reported tx error", () => {
    const err = { InstructionError: [0, "Custom"] };
    const evt = extractTransactionStatus(
      { transactionStatus: { signature: sigBytes, slot: 9, err } },
      "confirmed",
    );
    expect(evt?.err).toEqual(err);
  });

  it("coerces a string slot and carries the given commitment", () => {
    const evt = extractTransactionStatus(
      { transactionStatus: { signature: sigBytes, slot: "456" } },
      "processed",
    );
    expect(evt?.slot).toBe(456);
    expect(evt?.commitment).toBe("processed");
  });

  it("returns null for non-transaction updates (slot/account)", () => {
    expect(extractTransactionStatus({ slot: { slot: 5 } }, "confirmed")).toBeNull();
    expect(extractTransactionStatus({ account: {} }, "confirmed")).toBeNull();
    expect(extractTransactionStatus({}, "confirmed")).toBeNull();
  });
});
