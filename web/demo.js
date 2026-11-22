(() => {
  const cfg = window.LANDED;
  const $ = (id) => document.getElementById(id);
  const api = (p) => cfg.agentUrl.replace(/\/$/, "") + p;

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

  const randRef = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
  $("booking").value = randRef();

  function renderFlights() {
    $("flights").innerHTML = "";
    for (const f of flights) {
      const b = document.createElement("button");
      b.className = "flight";
      b.setAttribute("aria-pressed", String(f.id === flight.id));
      b.innerHTML = `<span><b>${f.id} · ${f.from} → ${f.to}</b><small>Due ${f.due} · ${f.date}</small></span><span class="pill wait">Due</span>`;
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

  const log = $("log");
  function addLine(text, cls = "now", detail = "") {
    log.querySelectorAll("li.now").forEach((li) => (li.className = "done"));
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = `<span class="dot"></span><span>${text}${detail ? `<br><code>${detail}</code>` : ""}</span><span class="note" style="margin:0">${new Date().toLocaleTimeString()}</span>`;
    log.appendChild(li);
    return li;
  }
  const short = (h) => (h ? h.slice(0, 10) + "…" + h.slice(-6) : "");
  const txLink = (chainId, h) => {
    const base = cfg.settlementExplorers[Number(chainId)];
    return base ? `<a href="${base}${h}" target="_blank" rel="noopener">${short(h)}</a>` : short(h);
  };

  const STEP_TEXT = {
    checked: (s) => `Rule checked: ${hm(s.delayMinutes)} late pays $${s.amountUsd}`,
    reserved: (s) => [`Booking locked on HSK Chain`, short(s.tx)],
    order: (s) => [`HSP order created`, `flow ${s.flowId}`],
    prepared: (s) => [`HSP quote locked`, `${s.tokenTotalRaw} raw units`],
    signed: () => `Payment authorisation signed by the airline's agent`,
    submitted: () => `Submitted to HSP's gateway`,
    status: (s) => `HSP status: ${s.status.replace("payment-", "")}`,
    settled: (s) => [`Receipt written on HSK Chain`, short(s.tx)],
    released: (s) => [`Booking released`, s.reason],
  };

  function showApproval(id, a) {
    const box = $("approval");
    box.innerHTML = `<div class="approve">
      <h3>${a.stage === "sign" ? "Approve this payout?" : "Send the signed payment?"}</h3>
      <dl><dt>Pay to</dt><dd>${a.payTo}</dd><dt>From</dt><dd>${a.payer}</dd><dt>Amount</dt><dd>$${a.amountUsd} (${a.tokenTotalRaw} raw units)</dd></dl>
      <div class="cta"><button class="btn" id="yes">${a.stage === "sign" ? "Approve and sign" : "Send payment"}</button><button class="btn ghost" id="no">Decline</button></div>
      <p class="note">HSP requires a person to confirm before signing and before sending.</p></div>`;
    const answer = async (ok) => {
      box.innerHTML = "";
      await fetch(api(`/api/claims/${id}/approve`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: a.stage, ok }) });
    };
    $("yes").onclick = () => answer(true);
    $("no").onclick = () => answer(false);
  }

  function showResult(r) {
    const el = $("result");
    el.style.display = "block";
    if (r.ok) {
      el.innerHTML = `<div class="eyebrow">Paid</div><div class="paid" style="margin-top:8px">$${r.amountUsd}</div>
        <p>HSP payment ${txLink(r.chainId, r.settlementTx)} · receipt on ${cfg.receipts.label} <a href="${cfg.receipts.explorer}/tx/${r.receiptTx}" target="_blank" rel="noopener">${short(r.receiptTx)}</a></p>
        <p class="note">Try "Land the flight" again with the same booking: the contract refuses a second payout.</p>`;
    } else {
      el.innerHTML = `<div class="eyebrow">${r.pending ? "Pending" : "Not paid"}</div><p>${r.reason}</p>`;
    }
  }

  async function land() {
    const m = Number($("delay").value);
    log.innerHTML = "";
    $("result").style.display = "none";
    addLine(`${flight.id} landed ${m < 15 ? "on time" : hm(m) + " late"}`, "done");
    $("land").disabled = true;
    try {
      const res = await fetch(api("/api/claims"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flight: flight.id, date: flight.date, delayMinutes: m, bookingRef: $("booking").value, passenger: $("wallet").value.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      const es = new EventSource(api(`/api/claims/${body.id}/events`));
      es.onmessage = (ev) => {
        const s = JSON.parse(ev.data);
        if (s.step === "approval") return showApproval(body.id, s.approval);
        if (s.step === "done") {
          es.close();
          log.querySelectorAll("li.now").forEach((li) => (li.className = s.result.ok ? "done" : "fail"));
          $("land").disabled = false;
          return showResult(s.result);
        }
        const t = STEP_TEXT[s.step]?.(s);
        if (!t) return;
        const [text, detail] = Array.isArray(t) ? t : [t, ""];
        addLine(text, s.step === "released" ? "fail" : "now", detail);
      };
      es.onerror = () => { es.close(); $("land").disabled = false; addLine("Lost connection to the agent", "fail"); };
    } catch (e) {
      addLine(`Not paid: ${e.message}`, "fail");
      $("land").disabled = false;
    }
  }

  async function init() {
    renderFlights();
    renderDelay();
    $("delay").oninput = renderDelay;
    $("land").onclick = land;
    if (!cfg.agentUrl) return offline("The live airline agent is not connected yet: HashKey Settlement Platform is approving its server for the hackathon environment. Everything else on this page is ready.");
    try {
      const h = await fetch(api("/api/health"), { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      if (h.flights?.length) { flights = h.flights; flight = flights[0]; renderFlights(); }
      if (h.demoWallet) $("wallet").value = h.demoWallet;
      online = !!h.hsp;
      $("status").className = "banner" + (online ? "" : " warn");
      $("status").textContent = online
        ? "Airline agent online. Payments run on HSP's test network; receipts go to HSK Chain."
        : `Agent reachable, but HSP is not answering yet (${h.hspDetail || "unknown"}).`;
      $("land").disabled = !online;
    } catch {
      offline("The airline agent is offline right now. Try again later, or watch the demo video.");
    }
  }
  function offline(msg) {
    $("status").className = "banner warn";
    $("status").textContent = msg;
    $("land").disabled = true;
  }
  init();
})();
