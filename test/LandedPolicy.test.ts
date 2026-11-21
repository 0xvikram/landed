import { expect } from "chai";
import hre from "hardhat";
import { keccak256, toHex, zeroHash, getAddress } from "viem";

const key = (s: string) => keccak256(toHex(s));
const TX = key("hsp-tx-1");

async function deploy() {
  const [airline, agent, stranger, passenger] = await hre.viem.getWalletClients();
  // 2h+ = $10, 3h+ = $25, 5h+ = $60 (demo amounts in USD cents)
  const policy = await hre.viem.deployContract("LandedPolicy", ["Demo Air", [120, 180, 300], [1000n, 2500n, 6000n]]);
  await policy.write.setAgent([agent.account.address, true]);
  const asAgent = await hre.viem.getContractAt("LandedPolicy", policy.address, { client: { wallet: agent } });
  const asStranger = await hre.viem.getContractAt("LandedPolicy", policy.address, { client: { wallet: stranger } });
  return { policy, asAgent, asStranger, airline, agent, stranger, passenger };
}

describe("LandedPolicy", () => {
  it("quotes by tier", async () => {
    const { policy } = await deploy();
    expect(await policy.read.quote([119])).to.equal(0n);
    expect(await policy.read.quote([120])).to.equal(1000n);
    expect(await policy.read.quote([192])).to.equal(2500n);
    expect(await policy.read.quote([600])).to.equal(6000n);
  });

  it("reserves, settles and counts a payout", async () => {
    const { policy, asAgent, passenger } = await deploy();
    await asAgent.write.reserve([key("BK1"), key("BA117|2026-12-01"), passenger.account.address, 192]);
    let p = await policy.read.payoutOf([key("BK1")]);
    expect(p.status).to.equal(1);
    expect(p.amountCents).to.equal(2500n);
    await asAgent.write.settle([key("BK1"), 11155111n, TX]);
    p = await policy.read.payoutOf([key("BK1")]);
    expect(p.status).to.equal(2);
    expect(p.settlementTx).to.equal(TX);
    expect(getAddress(p.passenger)).to.equal(getAddress(passenger.account.address));
    expect(await policy.read.paidCount()).to.equal(1n);
    expect(await policy.read.paidCentsTotal()).to.equal(2500n);
  });

  it("refuses to pay the same booking twice", async () => {
    const { asAgent, passenger } = await deploy();
    await asAgent.write.reserve([key("BK1"), key("F"), passenger.account.address, 200]);
    await expect(asAgent.write.reserve([key("BK1"), key("F"), passenger.account.address, 200])).to.be.rejectedWith("AlreadyClaimed");
    await asAgent.write.settle([key("BK1"), 84532n, TX]);
    await expect(asAgent.write.reserve([key("BK1"), key("F"), passenger.account.address, 200])).to.be.rejectedWith("AlreadyClaimed");
    await expect(asAgent.write.settle([key("BK1"), 84532n, TX])).to.be.rejectedWith("NotReserved");
  });

  it("rejects short delays", async () => {
    const { asAgent, passenger } = await deploy();
    await expect(asAgent.write.reserve([key("BK2"), key("F"), passenger.account.address, 45])).to.be.rejectedWith("NotEligible");
  });

  it("releases a failed payment so it can be retried", async () => {
    const { policy, asAgent, passenger } = await deploy();
    await asAgent.write.reserve([key("BK3"), key("F"), passenger.account.address, 200]);
    await asAgent.write.release([key("BK3"), "hsp payment failed"]);
    expect((await policy.read.payoutOf([key("BK3")])).status).to.equal(0);
    await asAgent.write.reserve([key("BK3"), key("F"), passenger.account.address, 200]);
  });

  it("only agents reserve/settle, only the owner changes the rule", async () => {
    const { asStranger, asAgent, passenger } = await deploy();
    await expect(asStranger.write.reserve([key("BK4"), key("F"), passenger.account.address, 200])).to.be.rejectedWith("NotAgent");
    await expect(asAgent.write.publishPolicy([[60], [500n]])).to.be.rejectedWith("NotOwner");
    await expect(asAgent.write.setAgent([passenger.account.address, true])).to.be.rejectedWith("NotOwner");
  });

  it("validates input and policy shape", async () => {
    const { policy, asAgent, passenger } = await deploy();
    await expect(asAgent.write.reserve([zeroHash, key("F"), passenger.account.address, 200])).to.be.rejectedWith("BadInput");
    await asAgent.write.reserve([key("BK5"), key("F"), passenger.account.address, 200]);
    await expect(asAgent.write.settle([key("BK5"), 0n, TX])).to.be.rejectedWith("BadInput");
    await expect(policy.write.publishPolicy([[180, 120], [1000n, 2000n]])).to.be.rejectedWith("BadPolicy");
    await expect(policy.write.publishPolicy([[120, 180], [2000n, 1000n]])).to.be.rejectedWith("BadPolicy");
    await expect(policy.write.publishPolicy([[], []])).to.be.rejectedWith("BadPolicy");
    await policy.write.publishPolicy([[60], [500n]]);
    expect(await policy.read.policyVersion()).to.equal(2n);
    expect(await policy.read.quote([61])).to.equal(500n);
  });
});
