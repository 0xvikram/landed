// Stand-in for HSP while its QA environment has not allowlisted our IP yet. It answers the same 8 tools
// with the same fields, but nothing is paid: chain id 999999 (no explorer) and tx = keccak256("STAND-IN")
// mark the "payment" as not real everywhere it shows up (contract receipt, proof page, demo page).
// The contract rejects zero values, so the marker has to be non-zero.
import { keccak256, toHex } from "viem";
import type { HspLike } from "./payout.js";

export const STAND_IN_CHAIN = 999999;
export const STAND_IN_TX = keccak256(toHex("STAND-IN"));

export function standInHsp(): HspLike {
  let raw = "0"; // USDC has 6 decimals: $25.00 -> 25000000, taken from the order like HSP would
  return {
    call: async (tool: string, args?: any): Promise<any> => {
      switch (tool) {
        case "get_chain_config": return { tokens: [{ network: "stand-in", chain_id: STAND_IN_CHAIN, address: "0x0000000000000000000000000000000000000000", coin: "USDC", payment_protocol: "eip3009" }] };
        case "create_order": {
          const usd = String(args?.cart_mandate?.contents?.payment_request?.details?.total?.amount?.value ?? "0");
          const [whole, frac = ""] = usd.split(".");
          raw = (BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();
          return { flow_id: "stand-in-flow", payment_request_id: "stand-in-pr" };
        }
        case "prepare_payment": {
          return { eip712: { domain: { name: "stand-in", version: "1", chainId: 133 }, types: { Hello: [{ name: "msg", type: "string" }] }, primaryType: "Hello", message: { msg: "stand-in" } }, token_total_raw: String(raw), cart_hash: "0".repeat(64), payment_payload: {}, payment_mandate_contents: {} };
        }
        case "finalize_payment": return { payment_mandate_json: "{}" };
        case "submit_payment": return { status: "payment-submitted" };
        case "query_payment": return { status: "payment-safe", attribution_verified: true, payment: { status: "payment-safe", tx_signature: STAND_IN_TX, chain_id: STAND_IN_CHAIN } };
      }
      throw new Error(`unknown tool ${tool}`);
    },
  };
}
