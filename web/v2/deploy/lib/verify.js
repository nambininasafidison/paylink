// SPDX-License-Identifier: MIT
// @ts-check
/**
 * On-chain verification of a PayLinkV2 deployment and its record, shared by the deploy page and
 * tools/verify-deployment. Reads through any `Reader` (lib/rpc.js); decides with the pure rules of lib/core.js.
 *
 * @module
 */
import { allPassed, authorityCandidates, deploymentRecordJson, deploymentRoute, verifyCode, verifyDeploymentTx } from "./core.js";
import { RpcError } from "./rpc.js";

/** @typedef {import("./core.js").Hex} Hex */
/** @typedef {import("./core.js").Address} Address */
/** @typedef {import("./core.js").Check} Check */
/** @typedef {import("./core.js").ReleaseData} ReleaseData */
/** @typedef {import("./core.js").ChainConfig} ChainConfig */
/** @typedef {import("./core.js").CodeReading} CodeReading */
/** @typedef {import("./core.js").RelayEvidence} RelayEvidence */
/** @typedef {import("./core.js").TxFacts} TxFacts */
/** @typedef {import("./core.js").ReceiptFacts} ReceiptFacts */
/** @typedef {import("./rpc.js").Reader} Reader */

/**
 * @typedef {object} Verification
 * @property {boolean} ok              every check passed
 * @property {Check[]} checks
 * @property {Hex} code                runtime code read at the address
 * @property {"CREATE2" | "CREATE" | null} method
 * @property {"direct" | "relayed" | null} route
 * @property {Address | null} deployer    the account whose call reached the factory (or that sent the creation)
 * @property {Address | null} submitter   the transaction's sender (a relayer on the relayed route)
 * @property {RelayEvidence | null} evidence  what was read for a relayed transaction: historical code, trace
 * @property {TxFacts | null} tx
 * @property {ReceiptFacts | null} receipt
 * @property {string | null} record    deployments/<chainId>.json, when the transaction was given and everything passed
 */

/**
 * Reads the evidence of a relayed deployment: the address's code at blocks N − 1 and N (N: the transaction's block), the
 * transaction's trace when the endpoint serves one, and the code of the authorities the transaction names. A block whose
 * state the endpoint no longer keeps (not an archive node) is recorded as such, and block N falls back to the latest
 * block; core.js `verifyDeploymentTx` says so in its checks.
 *
 * @param {object} p
 * @param {Reader} p.read
 * @param {number} p.chainId
 * @param {Address} p.address
 * @param {TxFacts} p.tx
 * @param {ReceiptFacts} p.receipt
 * @returns {Promise<RelayEvidence>}
 */
export async function relayEvidence({ read, chainId, address, tx, receipt }) {
  /** @param {Address} who @param {bigint} block @returns {Promise<CodeReading>} */
  const codeAt = async (who, block) => {
    try {
      return { block, code: await read.codeAt(who, block), error: null };
    } catch (error) {
      if (error instanceof RpcError) {
        return { block, code: null, error: error.message };
      }
      throw error;
    }
  };
  /** @param {Address} who @param {bigint} block @returns {Promise<CodeReading>} */
  const atOrLatest = async (who, block) => {
    const reading = await codeAt(who, block);
    return reading.code !== null ? reading : { block: "latest", code: await read.code(who), error: reading.error };
  };
  const n = receipt.blockNumber;
  const before = n === 0n ? { block: 0n, code: /** @type {Hex} */ ("0x"), error: null } : await codeAt(address, n - 1n);
  const after = await atOrLatest(address, n);
  const trace = await read.trace(tx.hash);
  /** @type {Record<string, CodeReading>} */
  const authorities = {};
  for (const authority of authorityCandidates(tx, chainId)) {
    authorities[authority] = await atOrLatest(authority, n);
  }
  return { before, after, trace, authorities };
}

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
  /** @type {Verification} */
  const result = { ok: false, checks, code: "0x", method: null, route: null, deployer: null, submitter: null, evidence: null, tx: null, receipt: null, record: null };
  if (reported !== chain.chainId) {
    return result;
  }
  const code = await read.code(address);
  result.code = code;
  const domain = code === "0x" ? null : await read.eip712Domain(address);
  checks.push(...verifyCode({ data, chainId: chain.chainId, address, code, domain }));

  /** @type {import("./core.js").TxVerdict | null} */
  let verdict = null;
  if (txHash !== null) {
    const tx = await read.transaction(txHash, chain.chainId);
    const receipt = await read.receipt(txHash);
    if (tx !== null && receipt !== null && receipt.success && deploymentRoute(data, tx) === "relayed") {
      result.evidence = await relayEvidence({ read, chainId: chain.chainId, address, tx, receipt });
    }
    verdict = verifyDeploymentTx({ data, chainId: chain.chainId, address, tx, receipt, relay: result.evidence });
    checks.push(...verdict.checks);
    Object.assign(result, { tx, receipt, method: verdict.method, route: verdict.route, deployer: verdict.deployer, submitter: verdict.submitter });
  }
  result.ok = allPassed(checks);
  if (result.ok && verdict !== null && verdict.method !== null && result.receipt !== null && txHash !== null) {
    result.record = deploymentRecordJson(data, chain, {
      address,
      method: verdict.method,
      deployer: verdict.deployer,
      txHash,
      blockNumber: result.receipt.blockNumber,
      runtimeCode: code,
      commit,
      ...(verdict.route === "relayed" && verdict.submitter !== null ? { relayed: { submitter: verdict.submitter, authorization: verdict.authorization } } : {}),
    });
  }
  return result;
}
