// Payout agent against a stand-in HSP (same 8 tool names and fields as the official guide)
// and an in-memory copy of the contract rules. Run: npm run test:agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { payDelayCompensation, type PayoutDeps, type PolicyLike, type Step } from "./payout.js";

const PASSENGER = "0x00000000000000000000000000000000000000aa" as Address;
const PAYER = "0x00000000000000000000000000000000000000bb" as Address;
const HSP_TX = ("0x" + "ab".repeat(32)) as Hex;
const claim = { flight: "ba117", date: "2026-12-01", bookingRef: "XK4P2Q", passenger: PASSENGER, delayMinutes: 192 };

function fakePolicy() {
  const state = new Map<Hex, number>();
  const log: string[] = [];
  const p: PolicyLike = {
    quote: async (m) => (m >= 300 ? 6000n : m >= 180 ? 2500n : m >= 120 ? 1000n : 0n),
    status: async (bk) => state.get(bk) ?? 0,
    reserve: async (bk) => {
      if (state.get(bk)) throw new Error("AlreadyClaimed");
      state.set(bk, 1);
      log.push("reserve");
      return "0x01" as Hex;
    },
    settle: async (bk) => {
      if (state.get(bk) !== 1) throw new Error("NotReserved");
      state.set(bk, 2);
      log.push("settle");
      return "0x02" as Hex;
    },
    release: async (bk) => {
      state.delete(bk);
      log.push("release");
      return "0x03" as Hex;
    },
  };
  return { p, state, log };
}

function fakeHsp(statuses: string[], opts: { failOn?: string } = {}) {
  const calls: Array<{ tool: string; args: any }> = [];
  let i = 0;
  return {
    calls,
    call: async (tool: string, args: any = {}): Promise<any> => {
      calls.push({ tool, args });
      if (opts.failOn === tool) throw new Error(`${tool} failed: boom`);
      switch (tool) {
        case "get_chain_config":
          return { tokens: [{ network: "base-sepolia", chain_id: 84532, address: "0x0000000000000000000000000000000000000c0c", coin: "USDC", payment_protocol: "eip3009" }] };
        case "create_order":
          return { flow_id: "flow-1", payment_request_id: "pr-1", payment_url: "https://example.invalid" };
        case "prepare_payment":
          return { eip712: { domain: {}, types: {}, primaryType: "TransferWithAuthorization", message: {} }, token_total_raw: "25000000", cart_hash: "c".repeat(64), payment_payload: { payload: { signature: "" } }, payment_mandate_contents: {} };
        case "finalize_payment":
          return { payment_mandate_json: "{}" };
        case "submit_payment":
          return { status: "payment-submitted" };
        case "query_payment": {
          const status = statuses[Math.min(i++, statuses.length - 1)];
          return { status, attribution_verified: true, payment: { status, tx_signature: status === "payment-safe" ? HSP_TX : "", chain_id: 84532, status_reason: "insufficient balance" } };
        }
      }
      throw new Error(`unknown tool ${tool}`);
    },
  };
}

function deps(over: Partial<PayoutDeps> & { hsp: PayoutDeps["hsp"]; policy: PolicyLike }): PayoutDeps & { steps: Step[] } {
  const steps: Step[] = [];
  return {
    steps,
    merchantName: "Landed",
    signer: { address: PAYER, signTypedData: async () => ("0x" + "11".repeat(65)) as Hex },
    pickToken: (c) => ({ network: c.tokens[0].network, chainId: c.tokens[0].chain_id, contract: c.tokens[0].address, coin: c.tokens[0].coin, protocol: "eip3009" }),
    approve: async () => true,
    onStep: (s) => steps.push(s),
    sleep: async () => {},
    ...over,
  };
}

