(() => {
  const cfg = window.LANDED;
  const $ = (id) => document.getElementById(id);
  const api = (p) => cfg.agentUrl.replace(/\/$/, "") + p;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Display copy of the demo rule. The agent re-reads the real rule from the contract.
  const TIERS = [[120, 1000], [180, 2500], [300, 6000]];
  const owedCents = (m) => TIERS.reduce((a, [min, c]) => (m >= min ? c : a), 0);
  const usd = (c) => "$" + (c / 100).toFixed(2);
  const hm = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;

  let flights = [
    { id: "DA117", from: "LHR", to: "JFK", due: "14:10", date: "2026-12-01" },
    { id: "DA402", from: "SIN", to: "NRT", due: "21:35", date: "2026-12-01" },
    { id: "DA88", from: "DXB", to: "ICN", due: "06:50", date: "2026-12-02" },
  ];
  let flight = flights[0];
  let online = false;
  let standIn = false; // agent runs with the HSP stand-in: payment steps are simulated and labelled
  let mode = "form"; // "form" = airline form, "a2a" = the passenger's agent signs a claim
  let paxAddr = null;
  let intakeMeta = null; // { model, promptSha256 } when the AI intake filled the fields
  let replaying = null; // { stop: boolean } while a replay plays

  const randRef = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
  $("booking").value = randRef();

  function renderFlights() {
    $("flights").innerHTML = "";
    for (const f of flights) {
      const b = document.createElement("button");
      b.className = "flight";
      b.setAttribute("aria-pressed", String(f.id === flight.id));
      b.innerHTML = `<span><b>${esc(f.id)} · ${esc(f.from)} → ${esc(f.to)}</b><small>Due ${esc(f.due)} · ${esc(f.date)}</small></span><span class="pill wait">Due</span>`;
      b.onclick = () => { flight = f; renderFlights(); };
      $("flights").appendChild(b);
    }
  }

  function renderDelay() {
    const m = Number($("delay").value);
    $("delayLabel").textContent = m < 15 ? "on time" : hm(m);
    const c = owedCents(m);
    $("owed").textContent = c ? usd(c) : "nothing (under 2 h)";
  }

  function setMode(m) {
    mode = m;
    $("mode-form").setAttribute("aria-selected", String(m === "form"));
    $("mode-a2a").setAttribute("aria-selected", String(m === "a2a"));
    $("a2aIntro").hidden = m !== "a2a";
    $("walletBox").hidden = m === "a2a";
    $("land").textContent = m === "a2a" ? "Sign and send the claim" : "Land the flight";
  }

  // ---------- step log ----------
  const log = $("log");
  const clock = (at) => (at ? new Date(at) : new Date()).toLocaleTimeString();
  function addLine(text, cls = "now", detail = "", at, extraHtml = "") {
    log.querySelectorAll("li.now").forEach((li) => (li.className = "done"));
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = `<span class="dot"></span><span>${text}${detail ? `<br><code>${detail}</code>` : ""}${extraHtml}</span><span class="note" style="margin:0">${clock(at)}</span>`;
    log.appendChild(li);
    return li;
  }
  const short = (h) => (h ? String(h).slice(0, 10) + "…" + String(h).slice(-6) : "");
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const txLink = (chainId, h) => {
    if (Number(chainId) === cfg.standInChainId) return `<span class="pill warn">Stand-in, not a real payment</span>`;
    const base = cfg.settlementExplorers[Number(chainId)];
    return base ? link(base + h, short(h)) : esc(short(h));
  };
  const receiptLink = (h) => link(`${cfg.receipts.explorer}/tx/${h}`, short(h));
  const NET_NAME = { 11155111: "Ethereum Sepolia", 84532: "Base Sepolia" };

  function claimJson(c, sig) {
    const view = { ...c, bookingKey: short(c.bookingKey), nonce: String(c.nonce).length > 12 ? String(c.nonce).slice(0, 10) + "…" : c.nonce, signature: short(sig) };
    return `<pre class="claim-json">${esc(JSON.stringify(view, null, 1))}</pre>`;
  }

  const STEP_TEXT = {
    checked: (s) => `Rule checked: ${hm(s.delayMinutes)} late pays $${esc(s.amountUsd)}`,
    reserved: (s) => [s.viaClaim ? `Booking locked on ${cfg.receipts.label} with the signed claim (<code>reserveWithClaim</code>)` : `Booking locked on ${cfg.receipts.label}`, receiptLink(s.tx)],
    order: (s) => [`HSP order created`, `flow ${esc(s.flowId)}`],
    prepared: (s) => [`HSP quote locked`, `${esc(s.tokenTotalRaw)} raw units`],
    signed: () => `Payment authorisation signed by the airline's agent`,
    submitted: () => `Submitted to HSP's gateway`,
    status: (s) => `HSP status: ${esc(String(s.status).replace("payment-", ""))}`,
    settled: (s) => [`Receipt written on ${cfg.receipts.label}`, receiptLink(s.tx)],
    released: (s) => [`Booking released`, esc(s.reason)],
  };
  const HSP_STEPS = new Set(["order", "prepared", "signed", "submitted", "status"]);

  function approvalCard(a, live) {
    const net = a.chainId ? ` on ${esc(NET_NAME[a.chainId] || a.network || a.chainId)}` : "";
    return `<div class="approve">
      <h3>${a.stage === "sign" ? "Approve this payout?" : "Send the signed payment?"}</h3>
      <dl><dt>Pay to</dt><dd>${esc(a.payTo)}</dd><dt>From</dt><dd>${esc(a.payer)}</dd><dt>Amount</dt><dd>$${esc(a.amountUsd)} (${esc(a.tokenTotalRaw)} raw units${net})</dd></dl>
      ${live ? `<div class="cta"><button class="btn" id="yes">${a.stage === "sign" ? "Approve and sign" : "Send payment"}</button><button class="btn ghost" id="no">Decline</button></div>` : `<p class="note" style="margin-top:0"><span class="pill">Replay</span> A person at the airline approved this in the real run.</p>`}
      <p class="note">HSP requires a person to confirm before signing and before sending.</p></div>`;
  }

  function showApproval(id, a) {
    const box = $("approval");
    box.innerHTML = approvalCard(a, true);
    const answer = async (ok) => {
      box.innerHTML = "";
      await fetch(api(`/api/claims/${id}/approve`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: a.stage, ok }) });
    };
    $("yes").onclick = () => answer(true);
    $("no").onclick = () => answer(false);
  }

  function showResult(r, replay) {
    const el = $("result");
    el.style.display = "block";
    if (r.ok) {
      el.innerHTML = `<div class="eyebrow">${replay ? "Paid · replay of a real payment" : "Paid"}</div><div class="paid" style="margin-top:8px">$${esc(r.amountUsd)}</div>
        <p>HSP payment ${txLink(r.chainId, r.settlementTx)} · receipt on ${cfg.receipts.label} ${receiptLink(r.receiptTx)}</p>
        ${r.flowId ? `<p class="note">HSP flow <code>${esc(r.flowId)}</code></p>` : ""}
        <p class="note">${replay ? `Both links open the real transactions. <a href="proof.html">See every payout</a>.` : `Try again with the same booking: the contract refuses a second payout.`}</p>`;
    } else {
      el.innerHTML = `<div class="eyebrow">${r.pending ? "Pending" : "Not paid"}</div><p>${esc(r.reason)}</p>`;
    }
  }

  /** One event from the airline agent, live (SSE) or from a recorded run. */
  function handleEvent(s, ctx) {
    if (s.step === "start") return;
    if (ctx.replay && s.step !== "approval") $("approval").innerHTML = "";
    if (s.step === "approval") {
      if (ctx.replay) $("approval").innerHTML = approvalCard(s.approval, false);
      else showApproval(ctx.id, s.approval);
      return;
    }
    if (s.step === "approved") {
      $("approval").innerHTML = "";
      return addLine(s.ok ? (s.stage === "sign" ? "Approved by a person at the airline: sign" : "Approved by a person at the airline: send") : `Declined at "${esc(s.stage)}"`, s.ok ? "done" : "fail", "", s.at);
    }
    if (s.step === "claim") {
      addLine(`Airline agent received the passenger agent's signed claim`, "done", "", s.at, claimJson(s.claim, s.signature));
      return addLine(`Signature verified: payTo = signer <span class="pill">${esc(short(s.signer))}</span>`, "done", "", s.at);
    }
    if (s.step === "done") {
      log.querySelectorAll("li.now").forEach((li) => (li.className = s.result.ok ? "done" : "fail"));
      $("approval").innerHTML = "";
      return showResult(s.result, ctx.replay);
    }
    const t = STEP_TEXT[s.step]?.(s);
    if (!t) return;
    let [text, detail] = Array.isArray(t) ? t : [t, ""];
    if (standIn && !ctx.replay && HSP_STEPS.has(s.step)) text += ' <span class="pill warn">stand-in</span>';
    addLine(text, s.step === "released" ? "fail" : "now", detail, s.at);
  }

  function follow(id) {
    const es = new EventSource(api(`/api/claims/${id}/events`));
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data);
      handleEvent(s, { id });
      if (s.step === "done") { es.close(); $("land").disabled = false; }
    };
    es.onerror = () => { es.close(); $("land").disabled = false; addLine("Lost connection to the agent", "fail"); };
  }

  async function post(path, body) {
    const res = await fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    return j;
  }

  async function land() {
    const m = Number($("delay").value);
    log.innerHTML = "";
    $("result").style.display = "none";
    $("approval").innerHTML = "";
    addLine(`${esc(flight.id)} landed ${m < 15 ? "on time" : hm(m) + " late"}`, "done");
    $("land").disabled = true;
    try {
      if (mode === "a2a") {
        const signed = await post("/api/passenger/sign", { flight: flight.id, date: flight.date, delayMinutes: m, bookingRef: $("booking").value });
        addLine(`Passenger agent signed a claim (EIP-712) with its wallet <span class="pill">${esc(short(signed.signer))}</span>`, "done", "the booking reference stays with the passenger: only its hash is signed");
        const body = await post("/api/a2a/claims", { claim: signed.claim, signature: signed.signature, intake: intakeMeta });
        follow(body.id);
      } else {
        const body = await post("/api/claims", { flight: flight.id, date: flight.date, delayMinutes: m, bookingRef: $("booking").value, passenger: $("wallet").value.trim() });
        follow(body.id);
      }
    } catch (e) {
      addLine(`Not paid: ${esc(e.message)}`, "fail");
      $("land").disabled = false;
    }
  }

  // ---------- AI intake (free text -> fields a person confirms; never money) ----------
  async function readStory() {
    const out = $("intakeOut");
    intakeMeta = null;
    if (!online) { out.innerHTML = `<p class="note">The agent is offline, so the AI intake is too. Fill in the form below.</p>`; return; }
    out.innerHTML = `<p class="note">Reading…</p>`;
    try {
      const res = await fetch(api("/api/intake"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: $("story").value }) });
      const r = await res.json();
      if (!r.ok) { out.innerHTML = `<p class="note">${esc(r.error)}${r.configured === false ? ". Fill in the form below." : ""}</p>`; return; }
      const f = r.fields;
      const match = flights.find((x) => x.id === f.flight && x.date === f.date);
      if (match) { flight = match; renderFlights(); }
      if (f.delayMinutes !== null) { $("delay").value = Math.min(f.delayMinutes, 420); renderDelay(); }
      if (f.bookingRef) $("booking").value = f.bookingRef;
      intakeMeta = { model: r.model, promptSha256: r.promptSha256 };
      const notes = [...r.flags, ...r.missing.map((k) => `missing: ${k}, fill it in below`)];
      if (f.flight && !match) notes.push(`${f.flight} on ${f.date ?? "?"} is not one of the demo flights: pick one below`);
      out.innerHTML = `<div class="intake"><div class="eyebrow">AI read this. Check it before signing.</div>
        <dl><dt>Flight</dt><dd>${esc(f.flight ?? "–")}</dd><dt>Date</dt><dd>${esc(f.date ?? "–")}</dd><dt>Booking</dt><dd>${esc(f.bookingRef ?? "–")}</dd><dt>Delay</dt><dd>${f.delayMinutes === null ? "–" : esc(hm(f.delayMinutes))}${f.scheduledArrival && f.actualArrival ? ` (${esc(f.scheduledArrival)} → ${esc(f.actualArrival)})` : ""}</dd></dl>
        ${notes.map((n) => `<p class="note" style="margin-top:4px">⚠ ${esc(n)}</p>`).join("")}
        <p class="note" style="margin-top:6px">The AI never sets the amount: the contract's published rule does. Model ${esc(r.model)}, prompt sha256 ${esc(String(r.promptSha256).slice(0, 12))}…</p></div>`;
    } catch (e) {
      out.innerHTML = `<p class="note">AI intake failed: ${esc(e.message)}. Fill in the form below.</p>`;
    }
  }

  // ---------- replay of a recorded real run ----------
  let replayData = null;
  async function loadReplays() {
    try {
      replayData = await fetch("replay.json", { cache: "no-cache" }).then((r) => r.json());
    } catch { replayData = null; }
    const bar = $("replayBar");
    if (!replayData?.runs?.length) return;
    bar.hidden = false;
    bar.innerHTML = replayData.runs.map((r, i) => `<button class="btn ${i === 0 && !online ? "" : "ghost"} small" data-run="${i}">${esc(r.button)}</button>`).join("");
    bar.querySelectorAll("button[data-run]").forEach((b) => (b.onclick = () => play(replayData.runs[Number(b.dataset.run)])));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function play(run) {
    if (replaying) replaying.stop = true;
    const me = (replaying = { stop: false });
    const prevStatus = { cls: $("status").className, text: $("status").textContent };
    $("status").className = "banner replay";
    $("status").innerHTML = esc(run.banner);
    $("land").disabled = true;
    log.innerHTML = "";
    $("result").style.display = "none";
    $("approval").innerHTML = "";
    setMode(run.mode === "a2a" ? "a2a" : "form");
    flight = flights.find((f) => f.id === run.form.flight) ?? flight;
    renderFlights();
    $("delay").value = run.form.delayMinutes;
    renderDelay();
    $("booking").value = run.form.bookingRef;
    if (run.form.wallet) $("wallet").value = run.form.wallet;
    if (run.mode === "a2a") $("paxAddr").textContent = run.form.passengerAgent;
    $("intakeOut").innerHTML = "";
    // On narrow screens the form sits above the log: jump to the agent's log so the replay is visible.
    (innerWidth < 900 ? $("log").closest(".card") : document.querySelector(".app")).scrollIntoView({ behavior: "smooth", block: "start" });

    addLine(`${esc(run.form.flight)} landed ${hm(run.form.delayMinutes)} late`, "done", "", run.events[0]?.at);
    if (run.mode === "a2a" && run.signedAt) addLine(`Passenger agent signed a claim (EIP-712) with its wallet <span class="pill">${esc(short(run.form.passengerAgent))}</span>`, "done", "the booking reference stays with the passenger: only its hash is signed", run.signedAt);
    let prev = null;
    for (const e of run.events) {
      if (me.stop) return;
      // Real gaps, squeezed so the whole run plays in under a minute; HSP's 15 s polls go quickly.
      const gap = prev ? (new Date(e.at) - new Date(prev.at)) / 1000 : 0;
      const wait = e.step === "status" && prev?.step === "status" ? 450 : Math.min(2200, 500 + gap * 120);
      await sleep(e.step === "approval" ? 600 : wait);
      if (me.stop) return;
      handleEvent(e, { replay: true });
      if (e.step === "approval") await sleep(2600);
      prev = e;
    }
    replaying = null;
    $("land").disabled = !online;
    if (online) { $("status").className = prevStatus.cls; $("status").textContent = prevStatus.text; }
  }

  async function init() {
    renderFlights();
    renderDelay();
    setMode("form");
    $("delay").oninput = renderDelay;
    $("land").onclick = land;
    $("mode-form").onclick = () => setMode("form");
    $("mode-a2a").onclick = () => setMode("a2a");
    $("readStory").onclick = readStory;
    if (!cfg.agentUrl) { offline(); return loadReplays(); }
    try {
      const h = await fetch(api("/api/health"), { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      if (h.flights?.length) { flights = h.flights; flight = flights[0]; renderFlights(); }
      if (h.demoWallet) $("wallet").value = h.demoWallet;
      paxAddr = h.passengerAgent;
      $("paxAddr").textContent = paxAddr || "not configured";
      $("mode-a2a").disabled = !paxAddr;
      online = !!h.hsp;
      standIn = h.mode === "standin";
      $("status").className = "banner" + (online && !standIn ? "" : " warn");
      $("status").textContent = standIn
        ? `Stand-in mode: HSP access for our server is pending, so the payment steps are simulated and marked "stand-in". The booking lock and the receipt are real ${cfg.receipts.label} transactions.`
        : online
        ? "Airline agent online. Payments run on HSP's test network; receipts go to HSK Chain."
        : `Agent reachable, but HSP is not answering yet (${h.hspDetail || "unknown"}).`;
      $("land").disabled = !online;
    } catch {
      offline();
    }
    loadReplays();
  }
  function offline() {
    $("status").className = "banner warn";
    $("status").textContent = "The live airline agent runs on one allowlisted laptop and is offline right now. You can still watch a replay of a real HSP payment, step by step, with live links.";
    $("land").disabled = true;
    $("paxAddr").textContent = "offline";
  }
  init();
})();
