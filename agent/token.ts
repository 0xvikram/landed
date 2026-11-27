import type { Address } from "viem";

/** Choose the payment token from get_chain_config. Prefers PAY_NETWORK, then a USDC on an EIP-3009 test network. */
export function pickToken(config: any) {
  const list: any[] = config?.tokens ?? config?.networks?.flatMap((n: any) => (n.tokens ?? []).map((t: any) => ({ ...n, ...t }))) ?? [];
  const want = process.env.PAY_NETWORK;
  const t =
    list.find((x) => want && (x.network === want || String(x.chain_id) === want || (config?.networks ?? []).some((n: any) => n.name === want && Number(n.chain_id) === Number(x.chain_id)) && /usdc/i.test(x.symbol ?? "") && (x.payment_protocol ?? x.protocol) === "eip3009")) ??
    list.find((x) => /usdc/i.test(x.coin ?? x.symbol ?? "") && (x.payment_protocol ?? x.protocol) === "eip3009") ??
    list[0];
  if (!t) throw new Error("get_chain_config returned no tokens");
  // Live tokens carry only chain_id; the network name lives in config.networks.
  const network = t.network ?? config?.networks?.find((n: any) => Number(n.chain_id) === Number(t.chain_id))?.name;
  if (!network) throw new Error(`no network name for chain ${t.chain_id} in get_chain_config`);
  return {
    network,
    chainId: Number(t.chain_id ?? t.chainId),
    contract: (t.address ?? t.contract_address) as Address,
    coin: t.coin ?? t.symbol,
    protocol: (t.payment_protocol ?? t.protocol ?? "eip3009") as "eip3009" | "permit2",
  };
}
