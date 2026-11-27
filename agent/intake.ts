// AI intake: an LLM turns a passenger's free-text message into claim fields. It never sets money:
// the contract's published tiers decide the amount. Every field is shown to a person before signing.
// Groq's OpenAI-compatible API, key GROQ_API_KEY. Without the key the intake says so and the form is used.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const INTAKE_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
export const INTAKE_PROMPT = readFileSync(new URL("./prompts/intake.md", import.meta.url), "utf8");
export const INTAKE_PROMPT_SHA256 = createHash("sha256").update(INTAKE_PROMPT).digest("hex");
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface IntakeFields {
  flight: string | null;
  date: string | null;
  bookingRef: string | null;
  scheduledArrival: string | null;
  actualArrival: string | null;
  delayMinutes: number | null;
}

export type IntakeResult =
  | { ok: true; fields: IntakeFields; missing: Array<keyof IntakeFields>; flags: string[]; model: string; promptSha256: string }
  | { ok: false; error: string; configured: boolean };

type Fetch = typeof fetch;

export const intakeConfigured = () => !!process.env.GROQ_API_KEY;

const hhmm = (v: unknown) => (typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim().padStart(5, "0") : null);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Validate and normalise what the model returned. The delay is recomputed from the times when both are present. */
export function normalise(raw: unknown): { fields: IntakeFields; missing: Array<keyof IntakeFields>; flags: string[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flags: string[] = [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  let flight = str(o.flight)?.replace(/\s+/g, "").toUpperCase() ?? null;
  if (flight && !/^[A-Z0-9]{2,8}$/.test(flight)) { flags.push(`flight "${flight}" does not look like a flight number`); flight = null; }
  let date = str(o.date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { flags.push(`date "${date}" is not YYYY-MM-DD`); date = null; }
  let bookingRef = str(o.bookingRef)?.toUpperCase() ?? null;
  if (bookingRef && !/^[A-Z0-9]{4,8}$/.test(bookingRef)) { flags.push(`booking reference "${bookingRef}" is not 4 to 8 letters or digits`); bookingRef = null; }
  const scheduledArrival = hhmm(o.scheduledArrival);
  const actualArrival = hhmm(o.actualArrival);
  let delayMinutes = typeof o.delayMinutes === "number" && Number.isInteger(o.delayMinutes) && o.delayMinutes >= 0 && o.delayMinutes <= 1440 ? o.delayMinutes : null;
  if (o.delayMinutes != null && delayMinutes === null) flags.push("the model's delay was not a whole number of minutes, ignored");
  if (scheduledArrival && actualArrival) {
    let d = minutes(actualArrival) - minutes(scheduledArrival);
    if (d < 0) d += 1440; // landed after midnight
    if (delayMinutes !== null && Math.abs(delayMinutes - d) > 1) flags.push(`the model said ${delayMinutes} min but ${scheduledArrival} to ${actualArrival} is ${d} min: using ${d}`);
    delayMinutes = d;
  } else if (delayMinutes !== null) {
    flags.push("delay taken from the message without both arrival times: check it");
  }
  const fields: IntakeFields = { flight, date, bookingRef, scheduledArrival, actualArrival, delayMinutes };
  const missing = (["flight", "date", "bookingRef", "delayMinutes"] as const).filter((k) => fields[k] === null);
  return { fields, missing, flags };
}

export async function extractClaim(text: string, opts: { fetch?: Fetch; apiKey?: string; today?: string } = {}): Promise<IntakeResult> {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, error: "AI intake not configured", configured: false };
  const message = String(text ?? "").trim();
  if (!message) return { ok: false, error: "Write a message first", configured: true };
  if (message.length > 1000) return { ok: false, error: "Message is too long (1000 characters max)", configured: true };
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(GROQ_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: INTAKE_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${INTAKE_PROMPT}\nTODAY: ${today}` },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, error: `AI intake unreachable: ${e instanceof Error ? e.message : String(e)}`, configured: true };
  }
  if (!res.ok) return { ok: false, error: `AI intake error: HTTP ${res.status}`, configured: true };
  let content: string;
  try {
    content = String((await res.json()).choices?.[0]?.message?.content ?? "");
  } catch {
    return { ok: false, error: "AI intake returned an unreadable response", configured: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, error: "AI intake did not return JSON. Fill in the form instead.", configured: true };
  }
  return { ok: true, ...normalise(parsed), model: INTAKE_MODEL, promptSha256: INTAKE_PROMPT_SHA256 };
}
