import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "dotenv/config";

const key = process.env.RECEIPT_WRITER_KEY;

const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hskTestnet: { url: "https://testnet.hsk.xyz", chainId: 133, accounts: key ? [key] : [] },
    hskMainnet: { url: "https://mainnet.hsk.xyz", chainId: 177, accounts: key ? [key] : [] },
  },
};
export default config;
