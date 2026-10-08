// SPDX-License-Identifier: MIT
// @ts-check
/**
 * PayLink v2 deployer (web/v2/deploy): connect a wallet, pick one of the registry's deploy targets, review the exact
 * transaction Deploy.s.sol would send, sign it in the wallet, verify the contract on-chain and print its
 * `protocol/deployments/<chainId>.json`. Keys never reach this page: the wallet signs; the page only prepares and
 * checks. Reads go to the registry's RPC (data/chains.json), falling back to the wallet's own RPC.
 */
import {
  clampGasLimit,
  DeployError,
  deploymentCost,
  explorerLinks,
  parseChainsData,
  parseReleaseData,
  planDeployment,
} from "./lib/core.js";
import { byId, fill, grouped, h, short } from "./lib/dom.js";
import * as fmt from "./lib/format.js";
import { httpRpc, providerRpc, reader, TransportError } from "./lib/rpc.js";
import { verifyDeployment } from "./lib/verify.js";
import { discoverWallets, switchOrAddChain, walletMessage } from "./lib/wallet.js";
import { getAddress, numberToHex } from "./vendor/viem.js";

/** @typedef {import("./lib/core.js").Hex} Hex */
/** @typedef {import("./lib/core.js").Address} Address */
/** @typedef {import("./lib/core.js").ChainConfig} ChainConfig */
/** @typedef {import("./lib/core.js").ReleaseData} ReleaseData */
/** @typedef {import("./lib/core.js").DeploymentPlan} DeploymentPlan */
/** @typedef {import("./lib/rpc.js").Reader} Reader */
/** @typedef {import("./lib/wallet.js").WalletDetail} WalletDetail */
/** @typedef {import("./lib/verify.js").Verification} Verification */

const POLL_MS = 1200;
const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;
const STORE_PREFIX = "paylink.v2.deploy.";

/**
 * @typedef {object} Review
 * @property {"loading" | "ready" | "error"} status
 * @property {"registry" | "wallet"} [via]
 * @property {string} [viaHost]
 * @property {DeploymentPlan} [plan]
 * @property {bigint | null} [estimate]
 * @property {bigint | null} [gasLimit]
 * @property {string | null} [gasError]
 * @property {{ baseFee: bigint; priorityFee: bigint } | null} [fees]
 * @property {ReturnType<typeof deploymentCost> | null} [cost]
 * @property {bigint} [balance]
 * @property {unknown} [error]
 */

/**
 * @typedef {object} SentTx
 * @property {Hex} hash
 * @property {number} chainId
 * @property {"CREATE2" | "CREATE"} method
 * @property {Address} expectedAddress
 * @property {Address} from
 * @property {number} sentAt
 */

const state = {
  /** @type {ReleaseData | null} */ data: null,
  /** @type {Map<number, ChainConfig>} */ chains: new Map(),
  /** @type {WalletDetail[] | null} */ wallets: null,
  /** @type {WalletDetail | null} */ wallet: null,
  /** @type {import("./lib/rpc.js").Rpc | null} */ walletRpc: null,
  /** @type {Reader | null} */ walletRead: null,
  /** @type {Address | null} */ account: null,
  /** @type {number | null} */ walletChainId: null,
  /** @type {number | null} */ chainId: null,
  /** @type {bigint | null} */ balance: null,
  /** @type {Review | null} */ review: null,
  /** @type {"boot" | "fatal" | "idle" | "switching" | "signing" | "pending" | "verifying" | "done" | "verified" | "failed"} */ phase: "boot",
  /** @type {SentTx | null} */ tx: null,
  /** @type {Verification | null} */ verification: null,
  /** @type {Address | null} */ verifiedAddress: null,
  /** @type {import("./lib/core.js").ReceiptFacts & { effectiveGasPrice?: bigint } | null} */ receipt: null,
  /** @type {number | null} */ settledMs: null,
  /** @type {(() => void) | null} */ unsubscribe: null,
};

const $ = {
  banner: byId("banner"),
  wallets: byId("wallets"),
  walletText: byId("wallet-text"),
  walletFacts: byId("wallet-facts"),
  walletName: byId("wallet-name"),
  walletAccount: byId("wallet-account"),
  bands: byId("bands"),
  networkFacts: byId("network-facts"),
  netName: byId("net-name"),
  netWallet: byId("net-wallet"),
  netBalance: byId("net-balance"),
  switchKey: /** @type {HTMLButtonElement} */ (byId("switch")),
  networkStatus: byId("network-status"),
  reviewText: byId("review-text"),
  review: byId("review"),
  reviewKind: byId("review-kind"),
  reviewChain: byId("review-chain"),
  readings: byId("readings"),
  lamps: byId("lamps"),
  deploy: /** @type {HTMLButtonElement} */ (byId("deploy")),
  status: byId("status"),
  recordText: byId("record-text"),
  resume: byId("resume"),
  txForm: /** @type {HTMLFormElement} */ (byId("txhash-form")),
  txInput: /** @type {HTMLInputElement} */ (byId("txhash")),
  checks: byId("checks"),
  slip: byId("slip"),
  record: byId("record"),
  recordPath: byId("record-path"),
  recordJson: byId("record-json"),
  copy: /** @type {HTMLButtonElement} */ (byId("copy")),
  download: /** @type {HTMLButtonElement} */ (byId("download")),
};

// ------------------------------------------------------------------------------------------------ helpers

/** @returns {ChainConfig | null} */
const selected = () => (state.chainId === null ? null : (state.chains.get(state.chainId) ?? null));
const onRightChain = () => state.chainId !== null && state.walletChainId === state.chainId;
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** "1.4 s", or "under 0.1 s" (a local chain). @param {number} ms */
const seconds = (ms) => (ms < 100 ? "under 0.1 s" : `${(ms / 1000).toFixed(1)} s`);

