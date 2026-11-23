// Full payout against the real LandedPolicy on HSK testnet, with a stand-in for HSP
// (HSP's QA endpoint still needs our IP allowlisted). Proves reserve -> settle receipts
// and that a second claim for the same booking is refused on-chain.
// Run: npx tsx agent/testnet-run.ts      (needs RECEIPT_WRITER_KEY, AGENT_PAYER_KEY, POLICY_ADDRESS in .env)
import "dotenv/config";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { policyOnChain } from "./chain.js";
import { payDelayCompensation } from "./payout.js";
import { standInHsp } from "./standin.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

const policy = policyOnChain({ address: need("POLICY_ADDRESS") as Address, writerKey: need("RECEIPT_WRITER_KEY") as Hex, testnet: true });
const payer = privateKeyToAccount(need("AGENT_PAYER_KEY") as Hex);
const ref = "T" + Date.now().toString(36).slice(-5).toUpperCase();
const claim = { flight: "DA117", date: "2026-12-01", bookingRef: ref, passenger: payer.address, delayMinutes: 192 };
const deps = {
  hsp: standInHsp(),
  policy,
  signer: { address: payer.address, signTypedData: (t: any) => payer.signTypedData(t) },
  merchantName: "Landed",
  pickToken: (c: any) => ({ network: c.tokens[0].network, chainId: c.tokens[0].chain_id, contract: c.tokens[0].address, coin: c.tokens[0].coin, protocol: "eip3009" as const }),
  approve: async () => true,
  onStep: (s: any) => console.log("  ", s.step, s.tx ?? s.status ?? ""),
  sleep: async () => {},
};

console.log(`Claim 1: DA117, 3 h 12 m late, booking ${ref}`);
const first = await payDelayCompensation(claim, deps);
console.log("Result:", JSON.stringify(first, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log(`Claim 2: same booking, written as "${ref.toLowerCase()} "`);
const second = await payDelayCompensation({ ...claim, bookingRef: ref.toLowerCase() + " " }, deps);
console.log("Result:", JSON.stringify(second));
const ok = first.ok && !second.ok;
console.log(ok ? "PASS: paid once, second claim refused" : "FAIL");
process.exit(ok ? 0 : 1);
