import { expect } from "chai";
import hre from "hardhat";
import { keccak256, toHex, getAddress, hashTypedData, parseEventLogs, type Address, type Hex } from "viem";

const key = (s: string) => keccak256(toHex(s));
const TX = key("hsp-tx-1");
const TYPES = {
  Claim: [
    { name: "flight", type: "string" },
    { name: "date", type: "string" },
    { name: "bookingKey", type: "bytes32" },
    { name: "delayMinutes", type: "uint32" },
    { name: "payTo", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

type Claim = { flight: string; date: string; bookingKey: Hex; delayMinutes: number; payTo: Address; deadline: bigint; nonce: bigint };

async function deploy() {
  const [airline, agent, stranger, passenger, other] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const policy = await hre.viem.deployContract("LandedPolicyV2", ["Demo Air", [120, 180, 300], [1000n, 2500n, 6000n]]);
  await policy.write.setAgent([agent.account.address, true]);
  const asAgent = await hre.viem.getContractAt("LandedPolicyV2", policy.address, { client: { wallet: agent } });
  const asStranger = await hre.viem.getContractAt("LandedPolicyV2", policy.address, { client: { wallet: stranger } });
  const chainId = await pub.getChainId();
  const domain = { name: "Landed", version: "2", chainId, verifyingContract: policy.address } as const;
  const now = (await pub.getBlock()).timestamp;
  const claim = (over: Partial<Claim> = {}): Claim => ({
    flight: "BA117",
    date: "2026-12-01",
    bookingKey: key("BA117|2026-12-01|XK4P2Q"),
    delayMinutes: 134,
    payTo: getAddress(passenger.account.address),
    deadline: now + 1800n,
    nonce: 1n,
    ...over,
  });
  const sign = (c: Claim, by = passenger) => by.signTypedData({ account: by.account, domain, types: TYPES, primaryType: "Claim", message: c });
  return { policy, asAgent, asStranger, passenger, other, pub, domain, claim, sign };
}

describe("LandedPolicyV2: agent-to-agent claims", () => {
  it("off-chain digest matches the contract's", async () => {
    const { policy, domain, claim } = await deploy();
    const c = claim();
    expect(await policy.read.claimDigest([c])).to.equal(hashTypedData({ domain, types: TYPES, primaryType: "Claim", message: c }));
  });

  it("a valid signed claim reserves, pays only payTo, and the receipt carries payTo", async () => {
    const { policy, asAgent, passenger, pub, claim, sign } = await deploy();
    const c = claim();
    const hash = await asAgent.write.reserveWithClaim([c, await sign(c)]);
    const r = await pub.waitForTransactionReceipt({ hash });
    const accepted = parseEventLogs({ abi: policy.abi, logs: r.logs, eventName: "ClaimAccepted" });
    expect(accepted.length).to.equal(1);
    expect(getAddress(accepted[0].args.payTo)).to.equal(getAddress(passenger.account.address));
    let p = await policy.read.payoutOf([c.bookingKey]);
    expect(p.status).to.equal(1);
    expect(p.amountCents).to.equal(1000n); // the contract set the amount from its tiers
    expect(p.flightKey).to.equal(key("BA117|2026-12-01"));
    expect(await policy.read.nonceUsed([c.payTo, 1n])).to.equal(true);

    const settleHash = await asAgent.write.settle([c.bookingKey, 11155111n, TX]);
    const sr = await pub.waitForTransactionReceipt({ hash: settleHash });
    const paid = parseEventLogs({ abi: policy.abi, logs: sr.logs, eventName: "PayoutPaid" });
    expect(getAddress(paid[0].args.passenger)).to.equal(getAddress(passenger.account.address));
    expect(paid[0].args.settlementTx).to.equal(TX);
    p = await policy.read.payoutOf([c.bookingKey]);
    expect(p.status).to.equal(2);
    expect(await policy.read.paidCentsTotal()).to.equal(1000n);
  });

  it("refuses a claim signed by someone other than payTo", async () => {
    const { asAgent, other, claim, sign } = await deploy();
    const c = claim();
    await expect(asAgent.write.reserveWithClaim([c, await sign(c, other)])).to.be.rejectedWith("WrongSigner");
  });

  it("refuses an expired claim", async () => {
    const { asAgent, claim, sign, pub } = await deploy();
    const c = claim({ deadline: (await pub.getBlock()).timestamp - 1n });
    await expect(asAgent.write.reserveWithClaim([c, await sign(c)])).to.be.rejectedWith("ClaimExpired");
  });

  it("refuses a replayed claim, and the same booking under a new nonce", async () => {
    const { asAgent, claim, sign } = await deploy();
    const c = claim();
    const sig = await sign(c);
    await asAgent.write.reserveWithClaim([c, sig]);
    await expect(asAgent.write.reserveWithClaim([c, sig])).to.be.rejectedWith("NonceUsed");
    const c2 = claim({ nonce: 2n });
    await expect(asAgent.write.reserveWithClaim([c2, await sign(c2)])).to.be.rejectedWith("AlreadyClaimed");
  });

  it("refuses a claim whose delay or payTo was changed after signing", async () => {
    const { asAgent, other, claim, sign } = await deploy();
    const c = claim();
    const sig = await sign(c);
    await expect(asAgent.write.reserveWithClaim([{ ...c, delayMinutes: 400 }, sig])).to.be.rejectedWith("WrongSigner");
    await expect(asAgent.write.reserveWithClaim([{ ...c, payTo: getAddress(other.account.address) }, sig])).to.be.rejectedWith("WrongSigner");
    await expect(asAgent.write.reserveWithClaim([{ ...c, bookingKey: key("other") }, sig])).to.be.rejectedWith("WrongSigner");
  });

  it("still applies the rule to signed claims (short delay is not eligible)", async () => {
    const { asAgent, claim, sign } = await deploy();
    const c = claim({ delayMinutes: 45 });
    await expect(asAgent.write.reserveWithClaim([c, await sign(c)])).to.be.rejectedWith("NotEligible");
  });

  it("only an airline agent can submit a claim", async () => {
    const { asStranger, claim, sign } = await deploy();
    const c = claim();
    await expect(asStranger.write.reserveWithClaim([c, await sign(c)])).to.be.rejectedWith("NotAgent");
  });

  it("keeps the v1 agent-only reserve path working", async () => {
    const { policy, asAgent, passenger } = await deploy();
    await asAgent.write.reserve([key("BK1"), key("F"), passenger.account.address, 200]);
    await asAgent.write.settle([key("BK1"), 84532n, TX]);
    expect((await policy.read.payoutOf([key("BK1")])).status).to.equal(2);
    await expect(asAgent.write.reserve([key("BK1"), key("F"), passenger.account.address, 200])).to.be.rejectedWith("AlreadyClaimed");
  });
});
