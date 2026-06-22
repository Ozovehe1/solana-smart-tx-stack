/**
 * Entry point — wires the loop (Spec §3.2):
 *
 *   Watcher (observe) → Tracker (record) → [on failure/decision] Agent (decide)
 *      → Builder (act) → back into Watcher/Tracker.
 *
 * Retry is NOT a special-cased path — it is the same loop running again, triggered by the
 * Tracker detecting a failure instead of a success (Spec §3.2).
 *
 * LIVE-INFRA: this requires real Yellowstone + Jito + mainnet credentials to actually run
 * (Spec §7.5). It is wired and type-checked here; running it end-to-end is the live
 * verification step, not something this sandbox can do.
 */
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config/env.js";
import { Watcher } from "./watcher/watcher.js";
import { getLeaderLookahead } from "./watcher/leaderSchedule.js";
import { LifecycleTracker } from "./tracker/lifecycleTracker.js";
import { LifecycleLogWriter, buildLogEntry } from "./tracker/logWriter.js";
import { JitoClient, fetchTipFloor } from "./builder/jitoClient.js";
import { Builder } from "./builder/builder.js";
import { createAgent, Agent } from "./agent/agent.js";
import type { AgentContext, LeaderWindow, LifecycleStage } from "./types.js";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Map Jito's getBundleStatuses `confirmation_status` → our LifecycleStage. */
function confirmationToStage(status: string): LifecycleStage {
  switch (status) {
    case "finalized":
      return "Finalized";
    case "confirmed":
      return "Confirmed";
    default:
      return "Processed"; // "processed" — landed but not yet vote-confirmed
  }
}