/**
 * @param {HTMLElement} el
 * @param {string} message
 * @param {"" | "ok" | "err"} [kind]  "" is the blinking amber "working" LED
 */
function say(el, message, kind = "") {
  el.className = kind === "" ? "status" : `status ${kind}`;
  el.textContent = message;
}

/** @param {string | null} message @param {"warn" | "err"} [kind] */
function banner(message, kind = "warn") {
  $.banner.hidden = message === null;
  $.banner.className = kind === "err" ? "banner is-err" : "banner";
  $.banner.textContent = message ?? "";
}

/** @param {unknown} error */
function describe(error) {
  if (error instanceof DeployError) {
    return error.message;
  }
  return walletMessage(error);
}

/** @param {ChainConfig} chain @param {bigint} value @param {"up" | "down"} mode */
const nativeAmount = (chain, value, mode) => `${fmt.native(value, chain.nativeCurrency.decimals, mode)} ${chain.nativeCurrency.symbol}`;

/** Per-browser memory of a sent deployment, so a reload never loses (or repeats) it. Storage may be unavailable. */
const memory = {
  /** @param {number} chainId @returns {SentTx | null} */
  get(chainId) {
    try {
      const raw = localStorage.getItem(`${STORE_PREFIX}${String(chainId)}`);
      if (raw === null) {
        return null;
      }
      const tx = /** @type {SentTx} */ (JSON.parse(raw));
      return /^0x[0-9a-f]{64}$/.test(tx.hash) && tx.chainId === chainId ? tx : null;
    } catch {
      return null;
    }
  },
  /** @param {SentTx} tx */
  set(tx) {
    try {
      localStorage.setItem(`${STORE_PREFIX}${String(tx.chainId)}`, JSON.stringify(tx));
    } catch {
      // Private window or blocked storage: the page still works, it only cannot resume after a reload.
    }
  },
};

/**
 * Runs `fn` against the registry RPC of `chain`, or against the wallet's RPC when the registry endpoints cannot be
 * reached (and the wallet is on that chain).
 *
 * @template T
 * @param {ChainConfig} chain
 * @param {(read: Reader) => Promise<T>} fn
 * @returns {Promise<{ value: T; via: "registry" | "wallet"; host: string }>}
 */
async function viaRegistry(chain, fn) {
  const rpc = httpRpc(chain.rpc);
  try {
    const value = await fn(reader(rpc));
    return { value, via: "registry", host: new URL(rpc.lastUrl() ?? chain.rpc[0] ?? "https://unknown").host };
  } catch (error) {
    if (!(error instanceof TransportError) || state.walletRead === null || !onRightChain()) {
      throw error;
    }
    return { value: await fn(state.walletRead), via: "wallet", host: state.wallet?.info.name ?? "wallet" };
  }
}

// ------------------------------------------------------------------------------------------------ boot

async function boot() {
  if (window.top !== window.self) {
    // Clickjacking guard (spec §5 threat 6); the production headers also send frame-ancestors 'none'.
    state.phase = "fatal";
    banner("This page refuses to run inside a frame. Open it directly.", "err");
    update();
    return;
  }
  try {
    const [release, chains] = await Promise.all([fetchJson("data/release.json"), fetchJson("data/chains.json")]);
    state.data = parseReleaseData(release);
    state.chains = parseChainsData(chains);
  } catch (error) {
    state.phase = "fatal";
    banner(`The page's release data failed its integrity check, so nothing can be deployed from here: ${describe(error)}`, "err");
    update();
    return;
  }
  bindIdentity(state.data);
  buildBands();
  const asked = new URLSearchParams(location.search).get("chain");
  if (asked !== null) {
    const id = /^[0-9]+$/.test(asked) ? Number(asked) : [...state.chains.values()].find((c) => c.label.toLowerCase() === asked.toLowerCase())?.chainId;
    if (id !== undefined && state.chains.has(id)) {
      state.chainId = id;
    } else {
      banner(`“${asked.slice(0, 40)}” is not a PayLink v2 deployment target. Pick one of the networks below.`);
    }
  }
  state.phase = "idle";
  discoverWallets((wallets) => {
    state.wallets = wallets;
    renderWallets();
    update();
  });
  wireEvents();
  update();
}

