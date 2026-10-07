// SPDX-License-Identifier: MIT
// @ts-check
/**
 * On-chain verification of a PayLinkV2 deployment and its record, shared by the deploy page and
 * tools/verify-deployment. Reads through any `Reader` (lib/rpc.js); decides with the pure rules of lib/core.js.
 *
 * @module
 */
import { allPassed, deploymentRecordJson, verifyCode, verifyDeploymentTx } from "./core.js";

/** @typedef {import("./core.js").Hex} Hex */
/** @typedef {import("./core.js").Address} Address */
/** @typedef {import("./core.js").Check} Check */
/** @typedef {import("./core.js").ReleaseData} ReleaseData */
/** @typedef {import("./core.js").ChainConfig} ChainConfig */
/** @typedef {import("./rpc.js").Reader} Reader */

/**
 * @typedef {object} Verification
 * @property {boolean} ok              every check passed
 * @property {Check[]} checks
 * @property {Hex} code                runtime code read at the address
 * @property {"CREATE2" | "CREATE" | null} method
 * @property {import("./core.js").TxFacts | null} tx
 * @property {import("./core.js").ReceiptFacts | null} receipt
 * @property {string | null} record    deployments/<chainId>.json, when the transaction was given and everything passed
 */

/**
 * Verifies the contract at `address` on `chain` through `read`, and, with `txHash`, the transaction that deployed it;
 * then renders the deployment record. The RPC must report the chain's id, so a wallet or endpoint on another chain can
 * never produce a record for this one.
 *
 * @param {object} p
 * @param {Reader} p.read
 * @param {ReleaseData} p.data
 * @param {ChainConfig} p.chain
 * @param {Address} p.address
 * @param {Hex | null} [p.txHash]
 * @param {string} [p.commit]   source.commit of the record (default: the release data's sourceCommit)
 * @returns {Promise<Verification>}
 */
export async function verifyDeployment({ read, data, chain, address, txHash = null, commit = data.sourceCommit }) {
  /** @type {Check[]} */
  const checks = [];
  const reported = await read.chainId();
  checks.push({ id: "chain", label: "RPC is on the expected chain", ok: reported === chain.chainId, detail: `chain ${String(reported)}, expected ${String(chain.chainId)} (${chain.name})` });
  if (reported !== chain.chainId) {
    return { ok: false, checks, code: "0x", method: null, tx: null, receipt: null, record: null };
  }
  const code = await read.code(address);
  const domain = code === "0x" ? null : await read.eip712Domain(address);
  checks.push(...verifyCode({ data, chainId: chain.chainId, address, code, domain }));

  /** @type {Verification["tx"]} */
  let tx = null;
  /** @type {Verification["receipt"]} */
  let receipt = null;
  /** @type {Verification["method"]} */
  let method = null;
  if (txHash !== null) {
    tx = await read.transaction(txHash, chain.chainId);
    receipt = await read.receipt(txHash);
    const result = verifyDeploymentTx({ data, chainId: chain.chainId, address, tx, receipt });
    checks.push(...result.checks);
    method = result.method;
  }
  const ok = allPassed(checks);
  const record =
    ok && tx !== null && receipt !== null && method !== null && txHash !== null
      ? deploymentRecordJson(data, chain, { address, method, deployer: tx.from, txHash, blockNumber: receipt.blockNumber, runtimeCode: code, commit })
      : null;
  return { ok, checks, code, method, tx, receipt, record };
}
