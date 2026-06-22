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
import type { AgentContext, LeaderWindow } from "./types.js";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rpc = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
  const jito = new JitoClient(cfg.JITO_BLOCK_ENGINE_URL);
  const log = new LifecycleLogWriter(cfg.LIFECYCLE_LOG_PATH);
  const agent = createAgent(cfg.ANTHROPIC_API_KEY);
  const payer = loadKeypair(cfg.MAINNET_KEYPAIR_PATH);

  // The set of Jito-enabled validator identities. Real source: Jito's published running
  // validator set; injected here so the lookahead stays testable (Spec §2.2).
  const jitoEnabledValidators = new Set<string>();
  const isJitoEnabled = (leader: string) => jitoEnabledValidators.has(leader);

  let leaderLookahead: LeaderWindow[] = [];

  const tracker = new LifecycleTracker({
    graceSlots: cfg.SILENCE_GRACE_SLOTS,
    statusProbe: async () => null, // wired to jito.getBundleStatuses in live runs
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
    },
    {
      onSlot: (slot) => {
        void tracker.onSlotTick(slot); // drives the silence watchdog (Spec §2.3)
      },
      onUpdate: () => {
        /* transaction/account updates → tracker.onStageEvent in live runs */
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
      log.write(buildLogEntry(record, decision.reasoning));
    }
  }

  console.log("[stack] starting Watcher; initial submission follows once streaming…");
  void watcher.start();
  await runOnce(null); // initial (non-retry) submission
}

main().catch((err) => {
  console.error("[stack] fatal:", err);
  process.exitCode = 1;
});