/** @param {string} path */
async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${String(response.status)}`);
  }
  return /** @type {unknown} */ (await response.json());
}

/** @param {ReleaseData} data */
function bindIdentity(data) {
  const r = data.release;
  /** @param {string} key @param {Node | string} value */
  const bind = (key, value) => {
    for (const el of document.querySelectorAll(`[data-bind="${key}"]`)) {
      fill(el, value);
    }
  };
  bind("release", r.release);
  bind("chain-count", String(state.chains.size));
  bind("initCodeHash", grouped(r.bytecode.initCodeHash, { tail: false }));
  bind("create2Address", grouped(r.create2.address));
  bind("saltPreimage", r.create2.saltPreimage);
  bind("salt", `keccak256 → ${short(r.create2.salt)}`);
  bind("compiler", `solc ${r.compiler.solc.split("+")[0] ?? r.compiler.solc}, ${r.compiler.evmVersion}, ${String(r.compiler.optimizerRuns)} runs · OpenZeppelin ${r.dependencies["@openzeppelin/contracts"] ?? "?"}`);
  bind(
    "sourceCommit",
    data.sourceCommit === "unknown"
      ? "unknown"
      : h("a", { href: `${r.source.repository}/tree/${data.sourceCommit}/protocol`, rel: "noopener noreferrer", target: "_blank", class: "ext", text: data.sourceCommit.slice(0, 12) }),
  );
}

// ------------------------------------------------------------------------------------------------ 01 wallet

function renderWallets() {
  if (state.wallets === null) {
    return;
  }
  if (state.wallets.length === 0) {
    fill(
      $.wallets,
      h(
        "p",
        { class: "wallets-empty" },
        h("b", { text: "No wallet found in this browser. " }),
        "Install MetaMask or Rabby, or open this page in your wallet app's browser, then reload.",
      ),
    );
    return;
  }
  fill(
    $.wallets,
    state.wallets.map((w) =>
      h(
        "button",
        {
          class: "key wallet-key",
          type: "button",
          "aria-pressed": state.wallet?.info.uuid === w.info.uuid ? "true" : "false",
          "data-wallet": w.info.rdns,
          onclick: () => {
            void connect(w);
          },
        },
        w.info.icon === null ? h("span", { class: "wallet-glyph", "aria-hidden": "true", text: w.info.name.slice(0, 2).toUpperCase() }) : h("img", { src: w.info.icon, alt: "", width: 28, height: 28 }),
        h("span", { class: "wallet-label" }, h("span", { class: "wallet-name", text: w.info.name }), h("span", { class: "wallet-rdns", text: w.info.rdns === "injected" ? "window.ethereum" : w.info.rdns })),
      ),
    ),
  );
}

/** @param {WalletDetail} wallet */
async function connect(wallet) {
  if (state.phase === "signing" || state.phase === "pending" || state.phase === "verifying") {
    return;
  }
  state.unsubscribe?.();
  state.wallet = wallet;
  state.walletRpc = providerRpc(wallet.provider);
  state.walletRead = reader(state.walletRpc);
  renderWallets();
  try {
    const accounts = /** @type {string[]} */ (await state.walletRpc.request("eth_requestAccounts"));
    const first = accounts[0];
    if (first === undefined) {
      throw new DeployError("E_NO_ACCOUNT", "The wallet returned no account.");
    }
    state.account = getAddress(first);
    state.walletChainId = await state.walletRead.chainId();
    subscribe(wallet);
    if (state.chainId === null && state.chains.has(state.walletChainId)) {
      state.chainId = state.walletChainId;
    }
    banner(null);
  } catch (error) {
    state.account = null;
    banner(describe(error));
  }
  renderWallets();
  update();
  void refreshReview();
}

/** EIP-1193 events: the wallet may change account or network at any time; the review follows. */
/** @param {WalletDetail} wallet */
function subscribe(wallet) {
  const p = wallet.provider;
  if (typeof p.on !== "function") {
    return;
  }
  /** @param {unknown} accounts */
  const onAccounts = (accounts) => {
    const list = Array.isArray(accounts) ? /** @type {string[]} */ (accounts) : [];
    const first = list[0];
    state.account = first === undefined ? null : getAddress(first);
    update();
    void refreshReview();
  };
  /** @param {unknown} chainId */
  const onChain = (chainId) => {
    state.walletChainId = typeof chainId === "string" ? Number.parseInt(chainId, 16) : Number(chainId);
    update();
    void refreshReview();
  };
  p.on("accountsChanged", onAccounts);
  p.on("chainChanged", onChain);
  state.unsubscribe = () => {
    p.removeListener?.("accountsChanged", onAccounts);
    p.removeListener?.("chainChanged", onChain);
  };
}

// ------------------------------------------------------------------------------------------------ 02 network

function buildBands() {
  const chains = [...state.chains.values()];
  fill(
    $.bands,
    chains.map((c) =>
      h(
        "button",
        {
          class: "band",
          type: "button",
          role: "radio",
          "aria-checked": "false",
          "aria-label": `${c.name}, chain ${String(c.chainId)}`,
          "data-chain": c.chainId,
          tabindex: "-1",
          onclick: () => {
            choose(c.chainId);
          },
          onkeydown: (event) => {
            const key = /** @type {KeyboardEvent} */ (event).key;
            const i = chains.indexOf(c);
            const next = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
            if (next !== 0) {
              event.preventDefault();
              const target = chains[(i + next + chains.length) % chains.length];
              if (target !== undefined) {
                choose(target.chainId);
                /** @type {HTMLElement | null} */ ($.bands.querySelector(`[data-chain="${String(target.chainId)}"]`))?.focus();
              }
            }
          },
        },
        h("span", { class: "band-label", text: c.label }),
        h("span", { class: "band-id", text: `${c.testnet ? "testnet" : "mainnet"} · ${String(c.chainId)}` }),
      ),
    ),
  );
}

/** @param {number} chainId */
function choose(chainId) {
  if (state.phase === "signing" || state.phase === "pending" || state.phase === "verifying" || state.chainId === chainId) {
    return;
  }
  state.chainId = chainId;
  state.tx = null;
  state.verification = null;
  state.verifiedAddress = null;
  state.receipt = null;
  state.phase = "idle";
  say($.status, "");
  banner(null);
  update();
  void refreshReview();
}

async function switchNetwork() {
  const chain = selected();
  if (chain === null || state.walletRpc === null || state.walletRead === null) {
    return;
  }
  state.phase = "switching";
  say($.networkStatus, `Asking the wallet to switch to ${chain.name}…`);
  update();
  try {
    const how = await switchOrAddChain(state.walletRpc, chain);
    state.walletChainId = await state.walletRead.chainId();
    say($.networkStatus, how === "added" ? `${chain.name} added to the wallet and selected.` : `Wallet switched to ${chain.name}.`, "ok");
  } catch (error) {
    say($.networkStatus, describe(error), "err");
  }
  state.phase = "idle";
  update();
  void refreshReview();
}

// ------------------------------------------------------------------------------------------------ 03 review

let reviewSeq = 0;

async function refreshReview() {
  const seq = (reviewSeq += 1);
  const chain = selected();
  const data = state.data;
  const account = state.account;
  if (chain === null || data === null || account === null || !onRightChain() || state.phase === "fatal") {
    state.review = null;
    state.balance = null;
    if (chain !== null && account !== null && data !== null) {
      // Balance on the selected chain, through the registry, even before the wallet switches.
      try {
        const { value } = await viaRegistry(chain, (read) => read.balance(account));
        if (seq === reviewSeq) {
          state.balance = value;
        }
      } catch {
        // The balance is shown again once the review runs.
      }
    }
    if (seq === reviewSeq) {
      update();
    }
    return;
  }
  state.review = { status: "loading" };
  update();
  /** @type {Review} */
  let review;
  try {
    const { value, via, host } = await viaRegistry(chain, async (read) => {
      const reported = await read.chainId();
      if (reported !== chain.chainId) {
        throw new DeployError("E_RPC_CHAIN", `The RPC for ${chain.name} reports chain ${String(reported)}.`);
      }
      const [factoryCode, create2Code, recordedCode, balance, nonce, fees] = await Promise.all([
        read.code(data.release.create2.factory),
        read.code(data.release.create2.address),
        chain.deployment === null ? Promise.resolve(null) : read.code(chain.deployment.address),
        read.balance(account),
        read.pendingNonce(account),
        read.fees(),
      ]);
      const plan = planDeployment({ data, chain, factoryCode, create2Code, recordedCode, deployer: account, nonce });
      /** @type {bigint | null} */
      let estimate = null;
      /** @type {bigint | null} */
      let gasLimit = null;
      /** @type {string | null} */
      let gasError = null;
      if (plan.kind === "deploy") {
        try {
          estimate = await read.estimateGas({ from: account, to: plan.to, data: plan.data });
          gasLimit = clampGasLimit(estimate, plan.gas);
          if (chain.gasModel.txGasCap !== null && gasLimit > chain.gasModel.txGasCap) {
            throw new DeployError("E_GAS_CAP", `The gas limit ${fmt.gas(gasLimit)} is above ${chain.name}'s per-transaction cap.`);
          }
        } catch (error) {
          gasError = describe(error);
          gasLimit = null;
        }
      }
      return { plan, estimate, gasLimit, gasError, fees, balance };
    });
    const cost =
      value.plan.kind === "deploy" && value.gasLimit !== null && value.estimate !== null
        ? deploymentCost({
            gasLimit: value.gasLimit,
            estimate: value.estimate,
            baseFee: value.fees.baseFee,
            priorityFee: value.fees.priorityFee,
            chargesGasLimit: chain.gasModel.chargesGasLimit,
          })
        : null;
    review = { status: "ready", via, viaHost: host, ...value, cost };
  } catch (error) {
    review = { status: "error", error };
  }
  if (seq !== reviewSeq) {
    return;
  }
  state.review = review;
  state.balance = review.balance ?? state.balance;
  update();
}

