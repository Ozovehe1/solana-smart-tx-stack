/**
 * Watcher — Observe (Spec §3.1, §2.5–§2.7).
 *
 * Maintains a live Yellowstone gRPC connection; tracks current slot + leader lookahead;
 * self-regulates its OWN processing rate; re-emits normalized events on an internal
 * queue decoupled from the stream-read path. It NEVER submits transactions or decides
 * anything.
 *
 * Three engineering obligations the brief grades (Spec §2.5–§2.7):
 *   - Streaming, not polling: events are pushed; we react the instant they occur.
 *   - Reconnection: a dropped stream fails SILENTLY (Spec §2.6) — we listen for
 *     error/close, reconnect with exponential backoff, and on reconnect compute the slot
 *     gap vs lastSeenSlot via one one-off RPC call.
 *   - Backpressure as SELF-REGULATION (Spec §2.7), NOT gRPC flow control: we measure our
 *     own arrival rate and adapt internal processing, emitting `degraded_mode` as one
 *     fact downstream — we never hand the raw rate to the Agent.
 *
 * LIVE-INFRA: requires a real Yellowstone endpoint (Spec §7.5). The ArrivalRateMeter and
 * backoff math are pure and exercised in isolation; the stream behavior is not.
 */
import pkg, {
  CommitmentLevel,
  type SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import type { Commitment } from "../types.js";

// @triton-one/yellowstone-grpc's CJS/ESM interop wraps the default export an
// extra level under tsx/Node ESM; unwrap it so `new Client(...)` works.
type YellowstoneClient = import("@triton-one/yellowstone-grpc").default;
const Client = ((pkg as unknown as { default?: unknown }).default ?? pkg) as new (
  endpoint: string,
  token?: string | undefined,
  opts?: Record<string, unknown>,
) => YellowstoneClient;

/**
 * Self-regulation rate meter (Spec §2.7). Rolling event count over a 5s window. Pure —
 * deterministic given a clock, so it can be reasoned about without a live stream.
 */
export class ArrivalRateMeter {
  private readonly events: number[] = []; // timestamps (ms)
  constructor(
    private readonly windowMs = 5000,
    private readonly highRatePerSec = 50,
  ) {}

  record(now: number): void {
    this.events.push(now);
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0]! < cutoff) this.events.shift();
  }

  ratePerSec(now: number): number {
    this.prune(now);
    return this.events.length / (this.windowMs / 1000);
  }

  /** Sustained high rate → degraded mode (Spec §2.7). */
  degraded(now: number): boolean {
    return this.ratePerSec(now) >= this.highRatePerSec;
  }
}

/** Exponential backoff with cap (Spec §2.6: start ~0.5-1s, double, cap 30-60s). */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 30000): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

/**
 * A streamed transaction update normalized off the Yellowstone feed (Spec §1.1/§8). This
 * is how landing is confirmed from the STREAM rather than by polling: when a tracked
 * bundle's transaction shows up here, its lifecycle stage advances.
 */
export interface TransactionStatusEvent {
  /** Base58 transaction signature (matches BundleRecord.signatures). */
  signature: string;
  slot: number;
  /** Commitment this update represents (the stream's subscription level). */
  commitment: Commitment;
  /** Tx-level error reported by the stream, if any (→ error-borne failure). */
  err: unknown;
}

export interface WatcherEvents {
  /** Live slot tick — drives the Tracker's silence watchdog. */
  onSlot: (slot: number) => void;
  /** Streamed tx update for a (possibly tracked) bundle — confirms landing via the stream. */
  onTransactionStatus: (evt: TransactionStatusEvent) => void;
  /** Normalized non-tx update (accounts/blocks/etc.) — low-priority queue path. */
  onUpdate: (update: unknown) => void;
  /** Self-regulation outcome changed. */
  onDegradedModeChange: (degraded: boolean) => void;
  /** Reconnect happened; reports the slot gap observed during the outage (Spec §2.6). */
  onReconnect: (gap: { lastSeenSlot: number; currentSlot: number }) => void;
}

export interface WatcherConfig {
  endpoint: string;
  token: string;
  rpcUrl: string;
  /**
   * Payer pubkey (base58). When set, the stream subscribes to transactions touching it so
   * the bundle's own transactions are pushed back for stream-based landing confirmation.
   */
  payer?: string;
}

/**
 * Extract a normalized TransactionStatusEvent from a raw Yellowstone SubscribeUpdate, or
 * null if it isn't a transaction/transactionStatus update. Defensive about field shape —
 * the exact LaserStream payload is confirmed against a live stream; unexpected shapes are
 * ignored rather than throwing, so the receive path never crashes.
 */
