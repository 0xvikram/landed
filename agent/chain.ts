// LandedPolicy on HSK Chain through viem. Waits for each receipt so the next step sees the new state.
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PolicyLike } from "./payout.js";
import { claimArg } from "./claim.js";

export const hskMainnet = defineChain({
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hsk.blockscout.com" } },
});

export const hskTestnet = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://testnet-explorer.hskchain.net" } },
  testnet: true,
});

export const policyAbi = [
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ name: "delayMinutes", type: "uint32" }], outputs: [{ type: "uint64" }] },
  {
    type: "function",
    name: "payoutOf",
    stateMutability: "view",
    inputs: [{ name: "bookingKey", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "flightKey", type: "bytes32" },
          { name: "passenger", type: "address" },
          { name: "delayMinutes", type: "uint32" },
          { name: "amountCents", type: "uint64" },
          { name: "settlementChainId", type: "uint64" },
          { name: "settlementTx", type: "bytes32" },
          { name: "reservedAt", type: "uint64" },
          { name: "paidAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "reserve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bookingKey", type: "bytes32" },
      { name: "flightKey", type: "bytes32" },
      { name: "passenger", type: "address" },
      { name: "delayMinutes", type: "uint32" },
    ],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bookingKey", type: "bytes32" },
      { name: "settlementChainId", type: "uint64" },
      { name: "settlementTx", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bookingKey", type: "bytes32" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reserveWithClaim",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "c",
        type: "tuple",
        components: [
          { name: "flight", type: "string" },
          { name: "date", type: "string" },
          { name: "bookingKey", type: "bytes32" },
          { name: "delayMinutes", type: "uint32" },
          { name: "payTo", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "uint64" }],
  },
  { type: "error", name: "ClaimExpired", inputs: [{ name: "deadline", type: "uint64" }] },
  { type: "error", name: "NonceUsed", inputs: [{ name: "payTo", type: "address" }, { name: "nonce", type: "uint256" }] },
  { type: "error", name: "WrongSigner", inputs: [{ name: "signer", type: "address" }, { name: "payTo", type: "address" }] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
  { type: "error", name: "BadPolicy", inputs: [] },
  { type: "error", name: "AlreadyClaimed", inputs: [{ name: "bookingKey", type: "bytes32" }] },
  { type: "error", name: "NotReserved", inputs: [{ name: "bookingKey", type: "bytes32" }] },
  { type: "error", name: "NotEligible", inputs: [{ name: "delayMinutes", type: "uint32" }] },
  { type: "error", name: "BadInput", inputs: [] },
] as const;

export function policyOnChain(opts: { address: Address; writerKey: Hex; rpcUrl?: string; testnet?: boolean }): PolicyLike {
  const chain = opts.testnet ? hskTestnet : hskMainnet;
  const transport = http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(opts.writerKey) });
  const write = async (functionName: "reserve" | "reserveWithClaim" | "settle" | "release", args: readonly unknown[]) => {
    const hash = await wallet.writeContract({ address: opts.address, abi: policyAbi, functionName, args } as any);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  };
  return {
    quote: (m) => pub.readContract({ address: opts.address, abi: policyAbi, functionName: "quote", args: [m] }),
    status: async (bk) => (await pub.readContract({ address: opts.address, abi: policyAbi, functionName: "payoutOf", args: [bk] })).status,
    reserve: (bk, fk, passenger, m) => write("reserve", [bk, fk, passenger, m]),
    // LandedPolicyV2 only: the passenger agent's signed claim; the contract re-checks the signature.
    reserveWithClaim: (c, sig) => write("reserveWithClaim", [claimArg(c), sig]),
    settle: (bk, chainId, tx) => write("settle", [bk, chainId, tx]),
    release: (bk, reason) => write("release", [bk, reason]),
  };
}
