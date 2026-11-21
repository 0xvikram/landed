(() => {
  const cfg = window.LANDED;
  const $ = (id) => document.getElementById(id);
  // keccak256("PayoutPaid(bytes32,bytes32,address,uint64,uint64,bytes32)")
  const TOPIC = "0x482f2e6a53157e4aa61de51c125366ef9aceb322f584ecbbf4ce346f847f8594";
  const short = (h) => h.slice(0, 8) + "…" + h.slice(-6);
  const rows = $("rows");

  async function rpc(method, params) {
    const r = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
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

  async function load() {
    if (!cfg.policy) {
      $("contract").textContent = "Deploys to HSK Chain mainnet before submission.";
      rows.innerHTML = `<tr><td colspan="5" class="no">No contract yet. Payouts will appear here as soon as it is live.</td></tr>`;
      return;
    }
    $("contract").innerHTML = `<a href="${cfg.explorer}/address/${cfg.policy}" target="_blank" rel="noopener">${cfg.policy}</a>`;
    try {
      const logs = await rpc("eth_getLogs", [{ address: cfg.policy, topics: [TOPIC], fromBlock: "0x" + Number(cfg.fromBlock || 0).toString(16), toBlock: "latest" }]);
      const items = logs.map(decode).reverse();
      $("count").textContent = items.length;
      $("total").textContent = "$" + (items.reduce((a, x) => a + x.cents, 0) / 100).toFixed(2);
      if (!items.length) {
        rows.innerHTML = `<tr><td colspan="5" class="no">No payouts yet.</td></tr>`;
        return;
      }
      const times = {};
      await Promise.all([...new Set(items.map((x) => x.block))].slice(0, 50).map(async (b) => {
        const blk = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
        times[b] = new Date(parseInt(blk.timestamp, 16) * 1000);
      }));
      rows.innerHTML = items.map((x) => {
        const base = cfg.settlementExplorers[x.chainId];
        const pay = base ? `<a href="${base}${x.settlementTx}" target="_blank" rel="noopener">${short(x.settlementTx)}</a>` : short(x.settlementTx);
        const when = times[x.block] ? times[x.block].toLocaleString() : `block ${x.block}`;
        return `<tr><td>${when}</td><td><b>$${(x.cents / 100).toFixed(2)}</b></td><td style="font:13px var(--mono)">${short(x.passenger)}</td><td style="font:13px var(--mono)">${pay}</td><td style="font:13px var(--mono)"><a href="${cfg.explorer}/tx/${x.receiptTx}" target="_blank" rel="noopener">${short(x.receiptTx)}</a></td></tr>`;
      }).join("");
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="5" class="no">Could not read HSK Chain: ${e.message}</td></tr>`;
    }
  }
  load();
})();
