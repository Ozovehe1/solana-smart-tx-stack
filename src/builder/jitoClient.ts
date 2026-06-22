/**
 * Jito block-engine client (Spec §1.6.1, §7).
 *
 * Targets MAINNET only — Jito has no functioning devnet/testnet block engine (verified,
 * Spec §1.6.1). Provides:
 *   - fetchTipFloor(): live landed-tip percentiles for dynamic tip calc (NOT hardcoded).
 *   - getTipAccounts(): the 8 tip accounts; caller picks one at random to reduce
 *     write-lock contention (Spec §7).
 *   - sendBundle(): submit a bundle of base58-encoded signed transactions.
 *
 * LIVE-INFRA: requires a real mainnet block-engine endpoint + funded keypair. Coded
 * here; cannot be exercised in-sandbox (Spec §7.5) — verify against the real endpoint.
 */
import type { TipFloorData } from "../types.js";

const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Raw shape of one row from Jito's tip_floor endpoint (values are in SOL). */
interface TipFloorRow {
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
}

function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

/**
 * Fetch live tip-floor percentiles and normalize to lamports.
 * Pure-ish: the only side effect is the network read; parsing is deterministic, so the
 * parsing half is unit-tested separately via `parseTipFloor`.
 */
export async function fetchTipFloor(
  fetchImpl: typeof fetch = fetch,
): Promise<TipFloorData> {
  const res = await fetchImpl(TIP_FLOOR_URL);
  if (!res.ok) {
    throw new Error(`tip_floor fetch failed: ${res.status} ${res.statusText}`);
  }
  const rows = (await res.json()) as TipFloorRow[];
  return parseTipFloor(rows);
}

/** Deterministic parse of the tip_floor payload → TipFloorData (lamports). */
export function parseTipFloor(rows: TipFloorRow[]): TipFloorData {
  const row = rows[0];
  if (!row) throw new Error("tip_floor returned no rows");
  return {
    landedTipsLamports: {
      p25: solToLamports(row.landed_tips_25th_percentile),
      p50: solToLamports(row.landed_tips_50th_percentile),
      p75: solToLamports(row.landed_tips_75th_percentile),
      p95: solToLamports(row.landed_tips_95th_percentile),
      p99: solToLamports(row.landed_tips_99th_percentile),
    },
    fetchedAt: Date.now(),
  };
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`${method} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method} error: ${json.error.message}`);
  return json.result as T;
}

export class JitoClient {
  constructor(
    private readonly blockEngineUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The 8 tip accounts (Spec §7). Caller selects one at random per bundle. */
  async getTipAccounts(): Promise<string[]> {
    return rpc<string[]>(this.blockEngineUrl, "getTipAccounts", [], this.fetchImpl);
  }

  /** Pick a random tip account to spread write-lock contention (Spec §7). */
  static pickTipAccount(accounts: string[]): string {
    if (accounts.length === 0) throw new Error("no tip accounts available");
    const idx = Math.floor(Math.random() * accounts.length);
    return accounts[idx]!;
  }

  /** Submit a bundle of base58-encoded signed transactions. Returns the bundle UUID. */
  async sendBundle(base58Txs: string[]): Promise<string> {
    return rpc<string>(this.blockEngineUrl, "sendBundle", [base58Txs], this.fetchImpl);
  }

  /** Direct status query for one bundle (Spec §2.6 silence disambiguation). */
  async getBundleStatuses(bundleIds: string[]): Promise<unknown> {
    return rpc(this.blockEngineUrl, "getBundleStatuses", [bundleIds], this.fetchImpl);
  }
}
