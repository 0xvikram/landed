// Deploy LandedPolicyV2 (agent-to-agent claims) with the same demo rule as v1.
// Run: npx hardhat run scripts/deploy-v2.ts --network hskTestnet
import hre from "hardhat";

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const { contract: policy, deploymentTransaction } = await hre.viem.sendDeploymentTransaction("LandedPolicyV2", ["Demo Air", [120, 180, 300], [1000n, 2500n, 6000n]]);
  const receipt = await pub.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
  // The constructor makes the deployer (the receipt writer) an agent.
  console.log(`POLICY_V2_ADDRESS=${policy.address}`);
  console.log(`deployTx=${deploymentTransaction.hash} block=${receipt.blockNumber} status=${receipt.status} network=${hre.network.name} agent=${wallet.account.address}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