function renderReview() {
  const chain = selected();
  const review = state.review;
  const data = state.data;
  if (chain === null || data === null || review === null) {
    $.review.hidden = true;
    $.lamps.hidden = true;
    $.reviewText.textContent =
      state.account === null ? "Connect a wallet first." : chain === null ? "Pick a network." : !onRightChain() ? `Switch the wallet to ${chain.name}.` : "The transaction appears here before your wallet asks for it.";
    return;
  }
  $.review.hidden = false;
  $.reviewChain.textContent = `${chain.label} · ${String(chain.chainId)}`;
  if (review.status === "loading") {
    $.reviewKind.textContent = "Reading the chain";
    fill($.readings, h("div", {}, h("dt", { text: "Status" }), h("dd", { text: `Reading ${chain.name}…` })));
    $.lamps.hidden = true;
    return;
  }
  if (review.status === "error" || review.plan === undefined) {
    $.reviewKind.textContent = "Unavailable";
    fill($.readings, h("div", {}, h("dt", { text: "Error" }), h("dd", { class: "bad", text: describe(review.error) })));
    $.lamps.hidden = true;
    $.reviewText.textContent = "The chain could not be read. Check your connection, then pick the network again.";
    return;
  }
  const plan = review.plan;
  const r = data.release;
  /** @type {HTMLElement[]} */
  const rows = [];
  /**
   * @param {string} label
   * @param {Node | string} value
   * @param {string | null} [sub]
   * @param {string} [cls]
   */
  const row = (label, value, sub = null, cls = "") =>
    rows.push(h("div", { class: cls || null }, h("dt", { text: label }), h("dd", {}, value, sub === null ? null : h("span", { class: "sub", text: sub }))));

  if (plan.kind === "verify") {
    $.reviewKind.textContent = "Already deployed";
    $.reviewText.textContent =
      plan.reason === "recorded" ? `${chain.name} already has a recorded PayLinkV2 deployment. The page verifies it instead of deploying again.` : `PayLinkV2 already exists at its CREATE2 address on ${chain.name}. Nothing to deploy: verify it and print its record.`;
    row("Method", plan.method, plan.reason === "recorded" ? "recorded in protocol/deployments" : "found at the CREATE2 address");
    row("Contract", grouped(plan.address), null, "is-address");
  } else {
    $.reviewKind.textContent = "Deployment transaction";
    $.reviewText.textContent = "Check the transaction below. Your wallet shows the same target, data size and gas limit.";
    row(
      "Method",
      plan.method,
      plan.method === "CREATE2" ? `through the proxy ${short(r.create2.factory)}, salt keccak256("${r.create2.saltPreimage}")` : `from your account; no deterministic proxy on ${chain.name}`,
    );
    row("Contract", grouped(plan.expectedAddress), plan.method === "CREATE2" ? "same address on every chain with the proxy" : "follows from your address and nonce", "is-address");
    row("Init code", h("span", { class: "ok", text: `${short(r.bytecode.initCodeHash)} = release ${r.release}` }), `${fmt.gas(r.bytecode.initCodeSize)} bytes, keccak256 checked by this page`);
    if (review.gasLimit !== null && review.gasLimit !== undefined && review.estimate !== null && review.estimate !== undefined) {
      row(
        "Gas limit",
        fmt.gas(review.gasLimit),
        `estimate ${fmt.gas(review.estimate)} × 1.10 within the measured ${fmt.gas(plan.gas.floor)} – ${fmt.gas(plan.gas.ceiling)} (anvil “${chain.deployGas.profile}”)`,
      );
    } else {
      row("Gas limit", h("span", { class: "bad", text: "not available" }), review.gasError ?? null);
    }
    if (review.fees !== null && review.fees !== undefined) {
      row("Gas price", `${fmt.gwei(review.fees.baseFee + review.fees.priorityFee)} gwei`, `base ${fmt.gwei(review.fees.baseFee)} + tip ${fmt.gwei(review.fees.priorityFee)}; your wallet sets the final fee`);
    }
    if (review.cost !== null && review.cost !== undefined) {
      rows.push(
        h(
          "div",
          { class: "is-cost" },
          h("dt", { text: "Cost" }),
          h(
            "dd",
            {},
            h("span", { class: "figure", text: `≈ ${fmt.native(review.cost.expected, chain.nativeCurrency.decimals, "up")}` }),
            h("span", { class: "unit", text: chain.nativeCurrency.symbol }),
            h("span", {
              class: "sub",
              text: chain.gasModel.chargesGasLimit
                ? `${chain.name} charges the whole gas limit, not the gas used. At most ${nativeAmount(chain, review.cost.maximum, "up")} at twice the base fee.`
                : `Charged on the gas used. At most ${nativeAmount(chain, review.cost.maximum, "up")} at twice the base fee.`,
            }),
          ),
        ),
      );
    }
  }
  if (review.balance !== undefined) {
    const after = review.cost === null || review.cost === undefined ? null : review.balance - review.cost.expected;
    row(
      "Balance",
      nativeAmount(chain, review.balance, "down"),
      after === null ? null : after >= 0n ? `≈ ${nativeAmount(chain, after, "down")} after` : `short by ${nativeAmount(chain, -after, "up")}`,
    );
  }
  fill($.readings, rows);
  renderLamps(chain, review);
}