test("pays a 3h12m delay: reserve, 8 HSP steps, settle with the HSP tx", async () => {
  const { p, log } = fakePolicy();
  const hsp = fakeHsp(["payment-submitted", "payment-included", "payment-safe"]);
  const d = deps({ hsp, policy: p });
  const r = await payDelayCompensation(claim, d);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.amountUsd, "25.00");
    assert.equal(r.settlementTx, HSP_TX);
    assert.equal(r.chainId, 84532n);
  }
  assert.deepEqual(log, ["reserve", "settle"]);
  assert.deepEqual(
    hsp.calls.map((c) => c.tool),
    ["get_chain_config", "create_order", "prepare_payment", "finalize_payment", "submit_payment", "query_payment", "query_payment", "query_payment"],
  );
  const order = hsp.calls[1].args;
  assert.equal(order.pay_to, PASSENGER);
  assert.equal(order.cart_mandate.contents.payment_request.details.total.amount.value, "25.00");
  assert.equal(order.cart_mandate.contents.payment_request.method_data[0].data.x402Version, 2);
  assert.equal(hsp.calls[2].args.payer, PAYER);
  assert.equal(hsp.calls[5].args.expected_merchant_name, "Landed");
});

test("refuses a second claim for the same booking without calling HSP", async () => {
  const { p } = fakePolicy();
  await payDelayCompensation(claim, deps({ hsp: fakeHsp(["payment-safe"]), policy: p }));
  const hsp2 = fakeHsp(["payment-safe"]);
  const r = await payDelayCompensation({ ...claim, bookingRef: "xk4p2q " }, deps({ hsp: hsp2, policy: p }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /already claimed/);
  assert.equal(hsp2.calls.length, 0);
});

test("short delay is not eligible and touches nothing", async () => {
  const { p, log } = fakePolicy();
  const hsp = fakeHsp(["payment-safe"]);
  const r = await payDelayCompensation({ ...claim, delayMinutes: 45 }, deps({ hsp, policy: p }));
  assert.equal(r.ok, false);
  assert.equal(log.length, 0);
  assert.equal(hsp.calls.length, 0);
});

test("airline declines before signing: booking released, nothing submitted", async () => {
  const { p, log } = fakePolicy();
  const hsp = fakeHsp(["payment-safe"]);
  const r = await payDelayCompensation(claim, deps({ hsp, policy: p, approve: async (a) => a.stage !== "sign" }));
  assert.equal(r.ok, false);
  assert.deepEqual(log, ["reserve", "release"]);
  assert.ok(!hsp.calls.some((c) => c.tool === "submit_payment"));
});

test("HSP payment-failed releases the booking so it can be retried", async () => {
  const { p, log, state } = fakePolicy();
  const r = await payDelayCompensation(claim, deps({ hsp: fakeHsp(["payment-submitted", "payment-failed"]), policy: p }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /insufficient balance/);
  assert.deepEqual(log, ["reserve", "release"]);
  assert.equal(state.size, 0);
});

test("error before submit releases; error after submit keeps the booking reserved", async () => {
  const a = fakePolicy();
  const r1 = await payDelayCompensation(claim, deps({ hsp: fakeHsp([], { failOn: "create_order" }), policy: a.p }));
  assert.equal(r1.ok, false);
  assert.deepEqual(a.log, ["reserve", "release"]);

  const b = fakePolicy();
  const r2 = await payDelayCompensation(claim, deps({ hsp: fakeHsp([], { failOn: "query_payment" }), policy: b.p }));
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.pending, true);
  assert.deepEqual(b.log, ["reserve"]);
});

test("still pending after the wait limit: reports pending, keeps the booking", async () => {
  const { p, log } = fakePolicy();
  let now = 0;
  const realNow = Date.now;
  Date.now = () => (now += 6 * 60_000);
  try {
    const r = await payDelayCompensation(claim, deps({ hsp: fakeHsp(["payment-processing"]), policy: p }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.pending, true);
      assert.equal(r.reason, "pending confirmation");
    }
    assert.deepEqual(log, ["reserve"]);
  } finally {
    Date.now = realNow;
  }
});
