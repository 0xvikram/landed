import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "dotenv/config";

const key = process.env.RECEIPT_WRITER_KEY;

const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    // HARDHAT_CHAIN_ID=133 lets a local node stand in for HSK testnet in smoke tests (same EIP-712 domain).
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 31337) },
    hskTestnet: { url: "https://testnet.hsk.xyz", chainId: 133, accounts: key ? [key] : [] },
    hskMainnet: { url: "https://mainnet.hsk.xyz", chainId: 177, accounts: key ? [key] : [] },
  },
  // Blockscout on HSK testnet takes source verification without an API key.
  etherscan: {
    apiKey: { hskTestnet: "blockscout" },
    customChains: [
      { network: "hskTestnet", chainId: 133, urls: { apiURL: "https://testnet-explorer.hskchain.net/api", browserURL: "https://testnet-explorer.hskchain.net" } },
    ],
  },
  sourcify: { enabled: false },
};
export default config;
