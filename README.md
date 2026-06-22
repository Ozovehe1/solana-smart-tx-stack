# Smart Transaction Stack

A backend service that submits Solana transactions as **Jito bundles**, watches their
entire lifecycle in real time via a **Yellowstone gRPC stream** (not polling), computes
timing/health signals, classifies failures, and hands exactly **one** real operational
decision to an AI agent (**Claude**, via the Anthropic API) that shows visible reasoning.
It optionally submits the same intent as multiple parallel bundles targeting different
upcoming Jito leaders, racing for inclusion, with an on-chain guard ensuring only the
first to land has real effect.

> Built for the Superteam Nigeria "Advanced Infrastructure Challenge: Build a Smart
> Transaction Stack" bounty. See `PROJECT_SPEC.md` for the full specification.

## Architecture (four components — observe / record / decide / act)

| Component | Verb | Responsibility |
|---|---|---|
| **Watcher** (`src/watcher/`) | Observe | Live Yellowstone gRPC connection; slot + Jito-enabled leader lookahead; self-regulation → `degraded_mode`; reconnection with exponential backoff. Never submits or decides. |
| **Lifecycle Tracker** (`src/tracker/`) | Record | Matches stream events to bundles; computes `Submitted→Processed→Confirmed→Finalized` deltas; classifies failures (4 categories); resolves sibling **sets**. Never decides retry/tip. |
| **Agent** (`src/agent/`) | Decide | Receives real runtime data; calls Claude; returns a decision (tip / parallel targets / retry) **with logged reasoning**. Never touches the network. |
| **Builder/Submitter** (`src/builder/`) | Act | Fetches a fresh blockhash (`processed`/`confirmed`, never `finalized`); builds/signs/submits the bundle(s) to Jito. Never decides tip/retry itself. |

The loop (`src/index.ts`): Watcher → Tracker → (on failure/decision) Agent → Builder →
back into Watcher. **Retry is the same loop running again**, triggered by the Tracker
detecting failure instead of success — not a special-cased code path.

### Detecting the four failure categories — two distinct paths

- **Error-borne** (`expired_blockhash`, `fee_too_low`, `compute_exceeded`,
  `bundle_failure`): `src/tracker/failureClassifier.ts` maps an RPC/Jito error → category.
- **Silence / skipped slot** (`bundle_skipped`): there is **no error object**. The
  Tracker's slot-driven watchdog (`onSlotTick`) detects it — when the live slot advances
  past a still-`Submitted` bundle's `targetSlot + grace`, it *synthesizes* the verdict
  from the absence of progression, after one direct status probe to rule out a missed
  stream event.

## Infrastructure note — Jito bundle submission is mainnet-only

Bundle submission targets **Solana mainnet** because Jito's block engine has no
functioning devnet/testnet equivalent at the time of building (verified against Jito's
docs and an open `jito-labs/jito-js-rpc` issue). All non-Jito components — the Yellowstone
stream, slot/leader tracking, and Solana RPC reads (blockhash fetch, balance checks) — are
developed and tested against **Devnet** first (free, no real funds at risk). Only the
actual `sendBundle` call uses a mainnet block-engine address and a mainnet-funded keypair.

## Setup

Requirements: Node 20+. (`solana-keygen` from the Solana CLI for keypair generation.)

```bash
npm install
cp .env.example .env   # then fill in real values — NEVER commit .env or keypair files
```

Configure the variables in `.env` (see `.env.example` for the full list and where each
comes from):

- `YELLOWSTONE_ENDPOINT` / `YELLOWSTONE_TOKEN` — gRPC endpoint + token (Alchemy/Helius).
- `SOLANA_RPC_URL` — Devnet RPC (e.g. `https://api.devnet.solana.com`).
- `DEVNET_KEYPAIR_PATH` — local keypair funded with free Devnet SOL.
- `JITO_BLOCK_ENGINE_URL` — mainnet block engine (e.g.
  `https://mainnet.block-engine.jito.wtf/api/v1/bundles`).
- `MAINNET_KEYPAIR_PATH` — a **separate** keypair funded with a small amount of real SOL.
- `ANTHROPIC_API_KEY` — for the Agent.

Generate a Devnet keypair and fund it:

```bash
solana-keygen new --outfile ./devnet-keypair.json --no-bip39-passphrase
solana config set --url https://api.devnet.solana.com
solana airdrop 2 --keypair ./devnet-keypair.json   # or use https://faucet.solana.com
```

## Running

```bash
npm run build         # type-check the whole stack (tsc --noEmit)
npm test              # run the synthetic test suites (vitest)
npm start             # run the loop (requires live credentials)
npm run fault-inject  # deliberately trigger a blockhash-expiry failure (Spec §1.4)
```

## Testing & verification status

Per the spec's self-testing requirement (§7.5), we distinguish what is verified
synthetically from what needs live infrastructure:

**Verified via synthetic in-sandbox test** (`npm test`, 26 tests):
- Failure classifier — all error-borne categories.
- Silence watchdog — slot-driven `bundle_skipped` detection + status-probe disambiguation.
- Lifecycle log writer — all §1.3 fields, durable JSONL, readable back.
- Tip calculator — dynamic from live tip-floor data; calm vs congested differ meaningfully.
- Agent prompt construction + response parsing (mocked Anthropic client).
- Parallel sibling-set resolution (supersede semantics).

**Coded; pending verification against live infrastructure with real credentials:**
- Yellowstone gRPC stream connecting and delivering live slot/transaction data.
- A bundle actually landing on Jito mainnet.
- Reconnection surviving a real dropped connection.
- Watcher self-regulation under real stream load.
- The real Anthropic API exchange (mocked this iteration by choice).

## The three required questions

**Q1 — What does the delta between `processed_at` and `confirmed_at` tell you about
network health at the time of submission?**

It measures real-time consensus speed. A delta near the typical ~1–2 second baseline
indicates healthy, fast stake-weighted voting. A widening delta (4s, 8s, 10s+) indicates
network congestion or slow vote propagation — itself a usable signal: the stack feeds it
into tip sizing (`src/builder/tipCalculator.ts`), since congestion correlates with more
competition for block space. *[To be strengthened with observed deltas from the lifecycle
log once the stack has run against live infrastructure.]*

**Q2 — Why should you never use `finalized` commitment when fetching a blockhash for a
time-sensitive transaction?**

A blockhash is valid for ~150 blocks (~60–90 seconds) after creation — this is its
replay-protection expiry. `finalized` commitment lags the live chain tip by ~13 seconds
(finalization itself takes ~13s). Fetching at `finalized` means starting your ~60–90s
countdown already ~13s in, for zero benefit — a blockhash's purpose is freshness, not
certainty, so finality is irrelevant to it. The Builder always fetches at `processed` or
`confirmed`; `finalized` is rejected (`src/builder/builder.ts`).

**Q3 — What happens to your bundle if the Jito leader skips their slot?**

The bundle was privately routed only to specific targeted upcoming Jito-enabled leaders
for a narrow window — it is **not** broadcast to the public network. If those leaders skip
their slots (produce no block), the bundle is discarded inside Jito's block-engine
infrastructure once the window passes. It leaves no on-chain trace and does **not** cascade
to the next leader the way an ordinary transaction in the public gossip pool might. The
only detectable signal is **silence** — no status progression past `Submitted` once the
targeted slot has passed — which the Tracker's slot-driven watchdog actively watches for
(`src/tracker/lifecycleTracker.ts`), rather than waiting indefinitely. *[To be strengthened
with a real skipped-slot example from the lifecycle log.]*

## License

Open source — MIT.
