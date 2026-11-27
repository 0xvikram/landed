// AI intake with a mocked LLM. The model only fills fields; the contract sets the amount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClaim, INTAKE_PROMPT_SHA256 } from "./intake.js";

const MSG = "My BA117 from London on 1 Dec landed at 16:24 instead of 14:10, booking XK4P2Q";
const mock = (content: string, status = 200) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
const opts = (content: string, status?: number) => ({ apiKey: "test", today: "2026-11-27", fetch: mock(content, status) });

test("without a key the intake says it is not configured (no fake AI)", async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const r = await extractClaim(MSG);
    assert.deepEqual(r, { ok: false, error: "AI intake not configured", configured: false });
  } finally {
    if (saved) process.env.GROQ_API_KEY = saved;
  }
});

test("valid JSON: fields extracted, delay checked against the times, prompt hash recorded", async () => {
  const r = await extractClaim(MSG, opts(JSON.stringify({ flight: "ba 117", date: "2026-12-01", bookingRef: "xk4p2q", scheduledArrival: "14:10", actualArrival: "16:24", delayMinutes: 134 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.fields, { flight: "BA117", date: "2026-12-01", bookingRef: "XK4P2Q", scheduledArrival: "14:10", actualArrival: "16:24", delayMinutes: 134 });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.flags, []);
  assert.equal(r.promptSha256, INTAKE_PROMPT_SHA256);
  assert.match(r.promptSha256, /^[0-9a-f]{64}$/);
  assert.ok(!("amount" in r.fields));
});

test("a missing field is reported, not invented", async () => {
  const r = await extractClaim("BA117 on 1 Dec was 2 hours late", opts(JSON.stringify({ flight: "BA117", date: "2026-12-01", bookingRef: null, scheduledArrival: null, actualArrival: null, delayMinutes: 120 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.missing, ["bookingRef"]);
  assert.ok(r.flags.some((f) => /check it/.test(f)));
});

test("non-JSON output is an error that sends the person back to the form", async () => {
  const r = await extractClaim(MSG, opts("Sure! The flight is BA117."));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /did not return JSON/);
  const r2 = await extractClaim(MSG, opts("{}", 500));
  assert.equal(r2.ok, false);
});

test("a delay the model made up is recomputed from the arrival times and flagged", async () => {
  const r = await extractClaim(MSG, opts(JSON.stringify({ flight: "BA117", date: "2026-12-01", bookingRef: "XK4P2Q", scheduledArrival: "14:10", actualArrival: "16:24", delayMinutes: 320 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.delayMinutes, 134);
  assert.ok(r.flags.some((f) => /320 min but 14:10 to 16:24 is 134 min/.test(f)));
});

test("past midnight landings and junk fields are handled", async () => {
  const r = await extractClaim(MSG, opts(JSON.stringify({ flight: "BA117", date: "1 Dec", bookingRef: "XK-4P2Q!!", scheduledArrival: "23:30", actualArrival: "01:45", delayMinutes: "lots", amount: 600 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.delayMinutes, 135);
  assert.equal(r.fields.date, null);
  assert.equal(r.fields.bookingRef, null);
  assert.deepEqual(r.missing, ["date", "bookingRef"]);
  assert.ok(!("amount" in r.fields));
});
