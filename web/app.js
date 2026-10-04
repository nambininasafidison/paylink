/* PayLink web app: create, share and pay USDC links on Arc. */
(function () {
  "use strict";
  const { ethers } = window;
  const CFG = Object.assign({}, window.PAYLINK_CONFIG);
  // A contract deployed from deploy.html is remembered in this browser until config.js is updated.
  if (!CFG.address) {
    try {
      const a = localStorage.getItem("paylink.address." + CFG.chainId);
      if (a && ethers.isAddress(a)) CFG.address = a;
    } catch (e) { /* storage unavailable */ }
  }
  const ABI = window.PAYLINK_ABI;
  // Arc native USDC has 18 decimals; we show and accept 6 (like the ERC-20 interface).
  const toNative = (s) => ethers.parseUnits(s, 6) * 10n ** 12n;
  const fmt = (v) => {
    const s = ethers.formatUnits(v / 10n ** 12n, 6);
    return s.replace(/\.?0+$/, "") || "0";
  };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  const readProvider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true });
  const reader = CFG.address ? new ethers.Contract(CFG.address, ABI, readProvider) : null;
  let signer = null, account = null;
  let tab = new URLSearchParams(location.search).get("id") ? "pay" : "create";

  const $ = (s) => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v != null && v !== false) el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  function status(el, msg, kind) { el.className = "status " + (kind || ""); el.textContent = msg; }
  function errMsg(e) {
    if (e && e.revert && e.revert.name) return e.revert.name;
    return (e && (e.shortMessage || e.reason || e.message)) || String(e);
  }

  async function connect() {
    if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or Rabby.");
    const hexId = "0x" + CFG.chainId.toString(16);
    await window.ethereum.request({ method: "eth_requestAccounts" });
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: hexId, chainName: CFG.network === "mainnet" ? "Arc" : "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer],
      }] });
    }
    const bp = new ethers.BrowserProvider(window.ethereum);
    signer = await bp.getSigner();
    account = await signer.getAddress();
    $("#connect").textContent = short(account);
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
  }
  const writer = () => new ethers.Contract(CFG.address, ABI, signer);

  function renderTabs() {
    $("#tabs").replaceChildren(...[["create", "Create link"], ["pay", "Pay a link"], ["mine", "My links"]].map(([k, label]) =>
      h("button", { class: tab === k ? "active" : "", onclick: () => { tab = k; render(); } }, label)));
  }

  function render() {
    renderTabs();
    $("#contract").replaceChildren(CFG.address
      ? h("a", { href: CFG.explorer + "/address/" + CFG.address, target: "_blank", rel: "noopener" }, h("code", {}, CFG.address))
      : "not deployed yet");
    $("#banner").replaceChildren(!CFG.address ? h("div", { class: "banner" }, h("span", {}, "No contract configured yet. ", h("a", { href: "deploy.html" }, "Deploy PayLink from your wallet"), " (or run npm run deploy).")) : "");
    const main = $("#main");
    if (tab === "pay") main.replaceChildren(renderPay());
    else if (tab === "mine") main.replaceChildren(renderMine());
    else main.replaceChildren(renderCreate());
  }

  // QR code of the payment link, so a customer can pay from their phone.
  function qr(text) {
    if (!window.qrcode) return null;
    const q = window.qrcode(0, "M");
    q.addData(text);
    q.make();
    const holder = h("div", { class: "qr", role: "img", "aria-label": "QR code for " + text });
    holder.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    return holder;
  }

  function shareUrl(id) {
    const u = new URL(location.href);
    u.search = "?id=" + id;
    u.hash = "";
    return u.toString();
  }

  function renderCreate() {
    const amount = h("input", { id: "amt", inputmode: "decimal", placeholder: "25.00 (leave empty = payer chooses)" });
    const memo = h("input", { id: "memo", maxlength: "280", placeholder: "Logo design — invoice #12" });
    const days = h("input", { id: "days", type: "number", min: "0", placeholder: "0 = never" });
    const st = h("div", { class: "status" });
    const out = h("div");
    const btn = h("button", { onclick: async () => {
      try {
        if (!CFG.address) throw new Error("Contract not deployed yet");
        if (!signer) await connect();
        const a = amount.value.trim();
        const value = a ? toNative(a) : 0n;
        if (a && value <= 0n) throw new Error("Amount must be positive");
        const d = parseInt(days.value || "0", 10);
        const expires = d > 0 ? Math.floor(Date.now() / 1000) + d * 86400 : 0;
        btn.disabled = true;
        status(st, "Confirm in your wallet…");
        const tx = await writer().create(value, expires, memo.value.trim());
        status(st, "Sending… " + tx.hash);
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return writer().interface.parseLog(l); } catch (e) { return null; } })
          .find((x) => x && x.name === "LinkCreated");
        const url = shareUrl(ev.args.id.toString());
        status(st, "Link #" + ev.args.id + " created ✓", "ok");
        const field = h("input", { value: url, readonly: true });
        out.replaceChildren(h("div", { class: "share" }, field,
          h("button", { class: "ghost", onclick: () => { navigator.clipboard.writeText(url); } }, "Copy")),
          qr(url),
          h("p", { class: "muted" }, h("a", { href: CFG.explorer + "/tx/" + tx.hash, target: "_blank", rel: "noopener" }, "View transaction")));
      } catch (e) { status(st, errMsg(e), "err"); } finally { btn.disabled = false; }
    } }, "Create link");
    return h("section", { class: "card" }, h("h2", {}, "New payment link"),
      h("label", { for: "amt" }, "Amount (USDC)"), amount,
      h("label", { for: "memo" }, "What is it for?"), memo,
      h("label", { for: "days" }, "Expires in (days)"), days,
      h("div", { class: "row" }, btn), st, out);
  }

  function renderPay() {
    const card = h("section", { class: "card" });
    const idIn = h("input", { id: "lid", inputmode: "numeric", value: new URLSearchParams(location.search).get("id") || "" });
    const view = h("div");
    const load = async () => {
      view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
      try {
        if (!reader) throw new Error("Contract not deployed yet");
        const id = BigInt(idIn.value);
        const l = await reader.getLink(id);
        view.replaceChildren(renderLink(id, l));
      } catch (e) { view.replaceChildren(h("p", { class: "status err" }, errMsg(e))); }
    };
    card.append(h("h2", {}, "Pay a link"), h("label", { for: "lid" }, "Link number"),
      h("div", { class: "share" }, idIn, h("button", { class: "ghost", onclick: load }, "Open")), view);
    if (idIn.value) load();
    return card;
  }

  function linkState(l) {
    const expired = l.expiresAt > 0n && BigInt(Math.floor(Date.now() / 1000)) > l.expiresAt;
    if (l.active && !expired) return ["open", "Open"];
    if (l.amount > 0n && l.payments > 0n) return ["paid", "Paid"];
    return ["closed", expired ? "Expired" : "Closed"];
  }

  function renderLink(id, l) {
    const [cls, label] = linkState(l);
    const st = h("div", { class: "status" });
    const fixed = l.amount > 0n;
    const amt = h("input", { inputmode: "decimal", placeholder: "Amount in USDC" });
    const note = h("input", { maxlength: "280", placeholder: "Note to the receiver (optional)" });
    const btn = h("button", { onclick: async () => {
      try {
        if (!signer) await connect();
        const value = fixed ? l.amount : toNative(amt.value.trim() || "0");
        if (value <= 0n) throw new Error("Enter an amount");
        btn.disabled = true;
        status(st, "Confirm in your wallet…");
        const tx = await writer().pay(id, note.value.trim(), { value });
        status(st, "Sending… " + tx.hash);
        await tx.wait();
        status(st, "Paid " + fmt(value) + " USDC ✓", "ok");
        st.append(" ", h("a", { href: CFG.explorer + "/tx/" + tx.hash, target: "_blank", rel: "noopener" }, "receipt"));
      } catch (e) { status(st, errMsg(e), "err"); btn.disabled = false; }
    } }, fixed ? "Pay " + fmt(l.amount) + " USDC" : "Send USDC");
    return h("div", {},
      h("p", {}, h("span", { class: "pill " + cls }, label), " ", h("span", { class: "muted" }, "Link #" + id)),
      h("div", { class: "amount" }, fixed ? fmt(l.amount) + " USDC" : "Any amount"),
      l.memo ? h("p", {}, l.memo) : null,
      h("p", { class: "muted" }, "To ", h("code", {}, l.payee),
        l.payments > 0n ? " · received " + fmt(l.totalReceived) + " USDC in " + l.payments + " payment(s)" : "",
        l.expiresAt > 0n ? " · expires " + new Date(Number(l.expiresAt) * 1000).toLocaleString() : ""),
      cls === "open" ? h("div", {}, fixed ? null : amt, note, h("div", { class: "row" }, btn)) : null, st);
  }

  function renderMine() {
    const card = h("section", { class: "card" }, h("h2", {}, "My links"));
    if (!account) {
      card.append(h("p", { class: "muted" }, "Connect your wallet to see your links."),
        h("button", { onclick: () => connect().then(render).catch((e) => alert(errMsg(e))) }, "Connect wallet"));
      return card;
    }
    const list = h("ul", { class: "links" }, h("li", { class: "muted" }, "Loading…"));
    card.append(list);
    (async () => {
      try {
        const ids = Array.from(await reader.linksOf(account)).reverse();
        if (!ids.length) { list.replaceChildren(h("li", { class: "muted" }, "No links yet.")); return; }
        const links = await Promise.all(ids.map((id) => reader.getLink(id)));
        list.replaceChildren(...links.map((l, i) => {
          const [cls, label] = linkState(l);
          const id = ids[i];
          return h("li", {},
            h("span", {}, h("span", { class: "pill " + cls }, label), " #" + id + " ",
              l.amount > 0n ? fmt(l.amount) + " USDC" : "open amount", l.memo ? " · " + l.memo : ""),
            h("span", {}, "received " + fmt(l.totalReceived) + " ",
              h("a", { href: shareUrl(id.toString()) }, "link"),
              l.active ? h("button", { class: "ghost", style: "margin-left:8px;padding:4px 10px", onclick: async (e) => {
                try { e.target.disabled = true; await (await writer().cancel(id)).wait(); render(); }
                catch (err) { alert(errMsg(err)); e.target.disabled = false; }
              } }, "Close") : null));
        }));
      } catch (e) { list.replaceChildren(h("li", { class: "status err" }, errMsg(e))); }
    })();
    return card;
  }

  $("#connect").addEventListener("click", () => connect().then(() => { if (tab === "mine") render(); }).catch((e) => alert(errMsg(e))));
  render();
})();