export function extractTransactionStatus(
  data: unknown,
  commitment: Commitment,
): TransactionStatusEvent | null {
  const d = data as {
    transactionStatus?: {
      signature?: ArrayLike<number>;
      slot?: string | number;
      err?: unknown;
    };
    transaction?: {
      slot?: string | number;
      transaction?: { signature?: ArrayLike<number> };
    };
  };

  let sig: ArrayLike<number> | undefined;
  let slotRaw: string | number | undefined;
  let err: unknown = null;

  if (d.transactionStatus?.signature) {
    sig = d.transactionStatus.signature;
    slotRaw = d.transactionStatus.slot;
    err = d.transactionStatus.err ?? null;
  } else if (d.transaction?.transaction?.signature) {
    sig = d.transaction.transaction.signature;
    slotRaw = d.transaction.slot;
  } else {
    return null;
  }
  if (!sig || slotRaw == null) return null;

  return {
    signature: bs58.encode(Uint8Array.from(Array.from(sig))),
    slot: Number(slotRaw),
    commitment,
    err,
  };
}

export class Watcher {
  private client?: YellowstoneClient;
  private lastSeenSlot = 0;
  private degraded = false;
  /** Commitment our subscription delivers at — must match the request below. */
  private readonly streamCommitment: Commitment = "confirmed";
  private readonly meter = new ArrivalRateMeter();
  private readonly rpc: Connection;
  /** Internal queue — receive step is fast/non-blocking; work drains here (Spec §2.7). */
  private readonly queue: unknown[] = [];
  private stopped = false;

  constructor(
    private readonly cfg: WatcherConfig,
    private readonly handlers: WatcherEvents,
  ) {
    this.rpc = new Connection(cfg.rpcUrl, "confirmed");
  }

  get currentSlot(): number {
    return this.lastSeenSlot;
  }

  get degradedMode(): boolean {
    return this.degraded;
  }

  /** Start streaming with auto-reconnect. Resolves only when stop() is called. */
  async start(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.runStream();
        attempt = 0; // clean exit (stop) — reset
      } catch (err) {
        if (this.stopped) break;
        const delay = backoffDelayMs(attempt++);
        console.error(
          `[watcher] stream dropped (${(err as Error).message}); reconnecting in ${delay}ms`,
        );
        await this.recoverGap();
        await sleep(delay);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** On reconnect, one-off RPC to measure the gap we missed (Spec §2.6). */
  private async recoverGap(): Promise<void> {
    try {
      const currentSlot = await this.rpc.getSlot("confirmed");
      if (this.lastSeenSlot > 0) {
        this.handlers.onReconnect({ lastSeenSlot: this.lastSeenSlot, currentSlot });
      }
      this.lastSeenSlot = Math.max(this.lastSeenSlot, currentSlot);
    } catch {
      // Best-effort; the next live slot will resync lastSeenSlot.
    }
  }

  private async runStream(): Promise<void> {
    const client = new Client(this.cfg.endpoint, this.cfg.token, {});
    this.client = client;
    const stream = await client.subscribe();

    const request: SubscribeRequest = {
      slots: { incoming: { filterByCommitment: false } },
      accounts: {},
      // Subscribe to transactions touching the payer so our own bundles' transactions are
      // pushed back to us — this is what lets landing be confirmed from the STREAM
      // (Spec §1.1/§8) rather than by polling.
      transactions: this.cfg.payer
        ? {
            tracked: {
              vote: false,
              failed: false,
              accountInclude: [this.cfg.payer],
              accountExclude: [],
              accountRequired: [],
            },
          }
        : {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    };

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (data: unknown) => this.onData(data));
      // A dropped stream fails SILENTLY unless we listen for these (Spec §2.6).
      stream.on("error", (e: Error) => reject(e));
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.write(request, (err: unknown) => {
        if (err) reject(err as Error);
      });
    });
  }

  /** Fast, non-blocking receive (Spec §2.7): stamp the rate, normalize, enqueue. */
  private onData(data: unknown): void {
    const now = Date.now();
    this.meter.record(now);
    this.updateDegradedMode(now);

    const slotUpdate = (data as { slot?: { slot?: string | number } }).slot;
    if (slotUpdate?.slot != null) {
      const slot = Number(slotUpdate.slot);
      this.lastSeenSlot = slot;
      this.handlers.onSlot(slot); // slot ticks always pass through (latest matters)
      return;
    }

    // High-priority: a transaction update for a (possibly tracked) bundle. Confirms landing
    // from the STREAM (Spec §1.1/§8). Kept on the fast path with full detail even under
    // degraded mode, per §2.7 (tracked-bundle events are never shed).
    const txStatus = extractTransactionStatus(data, this.streamCommitment);
    if (txStatus) {
      this.handlers.onTransactionStatus(txStatus);
      return;
    }

    // Other updates: enqueue for decoupled processing so the read path never stalls.
    this.queue.push(data);
    this.drain();
  }

  private updateDegradedMode(now: number): void {
    const degraded = this.meter.degraded(now);
    if (degraded !== this.degraded) {
      this.degraded = degraded;
      this.handlers.onDegradedModeChange(degraded);
    }
  }

  /**
   * Drain the internal queue. When degraded, batch and shed detail on low-priority
   * events (Spec §2.7) while preserving full detail for tracked-bundle updates.
   */
  private drain(): void {
    const batchSize = this.degraded ? 32 : 1;
    let processed = 0;
    while (this.queue.length && processed < batchSize) {
      const update = this.queue.shift();
      this.handlers.onUpdate(update);
      processed++;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
