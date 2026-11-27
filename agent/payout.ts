// The airline's payment agent: rule check -> reserve on HSK Chain -> human approval ->
// HSP payment (create_order, prepare_payment, sign, finalize_payment, submit_payment,
// query_payment) -> settle on HSK Chain, or release the booking if the payment fails.
import type { Address, Hex } from "viem";
import { bookingKey, centsToUsd, flightKey } from "./keys.js";
import type { SignedClaim } from "./claim.js";

export interface Claim {
  flight: string; // "BA117"
  date: string; // "2026-12-01"
  bookingRef?: string; // stays off chain, only its hash is stored (absent for A2A: the passenger agent sends only the hash)
  passenger: Address; // where the money goes
  delayMinutes: number; // from the (simulated) flight status
  /** A2A: the passenger agent's EIP-712 claim. Reserved with reserveWithClaim, so only its signer can be paid. */
  signed?: { claim: SignedClaim; signature: Hex };
}

/** Subset of the HSP MCP client the agent needs (real one is agent/hsp.ts). */
export interface HspLike {
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
}

/** Reads and writes LandedPolicy on HSK Chain (real one is agent/chain.ts). */
export interface PolicyLike {
  quote(delayMinutes: number): Promise<bigint>;
  status(bookingKey: Hex): Promise<number>; // 0 none, 1 reserved, 2 paid
  reserve(bookingKey: Hex, flightKey: Hex, passenger: Address, delayMinutes: number): Promise<Hex>;
  reserveWithClaim?(claim: SignedClaim, signature: Hex): Promise<Hex>;
  settle(bookingKey: Hex, chainId: bigint, settlementTx: Hex): Promise<Hex>;
  release(bookingKey: Hex, reason: string): Promise<Hex>;
}

export interface Signer {
  address: Address;
  signTypedData(eip712: { domain: any; types: any; primaryType: string; message: any }): Promise<Hex>;
}

export interface Approval {
  payTo: Address;
  payer: Address;
  amountUsd: string;
  tokenTotalRaw: string;
  stage: "sign" | "submit";
  network: string;
  chainId: number;
}

export type Step =
  | { step: "checked"; amountUsd: string; delayMinutes: number }
  | { step: "reserved"; tx: Hex; viaClaim?: boolean }
  | { step: "order"; flowId: string; paymentRequestId: string }
  | { step: "prepared"; tokenTotalRaw: string; quoteExpiresAt?: string }
  | { step: "signed" }
  | { step: "submitted" }
  | { step: "status"; status: string }
  | { step: "settled"; tx: Hex; settlementTx: Hex; chainId: bigint }
  | { step: "released"; reason: string };

export type PayoutResult =
  | { ok: true; bookingKey: Hex; amountUsd: string; settlementTx: Hex; chainId: bigint; receiptTx: Hex; flowId: string }
  | { ok: false; bookingKey: Hex; reason: string; flowId?: string; pending?: boolean };

export interface PayoutDeps {
  hsp: HspLike;
  policy: PolicyLike;
  signer: Signer;
  merchantName: string;
  /** chosen entry from get_chain_config: network, chain id, token */
  pickToken(config: any): { network: string; chainId: number; contract: Address; coin: string; protocol: "eip3009" | "permit2" };
  approve(a: Approval): Promise<boolean>; // a person at the airline confirms (HSP guide requires it)
  onStep?(s: Step): void;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?(ms: number): Promise<void>;
}

const PENDING = ["payment-submitted", "payment-verified", "payment-processing", "payment-included", "payment-timeout"];

