(() => {
  const cfg = window.LANDED;
  const $ = (id) => document.getElementById(id);
  // keccak256("PayoutPaid(bytes32,bytes32,address,uint64,uint64,bytes32)")
  const TOPIC = "0x482f2e6a53157e4aa61de51c125366ef9aceb322f584ecbbf4ce346f847f8594";
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
      receiptTx: log.transactionHash,
      block: parseInt(log.blockNumber, 16),
    };
  }

  function payCell(x) {
    if (x.chainId === cfg.standInChainId) return `<span class="pill wait" title="Written by the HSP stand-in while HSP access is pending">Stand-in, not a real payment</span>`;
    const base = cfg.settlementExplorers[x.chainId];
    return base ? `<a href="${base}${x.settlementTx}" target="_blank" rel="noopener">${short(x.settlementTx)}</a>` : short(x.settlementTx);
  }

  function setTabs() {
    for (const k of Object.keys(cfg.networks)) $("net-" + k).setAttribute("aria-selected", String(k === netKey));
    const note = $("netNote");
    note.style.display = netKey === "testnet" ? "block" : "none";
    note.textContent = "Test network. These receipts come from our end-to-end test runs. Until HashKey Settlement Platform approves the agent's server, the payment step uses a stand-in, marked on each row.";
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
    $("contract").innerHTML = `<a href="${net.explorer}/address/${net.policy}" target="_blank" rel="noopener">${net.policy}</a>`;
    rows.innerHTML = `<tr><td colspan="5" class="no">Loading…</td></tr>`;
    try {
      const logs = await rpc(net, "eth_getLogs", [{ address: net.policy, topics: [TOPIC], fromBlock: "0x" + Number(net.fromBlock || 0).toString(16), toBlock: "latest" }]);
      if (id !== loadId) return;
      const items = logs.map(decode).reverse();
      $("count").textContent = items.length;
      $("total").textContent = "$" + (items.reduce((a, x) => a + x.cents, 0) / 100).toFixed(2);
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
        return `<tr><td>${when}</td><td><b>$${(x.cents / 100).toFixed(2)}</b></td><td style="font:13px var(--mono)">${short(x.passenger)}</td><td style="font:13px var(--mono)">${payCell(x)}</td><td style="font:13px var(--mono)"><a href="${net.explorer}/tx/${x.receiptTx}" target="_blank" rel="noopener">${short(x.receiptTx)}</a></td></tr>`;
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
