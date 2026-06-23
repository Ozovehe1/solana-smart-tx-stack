/**
 * Shared types — the contract between the four components (Spec §3.1).
 * Verbs: Watcher = observe, Tracker = record, Agent = decide, Builder = act.
 */

/** Commitment levels (Spec §7, §2.4). Never `finalized` for time-sensitive blockhash. */
export type Commitment = "processed" | "confirmed" | "finalized";

/** The four-stage lifecycle (Spec §1.1, §2.4). */
export type LifecycleStage =
  | "Submitted" // our bookkeeping — code transmitted the bundle; nothing on-chain yet
  | "Processed" // a leader included it in a block (unconfirmed, can fork away)
  | "Confirmed" // supermajority stake-weighted vote attested the block
  | "Finalized"; // rooted (~32 slots later); unconditional

export const LIFECYCLE_ORDER: LifecycleStage[] = [
  "Submitted",
  "Processed",
  "Confirmed",
  "Finalized",
];

/**
 * Failure categories (Spec §1.1 requires the first four; §2.3 adds the silence case).
 * The first three are ERROR-BORNE — derived from an RPC/Jito error object.
 * `bundle_skipped` is the SILENCE case — no error object exists; detected by the
 * Tracker's slot-driven watchdog via absence of progression past `Submitted`.
 */
export type FailureCategory =
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "bundle_skipped"; // §2.3 silence: targeted leader(s) skipped; bundle never landed

/** Set of failure categories that originate from an error object (classifier handles). */
export const ERROR_BORNE_FAILURES: ReadonlySet<FailureCategory> = new Set([
  "expired_blockhash",
  "fee_too_low",
  "compute_exceeded",
  "bundle_failure",
]);

/** One recorded stage transition for a bundle. */
export interface StageTransition {
  stage: LifecycleStage;
  slot: number;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** ms since the previous recorded stage; null for the first (`Submitted`). */
  latencyDeltaMs: number | null;
}

/** Live tip-floor data fetched from Jito's endpoint (Spec §1.1, §7). */
export interface TipFloorData {
  /** Landed-tip percentiles in LAMPORTS. Keys are percentile labels. */
  landedTipsLamports: {
    p25?: number;
    p50: number;
    p75?: number;
    p95?: number;
    p99?: number;
  };
  /** When this snapshot was fetched (epoch ms). */
  fetchedAt: number;
}

/** Inputs the Agent reasons over — all pulled live at call time (Spec §6). */
export interface AgentContext {
  failure: FailureCategory | null;
  tipFloor: TipFloorData;
  /** Watcher's self-regulation outcome (Spec §2.7) — a fact, not raw arrival rate. */
  degradedMode: boolean;
  currentSlot: number;
  /** Upcoming Jito-enabled leader windows (Spec §2.2, §3.1). */
  leaderLookahead: LeaderWindow[];
  /** Prior tip used, if this is a retry (lamports). */
  previousTipLamports?: number;
}

/** The Agent's structured decision — the literal thing the Builder acts on (Spec §6). */
export interface AgentDecision {
  /** Dynamic tip to use, in LAMPORTS (never hardcoded; Agent-chosen). */
  tipLamports: number;
  /** How many parallel sibling bundles to send (1 = single bundle). */
  parallelTargets: number;
  /** Whether to (re)submit at all. */
  retry: boolean;
  /** Verbatim reasoning text from Claude — logged alongside the decision (Spec §6). */
  reasoning: string;
}

/** An upcoming leader window from the public schedule (Spec §2.2). */
export interface LeaderWindow {
  slot: number;
  /** Validator identity (base58). */
  leader: string;
  /** Whether this leader runs Jito (only these can include bundles). */
  jitoEnabled: boolean;
}

/** A single tracked bundle (one sibling within a set). */
export interface BundleRecord {
  bundleId: string;
  /**
   * Base58 signature(s) of the bundle's transaction(s). Used to correlate streamed
   * Yellowstone transaction updates back to this bundle so landing is confirmed from the
   * STREAM, not by polling (Spec §1.1/§8).
   */
  signatures: string[];
  /** The set this bundle belongs to (siblings share a setId). Spec §3.3. */
  setId: string;
  /** Slot at which we transmitted (our `Submitted` bookkeeping). */
  submitSlot: number;
  /**
   * The targeted Jito-enabled leader slot(s) this bundle was routed to.
   * The silence watchdog (Spec §2.3) measures its deadline against these — in SLOTS.
   */
  targetSlots: number[];
  tipLamports: number;
  transitions: StageTransition[];
  /** Current stage (last transition's stage, or `Submitted`). */
  stage: LifecycleStage;
  /** Failure verdict once resolved as failed. */
  failure: FailureCategory | null;
  /** Set if this sibling was resolved-as-superseded because a sibling landed first. */
  superseded: boolean;
  /**
   * Verbatim Agent reasoning that drove this submission (Spec §1.4/§6). Stored on the
   * record so EVERY log entry for the bundle — submit, landed, and failed — carries it,
   * not just the submit-time entry.
   */
  agentReasoning?: string;
}

/**
 * A set of sibling bundles racing for the same outcome (Spec §3.3).
 * Counts as ONE logical submission toward the bounty's "10 submissions" (Spec §3.3),
 * but every sibling's slot is logged for explorer verification.
 */
export interface SiblingSet {
  setId: string;
  siblings: BundleRecord[];
  /** bundleId of the sibling that actually landed, if any. */
  landedBundleId: string | null;
}

/** A durable lifecycle log entry (Spec §1.3 — all fields are required for the bounty). */
export interface LogEntry {
  bundleId: string;
  setId: string;
  /** Slot numbers across the lifecycle — judges cross-reference these on an explorer. */
  slots: {
    submit: number;
    target: number[];
    /** Slot at each reached stage. */
    perStage: Partial<Record<LifecycleStage, number>>;
  };
  /** Ordered commitment progression actually observed. */
  commitmentProgression: LifecycleStage[];
  /** Stage timestamps + deltas. */
  transitions: StageTransition[];
  tipLamports: number;
  failure: FailureCategory | null;
  superseded: boolean;
  /** Agent reasoning verbatim, when a decision drove this submission (Spec §6). */
  agentReasoning?: string;
  /** When this entry was written (epoch ms). */
  loggedAt: number;
}
