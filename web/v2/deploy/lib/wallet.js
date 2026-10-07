// SPDX-License-Identifier: MIT
// @ts-check
/**
 * Wallet discovery (EIP-6963) and network switching (EIP-3326, EIP-3085) for the deploy page.
 *
 * @module
 */
import { numberToHex } from "../vendor/viem.js";
import { RpcError } from "./rpc.js";

/** @typedef {import("./rpc.js").Eip1193Provider & { on?: (event: string, listener: (...args: any[]) => void) => void;
 *   removeListener?: (event: string, listener: (...args: any[]) => void) => void }} Provider */

/**
 * @typedef {object} WalletInfo
 * @property {string} uuid
 * @property {string} name
 * @property {string | null} icon   a `data:image/...` URI (EIP-6963 requires RFC 2397), or null
 * @property {string} rdns
 */

/** @typedef {{ info: WalletInfo; provider: Provider }} WalletDetail */

/**
 * @param {unknown} raw
 * @returns {WalletInfo | null}
 */
function sanitizeInfo(raw) {
  const info = /** @type {Record<string, unknown>} */ (raw);
  if (typeof info !== "object" || info === null) {
    return null;
  }
  const { uuid, name, icon, rdns } = info;
  if (typeof uuid !== "string" || uuid.length === 0 || uuid.length > 64 || typeof name !== "string" || typeof rdns !== "string") {
    return null;
  }
  // Names are shown as text; control and format characters (bidi overrides, zero-width joiners) are stripped so a
  // wallet cannot dress its label up as another's.
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 48);
  if (clean === "") {
    return null;
  }
  const safeIcon = typeof icon === "string" && /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(icon) && icon.length < 200_000 ? icon : null;
  return { uuid, name: clean, icon: safeIcon, rdns: rdns.slice(0, 120) };
}

/**
 * Listens for EIP-6963 announcements and asks wallets to announce themselves. Calls `onChange` with the current
 * list whenever it grows. A legacy `window.ethereum` is offered only when no wallet announces itself within
 * `legacyAfterMs`, so it never duplicates an EIP-6963 wallet.
 *
 * @param {(wallets: WalletDetail[]) => void} onChange
 * @param {{ legacyAfterMs?: number }} [options]
 * @returns {() => void} stop listening
 */
export function discoverWallets(onChange, { legacyAfterMs = 600 } = {}) {
  /** @type {Map<string, WalletDetail>} */
  const wallets = new Map();
  /** @param {Event} event */
  const onAnnounce = (event) => {
    const detail = /** @type {CustomEvent<{ info?: unknown; provider?: Provider }>} */ (event).detail;
    const info = sanitizeInfo(detail?.info);
    const provider = detail?.provider;
    if (info === null || provider === undefined || typeof provider.request !== "function" || wallets.has(info.uuid)) {
      return;
    }
    wallets.set(info.uuid, Object.freeze({ info: Object.freeze(info), provider }));
    onChange([...wallets.values()]);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const timer = setTimeout(() => {
    const legacy = /** @type {{ ethereum?: Provider }} */ (/** @type {unknown} */ (window)).ethereum;
    if (wallets.size === 0 && legacy !== undefined && typeof legacy.request === "function") {
      wallets.set("injected", { info: { uuid: "injected", name: "Browser wallet", icon: null, rdns: "injected" }, provider: legacy });
      onChange([...wallets.values()]);
    } else if (wallets.size === 0) {
      onChange([]);
    }
  }, legacyAfterMs);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

/** True for the wallet's "unknown chain" answers: 4902 (EIP-3326), and MetaMask mobile's wrapped -32603. */
export function isUnknownChainError(/** @type {unknown} */ error) {
  if (!(error instanceof RpcError)) {
    return false;
  }
  if (error.code === 4902) {
    return true;
  }
  const original = /** @type {{ originalError?: { code?: unknown } } | undefined} */ (error.data)?.originalError?.code;
  return error.code === -32603 && (original === 4902 || /unrecognized chain|unknown chain|add.*chain/i.test(error.message));
}

/**
 * Switches the wallet to `chain`, adding it first (EIP-3085, with the registry's RPC and explorer URLs) when the wallet
 * does not know it.
 *
 * @param {import("./rpc.js").Rpc} rpc  the wallet
 * @param {import("./core.js").ChainConfig} chain
 * @returns {Promise<"switched" | "added">}
 */
export async function switchOrAddChain(rpc, chain) {
  const chainId = numberToHex(chain.chainId);
  try {
    await rpc.request("wallet_switchEthereumChain", [{ chainId }]);
    return "switched";
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw error;
    }
  }
  await rpc.request("wallet_addEthereumChain", [
    {
      chainId,
      chainName: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpc,
      blockExplorerUrls: chain.explorers.map((e) => e.url),
    },
  ]);
  // Most wallets switch on add; asking again is harmless and covers the ones that do not.
  await rpc.request("wallet_switchEthereumChain", [{ chainId }]);
  return "added";
}

/**
 * A short sentence for a wallet or RPC failure.
 * @param {unknown} error
 * @returns {string}
 */
export function walletMessage(error) {
  if (error instanceof RpcError) {
    switch (error.code) {
      case 4001:
        return "You declined the request in your wallet. Nothing was sent.";
      case 4100:
        return "The wallet has not authorised this page for that account. Connect again.";
      case 4200:
        return "The wallet does not support this request.";
      case 4900:
      case 4901:
        return "The wallet is disconnected from the network.";
      case -32002:
        return "The wallet already has a request waiting. Open the wallet and answer it.";
      default:
        return `Wallet or RPC error ${String(error.code)}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
