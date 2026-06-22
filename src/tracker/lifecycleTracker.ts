/**
 * Lifecycle Tracker — Record (Spec §3.1).
 *
 * Subscribes to the Watcher's normalized events; matches them against bundles currently
 * being tracked; computes Submitted→Processed→Confirmed→Finalized deltas; classifies
 * failures; resolves sibling SETS the instant any sibling lands. It NEVER decides
 * retry/tip logic — it only detects + classifies, then escalates to the Agent.
 *
 * Two failure-detection paths (Spec §2.3):
 *   1. Error-borne (expired blockhash / fee too low / compute exceeded / bundle failure)
 *      → delegated to classifyError().
 *   2. Silence / skipped slot (`bundle_skipped`) → there is NO error object. Detected
 *      here by `onSlotTick`: when the live slot advances past a still-`Submitted`
 *      bundle's targetSlot + graceSlots, we synthesize the verdict, then fire ONE direct
 *      status probe (§2.6) to disambiguate "stream missed it" vs "genuinely never landed".
 */
import {
  type BundleRecord,
  type FailureCategory,
  type LifecycleStage,
  type SiblingSet,
  type StageTransition,
  LIFECYCLE_ORDER,
} from "../types.js";
import { classifyError } from "./failureClassifier.js";
import { makeTransition } from "./logWriter.js";

/** A normalized stage event coming off the Watcher's internal queue. */
export interface StageEvent {
  bundleId: string;
  stage: LifecycleStage;
  slot: number;
  /** Epoch ms. */
  timestamp: number;
}

/**
 * One-off direct status probe (Spec §2.6). Returns the bundle's real stage if the chain
 * actually has it, or null if it genuinely never landed. Injected so it can be mocked.
 */
export type StatusProbe = (
  record: BundleRecord,
) => Promise<{ stage: LifecycleStage; slot: number } | null>;

export interface TrackerOptions {
  /** Slots past targetSlot before the silence watchdog fires (Spec §2.3 deadline in slots). */
  graceSlots: number;
  /** Called when a bundle is resolved as failed (error-borne or silence). Escalates to Agent. */
  onFailure: (record: BundleRecord, category: FailureCategory) => void;
  /** Called when a bundle reaches a terminal success stage (Confirmed/Finalized). */
  onLanded: (record: BundleRecord, set: SiblingSet) => void;
  /** Single direct status query for silence disambiguation. */
  statusProbe?: StatusProbe;
}

function stageRank(stage: LifecycleStage): number {
  return LIFECYCLE_ORDER.indexOf(stage);
}

export class LifecycleTracker {
  private readonly bundles = new Map<string, BundleRecord>();
  private readonly sets = new Map<string, SiblingSet>();
  /** Guards against firing the silence watchdog twice for the same bundle. */
  private readonly silenceChecked = new Set<string>();

  constructor(private readonly opts: TrackerOptions) {}

  /** Register a new bundle (one sibling of a set). Called by the Builder on submit. */
  track(record: BundleRecord): void {
    this.bundles.set(record.bundleId, record);
    let set = this.sets.get(record.setId);
    if (!set) {
      set = { setId: record.setId, siblings: [], landedBundleId: null };
      this.sets.set(record.setId, set);
    }
    set.siblings.push(record);
  }

  getBundle(bundleId: string): BundleRecord | undefined {
    return this.bundles.get(bundleId);
  }

  getSet(setId: string): SiblingSet | undefined {
    return this.sets.get(setId);
  }

  /**
   * Record a stage transition. Computes the latency delta vs the previous stage, advances
   * the bundle's stage (never backwards), and — when a sibling reaches Processed or
   * better — resolves the whole set, marking other siblings superseded (Spec §3.3).
   */
  onStageEvent(evt: StageEvent): void {
    const record = this.bundles.get(evt.bundleId);
    if (!record) return; // not a bundle we're tracking

    // Ignore out-of-order / regressive events (e.g. a late Processed after Confirmed).
    if (stageRank(evt.stage) <= stageRank(record.stage) && record.transitions.length) {
      return;
    }

    const previous: StageTransition | undefined =
      record.transitions[record.transitions.length - 1];
    record.transitions.push(
      makeTransition(evt.stage, evt.slot, evt.timestamp, previous),
    );
    record.stage = evt.stage;
    this.silenceChecked.delete(evt.bundleId); // it progressed; not silent

    // First sibling to land (Processed+) wins the set.
    if (stageRank(evt.stage) >= stageRank("Processed")) {
      this.resolveSetOnLanding(record);
    }
  }

  /** Mark a bundle failed from an error-borne cause (Spec §2.3 causes 1/2 + bundle failure). */
  onError(bundleId: string, err: unknown): void {
    const record = this.bundles.get(bundleId);
    if (!record || record.failure || record.superseded) return;
    const category = classifyError(err);
    record.failure = category;
    this.opts.onFailure(record, category);
  }

  /**
   * Slot-driven silence watchdog (Spec §2.3). Call on every live slot tick from the
   * Watcher. For each still-`Submitted` bundle whose targeted window has passed by more
   * than graceSlots, synthesize the `bundle_skipped` verdict — after one direct status
   * probe to rule out a missed stream event.
   */
  async onSlotTick(currentSlot: number): Promise<void> {
    for (const record of this.bundles.values()) {
      if (record.stage !== "Submitted") continue; // already progressed
      if (record.failure || record.superseded) continue;
      if (this.silenceChecked.has(record.bundleId)) continue;

      const lastTarget = Math.max(...record.targetSlots, record.submitSlot);
      if (currentSlot <= lastTarget + this.opts.graceSlots) continue;

      this.silenceChecked.add(record.bundleId);

      // §2.6: don't assume the stream is authoritative — issue ONE direct status query.
      if (this.opts.statusProbe) {
        const probed = await this.opts.statusProbe(record);
        if (probed) {
          // The stream missed it; it actually landed. Replay as a stage event.
          this.onStageEvent({
            bundleId: record.bundleId,
            stage: probed.stage,
            slot: probed.slot,
            timestamp: Date.now(),
          });
          continue;
        }
      }

      // Confirmed silence: targeted leader(s) skipped; bundle never reached the network.
      record.failure = "bundle_skipped";
      this.opts.onFailure(record, "bundle_skipped");
    }
  }

  /** Resolve a set when one sibling lands: mark the rest superseded (Spec §3.3). */
  private resolveSetOnLanding(landed: BundleRecord): void {
    const set = this.sets.get(landed.setId);
    if (!set || set.landedBundleId) return; // already resolved
    set.landedBundleId = landed.bundleId;
    for (const sibling of set.siblings) {
      if (sibling.bundleId === landed.bundleId) continue;
      if (sibling.stage === "Submitted" || !sibling.failure) {
        // Superseded — resolved-as-superseded, NOT independently failed (Spec §3.3).
        sibling.superseded = true;
      }
    }
    this.opts.onLanded(landed, set);
  }
}
