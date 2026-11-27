(() => {
  const cfg = window.LANDED;
  const $ = (id) => document.getElementById(id);
  // keccak256("PayoutPaid(bytes32,bytes32,address,uint64,uint64,bytes32)")
  const TOPIC = "0x482f2e6a53157e4aa61de51c125366ef9aceb322f584ecbbf4ce346f847f8594";
  // keccak256("ClaimAccepted(bytes32,address,uint256,bytes32)"): v2 payouts that came from a passenger agent's signed claim
  const CLAIM_TOPIC = "0xb5cee84e2eb226b607d4f75593e2e545c7eb5b62edf1ee1e28fd1e36d3de374f";
  const short = (h) => h.slice(0, 8) + "…" + h.slice(-6);
  const rows = $("rows");
  const fromUrl = new URLSearchParams(location.search).get("net");
  let netKey = cfg.networks[fromUrl] ? fromUrl : cfg.networks.mainnet.policy ? "mainnet" : "testnet";
  let loadId = 0;

  async function rpc(net, method, params) {
    const r = await fetch(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  // data = passenger (32) | amountCents (32) | settlementChainId (32) | settlementTx (32)
  function decode(log) {
    const d = log.data.slice(2);
    const word = (i) => d.slice(i * 64, i * 64 + 64);
    return {
      passenger: "0x" + word(0).slice(24),
      cents: Number(BigInt("0x" + word(1))),
      chainId: Number(BigInt("0x" + word(2))),
      settlementTx: "0x" + word(3),
      bookingKey: log.topics[1],
      receiptTx: log.transactionHash,
      block: parseInt(log.blockNumber, 16),
    };
  }

  function payCell(x) {
    if (x.chainId === cfg.standInChainId) return `<span class="pill wait" title="Written by the HSP stand-in while HSP access is pending">Stand-in, not a real payment</span>`;
    const base = cfg.settlementExplorers[x.chainId];
    const link = base ? `<a href="${base}${x.settlementTx}" target="_blank" rel="noopener">${short(x.settlementTx)}</a>` : short(x.settlementTx);
    return `${link} <span class="pill ok" title="Paid through HashKey Settlement Platform (QA gateway, test funds)">HSP</span>`;
  }

  function setTabs() {
    for (const k of Object.keys(cfg.networks)) $("net-" + k).setAttribute("aria-selected", String(k === netKey));
    const note = $("netNote");
    note.style.display = netKey === "testnet" ? "block" : "none";
    note.textContent = "Test network. Payouts from both contract versions are listed (v1, and v2 which adds agent-to-agent claims, marked A2A). Rows marked HSP were paid through HashKey Settlement Platform's QA gateway with test USDC; the payment link opens the transfer on its network. Older rows from before HSP access was granted used a stand-in and are marked.";
  }

  async function load() {
    const id = ++loadId;
    const net = cfg.networks[netKey];
    setTabs();
    $("count").textContent = "–";
    $("total").textContent = "–";
    if (!net.policy) {
      $("contract").textContent = `Deploys to ${net.label} before submission.`;
      rows.innerHTML = `<tr><td colspan="5" class="no">No contract yet. Payouts will appear here as soon as it is live.</td></tr>`;
      return;
    }
    const contracts = [{ policy: net.policy, fromBlock: net.fromBlock, version: net.version || "" }, ...(net.older || [])];
    $("contract").innerHTML = contracts
      .map((c) => `${c.version ? `<span class="tag">${c.version}</span>` : ""}<a href="${net.explorer}/address/${c.policy}" target="_blank" rel="noopener">${c.policy}</a>`)
      .join("<br>");
    rows.innerHTML = `<tr><td colspan="5" class="no">Loading…</td></tr>`;
    try {
      // The public RPC caps eth_getLogs at about 5,000 blocks per query, so read the range in windows, a few at a time.
      const head = parseInt(await rpc(net, "eth_blockNumber", []), 16);
      const STEP = 4_999;
      const hex = (n) => "0x" + n.toString(16);
      const windows = [];
      for (const c of contracts)
        for (let from = Number(c.fromBlock || 0); from <= head; from += STEP + 1) windows.push({ c, f: from, t: Math.min(from + STEP, head) });
      const getWindow = async ({ c, f, t }, tries = 3) => {
        // v2 windows also fetch ClaimAccepted, to mark payouts that came from a passenger agent (A2A).
        const topics = c.version === "v1" ? [TOPIC] : [[TOPIC, CLAIM_TOPIC]];
        try { return (await rpc(net, "eth_getLogs", [{ address: c.policy, topics, fromBlock: hex(f), toBlock: hex(t) }])).map((l) => ({ ...l, version: c.version })); }
        catch (e) { if (tries <= 1) throw e; await new Promise((r) => setTimeout(r, 400)); return getWindow({ c, f, t }, tries - 1); }
      };
      const found = new Array(windows.length);
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => { while (next < windows.length) { const i = next++; found[i] = await getWindow(windows[i]); } }));
      const all = found.flat();
      if (id !== loadId) return;
      const a2a = new Set(all.filter((l) => l.topics[0] === CLAIM_TOPIC).map((l) => l.topics[1]));
      const items = all
        .filter((l) => l.topics[0] === TOPIC)
        .map((l) => ({ ...decode(l), version: l.version, a2a: l.version !== "v1" && a2a.has(l.topics[1]) }))
        .sort((x, y) => y.block - x.block);
      // Totals count real payouts only; stand-in rows stay listed but moved no money.
      const real = items.filter((x) => x.chainId !== cfg.standInChainId);
      $("count").textContent = real.length;
      $("total").textContent = "$" + (real.reduce((a, x) => a + x.cents, 0) / 100).toFixed(2);
      if (!items.length) {
        rows.innerHTML = `<tr><td colspan="5" class="no">No payouts yet.</td></tr>`;
        return;
      }
      const times = {};
      await Promise.all([...new Set(items.map((x) => x.block))].slice(0, 50).map(async (b) => {
        const blk = await rpc(net, "eth_getBlockByNumber", ["0x" + b.toString(16), false]);
        times[b] = new Date(parseInt(blk.timestamp, 16) * 1000);
      }));
      if (id !== loadId) return;
      rows.innerHTML = items.map((x) => {
        const when = times[x.block] ? times[x.block].toLocaleString() : `block ${x.block}`;
        const tags = `${x.version ? `<br><span class="tag">${x.version}</span>` : ""}${x.a2a ? `<span class="pill" title="Claim signed by the passenger's own agent (EIP-712); the contract paid only that signer">A2A</span>` : ""}`;
        return `<tr><td>${when}${tags}</td><td><b>$${(x.cents / 100).toFixed(2)}</b></td><td style="font:13px var(--mono)">${short(x.passenger)}</td><td style="font:13px var(--mono)">${payCell(x)}</td><td style="font:13px var(--mono)"><a href="${net.explorer}/tx/${x.receiptTx}" target="_blank" rel="noopener">${short(x.receiptTx)}</a></td></tr>`;
      }).join("");
    } catch (e) {
      if (id === loadId) rows.innerHTML = `<tr><td colspan="5" class="no">Could not read ${net.label}: ${e.message}</td></tr>`;
    }
  }

  for (const k of Object.keys(cfg.networks)) {
    $("net-" + k).onclick = () => {
      netKey = k;
      history.replaceState(null, "", "?net=" + k);
      load();
    };
  }
  load();
})();