/** @param {ChainConfig} chain @param {Review} review */
function renderLamps(chain, review) {
  const plan = review.plan;
  const data = state.data;
  if (plan === undefined || data === null) {
    $.lamps.hidden = true;
    return;
  }
  /** @type {[string, "ok" | "wait" | "err" | "busy" | "off", string][]} */
  const lamps = [];
  lamps.push(["Release bytecode", "ok", `keccak256(init code) = ${short(data.release.bytecode.initCodeHash)}, release ${data.release.release}`]);
  if (plan.kind === "verify") {
    lamps.push(["Route", "ok", plan.reason === "recorded" ? "Recorded deployment: verify only (Deploy.s.sol does the same)" : "CREATE2 address occupied: verify only"]);
  } else if (plan.method === "CREATE2") {
    lamps.push(["Route", "ok", `Deterministic proxy found at ${short(data.release.create2.factory)} with its canonical code`]);
  } else {
    lamps.push(["Route", "wait", "No proxy on this chain: plain CREATE, address depends on your nonce"]);
  }
  if (plan.kind === "deploy") {
    lamps.push(
      plan.method === "CREATE2"
        ? ["Smart account", "ok", "MetaMask smart-account (EIP-7702) mode may relay this call through its delegation contract: supported, the record names your account"]
        : ["Smart account", "off", "Plain CREATE must come from a standard account: a relayed creation cannot be recorded"],
    );
    lamps.push(
      review.gasLimit === null || review.gasLimit === undefined
        ? ["Gas limit", "err", review.gasError ?? "No estimate"]
        : ["Gas limit", "ok", `${fmt.gas(review.gasLimit)}, inside the measured bounds`],
    );
    const cost = review.cost;
    const balance = review.balance ?? 0n;
    if (cost === null || cost === undefined) {
      lamps.push(["Balance", "off", "Waiting for the gas limit"]);
    } else if (balance < cost.expected) {
      lamps.push(["Balance", "err", `Needs ≈ ${nativeAmount(chain, cost.expected, "up")}; the account holds ${nativeAmount(chain, balance, "down")}`]);
    } else if (balance < cost.maximum) {
      lamps.push(["Balance", "wait", `Covers the expected cost, not the ${nativeAmount(chain, cost.maximum, "up")} maximum: lower the max fee if the wallet refuses`]);
    } else {
      lamps.push(["Balance", "ok", `Covers the cost with room (${nativeAmount(chain, cost.maximum, "up")} at most)`]);
    }
  }
  lamps.push(review.via === "registry" ? ["Chain data", "ok", `Read from the registry RPC ${review.viaHost ?? ""}`] : ["Chain data", "wait", "Registry RPC unreachable: read through your wallet's RPC"]);
  fill(
    $.lamps,
    lamps.map(([name, lamp, detail]) => h("li", { "data-lamp": lamp }, h("span", { class: "lamp-name", text: name }), h("span", { class: "lamp-detail", text: detail }))),
  );
  $.lamps.hidden = false;
}