export async function payDelayCompensation(claim: Claim, d: PayoutDeps): Promise<PayoutResult> {
  const emit = d.onStep ?? (() => {});
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const s = claim.signed;
  if (s && (s.claim.payTo.toLowerCase() !== claim.passenger.toLowerCase() || s.claim.delayMinutes !== claim.delayMinutes))
    throw new Error("signed claim does not match the payout request");
  if (!s && !claim.bookingRef) throw new Error("bookingRef is required without a signed claim");
  const bk = s ? s.claim.bookingKey : bookingKey(claim.flight, claim.date, claim.bookingRef!);
  const fk = flightKey(claim.flight, claim.date);

  // 1. Rule check, from the published policy (code decides the amount, never a model).
  const cents = await d.policy.quote(claim.delayMinutes);
  if (cents === 0n) return { ok: false, bookingKey: bk, reason: `not eligible: ${claim.delayMinutes} min delay` };
  if ((await d.policy.status(bk)) !== 0) return { ok: false, bookingKey: bk, reason: "already claimed for this booking" };
  const amountUsd = centsToUsd(cents);
  emit({ step: "checked", amountUsd, delayMinutes: claim.delayMinutes });

  // 2. Reserve first so a second claim can never be paid.
  if (s) {
    if (!d.policy.reserveWithClaim) throw new Error("this policy contract does not accept signed claims (needs LandedPolicyV2)");
    emit({ step: "reserved", tx: await d.policy.reserveWithClaim(s.claim, s.signature), viaClaim: true });
  } else {
    emit({ step: "reserved", tx: await d.policy.reserve(bk, fk, claim.passenger, claim.delayMinutes) });
  }

  let flowId: string | undefined;
  let submitted = false; // once true, money may have moved: never release the booking on error
  const fail = async (reason: string): Promise<PayoutResult> => {
    await d.policy.release(bk, reason);
    emit({ step: "released", reason });
    return { ok: false, bookingKey: bk, reason, flowId };
  };

  try {
    // 3. HSP order: the airline (payer) pays the passenger (pay_to).
    const config = await d.hsp.call("get_chain_config");
    const t = d.pickToken(config);
    const order = await d.hsp.call("create_order", {
      merchant_name: d.merchantName,
      pay_to: claim.passenger,
      cart_mandate: cartMandate(claim, bk, amountUsd, t),
    });
    flowId = String(order.flow_id);
    const paymentRequestId = String(order.payment_request_id);
    emit({ step: "order", flowId, paymentRequestId });

    // 4. Prepare -> approve -> sign -> finalize -> approve -> submit.
    const prep = await d.hsp.call("prepare_payment", { flow_id: flowId, payer: d.signer.address, protocol: t.protocol });
    emit({ step: "prepared", tokenTotalRaw: String(prep.token_total_raw), quoteExpiresAt: prep.quote_expires_at });
    const ask = (stage: Approval["stage"]) =>
      d.approve({ payTo: claim.passenger, payer: d.signer.address, amountUsd, tokenTotalRaw: String(prep.token_total_raw), stage, network: t.network, chainId: t.chainId });
    if (!(await ask("sign"))) return await fail("airline declined before signing");
    const signature = await d.signer.signTypedData(prep.eip712);
    emit({ step: "signed" });
    const fin = await d.hsp.call("finalize_payment", {
      signature,
      payment_payload: prep.payment_payload,
      payment_mandate_contents: prep.payment_mandate_contents,
      cart_hash: prep.cart_hash,
    });
    if (!(await ask("submit"))) return await fail("airline declined before submitting");
    submitted = true;
    await d.hsp.call("submit_payment", { payment_mandate_json: fin.payment_mandate_json });
    emit({ step: "submitted" });

    // 5. Poll until safe/finalized/failed. A timeout keeps the booking reserved (payment may still land).
    const started = Date.now();
    for (;;) {
      const q = await d.hsp.call("query_payment", {
        flow_id: flowId,
        payment_request_id: paymentRequestId,
        expected_merchant_name: d.merchantName,
      });
      const status = String(q.status ?? q.payment?.status ?? "unknown");
      emit({ step: "status", status });
      if (status === "payment-safe" || status === "payment-finalized") {
        const tx = q.payment?.tx_signature as Hex | undefined;
        if (!tx) throw new Error(`${status} without a transaction hash`);
        if (q.attribution_verified === false) throw new Error("HSP attribution not verified for this team");
        const chainId = BigInt(q.payment?.chain_id ?? t.chainId);
        const receiptTx = await d.policy.settle(bk, chainId, tx);
        emit({ step: "settled", tx: receiptTx, settlementTx: tx, chainId });
        return { ok: true, bookingKey: bk, amountUsd, settlementTx: tx, chainId, receiptTx, flowId };
      }
      if (status === "payment-failed") return await fail(`HSP payment failed: ${q.payment?.status_reason ?? "no reason given"}`);
      if (!PENDING.includes(status)) throw new Error(`unrecognised HSP status: ${status}`);
      if (Date.now() - started > (d.maxWaitMs ?? 10 * 60_000)) {
        return { ok: false, bookingKey: bk, reason: "pending confirmation", flowId, pending: true };
      }
      await sleep(d.pollMs ?? 15_000);
    }
  } catch (err) {
    // Before submission nothing moved: free the booking. After submission, keep it reserved for recovery.
    const msg = err instanceof Error ? err.message : String(err);
    return submitted ? { ok: false, bookingKey: bk, reason: msg, flowId, pending: true } : await fail(msg);
  }
}

/** AP2-style cart per the HSP guide. Field names to be re-checked against the live create_order schema. */
export function cartMandate(
  claim: Claim,
  bk: Hex,
  amountUsd: string,
  t: { network: string; chainId: number; contract: Address; coin: string },
) {
  const label = `Delay compensation ${claim.flight} ${claim.date} (${claim.delayMinutes} min late)`;
  return {
    contents: {
      id: `landed-${bk.slice(2, 18)}`,
      cart_expiry: new Date(Date.now() + 15 * 60_000).toISOString(),
      payment_request: {
        method_data: [
          {
            supported_methods: "https://www.x402.org/",
            data: { x402Version: 2, network: t.network, chain_id: t.chainId, contract_address: t.contract, coin: t.coin, pay_to: claim.passenger },
          },
        ],
        details: {
          id: `landed-${bk.slice(2, 18)}`,
          display_items: [{ label, amount: { currency: "USD", value: amountUsd } }],
          total: { label: "Total", amount: { currency: "USD", value: amountUsd } },
        },
      },
    },
  };
}
