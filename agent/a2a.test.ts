// Agent-to-agent claims: passenger agent signs, airline agent verifies, payout reserves with the claim.
// Run: npm run test:agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildClaim, signClaim, verifyClaim } from "./claim.js";
import { bookingKey } from "./keys.js";
import { payDelayCompensation, type PolicyLike } from "./payout.js";
import { standInHsp } from "./standin.js";

const POLICY = "0xac5f455d7e59933781680b4fb0217e111f4961ef" as Address;
const passenger = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const base = () => buildClaim({ flight: "da117", date: "2026-12-01", bookingRef: "xk4p2q", delayMinutes: 134, payTo: passenger.address });

test("passenger agent's claim hashes the booking ref and verifies as payTo = signer", async () => {
  const c = base();
  assert.equal(c.flight, "DA117");
  assert.equal(c.bookingKey, bookingKey("DA117", "2026-12-01", "XK4P2Q"));
  assert.ok(!JSON.stringify(c).includes("XK4P2Q"));
  const sig = await signClaim(passenger, c, POLICY);
  const r = await verifyClaim(c, sig, POLICY);
  assert.deepEqual(r, { ok: true, signer: passenger.address });
});

test("off-chain check refuses a wrong signer, a tampered delay, an expired claim and a bad shape", async () => {
  const c = base();
  const bad = await verifyClaim(c, await signClaim(stranger, c, POLICY), POLICY);
  assert.equal(bad.ok, false);
  const sig = await signClaim(passenger, c, POLICY);
  assert.equal((await verifyClaim({ ...c, delayMinutes: 400 }, sig, POLICY)).ok, false);
  assert.equal((await verifyClaim(c, sig, POLICY, { chainId: 177 })).ok, false); // wrong chain in the domain
  const expired = await verifyClaim(c, sig, POLICY, { now: c.deadline + 1 });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.error, /expired/);
  assert.equal((await verifyClaim({ ...c, payTo: "nope" }, sig, POLICY)).ok, false);
  assert.equal((await verifyClaim(c, "0x1234", POLICY)).ok, false);
});

function fakePolicy() {
  const log: string[] = [];
  const state = new Map<Hex, number>();
  const p: PolicyLike = {
    quote: async (m) => (m >= 300 ? 6000n : m >= 180 ? 2500n : m >= 120 ? 1000n : 0n),
    status: async (bk) => state.get(bk) ?? 0,
    reserve: async () => { log.push("reserve"); return "0x01"; },
    reserveWithClaim: async (c) => { state.set(c.bookingKey, 1); log.push(`reserveWithClaim:${c.payTo}`); return "0x0a"; },
    settle: async (bk) => { state.set(bk, 2); log.push("settle"); return "0x02"; },
    release: async () => { log.push("release"); return "0x03"; },
  };
  return { p, log };
}

const deps = (p: PolicyLike) => ({
  hsp: standInHsp(),
  policy: p,
  signer: { address: "0x00000000000000000000000000000000000000bb" as Address, signTypedData: async () => ("0x" + "11".repeat(65)) as Hex },
  merchantName: "Landed",
  pickToken: (c: any) => ({ network: c.tokens[0].network, chainId: c.tokens[0].chain_id, contract: c.tokens[0].address, coin: "USDC", protocol: "eip3009" as const }),
  approve: async () => true,
  sleep: async () => {},
});

test("a signed claim is reserved with reserveWithClaim and paid to payTo", async () => {
  const c = base();
  const signature = await signClaim(passenger, c, POLICY);
  const { p, log } = fakePolicy();
  const r = await payDelayCompensation({ flight: c.flight, date: c.date, passenger: c.payTo, delayMinutes: c.delayMinutes, signed: { claim: c, signature } }, deps(p));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.bookingKey, c.bookingKey);
  assert.deepEqual(log, [`reserveWithClaim:${passenger.address}`, "settle"]);
});

test("a payout request that does not match its signed claim is refused before anything moves", async () => {
  const c = base();
  const signature = await signClaim(passenger, c, POLICY);
  const { p, log } = fakePolicy();
  await assert.rejects(payDelayCompensation({ flight: c.flight, date: c.date, passenger: stranger.address, delayMinutes: c.delayMinutes, signed: { claim: c, signature } }, deps(p)), /does not match/);
  assert.deepEqual(log, []);
});
