/**
 * Failure classification (Spec §1.1, §2.3).
 *
 * IMPORTANT boundary: this module only handles the THREE error-borne categories plus
 * generic bundle failure — i.e. cases where an RPC/Jito error object or string exists.
 *
 * The FOURTH category, `bundle_skipped` (the §2.3 silence case), has NO error object
 * and is therefore NOT detected here. It is synthesized by the Lifecycle Tracker's
 * slot-driven watchdog (see lifecycleTracker.ts) from the absence of status progression
 * past `Submitted`. Keeping that out of this function is deliberate: there is nothing to
 * classify when the only signal is silence.
 */
import type { FailureCategory } from "../types.js";

/** Normalize an unknown error into a lowercased searchable string. */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err.toLowerCase();
  if (err instanceof Error) return `${err.name} ${err.message}`.toLowerCase();
  if (typeof err === "object") {
    // RPC errors often nest the useful text under message/data/logs.
    try {
      return JSON.stringify(err).toLowerCase();
    } catch {
      return String(err).toLowerCase();
    }
  }
  return String(err).toLowerCase();
}

/**
 * Classify an error-borne failure. Returns one of the four error categories.
 *
 * Order matters: more specific signatures are checked before the generic
 * `bundle_failure` fallback. We match on substrings observed in real Solana/Jito error
 * payloads (blockhash expiry, insufficient priority fee, compute-budget exhaustion).
 */
export function classifyError(err: unknown): Exclude<FailureCategory, "bundle_skipped"> {
  const text = errorText(err);

  // 1. Expired blockhash — the transaction's freshness anchor aged out (Spec §2.4/§5).
  if (
    text.includes("blockhash not found") ||
    text.includes("block height exceeded") ||
    text.includes("blockhashnotfound") ||
    text.includes("expired") ||
    (text.includes("blockhash") && text.includes("not found"))
  ) {
    return "expired_blockhash";
  }

  // 2. Fee/tip too low — lost the priority-fee / tip auction (Spec §2.3 cause 1).
  if (
    text.includes("fee too low") ||
    text.includes("priority fee") ||
    text.includes("insufficient fee") ||
    text.includes("tip too low") ||
    text.includes("tip is too low") ||
    text.includes("tip below") ||
    (text.includes("fee") && text.includes("low"))
  ) {
    return "fee_too_low";
  }

  // 3. Compute budget exceeded — ran out of compute units mid-execution.
  if (
    text.includes("compute") &&
    (text.includes("exceed") ||
      text.includes("budget") ||
      text.includes("limit") ||
      text.includes("exhaust"))
  ) {
    return "compute_exceeded";
  }
  if (
    text.includes("computational budget exceeded") ||
    text.includes("exceeded cus") ||
    text.includes("exceeded compute")
  ) {
    return "compute_exceeded";
  }

  // 4. Generic bundle failure — Jito-level rejection / simulation failure / dropped.
  return "bundle_failure";
}
