/**
 * Verify whether Jito has a usable devnet/testnet block engine (Spec §1.6.1 hinges on
 * this ONE fact). The whole "must fund mainnet" question reduces to: does a non-mainnet
 * Jito block engine actually answer?
 *
 * This probes each candidate block-engine endpoint with a real `getTipAccounts` JSON-RPC
 * call and reports which respond:
 *   - If ONLY mainnet returns tip accounts → §1.6.1 holds: Jito is mainnet-only, so the
 *     bounty's "real Jito bundles" (§1.1) + "10 real submissions" (§1.3) need a few $ of
 *     real SOL. No way around it on devnet.
 *   - If a devnet/testnet endpoint returns tip accounts → a free devnet path *may* exist;
 *     CONFIRM it by actually landing a real devnet bundle before trusting it (a responding
 *     getTipAccounts is necessary but not sufficient).
 *
 * No credentials or env needed — pure reachability probe. Run in a network-enabled session.
 */

interface Candidate {
  label: string;
  url: string;
}

// Mainnet is the control (known-working). The rest are the plausible non-mainnet guesses,
// including the exact testnet host §1.6.1 cites as reported-broken.
const CANDIDATES: Candidate[] = [
  { label: "mainnet (control)", url: "https://mainnet.block-engine.jito.wtf/api/v1/bundles" },
  { label: "devnet", url: "https://devnet.block-engine.jito.wtf/api/v1/bundles" },
  { label: "testnet", url: "https://testnet.block-engine.jito.wtf/api/v1/bundles" },
  { label: "dallas.testnet (cited broken)", url: "https://dallas.testnet.block-engine.jito.wtf/api/v1/bundles" },
  { label: "amsterdam.testnet", url: "https://amsterdam.testnet.block-engine.jito.wtf/api/v1/bundles" },
  { label: "ny.testnet", url: "https://ny.testnet.block-engine.jito.wtf/api/v1/bundles" },
];

async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { result?: unknown; error?: { message: string } };
      if (Array.isArray(json.result)) {
        return { ok: true, detail: `HTTP ${res.status} — getTipAccounts OK (${json.result.length} tip accounts)` };
      }
      if (json.error) return { ok: false, detail: `HTTP ${res.status} — RPC error: ${json.error.message}` };
      return { ok: false, detail: `HTTP ${res.status} — ${text.slice(0, 140)}` };
    } catch {
      return { ok: false, detail: `HTTP ${res.status} — ${text.slice(0, 140)}` };
    }
  } catch (err) {
    // DNS failure / connection refused = the endpoint does not exist at all.
    return { ok: false, detail: `UNREACHABLE — ${(err as Error).message}` };
  }
}

async function main(): Promise<void> {
  console.log("Probing Jito block-engine endpoints with getTipAccounts…\n");
  const working: string[] = [];
  for (const c of CANDIDATES) {
    const { ok, detail } = await probe(c.url);
    console.log(`  [${c.label}]`);
    console.log(`    ${c.url}`);
    console.log(`    → ${detail}\n`);
    if (ok && c.label !== "mainnet (control)") working.push(c.label);
  }

  console.log("──────────────────────────────────────────────────────");
  if (working.length === 0) {
    console.log("RESULT: Only mainnet responds. Spec §1.6.1 CONFIRMED — Jito is mainnet-only.");
    console.log("→ The 10-bundle lifecycle log (§1.1/§1.3) requires a few $ of real SOL.");
    console.log("  Devnet covers everything else (streaming, tracking, the 2 failures, agent).");
  } else {
    console.log(`RESULT: a non-mainnet endpoint responded: ${working.join(", ")}.`);
    console.log("→ A free devnet/testnet Jito path MAY exist. Do NOT trust it yet — confirm by");
    console.log("  actually landing a real devnet bundle (getTipAccounts answering ≠ bundles land).");
  }
}

main().catch((err) => {
  console.error("[check:jito-devnet] fatal:", err);
  process.exitCode = 1;
});
