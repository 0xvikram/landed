// Full payout against the real LandedPolicy on HSK testnet, with a stand-in for HSP
// (HSP's QA endpoint still needs our IP allowlisted). Proves reserve -> settle receipts
// and that a second claim for the same booking is refused on-chain.
// Run: npx tsx agent/testnet-run.ts      (needs RECEIPT_WRITER_KEY, AGENT_PAYER_KEY, POLICY_ADDRESS in .env)
import "dotenv/config";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { policyOnChain } from "./chain.js";
import { payDelayCompensation, type HspLike } from "./payout.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

// Stand-in HSP. Chain id 999999 (no explorer) and tx = keccak256("STAND-IN") mark the "payment"
// as not real. The contract rejects zero values, so the marker has to be non-zero.
const STAND_IN_CHAIN = 999999;
const STAND_IN_TX = keccak256(toHex("STAND-IN"));
function standInHsp(): HspLike {
  return {
    call: async (tool: string): Promise<any> => {
      switch (tool) {
        case "get_chain_config": return { tokens: [{ network: "stand-in", chain_id: STAND_IN_CHAIN, address: "0x0000000000000000000000000000000000000000", coin: "USDC", payment_protocol: "eip3009" }] };
        case "create_order": return { flow_id: "stand-in-flow", payment_request_id: "stand-in-pr" };
        case "prepare_payment": return { eip712: { domain: { name: "stand-in", version: "1", chainId: 133 }, types: { Hello: [{ name: "msg", type: "string" }] }, primaryType: "Hello", message: { msg: "stand-in" } }, token_total_raw: "25000000", cart_hash: "0".repeat(64), payment_payload: {}, payment_mandate_contents: {} };
        case "finalize_payment": return { payment_mandate_json: "{}" };
        case "submit_payment": return { status: "payment-submitted" };
        case "query_payment": return { status: "payment-safe", attribution_verified: true, payment: { status: "payment-safe", tx_signature: STAND_IN_TX, chain_id: STAND_IN_CHAIN } };
      }
      throw new Error(`unknown tool ${tool}`);
    },
  };
}

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
