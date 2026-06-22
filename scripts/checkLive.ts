/**
 * Read-only live credential check (risks no funds).
 *
 * Validates the credentials that DON'T require a keypair or Yellowstone gRPC:
 *   - Solana RPC (Alchemy Devnet): getSlot + getLatestBlockhash("confirmed")
 *   - Jito public tip-floor endpoint: live landed-tip percentiles
 *
 * Reads process.env directly (via dotenv) rather than loadConfig(), so it runs even while
 * the Yellowstone/keypair vars are still PENDING. Reports honestly if the sandbox network
 * policy blocks egress.
 */
import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { fetchTipFloor } from "../src/builder/jitoClient.js";

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error("SOLANA_RPC_URL not set in .env");
    process.exitCode = 1;
    return;
  }

  console.log("=== Solana RPC (Alchemy Devnet) ===");
  try {
    const rpc = new Connection(rpcUrl, "confirmed");
    const slot = await rpc.getSlot("confirmed");
    const { blockhash, lastValidBlockHeight } =
      await rpc.getLatestBlockhash("confirmed");
    console.log(`  ✓ current slot:        ${slot}`);
    console.log(`  ✓ blockhash (confirmed): ${blockhash}`);
    console.log(`  ✓ lastValidBlockHeight:  ${lastValidBlockHeight}`);
    console.log(`  → verify the slot on https://explorer.solana.com/?cluster=devnet`);
  } catch (err) {
    console.error(`  ✗ RPC check failed: ${(err as Error).message}`);
  }

  console.log("\n=== Jito tip-floor (public endpoint) ===");
  try {
    const tipFloor = await fetchTipFloor();
    const t = tipFloor.landedTipsLamports;
    console.log(`  ✓ live landed-tip percentiles (lamports):`);
    console.log(
      `    p25=${t.p25} p50=${t.p50} p75=${t.p75} p95=${t.p95} p99=${t.p99}`,
    );
  } catch (err) {
    console.error(`  ✗ tip-floor fetch failed: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