/** Spacing between submissions in a batch run (~5 slots) so they target distinct windows. */
const SUBMIT_SPACING_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rpc = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
  const jito = new JitoClient(cfg.JITO_BLOCK_ENGINE_URL);
  const log = new LifecycleLogWriter(cfg.LIFECYCLE_LOG_PATH);
  const agent = createAgent(cfg.ANTHROPIC_API_KEY);
  const payer = loadKeypair(cfg.MAINNET_KEYPAIR_PATH);

  // The set of Jito-enabled validator identities. Real source: Jito's published running
  // validator set; injected here so the lookahead stays testable (Spec §2.2). Until that
  // allowlist is wired, an empty set means "treat all upcoming leaders as targetable": on
  // mainnet the supermajority run jito-solana, and a bundle routed to a non-Jito leader
  // simply never lands — which the Tracker's silence watchdog already catches (Spec §2.3).
  const jitoEnabledValidators = new Set<string>();
  const isJitoEnabled = (leader: string) =>
    jitoEnabledValidators.size === 0 || jitoEnabledValidators.has(leader);

  let leaderLookahead: LeaderWindow[] = [];

  // Correlates streamed transaction signatures back to the bundle that owns them, so
  // landing is confirmed from the STREAM (Spec §1.1/§8). Populated on every submit.
  const sigIndex = new Map<string, string>();

  const tracker = new LifecycleTracker({
    graceSlots: cfg.SILENCE_GRACE_SLOTS,
    // FALLBACK ONLY (Spec §2.6): the stream (onTransactionStatus below) is the primary,
    // mandated way landing is confirmed. This single direct query fires only from the
    // silence watchdog, for a still-`Submitted` bundle past its deadline, to disambiguate
    // "stream missed it" vs "genuinely never landed" — never as the primary mechanism.
    statusProbe: async (record) => {
      const res = (await jito.getBundleStatuses([record.bundleId])) as {
        value?: Array<{ slot?: number; confirmation_status?: string | null } | null>;
      };
      const row = res?.value?.[0];
      if (!row || row.confirmation_status == null) return null; // never landed
      return {
        stage: confirmationToStage(row.confirmation_status),
        slot: row.slot ?? record.submitSlot,
      };
    },
    onLanded: (record, set) => {
      log.write(buildLogEntry(record));
      console.log(`[tracker] set ${set.setId} landed via ${record.bundleId}`);
    },
    onFailure: async (record, category) => {
      log.write(buildLogEntry(record));
      console.log(`[tracker] bundle ${record.bundleId} failed: ${category}`);
      // Failure → Agent decides → Builder retries. Same loop, triggered by failure.
      await runOnce(category);
    },
  });

  const watcher = new Watcher(
    {
      endpoint: cfg.YELLOWSTONE_ENDPOINT,
      token: cfg.YELLOWSTONE_TOKEN,
      rpcUrl: cfg.SOLANA_RPC_URL,
      payer: payer.publicKey.toBase58(), // subscribe to our own bundles' transactions
    },
    {
      onSlot: (slot) => {
        void tracker.onSlotTick(slot); // drives the silence watchdog (Spec §2.3)
      },
      // PRIMARY landing confirmation, from the stream (Spec §1.1/§8 — not polling). A
      // streamed tx update for one of our signatures advances that bundle's lifecycle
      // stage; a stream-reported tx error becomes an error-borne failure.
      onTransactionStatus: ({ signature, slot, commitment, err }) => {
        const bundleId = sigIndex.get(signature);
        if (!bundleId) return; // not one of our bundles
        if (err) {
          tracker.onError(bundleId, err);
          return;
        }
        tracker.onStageEvent({
          bundleId,
          stage: confirmationToStage(commitment),
          slot,
          timestamp: Date.now(),
        });
      },
      onUpdate: () => {
        // Non-transaction updates (accounts/blocks/entries). Not needed for the lifecycle
        // log; the queue/drain path keeps the receive loop non-blocking (Spec §2.7).
      },
      onDegradedModeChange: (degraded) =>
        console.log(`[watcher] degraded_mode=${degraded}`),
      onReconnect: ({ lastSeenSlot, currentSlot }) =>
        console.log(`[watcher] reconnected; slot gap ${currentSlot - lastSeenSlot}`),
    },
  );

  /** One pass of the loop: gather real data → Agent decides → Builder submits. */
  async function runOnce(failure: AgentContext["failure"]): Promise<void> {
    const tipFloor = await fetchTipFloor();
    const currentSlot = watcher.currentSlot || (await rpc.getSlot("confirmed"));
    leaderLookahead = await getLeaderLookahead(
      { connection: rpc, lookahead: cfg.LEADER_LOOKAHEAD, isJitoEnabled },
      currentSlot + 1,
    );

    const ctx: AgentContext = {
      failure,
      tipFloor,
      degradedMode: watcher.degradedMode,
      currentSlot,
      leaderLookahead,
    };

    let decision;
    try {
      decision = await agent.decide(ctx); // the real decision (Spec §6)
    } catch (err) {
      console.error(`[agent] API failed (${(err as Error).message}); using fallback`);
      decision = Agent.deterministicFallback(ctx, tipFloor);
    }
    console.log(`[agent] decision:`, decision);

    const targets = leaderLookahead.filter((w) => w.jitoEnabled).map((w) => w.slot);
    const builder = new Builder({
      connection: rpc,
      payer,
      jito,
      buildIntent: (pk) => {
        // Minimal self-transfer intent for the lifecycle log; the guard-bearing intent
        // for parallel siblings (Spec §3.3) slots in here at Phase 4.
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({ fromPubkey: pk, toPubkey: pk, lamports: 1 }));
        return tx;
      },
      setId: `set-${currentSlot}`,
      targetSlots: targets.slice(0, decision.parallelTargets),
      submitSlot: currentSlot,
    });

    if (decision.retry || failure === null) {
      const record = await builder.submit(decision);
      tracker.track(record);
      // Register signatures so streamed tx updates correlate back to this bundle.
      for (const sig of record.signatures) sigIndex.set(sig, record.bundleId);
      log.write(buildLogEntry(record, decision.reasoning));
    }
  }

  console.log(
    `[stack] starting Watcher; submitting ${cfg.SUBMISSION_COUNT} bundle(s) once streaming…`,
  );
  void watcher.start();
  for (let i = 0; i < cfg.SUBMISSION_COUNT; i++) {
    await runOnce(null); // each pass is one logical (non-retry) submission
    if (i < cfg.SUBMISSION_COUNT - 1) await sleep(SUBMIT_SPACING_MS);
  }
  console.log(
    `[stack] submitted ${cfg.SUBMISSION_COUNT} bundle(s); Watcher keeps tracking lifecycle ` +
      "stages to resolution. Stop with Ctrl-C once the log shows all bundles resolved.",
  );
}

main().catch((err) => {
  console.error("[stack] fatal:", err);
  process.exitCode = 1;
});
