/**
 * Fault injection — the mandatory blockhash-expiry test case (Spec §1.4, §4.2).
 *
 * This deliberately builds a transaction, then HOLDS it past its blockhash validity
 * window before submitting, forcing a real "blockhash not found / block height exceeded"
 * failure. This is a required, intentional test case — not an incidental bug.
 *
 * In the full system the Tracker classifies the resulting error as `expired_blockhash`
 * and the Agent reasons about it, refreshes the blockhash, recalculates the tip, and
 * resubmits autonomously (Spec §1.4). Here we just produce the genuine failure.
 *
 * LIVE-INFRA: needs a real RPC + funded keypair to actually submit and observe the
 * expiry (Spec §7.5). Run it once real credentials exist to generate a real failure entry
 * in the lifecycle log.
 */
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { loadConfig } from "../src/config/env.js";
import { classifyError } from "../src/tracker/failureClassifier.js";
import { fetchTipFloor } from "../src/builder/jitoClient.js";
import { LifecycleLogWriter, buildLogEntry } from "../src/tracker/logWriter.js";
import { createAgent } from "../src/agent/agent.js";
import type { AgentContext, BundleRecord } from "../src/types.js";

/** A blockhash is valid ~150 blocks (~60-90s). We wait well past that on purpose. */
const HOLD_MS = 95_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rpc = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
  const secret = JSON.parse(readFileSync(cfg.DEVNET_KEYPAIR_PATH, "utf8")) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  // Fetch a fresh blockhash at `confirmed` (never finalized — Spec §2.4/§5).
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  console.log(
    `[fault] built tx on blockhash ${blockhash}; holding ${HOLD_MS}ms to force expiry…`,
  );
  await new Promise((r) => setTimeout(r, HOLD_MS));

  try {
    const sig = await rpc.sendRawTransaction(tx.serialize());
    console.error(`[fault] UNEXPECTED: tx landed (${sig}); blockhash had not expired`);
  } catch (err) {
    const category = classifyError(err);
    console.log(`[fault] got expected failure, classified as: ${category}`);
    console.log(`[fault] raw error: ${(err as Error).message}`);
    if (category !== "expired_blockhash") {
      console.warn(`[fault] WARNING: expected expired_blockhash, got ${category}`);
    }

    // Drive the same failure → Agent → log path the live loop uses, so this produces a
    // real failure entry (with verbatim agent reasoning) in the lifecycle log — the
    // mandatory injected case the bounty grades (Spec §1.4, §4.2, §6).
    const submitSlot = await rpc.getSlot("confirmed");
    const signature = bs58.encode(tx.signature!); // the (un-landed) tx signature
    const record: BundleRecord = {
      bundleId: signature,
      signatures: [signature],
      setId: `fault-${submitSlot}`,
      submitSlot,
      targetSlots: [],
      tipLamports: 0,
      transitions: [],
      stage: "Submitted",
      failure: category,
      superseded: false,
    };

    let reasoning = "(agent not consulted)";
    try {
      const tipFloor = await fetchTipFloor();
      const ctx: AgentContext = {
        failure: category,
        tipFloor,
        degradedMode: false,
        currentSlot: submitSlot,
        leaderLookahead: [],
      };
      const decision = await createAgent(cfg.ANTHROPIC_API_KEY).decide(ctx);
      reasoning = decision.reasoning;
      console.log(`[fault] agent decision:`, decision);
    } catch (agentErr) {
      console.warn(`[fault] agent step skipped: ${(agentErr as Error).message}`);
    }

    new LifecycleLogWriter(cfg.LIFECYCLE_LOG_PATH).write(buildLogEntry(record, reasoning));
    console.log(`[fault] wrote failure entry to ${cfg.LIFECYCLE_LOG_PATH}`);
  }
}

main().catch((err) => {
  console.error("[fault] fatal:", err);
  process.exitCode = 1;
});
