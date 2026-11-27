// The passenger's agent: its own wallet (PASSENGER_AGENT_KEY), separate from the airline's keys.
// It builds a claim from the passenger's confirmed fields, signs it (EIP-712), and hands it to the airline agent.
// The raw booking reference stays here; only its hash leaves.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildClaim, signClaim, type SignedClaim } from "./claim.js";

export function passengerAgent(key: Hex, policy: Address, chainId = 133) {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    async sign(input: { flight: string; date: string; bookingRef: string; delayMinutes: number }): Promise<{ claim: SignedClaim; signature: Hex }> {
      const claim = buildClaim({ ...input, payTo: account.address });
      return { claim, signature: await signClaim(account, claim, policy, chainId) };
    },
  };
}
