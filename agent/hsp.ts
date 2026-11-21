// HSP Agentic Payment client: the 8 MCP tools from the official hackathon guide
// (https://dorahacks.io/hackathon/hskchainindia/agentic-payment-guide, rev 2026-10-30).
// HSP QA only answers allowlisted IPs. Do not retry a blocked endpoint in a loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const HSP_URL = process.env.HSP_MCP_URL ?? "https://mcp-qa.hashkeymerchant.com/";
export const REQUIRED_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
export type HspTool = (typeof REQUIRED_TOOLS)[number];

export const FINAL_STATES = ["payment-safe", "payment-finalized", "payment-failed"] as const;

export class HspError extends Error {
  constructor(message: string, readonly tool?: string, readonly raw?: unknown) {
    super(message);
  }
}

export async function healthCheck(): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(new URL("health", HSP_URL), { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok || !text.includes('"ok"')) {
    const blocked = /blocked|Cloudflare/i.test(text);
    return { ok: false, detail: blocked ? "blocked by HSP firewall (IP not allowlisted yet)" : `HTTP ${res.status}` };
  }
  return { ok: true, detail: text.trim() };
}

export class Hsp {
  private client = new Client({ name: "landed-airline-agent", version: "0.1.0" });
  private tools = new Map<string, { inputSchema: unknown; description?: string }>();
  private rawNames = new Map<string, string>();

  async connect() {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(HSP_URL)));
    const { tools } = await this.client.listTools();
    for (const t of tools) {
      // Clients may add prefixes; match on the tool's own name ending.
      const name = REQUIRED_TOOLS.find((r) => t.name === r || t.name.endsWith(`__${r}`) || t.name.endsWith(`.${r}`));
      if (name) this.tools.set(name, { inputSchema: t.inputSchema, description: t.description });
      this.rawNames.set(name ?? t.name, t.name);
    }
    const missing = REQUIRED_TOOLS.filter((r) => !this.tools.has(r));
    if (missing.length) throw new HspError(`HSP is missing tools: ${missing.join(", ")}`);
    return this;
  }
  schemas() {
    return Object.fromEntries(this.tools);
  }

  async call<T = any>(tool: HspTool, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.client.callTool({ name: this.rawNames.get(tool) ?? tool, arguments: args });
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const structured = (res as { structuredContent?: unknown }).structuredContent;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    let body: unknown = structured;
    if (body === undefined) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.isError) throw new HspError(`${tool} failed: ${typeof body === "string" ? body : JSON.stringify(body)}`, tool, body);
    return body as T;
  }

  async close() {
    await this.client.close();
  }
}
