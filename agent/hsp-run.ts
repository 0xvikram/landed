// One real delay payout through HashKey HSP (QA gateway, testnet funds), recorded on LandedPolicy (HSK testnet).
// A human approves twice, as the HSP guide requires: before signing and before submitting.
//
//   npx tsx agent/hsp-run.ts --dry     order + locked quote, then decline before signing (no money moves)
//   npx tsx agent/hsp-run.ts           the real payment (asks y/N twice)
//   npx tsx agent/hsp-run.ts --yes     the real payment, when a human already approved these exact amounts
//
// Needs in .env: RECEIPT_WRITER_KEY, AGENT_PAYER_KEY, POLICY_ADDRESS. Optional: PAY_NETWORK (default base-sepolia),
// PASSENGER (pay_to, default DEMO_PASSENGER_WALLET or the receipt writer's address).
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Hsp, healthCheck } from "./hsp.js";
import { policyOnChain } from "./chain.js";
import { payDelayCompensation, type Approval } from "./payout.js";
import { pickToken } from "./token.js";

const DRY = process.argv.includes("--dry");
const YES = process.argv.includes("--yes");
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
process.env.PAY_NETWORK ||= "base-sepolia";

const RPC: Record<number, string> = {
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  84532: "https://sepolia.base.org",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
  133: "https://testnet.hsk.xyz",
};

const health = await healthCheck();
if (!health.ok) { console.log(`HSP not reachable: ${health.detail}`); process.exit(1); }

const payer = privateKeyToAccount(need("AGENT_PAYER_KEY") as Hex);
const writer = privateKeyToAccount(need("RECEIPT_WRITER_KEY") as Hex);
const passenger = (process.env.PASSENGER || process.env.DEMO_PASSENGER_WALLET || writer.address) as Address;
const policy = policyOnChain({ address: need("POLICY_ADDRESS") as Address, writerKey: need("RECEIPT_WRITER_KEY") as Hex, testnet: true });
const hsp = await new Hsp().connect();

const token = pickToken(await hsp.call("get_chain_config"));
const rpc = RPC[token.chainId];
const balanceOf = async () =>
  rpc
    ? await createPublicClient({ transport: http(rpc) }).readContract({
        address: token.contract,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [payer.address],
      })
    : undefined;
const startBalance = await balanceOf();
console.log(`Network ${token.network} (${token.chainId}), ${token.coin} ${token.contract} via ${token.protocol}`);
console.log(`Payer (airline agent wallet) ${payer.address}: ${startBalance ?? "?"} raw ${token.coin}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const approve = async (a: Approval) => {
  console.log(`\n  APPROVAL (${a.stage}): pay_to ${a.payTo}\n  payer ${a.payer}\n  amount $${a.amountUsd} = token_total_raw ${a.tokenTotalRaw}`);
  if (startBalance !== undefined && startBalance < BigInt(a.tokenTotalRaw)) {
    console.log(`  Payer holds ${startBalance}, needs ${a.tokenTotalRaw}: fund it first.`);
    return false;
  }
  if (DRY) { console.log("  --dry: declining here, nothing is signed."); return false; }
  if (YES) { console.log("  --yes: approved in advance by the operator."); return true; }
  return (await rl.question("  Approve? [y/N] ")).trim().toLowerCase() === "y";
};

const ref = "H" + Date.now().toString(36).slice(-5).toUpperCase();
const claim = { flight: "DA117", date: "2026-11-27", bookingRef: ref, passenger, delayMinutes: 134 };
console.log(`\nClaim: ${claim.flight} landed ${claim.delayMinutes} min late, booking ${ref}, passenger ${passenger}`);

const result = await payDelayCompensation(claim, {
  hsp,
  policy,
  signer: { address: payer.address, signTypedData: (t: any) => payer.signTypedData(t) },
  merchantName: need("HSP_MERCHANT_NAME"),
  pickToken: () => token,
  approve,
  onStep: (s: any) => console.log("  ", s.step, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
});
rl.close();
await hsp.close();
console.log("\nResult:", JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
if (result.ok) console.log(`Payer balance now: ${await balanceOf()} raw ${token.coin}`);
process.exit(result.ok || DRY ? 0 : 1);
