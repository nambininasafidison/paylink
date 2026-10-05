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
  // A contract error code ("… (UnknownLink)") is set apart on a muted line under the sentence, for support.
  const said = (msg) => {
    const m = /^([\s\S]*)\u00a0\((\w+)\)$/.exec(msg);
    return m ? [m[1], h("span", { class: "code" }, "Error code " + m[2])] : [msg];
  };
  function status(el, msg, kind) { el.className = "status " + (kind || ""); el.replaceChildren(...said(msg)); }
  // Plain-language versions of the contract's custom errors (the code stays visible for support).
  const FRIENDLY = {
    UnknownLink: "There is no payment link with this number.",
    Inactive: "This link is closed and can no longer be paid.",
    Expired: "This link has expired.",
    NotPayee: "Only the creator of this link can close it.",
    WrongAmount: "The amount does not match this link.",
    MemoTooLong: "The memo is too long.",
    BadExpiry: "The expiry must be in the future.",
  };
  function errMsg(e) {
    if (e && e.revert && e.revert.name) return FRIENDLY[e.revert.name] ? FRIENDLY[e.revert.name] + "\u00a0(" + e.revert.name + ")" : e.revert.name;
    const msg = (e && (e.shortMessage || e.reason || e.message)) || String(e);
    // Typing mistakes read as instructions, not library errors (parsing itself is unchanged).
    if (/invalid FixedNumber string value/.test(msg)) return "Enter the amount with a dot for decimals, e.g. 25.50";
    if (/too many decimals for format/.test(msg)) return "Use at most 6 decimals, e.g. 25.50";
    if (/to a BigInt/.test(msg)) return "Enter the link number only, e.g. 12";
    // An unreachable RPC reads as what it means for the user, not as a browser fetch error.
    if (/failed to fetch|networkerror|network error|load failed|ECONNREFUSED/i.test(msg)) return "Could not reach Arc";
    return msg;
  }

  /* ---------- Presentation helpers (display only, no amount math) ---------- */
  // "25.5" -> "25.50", "1200" -> "1 200.00": always at least two decimals, thin-space thousands.
  const money = (s) => {
    const [i, d = ""] = String(s).split(".");
    return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "." + (d + "00").slice(0, Math.max(2, d.length));
  };
  const num = (s, cls) => h("span", { class: "num" + (cls ? " " + cls : ""), style: "--n:" + Math.max(4, s.length) }, s);
  const unit = (u) => h("span", { class: "unit" }, u || "USDC");
  const ext = (href, label) => h("a", { class: "ext", href, target: "_blank", rel: "noopener" }, label);
  // 0x90F8 bf6A 479f … c9C1: grouped in fours so a payer can compare it with what they were told.
  // The first and last groups are bold, the part wallets show as 0x90F8…c9C1.
  const addr = (a) => {
    const groups = [a.slice(0, 6)].concat(a.slice(6).match(/.{1,4}/g) || []);
    return h("code", { class: "addr", title: a }, groups.map((g, k) => h("span", { class: k === 0 || k === groups.length - 1 ? "end" : null }, g)));
  };
  const network = () => (CFG.network === "mainnet" ? "Arc mainnet" : "Arc testnet");
  // Display only: tells the lead column what the pay terminal shows (open-amount, paid, settled, error).
  const voice = (v) => { if (v) document.documentElement.dataset.state = v; else delete document.documentElement.dataset.state; };
  // Status lines break between phrases, never inside "25.50 USDC" or "on Arc".
  const keep = (s) => s.replace(/ /g, "\u00a0");
  const when = (sec) => new Date(Number(sec) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  // The ledger's short form, the day only ("Oct 12"; the year when it is not this one), so it never wraps in its
  // column. The exact time is in its tooltip and on the link's own page.
  const shortDate = (sec) => {
    const d = new Date(Number(sec) * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  };
  const plural = (n, one, many) => n + " " + (n === 1n || n === 1 ? one : many);
  const head = (title, meta) => h("div", { class: "view-head" }, h("h2", {}, title), meta ? h("span", { class: "view-meta" }, meta) : null);
  // One polite live region for confirmations that are otherwise only visual (e.g. "Copied").
  const announcer = h("span", { class: "sr-only", role: "status" });
  document.body.append(announcer);
  const announce = (msg) => { announcer.textContent = ""; setTimeout(() => { announcer.textContent = msg; }, 50); };
  function copy(text, btn) {
    const done = () => {
      announce("Link copied");
      btn.textContent = "Copied"; btn.classList.add("is-done");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("is-done"); }, 1600);
    };
    try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* clipboard unavailable */ }
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
    $("#connect").classList.add("is-on");
    $("#connect").setAttribute("title", account);
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
  }
  const writer = () => new ethers.Contract(CFG.address, ABI, signer);

  function renderTabs() {
    $("#tabs").replaceChildren(...[["create", "Create link"], ["pay", "Pay a link"], ["mine", "My links"]].map(([k, label]) =>
      h("button", { type: "button", class: tab === k ? "active" : "", "aria-pressed": tab === k ? "true" : "false", onclick: () => { tab = k; render(); } }, label)));
  }

  function render() {
    renderTabs();
    document.documentElement.dataset.view = tab;
    document.documentElement.dataset.contract = CFG.address ? "on" : "off";
    $("#plate").textContent = (CFG.network === "mainnet" ? "Arc mainnet" : "Arc testnet") + " · " + CFG.chainId;
    // The text stays the full address; on a phone CSS hides its middle so it reads 0xe78A…a8Ab on one line.
    $("#contract").replaceChildren(CFG.address
      ? h("a", { class: "ext", href: CFG.explorer + "/address/" + CFG.address, target: "_blank", rel: "noopener", title: CFG.address },
        h("code", {}, h("span", {}, CFG.address.slice(0, 6)), h("span", { class: "addr-mid" }, CFG.address.slice(6, -4)), h("span", { class: "addr-tail" }, CFG.address.slice(-4))))
      : "Not deployed yet");
    $("#banner").replaceChildren(!CFG.address ? h("div", { class: "banner", role: "status" },
      h("p", {}, h("b", {}, "No contract configured yet. "), h("a", { href: "deploy.html" }, "Deploy PayLink from your wallet"), " (or run ", h("code", {}, "npm run deploy"), ").")) : "");
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

  // The counter card printed after a link is created: amount, memo and QR on paper (in both themes), so a photo
  // or screenshot of it explains itself. The copyable link and the transaction stay on the terminal below it.
  function ticket(t) {
    const field = h("input", { value: t.url, readonly: true, "aria-label": "Payment link", onfocus: (e) => e.target.select() });
    const copyBtn = h("button", { type: "button", class: "key key-line", onclick: () => copy(t.url, copyBtn) }, "Copy");
    // A long URL scrolls to its end, so the link number (?id=N) is what shows.
    requestAnimationFrame(() => { field.scrollLeft = field.scrollWidth; });
    const issued = h("div", { class: "issued" },
      h("div", { class: "ticket", role: "group", "aria-label": "Payment card for link " + t.id },
        h("div", { class: "lamba", "aria-hidden": "true" }),
        h("div", { class: "ticket-top" }, h("span", { class: "ticket-brand" }, "PayLink"), h("span", {}, "Link #" + t.id)),
        h("div", { class: "ticket-amt" }, t.amount ? [num(money(t.amount)), unit()] : num("Any amount", "any")),
        t.memo ? h("p", { class: "ticket-memo" }, t.memo) : null,
        h("div", { class: "perf", "aria-hidden": "true" }),
        h("div", { class: "ticket-scan" }, h("div", { class: "qr-frame" }, qr(t.url)),
          h("div", { class: "scan-cap" }, h("b", {}, "Scan to pay"),
            h("span", {}, "With any wallet on Arc. The USDC goes straight to the seller."),
            h("code", { class: "printed-url" }, t.url.replace(/^https?:\/\//, ""))))),
      h("div", { class: "share" }, field, copyBtn),
      h("p", { class: "ticket-links" }, ext(CFG.explorer + "/tx/" + t.tx, "View transaction"), ext(t.url, "Open the pay page")));
    // The card prints below the fold on a laptop: bring it into view.
    requestAnimationFrame(() => issued.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    return issued;
  }

  function renderCreate() {
    const amount = h("input", { id: "amt", class: "readout-input", inputmode: "decimal", placeholder: "0.00", autocomplete: "off", "aria-describedby": "amt-hint" });
    const memo = h("input", { id: "memo", maxlength: "280", placeholder: "e.g. Logo design, invoice #12", autocomplete: "off" });
    const days = h("input", { id: "days", type: "number", min: "0", inputmode: "numeric", placeholder: "e.g. 7", "aria-describedby": "days-hint" });
    const st = h("div", { class: "status", role: "status", "aria-live": "polite" });
    const out = h("div", { class: "out" });
    const btn = h("button", { type: "button", class: "key key-primary", onclick: async () => {
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
        const m = memo.value.trim();
        const tx = await writer().create(value, expires, m);
        status(st, "Sending… " + tx.hash);
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return writer().interface.parseLog(l); } catch (e) { return null; } })
          .find((x) => x && x.name === "LinkCreated");
        const url = shareUrl(ev.args.id.toString());
        status(st, "Link #" + ev.args.id + " is live. Share it below.", "ok");
        out.replaceChildren(ticket({ id: ev.args.id, url, amount: a ? fmt(value) : null, memo: m, tx: tx.hash }));
      } catch (e) { status(st, errMsg(e), "err"); } finally { btn.disabled = false; }
    } }, "Create link");
    return h("section", { class: "view view-create" }, head("New payment link"),
      h("div", { class: "readout" },
        h("div", { class: "readout-top" }, h("label", { for: "amt" }, "Amount", h("span", { class: "sr-only" }, " (USDC)")), h("span", { "aria-hidden": "true" }, "USDC")),
        amount,
        h("p", { class: "readout-hint", id: "amt-hint" }, "Leave empty and the payer chooses the amount, like a tip jar.")),
      h("div", { class: "form-grid" },
        h("div", { class: "field" }, h("label", { for: "memo" }, "What is it for?"), memo),
        h("div", { class: "field" }, h("label", { for: "days" }, "Expires after", h("span", { class: "sr-only" }, " (days)")), h("div", { class: "well with-unit" }, days, h("span", { "aria-hidden": "true" }, "days")),
          h("p", { class: "field-hint", id: "days-hint" }, "Empty: never expires."))),
      btn, st, out);
  }

  function renderPay() {
    voice(null);
    const card = h("section", { class: "view view-pay" });
    const idIn = h("input", { id: "lid", inputmode: "numeric", autocomplete: "off", placeholder: "12", value: new URLSearchParams(location.search).get("id") || "" });
    const view = h("div", { class: "view-body" });
    const load = async () => {
      voice(null);
      view.replaceChildren(h("p", { class: "loading", role: "status" }, "Reading from Arc…"));
      try {
        if (!reader) throw new Error("Contract not deployed yet");
        const id = BigInt(idIn.value);
        const l = await reader.getLink(id);
        view.replaceChildren(renderLink(id, l));
      } catch (e) {
        // The lead only says "not found" when the contract says so or the number itself is unusable;
        // an unreachable RPC or a missing contract must not tell the payer the seller's link is fake.
        const notFound = (e && e.revert && e.revert.name === "UnknownLink") || e instanceof SyntaxError || (e && e.code === "INVALID_ARGUMENT");
        voice(notFound ? "error" : "offline");
        // What to do next sits under the error itself, so a payer on a phone (where the lead column is hidden) gets it too.
        const next = notFound ? "Check the number with the seller, or open the full link they sent you."
          : reader ? "Check your connection, then press Open again. Nothing has left your wallet." : null;
        view.replaceChildren(h("div", { role: "alert" }, h("p", { class: "status err" }, said(errMsg(e))),
          next ? h("p", { class: "state-note load-note" }, next) : null));
      }
    };
    card.append(head("Pay a link"),
      h("div", { class: "lookup" }, h("label", { for: "lid" }, "Link no."), idIn, h("button", { type: "button", class: "key", onclick: load }, "Open")), view);
    if (idIn.value) load();
    return card;
  }

  function linkState(l) {
    const expired = l.expiresAt > 0n && BigInt(Math.floor(Date.now() / 1000)) > l.expiresAt;
    if (l.active && !expired) return ["open", "Open"];
    if (l.amount > 0n && l.payments > 0n) return ["paid", "Paid"];
    return ["closed", expired ? "Expired" : "Closed"];
  }

  // The printed slip after a successful payment.
  function receipt(r) {
    const row = (k, v) => h("div", {}, h("dt", {}, k), h("dd", {}, v));
    return h("div", { class: "receipt-wrap" }, h("div", { class: "receipt", role: "group", "aria-label": "Payment receipt" },
      h("div", { class: "receipt-top" }, h("span", {}, "PayLink receipt"), h("b", {}, "Approved")),
      h("div", { class: "receipt-amt" }, num(money(fmt(r.value))), unit()),
      h("dl", {},
        row("Link", "#" + r.id),
        r.memo ? row("For", r.memo) : null,
        row("To", short(r.payee)),
        r.note ? row("Note", r.note) : null,
        row("Time", new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })),
        row("Tx", ext(CFG.explorer + "/tx/" + r.tx, short(r.tx)))),
      h("p", { class: "receipt-foot" }, "Settled on Arc")));
  }

  function renderLink(id, l) {
    const [cls, label] = linkState(l);
    const st = h("div", { class: "status", role: "status", "aria-live": "polite" });
    const fixed = l.amount > 0n;
    voice(cls !== "open" ? "settled" : fixed ? null : "open-amount");
    const amt = h("input", { id: "pay-amt", class: "readout-input", inputmode: "decimal", placeholder: "0.00", autocomplete: "off" });
    const note = h("input", { id: "pay-note", maxlength: "280", placeholder: "Add a short message", autocomplete: "off" });
    const pill = h("span", { class: "pill " + cls }, label);
    const slot = h("div", { class: "receipt-slot" });
    const bill = h("div", { class: "bill is-" + cls });
    // Presentation only: what the display window says about the amount, and the terminal's verdict line.
    const due = h("span", { class: "due" }, cls === "paid" ? "Amount paid" : cls === "closed" ? "Amount" : fixed ? "Amount due" : "Open amount");
    const verdict = (title, sub) => h("div", { class: "verdict", role: "status" }, h("b", {}, title), h("span", {}, sub));
    const btn = h("button", { type: "button", class: "key key-primary", onclick: async () => {
      try {
        if (!signer) await connect();
        const value = fixed ? l.amount : toNative(amt.value.trim() || "0");
        if (value <= 0n) throw new Error("Enter an amount");
        btn.disabled = true;
        status(st, "Confirm in your wallet…");
        const n = note.value.trim();
        const tx = await writer().pay(id, n, { value });
        status(st, "Sending… " + tx.hash);
        await tx.wait();
        status(st, keep("Paid " + money(fmt(value)) + " USDC") + " · " + keep("confirmed on Arc"), "ok");
        // Presentation only: the terminal flips to Paid, shows its verdict and prints a receipt.
        if (fixed) { pill.className = "pill paid"; pill.textContent = "Paid"; due.textContent = "Amount paid"; }
        screen.append(verdict("Approved", fixed ? "Paid in full" : money(fmt(value)) + " USDC sent"));
        bill.classList.add("is-done");
        voice("paid");
        slot.replaceChildren(receipt({ id, memo: l.memo, payee: l.payee, value, note: n, tx: tx.hash }),
          h("p", { class: "thanks" }, h("b", { lang: "mg" }, "Misaotra!"), h("span", { class: "gloss" }, "Thank you, in Malagasy"),
            "The USDC is already in the payee's wallet."));
      } catch (e) { status(st, errMsg(e), "err"); btn.disabled = false; }
    } }, fixed ? "Pay " + fmt(l.amount) + " USDC" : "Send USDC");
    const stateNote = { paid: "This link has been paid. Thank you.", closed: label === "Expired" ? "This link has expired. Ask the sender for a new one." : "The sender closed this link. Ask them for a new one." }[cls];
    const screen = h("div", { class: "screen" },
      h("div", { class: "screen-top" }, pill, h("span", {}, "Link #" + id)),
      h("div", { class: "screen-label" }, due),
      h("div", { class: "amount" }, fixed ? [num(money(fmt(l.amount))), " ", unit()] : num("Any amount", "any")),
      l.memo ? h("p", { class: "screen-memo" }, l.memo) : null,
      cls === "paid" ? verdict("Paid in full", "Settled on Arc") : null);
    bill.append(screen,
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, "Pay to"), h("dd", {}, addr(l.payee))),
        h("div", {}, h("dt", {}, "Network"), h("dd", {}, network() + " · paid in USDC")),
        l.payments > 0n ? h("div", {}, h("dt", {}, "Received"), h("dd", {}, money(fmt(l.totalReceived)) + " USDC in " + plural(l.payments, "payment", "payments"))) : null,
        l.expiresAt > 0n ? h("div", {}, h("dt", {}, label === "Expired" ? "Expired" : "Expires"), h("dd", {}, when(l.expiresAt))) : null),
      cls === "open" ? h("div", { class: "payform" },
        fixed ? null : h("div", { class: "readout" },
          h("div", { class: "readout-top" }, h("label", { for: "pay-amt" }, "Your amount", h("span", { class: "sr-only" }, " (USDC)")), h("span", { "aria-hidden": "true" }, "USDC")), amt),
        h("div", { class: "field" }, h("label", { for: "pay-note" }, "Note to the receiver", h("span", { class: "opt" }, "optional")), note),
        btn,
        h("p", { class: "assure" }, "Non-custodial: USDC goes straight from your wallet to the address above. The network fee is paid in USDC.")) : h("p", { class: "state-note" }, stateNote),
      st, slot);
    return bill;
  }

  function renderMine() {
    const card = h("section", { class: "view view-mine" }, head("My links", account ? short(account) : null));
    if (!account) {
      card.append(h("div", { class: "empty-state" }, h("p", {}, "Connect your wallet to see your links."),
        h("button", { type: "button", class: "key key-primary", onclick: () => connect().then(render).catch((e) => alert(errMsg(e))) }, "Connect wallet")));
      return card;
    }
    const tally = h("div", { class: "tally screen", hidden: true });
    const list = h("ul", { class: "links" }, h("li", { class: "loading" }, "Reading from Arc…"));
    const footing = h("div", { class: "footing", hidden: true });
    const columns = h("div", { class: "ledger-head", "aria-hidden": "true", hidden: true }, h("span", {}, "No."), h("span", {}, "Link"), h("span", {}, "USDC"));
    card.append(tally, columns, list, footing);
    (async () => {
      try {
        const ids = Array.from(await reader.linksOf(account)).reverse();
        if (!ids.length) {
          list.replaceChildren(h("li", { class: "empty empty-state" }, h("p", {}, "No links yet. Your first one takes a single transaction."),
            h("button", { type: "button", class: "key key-primary", onclick: () => { tab = "create"; render(); } }, "Create your first link")));
          return;
        }
        const links = await Promise.all(ids.map((id) => reader.getLink(id)));
        // Display only: the number column is as wide as the longest "#id", so 4- and 5-digit ids never wrap.
        card.style.setProperty("--idc", String(Math.max(...ids.map((id) => ("#" + id).length))));
        // Display-only summary of what these links have brought in.
        const total = links.reduce((s, l) => s + l.totalReceived, 0n);
        const open = links.filter((l) => linkState(l)[0] === "open").length;
        tally.replaceChildren(h("span", { class: "tally-label" }, "Received, all links"),
          h("div", { class: "tally-sum" }, num(money(fmt(total))), unit()),
          h("div", { class: "tally-sub" }, h("span", {}, h("b", {}, String(links.length)), " links"), h("span", {}, h("b", {}, String(open)), " open")));
        tally.hidden = false;
        // The ledger closes on a double rule, like the foot of an account book.
        footing.replaceChildren(h("span", { class: "footing-label" }, "Total received"), h("span", { class: "footing-sum" }, num(money(fmt(total))), unit()));
        footing.hidden = false;
        columns.hidden = false;
        list.replaceChildren(...links.map((l, i) => {
          const [cls, label] = linkState(l);
          const id = ids[i];
          const url = shareUrl(id.toString());
          const copyBtn = h("button", { type: "button", class: "key key-text", onclick: () => copy(url, copyBtn) }, "Copy");
          const meta = l.payments > 0n ? plural(l.payments, "payment", "payments") : cls === "open" ? "Awaiting payment" : "No payments";
          return h("li", { class: "is-" + cls },
            h("span", { class: "row-id" }, "#" + id),
            h("div", { class: "row-main" },
              h("span", { class: "pill " + cls }, label),
              h("p", { class: "row-memo" }, l.memo || (l.amount > 0n ? "Payment link" : "Open amount")),
              // Every row reads the same way: state, memo, then its activity line; the actions sit on their own line.
              // An expiry always takes the next line of its own, whole, so no row ends on a dangling "·" or splits a date.
              h("p", { class: "row-meta" }, meta, l.expiresAt > 0n ? [h("span", { class: "sr-only" }, ", "),
                h("span", { class: "when", title: when(l.expiresAt) }, (label === "Expired" ? "Expired " : "Expires ") + shortDate(l.expiresAt))] : null)),
            h("div", { class: "row-amt" },
              // The USDC column head is aria-hidden, so each amount carries its unit for screen readers; the credit
              // is read as "Received 120.00 USDC" rather than its visible "+120.00".
              l.amount > 0n ? [num(money(fmt(l.amount)), "price"), h("span", { class: "sr-only" }, " USDC")] : h("span", { class: "price any" }, "Any amount"),
              l.payments > 0n ? h("span", { class: "credit", style: "--n:" + Math.max(4, money(fmt(l.totalReceived)).length + 1) },
                h("span", { class: "sr-only" }, "Received " + money(fmt(l.totalReceived)) + " USDC"),
                h("span", { "aria-hidden": "true" }, "+" + money(fmt(l.totalReceived)))) : null),
            h("div", { class: "row-foot" },
              h("div", { class: "row-actions" }, copyBtn,
                h("a", { class: "key key-text", href: url }, "View"),
                l.active ? h("button", { type: "button", class: "key key-text key-danger", onclick: async (e) => {
                  try { e.target.disabled = true; await (await writer().cancel(id)).wait(); render(); }
                  catch (err) { alert(errMsg(err)); e.target.disabled = false; }
                } }, "Close") : null)));
        }));
      } catch (e) {
        // Rendered like the pay view's load error: the message, then what to do next, announced as one alert.
        list.replaceChildren(h("li", { class: "load-error" }, h("div", { role: "alert" }, h("p", { class: "status err" }, said(errMsg(e))),
          reader ? h("p", { class: "state-note load-note" }, "Check your connection, then press My links again.") : null)));
      }
    })();
    return card;
  }

  $("#connect").addEventListener("click", () => connect().then(() => { if (tab === "mine") render(); }).catch((e) => alert(errMsg(e))));
  render();
})();
