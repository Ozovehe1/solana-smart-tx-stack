/**
 * Builder / Submitter — Act (Spec §3.1).
 *
 * Takes the Agent's decision and EXECUTES it: fetches a fresh blockhash (at `processed`
 * or `confirmed` — NEVER `finalized`, Spec §2.4/§5/§8), builds the bundle, signs, and
 * submits to Jito's mainnet block engine. It never decides tip amounts or retry logic —
 * those come from the Agent (Spec §3.1).
 *
 * Phase 1 builds a single bundle. The parallel-bundle / on-chain-guard design (Spec §3.3,
 * Phase 4) slots in at `buildSiblings` — deferred, with the seam marked below.
 *
 * LIVE-INFRA: requires a funded mainnet keypair + real block engine (Spec §7.5).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { AgentDecision, BundleRecord } from "../types.js";
import { JitoClient } from "./jitoClient.js";

/** Commitment for blockhash fetch — MUST be processed/confirmed, never finalized. */
export type BlockhashCommitment = "processed" | "confirmed";

export interface BuildContext {
  connection: Connection;
  payer: Keypair;
  jito: JitoClient;
  /** The intent this bundle expresses — e.g. a small self-transfer for the lifecycle log. */
  buildIntent: (payer: PublicKey) => Transaction;
  setId: string;
  /** Targeted Jito-enabled leader slots from the Watcher's lookahead (Spec §2.2). */
  targetSlots: number[];
  /** Current slot at submit time (our `Submitted` bookkeeping). */
  submitSlot: number;
}

function assertNotFinalized(commitment: BlockhashCommitment): void {
  // Defensive: the type already forbids it, but Spec §8 makes this a hard rule worth
  // failing loudly on if someone widens the type later.
  if ((commitment as string) === "finalized") {
    throw new Error(
      "Refusing to fetch a blockhash at `finalized` for a time-sensitive bundle (Spec §2.4/§5).",
    );
  }
}

export class Builder {
  constructor(private readonly ctx: BuildContext) {}

  /**
   * Build, sign, and submit ONE bundle per the Agent's decision. Returns the tracked
   * BundleRecord (handed to the Tracker via track()).
   */
  async submit(
    decision: AgentDecision,
    commitment: BlockhashCommitment = "confirmed",
  ): Promise<BundleRecord> {
    assertNotFinalized(commitment);
    const { connection, payer, jito, buildIntent, setId, targetSlots, submitSlot } =
      this.ctx;

    // 1. Fresh blockhash at processed/confirmed (never finalized).
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);

    // 2. Intent + dynamic tip (the Agent decided the amount; we never hardcode it).
    const tipAccounts = await jito.getTipAccounts();
    const tipAccount = new PublicKey(JitoClient.pickTipAccount(tipAccounts));

    const tx = buildIntent(payer.publicKey);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAccount,
        lamports: decision.tipLamports,
      }),
    );
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);

    // 3. Serialize + submit as a bundle. Capture the tx signature so the Tracker can
    //    correlate streamed Yellowstone updates back to this bundle (Spec §1.1/§8).
    const serialized = bs58.encode(tx.serialize());
    const signature = bs58.encode(tx.signature!);
    const bundleId = await jito.sendBundle([serialized]);

    return {
      bundleId,
      signatures: [signature],
      setId,
      submitSlot,
      targetSlots,
      tipLamports: decision.tipLamports,
      transitions: [],
      stage: "Submitted",
      failure: null,
      superseded: false,
    };
  }

  /**
   * Phase 4 seam (Spec §3.3): build N sibling bundles carrying the SAME on-chain guard
   * condition but targeting different upcoming Jito leaders, so only the first to land
   * has real effect. Deferred until Phase 1 is verified live.
   */
  // async buildSiblings(decision: AgentDecision): Promise<BundleRecord[]> { ... }
}