/** True when the Deploy (or Verify) key may be pressed. */
function canAct() {
  const review = state.review;
  if (review?.status !== "ready" || review.plan === undefined || !onRightChain() || state.account === null) {
    return false;
  }
  if (!["idle", "failed"].includes(state.phase)) {
    return false;
  }
  if (review.plan.kind === "verify") {
    return true;
  }
  return review.gasLimit !== null && review.gasLimit !== undefined && review.cost !== null && review.cost !== undefined && (review.balance ?? 0n) >= review.cost.expected;
}

async function onDeploy() {
  const chain = selected();
  const review = state.review;
  const data = state.data;
  const account = state.account;
  if (!canAct() || chain === null || review?.plan === undefined || data === null || account === null || state.walletRpc === null || state.walletRead === null) {
    return;
  }
  const plan = review.plan;
  if (plan.kind === "verify") {
    await verifyExisting(chain, plan.address, chain.deployment !== null && plan.reason === "recorded" ? chain.deployment.txHash : null);
    return;
  }
  const gasLimit = review.gasLimit;
  if (gasLimit === null || gasLimit === undefined) {
    return;
  }
  state.phase = "signing";
  say($.status, "Confirm the deployment in your wallet…");
  update();
  try {
    // The wallet may have moved since the review: never sign for another chain or account.
    const walletChain = await state.walletRead.chainId();
    if (walletChain !== chain.chainId) {
      throw new DeployError("E_WRONG_CHAIN", `The wallet moved to chain ${String(walletChain)}. Switch back to ${chain.name}.`);
    }
    const tx = { from: account, ...(plan.to === null ? {} : { to: plan.to }), data: plan.data, gas: numberToHex(gasLimit), value: "0x0" };
    const hash = /** @type {unknown} */ (await state.walletRpc.request("eth_sendTransaction", [tx]));
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new DeployError("E_WALLET", "The wallet returned no transaction hash.");
    }
    state.tx = { hash: /** @type {Hex} */ (hash.toLowerCase()), chainId: chain.chainId, method: plan.method, expectedAddress: plan.expectedAddress, from: account, sentAt: Date.now() };
    memory.set(state.tx);
    await settle(chain, state.tx);
  } catch (error) {
    state.phase = "idle";
    say($.status, describe(error), "err");
    update();
  }
}

// ------------------------------------------------------------------------------------------------ 04 verify and record

/**
 * Waits for the receipt, then verifies the contract and the transaction, and prints the record.
 * @param {ChainConfig} chain
 * @param {SentTx} tx
 */
async function settle(chain, tx) {
  const data = state.data;
  if (data === null) {
    return;
  }
  state.tx = tx;
  state.phase = "pending";
  update();
  const started = performance.now();
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  /** @type {(import("./lib/core.js").ReceiptFacts & { effectiveGasPrice?: bigint }) | null} */
  let receipt = null;
  while (receipt === null) {
    const elapsed = Math.round((performance.now() - started) / 100) / 10;
    say($.status, `Sent ${short(tx.hash)}. Waiting for it to be included… ${elapsed.toFixed(1)} s`);
    try {
      const { value } = await viaRegistry(chain, async (read) => {
        const facts = await read.receipt(tx.hash);
        if (facts === null) {
          return null;
        }
        const raw = /** @type {{ effectiveGasPrice?: string } | null} */ (await read.rpc.request("eth_getTransactionReceipt", [tx.hash]));
        return { ...facts, ...(raw?.effectiveGasPrice === undefined ? {} : { effectiveGasPrice: BigInt(raw.effectiveGasPrice) }) };
      });
      receipt = value;
    } catch {
      // Transient RPC failure: keep polling until the deadline.
    }
    if (receipt === null) {
      if (Date.now() > deadline) {
        state.phase = "failed";
        say($.status, `No receipt after ${String(RECEIPT_TIMEOUT_MS / 60000)} minutes. The transaction may still land: reload the page later, it resumes from this browser.`, "err");
        update();
        return;
      }
      await sleep(POLL_MS);
    }
  }
  state.receipt = receipt;
  state.settledMs = Math.round(performance.now() - started);
  if (!receipt.success) {
    state.phase = "failed";
    say($.status, `The transaction reverted in block ${receipt.blockNumber.toString()}. Nothing was deployed; gas was spent.`, "err");
    update();
    return;
  }
  const address = tx.method === "CREATE2" ? tx.expectedAddress : (receipt.contractAddress ?? tx.expectedAddress);
  say($.status, `Included in block ${receipt.blockNumber.toString()} after ${seconds(state.settledMs)}. Verifying…`);
  await verify(chain, address, tx.hash, true);
}

/**
 * @param {ChainConfig} chain
 * @param {Address} address
 * @param {Hex | null} txHash
 */
async function verifyExisting(chain, address, txHash) {
  state.tx = null;
  state.receipt = null;
  await verify(chain, address, txHash, false);
}

/**
 * Verifies through the registry RPC, retrying briefly: a load-balanced endpoint can lag the wallet's by a block.
 * @param {ChainConfig} chain
 * @param {Address} address
 * @param {Hex | null} txHash
 * @param {boolean} deployed  true right after this page's own transaction
 */
