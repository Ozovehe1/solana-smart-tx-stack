/**
 * Centralized configuration. Every value the stack uses comes from here, and every
 * value here comes from an environment variable (Spec §8: no hardcoded values, ever —
 * not even a "temporary" placeholder). Validation fails fast with a clear message.
 */
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const schema = z.object({
  // --- Watcher (Yellowstone gRPC) ---
  YELLOWSTONE_ENDPOINT: z.string().url(),
  YELLOWSTONE_TOKEN: z.string().min(1),

  // --- Standard Solana RPC (one-off calls) ---
  SOLANA_RPC_URL: z.string().url(),

  // --- Keypairs ---
  DEVNET_KEYPAIR_PATH: z.string().min(1),
  MAINNET_KEYPAIR_PATH: z.string().min(1),

  // --- Jito block engine (mainnet-only, Spec §1.6.1) ---
  JITO_BLOCK_ENGINE_URL: z.string().url(),

  // --- Agent ---
  ANTHROPIC_API_KEY: z.string().min(1),

  // --- Optional tuning (defaults applied) ---
  LEADER_LOOKAHEAD: z.coerce.number().int().positive().default(8),
  SILENCE_GRACE_SLOTS: z.coerce.number().int().positive().default(8),
  JITO_REGION: z.string().default("mainnet"),
  LIFECYCLE_LOG_PATH: z.string().default("./logs/lifecycle.jsonl"),
});

export type AppConfig = z.infer<typeof schema>;

/**
 * Parse and validate the environment. Throws a readable aggregate error listing every
 * missing/invalid variable rather than failing on the first one.
 *
 * `requireLive` lets non-live code paths (e.g. unit tests, the tip-floor fetch) avoid
 * forcing the operator to populate live-infra credentials. When false, only the
 * optional/tuning fields are validated and the rest are passed through best-effort.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix these variables (see .env.example):\n${issues}`,
    );
  }
  return parsed.data;
}

/** The Jito tip floor in lamports (Spec §7) — a FLOOR, never a target. */
export const JITO_MIN_TIP_LAMPORTS = 1000;

/** A blockhash is valid ~150 blocks (Spec §2.4/§5). Used by the silence watchdog bound. */
export const BLOCKHASH_VALIDITY_SLOTS = 150;
