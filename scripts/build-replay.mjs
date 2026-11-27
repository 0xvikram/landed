// Builds web/replay.json from real runs only, and checks every hash on-chain before writing.
//   node scripts/build-replay.mjs [runs/a2a-<...>.jsonl]
// Run 1 (27 Nov, form, booking M2V9QL): step times from the recorded demo screen (IST), hashes from the chain.
// Run 2 (A2A): the airline agent server's own event log for that run.
import { readFileSync, writeFileSync } from "node:fs";

const RPC = { 11155111: "https://ethereum-sepolia-rpc.publicnode.com", 84532: "https://sepolia.base.org", 133: "https://testnet.hsk.xyz" };
async function receipt(chainId, hash) {
  const r = await fetch(RPC[chainId], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }) }).then((r) => r.json());
  if (!r.result) throw new Error(`tx ${hash} not found on chain ${chainId}`);
  if (r.result.status !== "0x1") throw new Error(`tx ${hash} failed on chain ${chainId}`);
  return r.result;
}

const ist = (t) => `2026-11-27T${t}+05:30`;
const m2v9ql = (() => {
  const ev = (t, e) => ({ at: new Date(ist(t)).toISOString(), ...e });
  const payer = "0x92742A4C1E116281808ECFeb0Cc443B083B34B7e";
  const payTo = "0x0fd0C4B952F9172E66A86eF22409e375c0794df2";
  const ap = (stage) => ({ step: "approval", approval: { payTo, payer, amountUsd: "10.00", tokenTotalRaw: "10002001", stage, network: "sepolia", chainId: 11155111 } });
  const polls = ["14:26:52", "14:27:08"].map((t) => ev(t, { step: "status", status: "payment-submitted" }))
    .concat(["14:27:24", "14:27:40", "14:27:57", "14:28:12", "14:28:28", "14:28:44", "14:29:01", "14:29:17", "14:29:33", "14:29:49", "14:30:05", "14:30:21"].map((t) => ev(t, { step: "status", status: "payment-included" })));
  const result = { ok: true, bookingKey: "0x6c67eb5886a6ccad12ea570471f017017ef69a90465d24dc8936434674c68710", amountUsd: "10.00", settlementTx: "0x69d358e2201d9bcb301b67aee49b7e430c3486083de40e9b94973eb104d55e15", chainId: "11155111", receiptTx: "0x849a8f6e1b11b94d143e453fef277a0ca7c56667740d4a3558a287818d332dc2", flowId: "a0d6e9af-9433-4596-92ac-30f3aef49311" };
  return {
    id: "2026-11-27-M2V9QL",
    mode: "form",
    button: "Replay: airline form, 27 Nov (M2V9QL)",
    banner: "Replay of a real HSP payment made on 27 Nov 2026 from this page (booking M2V9QL, $10 test USDC on Ethereum Sepolia). The links are live.",
    source: "Step times from the recorded demo screen; hashes read back from Ethereum Sepolia and HSK testnet.",
    policy: { version: "v1", address: "0x2b44008428ce6ee69c0b44aec4daef74b22c5a71" },
    form: { flight: "DA117", date: "2026-12-01", delayMinutes: 134, bookingRef: "M2V9QL", wallet: payTo },
    events: [
      ev("14:26:38", { step: "start", mode: "hsp" }),
      ev("14:26:40", { step: "checked", amountUsd: "10.00", delayMinutes: 134 }),
      ev("14:26:45", { step: "reserved", tx: "0x4ed6e47236bb42c3adf921182c092df842413d87edadf575b3672931719750e0" }),
      ev("14:26:48", { step: "order", flowId: result.flowId }),
      ev("14:26:48", { step: "prepared", tokenTotalRaw: "10002001" }),
      ev("14:26:48", ap("sign")),
      ev("14:26:49", { step: "signed" }),
      ev("14:26:49", ap("submit")),
      ev("14:26:51", { step: "submitted" }),
      ...polls,
      ev("14:30:37", { step: "status", status: "payment-safe" }),
      ev("14:30:41", { step: "settled", tx: result.receiptTx, settlementTx: result.settlementTx, chainId: "11155111" }),
      ev("14:30:41", { step: "done", result }),
    ],
    checks: [[11155111, result.settlementTx], [133, result.receiptTx], [133, "0x4ed6e47236bb42c3adf921182c092df842413d87edadf575b3672931719750e0"]],
  };
})();

function fromLog(path) {
  const events = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = events.find((e) => e.step === "start");
  const claim = events.find((e) => e.step === "claim");
  const done = events.find((e) => e.step === "done");
  if (!start || !claim || !done?.result?.ok) throw new Error(`${path} is not a completed A2A run`);
  if (start.mode !== "hsp") throw new Error(`${path} is a ${start.mode} run, not a real HSP payment`);
  const reserved = events.find((e) => e.step === "reserved");
  const r = done.result;
  const day = new Date(start.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  return {
    id: `${start.at.slice(0, 10)}-a2a`,
    mode: "a2a",
    button: `Replay: passenger agent (A2A), ${day.replace(/ \d{4}$/, "")}`,
    banner: `Replay of a real HSP payment made on ${day}: the passenger's agent signed the claim, the airline's agent verified it and paid that wallet ($${r.amountUsd} test USDC on Ethereum Sepolia). The links are live.`,
    source: `The airline agent server's own event log for this run (${path.split("/").pop()}).`,
    policy: { version: "v2", address: start.policy },
    form: { flight: start.flight, date: start.date, delayMinutes: start.delayMinutes, bookingRef: "(hashed)", passengerAgent: claim.claim.payTo },
    signedAt: claim.at,
    events,
    checks: [[Number(r.chainId), r.settlementTx], [133, r.receiptTx], [133, reserved.tx]],
  };
}

const runs = [];
if (process.argv[2]) runs.push(fromLog(process.argv[2]));
runs.push(m2v9ql);
const out = [];
for (const { checks, ...run } of runs) {
  for (const [chainId, hash] of checks) await receipt(chainId, hash);
  console.log(`${run.id}: ${checks.length} transactions confirmed on-chain`);
  out.push(run);
}
writeFileSync(new URL("../web/replay.json", import.meta.url), JSON.stringify({ generated: new Date().toISOString(), runs: out }, null, 1) + "\n");
console.log("wrote web/replay.json");