async function verify(chain, address, txHash, deployed) {
  const data = state.data;
  if (data === null) {
    return;
  }
  state.phase = "verifying";
  update();
  /** @type {Verification | null} */
  let result = null;
  let lastError = /** @type {unknown} */ (null);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const { value } = await viaRegistry(chain, (read) => verifyDeployment({ read, data, chain, address, txHash }));
      result = value;
      const lagging = value.checks.some((c) => !c.ok && (c.id === "code" || c.id === "tx"));
      if (value.ok || !lagging) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1500);
  }
  state.verification = result;
  state.verifiedAddress = address;
  if (result === null) {
    state.phase = "failed";
    say($.status, `Verification could not read the chain: ${describe(lastError)}`, "err");
  } else if (result.ok) {
    state.phase = deployed ? "done" : "verified";
    say(
      $.status,
      deployed
        ? `PayLinkV2 deployed and verified on ${chain.name}${state.settledMs === null ? "" : `, included in ${seconds(state.settledMs)}`}${result.route === "relayed" ? `, relayed by ${short(result.submitter ?? address)} through your smart account` : ""}.`
        : `The contract at ${short(address)} is the PayLinkV2 release${result.route === "relayed" ? ", deployed through a relayed (smart-account) transaction" : ""}.${result.record === null ? " Add its transaction hash to print the record." : ""}`,
      "ok",
    );
  } else {
    state.phase = "failed";
    say($.status, `Verification failed: ${result.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}. Do not record this address.`, "err");
  }
  update();
  if (state.phase === "done" || state.phase === "verified") {
    byId("h-record").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }
}

function renderResult() {
  const chain = selected();
  const v = state.verification;
  const review = state.review;
  const verifyOnly = review?.plan?.kind === "verify";

  // Resume a deployment sent from this browser earlier (reload, closed tab, phone browser restart).
  const stored = chain === null ? null : memory.get(chain.chainId);
  const showResume = stored !== null && state.tx === null && v === null && !verifyOnly && state.phase === "idle" && onRightChain();
  $.resume.hidden = !showResume;
  if (showResume && chain !== null && stored !== null) {
    fill(
      $.resume,
      h("p", { class: "proc-text", text: `This browser sent a deployment on ${chain.name} (${short(stored.hash)}). Check it before sending another.` }),
      h("button", {
        class: "key key-line",
        type: "button",
        text: "Check that transaction",
        onclick: () => {
          void settle(chain, stored);
        },
      }),
    );
  }

  $.txForm.hidden = !(verifyOnly && v !== null && v.ok && v.record === null);

  $.checks.hidden = v === null && state.phase !== "verifying";
  if (state.phase === "verifying" && v === null) {
    fill($.checks, h("li", { "data-ok": "busy" }, h("span", { class: "check-name", text: "Reading the contract" }), h("span", { class: "check-detail", text: "code, metadata, immutables, eip712Domain()" })));
  } else if (v !== null) {
    fill(
      $.checks,
      v.checks.map((c) => h("li", { "data-ok": String(c.ok), "data-check": c.id }, h("span", { class: "check-name", text: c.label }), h("span", { class: "check-detail", text: c.detail }))),
    );
  }

  const record = v?.ok === true ? v.record : null;
  $.record.hidden = record === null;
  $.slip.hidden = !(v?.ok === true && chain !== null);
  if (record !== null && chain !== null) {
    $.recordPath.textContent = `protocol/deployments/${String(chain.chainId)}.json`;
    $.recordJson.textContent = record;
  }
  if (v?.ok === true && chain !== null && state.data !== null) {
    renderSlip(chain, v);
  }
}

/** @param {ChainConfig} chain @param {Verification} v */
function renderSlip(chain, v) {
  const data = state.data;
  if (data === null) {
    return;
  }
  const address = state.verifiedAddress;
  if (address === null) {
    return;
  }
  const receipt = state.receipt ?? v.receipt;
  // What the deployment cost: the gas the chain charges (the whole limit on Monad) at the price the receipt reports.
  const charged = v.tx === null || receipt === null ? null : chain.gasModel.chargesGasLimit ? v.tx.gas : receipt.gasUsed;
  // A relayed deployment's gas was paid by the relayer, not by this account: no fee on the slip.
  const fee = v.route === "relayed" || state.receipt?.effectiveGasPrice === undefined || charged === null ? null : charged * state.receipt.effectiveGasPrice;
  /** @param {string} label @param {Node | string} value */
  const line = (label, value) => h("div", {}, h("dt", { text: label }), h("dd", {}, value));
  /** @param {{ name: string; href: string }[]} links */
  const links = (links) => h("span", { class: "slip-links" }, links.map((l) => h("a", { href: l.href, rel: "noopener noreferrer", target: "_blank", class: "ext", text: l.name })));
  fill(
    $.slip,
    h(
      "div",
      { class: "receipt slip" },
      h("div", { class: "receipt-top" }, h("span", { text: `PayLinkV2 ${data.release.release}` }), h("b", { text: state.phase === "done" ? "Deployed" : "Verified" })),
      h(
        "div",
        { class: "receipt-amt" },
        h("span", { class: "num", text: fee === null ? chain.label : fmt.native(fee, chain.nativeCurrency.decimals, "up") }),
        h("span", { class: "unit", text: fee === null ? `chain ${String(chain.chainId)}` : `${chain.nativeCurrency.symbol} gas paid` }),
      ),
      h(
        "dl",
        {},
        line("Contract", grouped(address)),
        line("Network", `${chain.name} · ${String(chain.chainId)}`),
        v.method === null ? null : line("Method", v.route === "relayed" ? `${v.method}, relayed` : v.method),
        v.tx === null ? null : line("Tx", h("span", {}, short(v.tx.hash), " ", links(explorerLinks(chain, "tx", v.tx.hash)))),
        receipt === null ? null : line("Block", receipt.blockNumber.toString()),
        v.tx === null ? null : line("Deployer", v.deployer === null ? "not shown by the chain" : grouped(v.deployer)),
        v.route === "relayed" && v.submitter !== null ? line("Relayer", grouped(v.submitter)) : null,
        line("Explorer", links(explorerLinks(chain, "address", address))),
      ),
      h("div", { class: "receipt-foot", text: "Ownerless · immutable · fee-less" }),
    ),
  );
}

