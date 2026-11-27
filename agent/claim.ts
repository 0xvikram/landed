// Agent-to-agent claims: the passenger's agent signs an EIP-712 claim with its own wallet,
// the airline's agent checks it off-chain (fast, clear error), then LandedPolicyV2.reserveWithClaim
// checks it again on HSK Chain. Only the signer can be paid. The claim never carries an amount.
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { bookingKey } from "./keys.js";

export const CLAIM_TYPES = {
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

export interface SignedClaim {
  flight: string;
  date: string;
  bookingKey: Hex;
  delayMinutes: number;
  payTo: Address;
  deadline: number; // unix seconds
  nonce: string; // decimal string (uint256)
}

export const claimDomain = (policy: Address, chainId = 133) =>
  ({ name: "Landed", version: "2", chainId, verifyingContract: policy }) as const;

/** What the passenger agent builds. The raw booking reference stays with the passenger; only its hash is signed. */
export function buildClaim(input: { flight: string; date: string; bookingRef: string; delayMinutes: number; payTo: Address; ttlSeconds?: number; now?: number; nonce?: bigint }): SignedClaim {
  const flight = input.flight.trim().toUpperCase();
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return {
    flight,
    date: input.date,
    bookingKey: bookingKey(flight, input.date, input.bookingRef),
    delayMinutes: input.delayMinutes,
    payTo: getAddress(input.payTo),
    deadline: now + (input.ttlSeconds ?? 30 * 60),
    nonce: nonce.toString(),
  };
}

export const typedMessage = (c: SignedClaim) => ({
  flight: c.flight,
  date: c.date,
  bookingKey: c.bookingKey,
  delayMinutes: c.delayMinutes,
  payTo: c.payTo,
  deadline: BigInt(c.deadline),
  nonce: BigInt(c.nonce),
});

/** Tuple shape for reserveWithClaim. */
export const claimArg = (c: SignedClaim) => ({ ...typedMessage(c) });

export async function signClaim(account: { signTypedData: (a: any) => Promise<Hex> }, c: SignedClaim, policy: Address, chainId = 133) {
  return account.signTypedData({ domain: claimDomain(policy, chainId), types: CLAIM_TYPES, primaryType: "Claim", message: typedMessage(c) });
}

export type ClaimCheck = { ok: true; signer: Address } | { ok: false; error: string; signer?: Address };

/** Off-chain check before anything is reserved or paid. Mirrors what the contract enforces. */
export async function verifyClaim(raw: unknown, signature: unknown, policy: Address, opts: { chainId?: number; now?: number } = {}): Promise<ClaimCheck> {
  const c = raw as Partial<SignedClaim> | null;
  if (!c || typeof c !== "object") return { ok: false, error: "claim missing" };
  if (typeof c.flight !== "string" || !/^[A-Z0-9]{2,8}$/.test(c.flight)) return { ok: false, error: "claim.flight must be an upper-case flight number" };
  if (typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return { ok: false, error: "claim.date must be YYYY-MM-DD" };
  if (typeof c.bookingKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(c.bookingKey)) return { ok: false, error: "claim.bookingKey must be a 32-byte hash" };
  if (!Number.isInteger(c.delayMinutes) || c.delayMinutes! < 0 || c.delayMinutes! > 24 * 60) return { ok: false, error: "claim.delayMinutes must be 0 to 1440" };
  if (typeof c.payTo !== "string" || !isAddress(c.payTo)) return { ok: false, error: "claim.payTo is not an address" };
  if (!Number.isInteger(c.deadline)) return { ok: false, error: "claim.deadline must be unix seconds" };
  if (typeof c.nonce !== "string" || !/^\d{1,78}$/.test(c.nonce)) return { ok: false, error: "claim.nonce must be a decimal string" };
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, error: "signature must be 65 bytes hex" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (c.deadline! < now) return { ok: false, error: "claim expired" };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ domain: claimDomain(policy, opts.chainId ?? 133), types: CLAIM_TYPES, primaryType: "Claim", message: typedMessage(c as SignedClaim), signature: signature as Hex });
  } catch {
    return { ok: false, error: "signature could not be recovered" };
  }
  if (getAddress(signer) !== getAddress(c.payTo)) return { ok: false, error: `signature is from ${signer}, not payTo ${getAddress(c.payTo)}`, signer };
  return { ok: true, signer };
}
