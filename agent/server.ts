// Airline agent server for the live demo. Must run on an HSP-allowlisted IP.
// Run: npx tsx agent/server.ts   (reads .env: AGENT_PAYER_KEY, RECEIPT_WRITER_KEY, POLICY_ADDRESS, ...)
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Hsp, healthCheck } from "./hsp.js";
import { policyOnChain } from "./chain.js";
import { payDelayCompensation, type Approval, type Claim, type Step } from "./payout.js";

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5500,http://127.0.0.1:5500").split(",");
const MERCHANT = process.env.HSP_MERCHANT_NAME ?? "Landed";
const DEMO_WALLET = (process.env.DEMO_PASSENGER_WALLET ?? "") as Address;

export const FLIGHTS = [
  { id: "DA117", from: "LHR", to: "JFK", due: "14:10", date: "2026-12-01" },
  { id: "DA402", from: "SIN", to: "NRT", due: "21:35", date: "2026-12-01" },
  { id: "DA88", from: "DXB", to: "ICN", due: "06:50", date: "2026-12-02" },
];

type Run = {
  events: Array<Step | { step: "approval"; approval: Approval } | { step: "done"; result: unknown }>;
  listeners: Set<ServerResponse>;
  pending?: { stage: Approval["stage"]; resolve: (ok: boolean) => void };
  done: boolean;
};
const runs = new Map<string, Run>();
let busy = false; // one payout at a time keeps the demo wallet's nonces and quotes simple

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function publish(run: Run, e: Run["events"][number]) {
  run.events.push(e);
  const line = `data: ${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
  for (const res of run.listeners) res.write(line);
}

async function startClaim(claim: Claim) {
  const signer = privateKeyToAccount(need("AGENT_PAYER_KEY") as Hex); // fail before marking busy
  const policy = policyOnChain({ address: need("POLICY_ADDRESS") as Address, writerKey: need("RECEIPT_WRITER_KEY") as Hex, testnet: process.env.POLICY_NETWORK === "testnet" });
  const id = randomUUID();
  const run: Run = { events: [], listeners: new Set(), done: false };
  runs.set(id, run);
  busy = true;
  (async () => {
    const hsp = new Hsp();
    try {
      await hsp.connect();
      const result = await payDelayCompensation(claim, {
        hsp,
        policy,
        signer: { address: signer.address, signTypedData: (t) => signer.signTypedData(t as any) },
        merchantName: MERCHANT,
        pickToken,
        approve: (a) =>
          new Promise<boolean>((resolve) => {
            run.pending = { stage: a.stage, resolve };
            publish(run, { step: "approval", approval: a });
            setTimeout(() => run.pending?.stage === a.stage && (run.pending = undefined, resolve(false)), 3 * 60_000);
          }),
        onStep: (s) => publish(run, s),
      });
      publish(run, { step: "done", result });
    } catch (err) {
      publish(run, { step: "done", result: { ok: false, reason: err instanceof Error ? err.message : String(err) } });
    } finally {
      run.done = true;
      busy = false;
      await hsp.close().catch(() => {});
      for (const res of run.listeners) res.end();
    }
  })();
  return id;
}

/** Choose the payment token from get_chain_config. Prefers PAY_NETWORK, then a USDC on an EIP-3009 test network. */
export function pickToken(config: any) {
  const list: any[] = config?.tokens ?? config?.networks?.flatMap((n: any) => (n.tokens ?? []).map((t: any) => ({ ...n, ...t }))) ?? [];
  const want = process.env.PAY_NETWORK;
  const t =
    list.find((x) => want && (x.network === want || String(x.chain_id) === want)) ??
    list.find((x) => /usdc/i.test(x.coin ?? x.symbol ?? "") && (x.payment_protocol ?? x.protocol) === "eip3009") ??
    list[0];
  if (!t) throw new Error("get_chain_config returned no tokens");
  return {
    network: t.network,
    chainId: Number(t.chain_id ?? t.chainId),
    contract: (t.address ?? t.contract_address) as Address,
    coin: t.coin ?? t.symbol,
    protocol: (t.payment_protocol ?? t.protocol ?? "eip3009") as "eip3009" | "permit2",
  };
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin ?? "";
  if (ORIGINS.includes(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

export const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      const h = await healthCheck().catch((e) => ({ ok: false, detail: String(e) }));
      return json(res, 200, { hsp: h.ok, hspDetail: h.detail, flights: FLIGHTS, demoWallet: DEMO_WALLET || null, busy });
    }
    if (req.method === "POST" && url.pathname === "/api/claims") {
      if (busy) return json(res, 429, { error: "Another payout is running. Try again in a minute." });
      const b = await readJson(req);
      const flight = FLIGHTS.find((f) => f.id === b.flight && f.date === b.date);
      const passenger = String(b.passenger || DEMO_WALLET);
      const delay = Number(b.delayMinutes);
      const ref = String(b.bookingRef ?? "").trim();
      if (!flight) return json(res, 400, { error: "Unknown flight" });
      if (!isAddress(passenger)) return json(res, 400, { error: "Passenger wallet is not a valid address" });
      if (!Number.isInteger(delay) || delay < 0 || delay > 24 * 60) return json(res, 400, { error: "Delay must be 0 to 1440 minutes" });
      if (!/^[A-Za-z0-9]{4,8}$/.test(ref)) return json(res, 400, { error: "Booking reference must be 4 to 8 letters or digits" });
      const id = await startClaim({ flight: flight.id, date: flight.date, bookingRef: ref, passenger: passenger as Address, delayMinutes: delay });
      return json(res, 201, { id });
    }
    const m = url.pathname.match(/^\/api\/claims\/([0-9a-f-]{36})\/(events|approve)$/);
    const run = m ? runs.get(m[1]) : undefined;
    if (m && !run) return json(res, 404, { error: "Unknown claim" });
    if (run && m![2] === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of run.events) res.write(`data: ${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
      if (run.done) return res.end();
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }
    if (run && m![2] === "approve" && req.method === "POST") {
      const b = await readJson(req);
      if (!run.pending || run.pending.stage !== b.stage) return json(res, 409, { error: "Nothing waiting for that approval" });
      const p = run.pending;
      run.pending = undefined;
      p.resolve(b.ok === true);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
  }
});

if (process.argv[1]?.endsWith("server.ts")) {
  server.listen(PORT, () => console.log(`Landed airline agent on http://localhost:${PORT} (allowed origins: ${ORIGINS.join(", ")})`));
}