// ------------------------------------------------------------------------------------------------ render

function update() {
  document.body.dataset["phase"] = state.phase;
  const chain = selected();
  const fatal = state.phase === "fatal";
  const busy = state.phase === "signing" || state.phase === "pending" || state.phase === "verifying" || state.phase === "switching";

  // 01
  $.walletFacts.hidden = state.account === null;
  if (state.account !== null && state.wallet !== null) {
    $.walletName.textContent = state.wallet.info.name;
    fill($.walletAccount, grouped(state.account));
    $.walletText.textContent = "Connected. The wallet signs; this page never sees a key.";
  }
  for (const key of $.wallets.querySelectorAll("button")) {
    /** @type {HTMLButtonElement} */ (key).disabled = fatal || busy;
  }

  // 02
  for (const band of $.bands.querySelectorAll(".band")) {
    const b = /** @type {HTMLButtonElement} */ (band);
    const on = Number(b.dataset["chain"]) === state.chainId;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on || (state.chainId === null && b === $.bands.firstElementChild) ? 0 : -1;
    b.disabled = fatal || busy;
  }
  $.networkFacts.hidden = chain === null;
  if (chain !== null) {
    $.netName.textContent = `${chain.name} · chain ${String(chain.chainId)}`;
    $.netWallet.textContent =
      state.walletChainId === null
        ? "not connected"
        : state.walletChainId === chain.chainId
          ? `${chain.name} ✓`
          : `${state.chains.get(state.walletChainId)?.name ?? "another network"} (chain ${String(state.walletChainId)})`;
    $.netBalance.textContent = state.balance === null ? "—" : nativeAmount(chain, state.balance, "down");
  }
  const needSwitch = chain !== null && state.account !== null && state.walletChainId !== chain.chainId;
  $.switchKey.hidden = !needSwitch;
  $.switchKey.disabled = busy || fatal;
  if (chain !== null) {
    $.switchKey.textContent = `Switch wallet to ${chain.name}`;
  }
  if (state.account !== null && chain === null && state.walletChainId !== null && !state.chains.has(state.walletChainId) && $.networkStatus.textContent === "") {
    say($.networkStatus, `The wallet is on chain ${String(state.walletChainId)}, which is not a PayLink v2 deployment target. Pick a network.`, "err");
  } else if (!needSwitch && $.networkStatus.classList.contains("err") && chain !== null) {
    say($.networkStatus, "");
  }

  // 03
  renderReview();
  const plan = state.review?.plan;
  $.deploy.textContent = plan?.kind === "verify" ? "Verify the deployed contract" : chain === null ? "Deploy PayLinkV2" : `Deploy PayLinkV2 to ${chain.name}`;
  $.deploy.disabled = fatal || !canAct();
  $.deploy.setAttribute("aria-busy", busy ? "true" : "false");

  // 04
  renderResult();

  // Step lights
  const steps = /** @type {const} */ ([
    ["step-wallet", state.account !== null ? "done" : "current"],
    ["step-network", state.account === null ? "pending" : onRightChain() ? "done" : "current"],
    [
      "step-review",
      !onRightChain() || state.account === null ? "pending" : state.tx !== null || state.verification !== null ? "done" : "current",
    ],
    [
      "step-record",
      state.phase === "done" || state.phase === "verified"
        ? "done"
        : state.phase === "failed" && (state.tx !== null || state.verification !== null)
          ? "failed"
          : state.tx !== null || state.phase === "verifying"
            ? "current"
            : "pending",
    ],
  ]);
  for (const [id, s] of steps) {
    byId(id).dataset["state"] = fatal ? "pending" : s;
  }
}

function wireEvents() {
  $.switchKey.addEventListener("click", () => {
    void switchNetwork();
  });
  $.deploy.addEventListener("click", () => {
    void onDeploy();
  });
  $.txForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const chain = selected();
    const plan = state.review?.plan;
    const value = $.txInput.value.trim().toLowerCase();
    if (chain === null || plan?.kind !== "verify") {
      return;
    }
    if (!/^0x[0-9a-f]{64}$/.test(value)) {
      say($.status, "A transaction hash is 0x followed by 64 hexadecimal characters.", "err");
      return;
    }
    void verify(chain, plan.address, /** @type {Hex} */ (value), false);
  });
  $.copy.addEventListener("click", () => {
    const record = state.verification?.record;
    if (record === null || record === undefined) {
      return;
    }
    // From state, never from the DOM (spec §3.6).
    navigator.clipboard.writeText(record).then(
      () => {
        $.copy.textContent = "Copied";
        $.copy.classList.add("is-done");
        setTimeout(() => {
          $.copy.textContent = "Copy";
          $.copy.classList.remove("is-done");
        }, 2000);
      },
      () => {
        getSelection()?.selectAllChildren($.recordJson);
        say($.status, "The clipboard is blocked here: the record is selected, copy it with your keyboard.", "err");
      },
    );
  });
  $.download.addEventListener("click", () => {
    const record = state.verification?.record;
    const chain = selected();
    if (record === null || record === undefined || chain === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([record], { type: "application/json" }));
    const a = h("a", { href: url, download: `${String(chain.chainId)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  });
}

void boot();
