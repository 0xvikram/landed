// Where the site finds the live agent and the contract. Filled in at deploy time.
window.LANDED = {
  // Airline agent server (needs an HSP-allowlisted IP). Empty = offline.
  agentUrl: new URLSearchParams(location.search).get("agent") || "",
  // LandedPolicy on HSK Chain mainnet. Empty until deployed.
  policy: "",
  // Block the contract was deployed in (keeps log queries small).
  fromBlock: 0,
  rpc: "https://mainnet.hsk.xyz",
  explorer: "https://hsk.blockscout.com",
  // Explorers for the networks HSP settles on in its test environment.
  settlementExplorers: {
    11155111: "https://sepolia.etherscan.io/tx/",
    84532: "https://sepolia.basescan.org/tx/",
    133: "https://testnet-explorer.hsk.xyz/tx/",
    177: "https://hsk.blockscout.com/tx/",
  },
};
