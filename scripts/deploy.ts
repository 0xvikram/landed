// Deploy LandedPolicy with the demo rule. Run: npx hardhat run scripts/deploy.ts --network hskTestnet
import hre from "hardhat";

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const policy = await hre.viem.deployContract("LandedPolicy", ["Demo Air", [120, 180, 300], [1000n, 2500n, 6000n]]);
  const block = await pub.getBlockNumber();
  // The constructor makes the deployer (the receipt writer) an agent.
  console.log(`POLICY_ADDRESS=${policy.address}`);
  console.log(`fromBlock≈${block}  network=${hre.network.name}  agent=${wallet.account.address}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
