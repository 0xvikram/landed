// One-shot check: is HSP reachable from this machine, and what are the live tool schemas?
// Run: npx tsx agent/inspect.ts   (writes agent/hsp-schemas.json on success)
import { writeFileSync } from "node:fs";
import { Hsp, healthCheck, HSP_URL } from "./hsp.js";

const egress = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => "unknown");
console.log(`HSP endpoint: ${HSP_URL}\nThis machine's public IPv4: ${egress}`);

const health = await healthCheck();
console.log(`Health: ${health.ok ? "ok" : "NOT ok"} (${health.detail})`);
if (!health.ok) {
  console.log("Stop here: ask HSP to allowlist the IP above, then run this once more. Do not retry in a loop.");
  process.exit(1);
}

const hsp = await new Hsp().connect();
console.log("All 8 HSP tools present.");
writeFileSync(new URL("./hsp-schemas.json", import.meta.url), JSON.stringify(hsp.schemas(), null, 2));
const config = await hsp.call("get_chain_config");
writeFileSync(new URL("./hsp-chain-config.json", import.meta.url), JSON.stringify(config, null, 2));
console.log("Saved agent/hsp-schemas.json and agent/hsp-chain-config.json");
await hsp.close();
