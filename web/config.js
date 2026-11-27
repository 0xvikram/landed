// Where the site finds the live agent and the contracts. Filled in at deploy time.
window.LANDED = {
  // Airline agent server (needs an HSP-allowlisted IP). Empty = offline.
  agentUrl: new URLSearchParams(location.search).get("agent") || "",
  // LandedPolicy deployments. policy "" = not deployed yet. fromBlock keeps log queries small.
  networks: {
    mainnet: {
      label: "HSK Chain",
      policy: "",
      fromBlock: 0,
      rpc: "https://mainnet.hsk.xyz",
      explorer: "https://hsk.blockscout.com",
    },
    testnet: {
      label: "HSK testnet",
      // LandedPolicyV2: same rule + agent-to-agent claims (reserveWithClaim). Verified on the explorer.
      policy: "0xac5f455d7e59933781680b4fb0217e111f4961ef",
      fromBlock: 36293386,
      version: "v2",
      // Earlier contracts whose receipts stay listed on the proof page.
      older: [{ policy: "0x2b44008428ce6ee69c0b44aec4daef74b22c5a71", fromBlock: 36072224, version: "v1" }],
      rpc: "https://testnet.hsk.xyz",
      explorer: "https://testnet-explorer.hskchain.net",
    },
  },
  // Explorers for the networks HSP settles on in its test environment.
  settlementExplorers: {
    11155111: "https://sepolia.etherscan.io/tx/",
    84532: "https://sepolia.basescan.org/tx/",
    133: "https://testnet-explorer.hskchain.net/tx/",
    177: "https://hsk.blockscout.com/tx/",
  },
  // Chain id the HSP stand-in writes, so test receipts are never mistaken for real payments.
  standInChainId: 999999,
};
// The demo page links receipts on the network the agent writes to.
window.LANDED.receipts = window.LANDED.networks[window.LANDED.networks.mainnet.policy ? "mainnet" : "testnet"];
