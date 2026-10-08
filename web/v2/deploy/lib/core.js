// SPDX-License-Identifier: MIT
// @ts-check
/**
 * PayLinkV2 deployment logic shared by the deploy page (web/v2/deploy/app.js) and the command-line verifier
 * (tools/verify-deployment). Pure functions: no DOM, no network. Every rule restates protocol/script/Deploy.s.sol and
 * protocol/script/utils/PayLinkRelease.sol (PAYLINK-V2-SPEC §3.3.7), and the record writer reproduces their JSON
 * byte for byte, so a record printed by the page, written by the CLI or written by `forge script ... record()` is the
 * same file (tools/deploy-page/test and e2e/ check all three).
 *
 * @module
 */
import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  getCreateAddress,
  isAddress,
  isHex,
  keccak256,
  size,
  slice,
  stringToHex,
} from "../vendor/viem.js";
import { authorizationAuthority, delegationOf } from "./eip7702.js";

/** @typedef {`0x${string}`} Hex */
/** @typedef {`0x${string}`} Address */
/** @typedef {import("./eip7702.js").Authorization} Authorization */

/**
 * `deployments/release.json` (schema `paylink.release/1`), as written by `Predict.s.sol writeRelease()`.
 * @typedef {object} ReleaseRecord
 * @property {"paylink.release/1"} schema
 * @property {"PayLinkV2"} contract
 * @property {string} release
 * @property {{ initCodeHash: Hex; initCodeSize: number; maskedRuntimeHash: Hex; runtimeCodeSize: number; masking: string;
 *   immutableReferences: { start: number; length: number }[]; cborMetadata: Hex }} bytecode
 * @property {{ solc: string; evmVersion: string; optimizer: boolean; optimizerRuns: number; viaIR: boolean;
 *   bytecodeHash: string; settings: string; settingsHash: Hex }} compiler
 * @property {Record<string, string>} dependencies
 * @property {{ factory: Address; salt: Hex; saltPreimage: string; address: Address; note: string }} create2
 * @property {{ repository: string; path: string }} source
 */

/**
 * The page's release data (`data/release.json`, schema `paylink.deploy-page.release/1`).
 * @typedef {object} ReleaseData
 * @property {"paylink.deploy-page.release/1"} schema
 * @property {ReleaseRecord} release        protocol/deployments/release.json, verbatim
 * @property {Hex} initCode                 creation code of the release artifact
 * @property {string} sourceCommit          last commit that changed the release source
 * @property {Hex} factoryRuntime           runtime code of the deterministic-deployment proxy
 */

/**
 * @typedef {object} DeployGasEntry
 * @property {bigint} estimate
 * @property {bigint} gasUsed
 * @property {bigint} floor
 * @property {bigint} ceiling
 */

/**
 * One chain of the page's chain data (`data/chains.json`, schema `paylink.deploy-page.chains/1`), from @paylink/chains.
 * @typedef {object} ChainConfig
 * @property {number} chainId
 * @property {string} caip2
 * @property {string} name
 * @property {string} label
 * @property {string} tier
 * @property {boolean} testnet
 * @property {{ name: string; symbol: string; decimals: number }} nativeCurrency
 * @property {string[]} rpc
 * @property {{ name: string; url: string }[]} explorers
 * @property {{ chargesGasLimit: boolean; txGasCap: bigint | null; reserveBalance: bigint | null }} gasModel
 * @property {{ profile: string; hardfork: string; network: string; provisional: boolean; evidence: string;
 *   create: DeployGasEntry; create2: DeployGasEntry }} deployGas
 * @property {{ address: Address; method: "CREATE" | "CREATE2"; txHash: Hex; blockNumber: bigint; deployer: Address;
 *   status: string } | null} deployment
 * @property {string[]} notes
 */

/** ERC-5267 `eip712Domain()`; the only function of PayLinkV2 the deployer calls. */
export const EIP712_DOMAIN_ABI = /** @type {const} */ ([
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
]);

/** keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"). */
export const EIP712_DOMAIN_TYPEHASH = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
export const DOMAIN_NAME = "PayLink";
export const DOMAIN_VERSION = "2";

/** The ten percent estimate margin of PAYLINK-V2-SPEC §3.3.6, as in `@paylink/sdk` `clampGasLimit`. */
export const GAS_ESTIMATE_MARGIN = /** @type {const} */ ({ numerator: 110n, denominator: 100n });

/** A refusal with a stable code that the page and the CLI map to their own wording. */
export class DeployError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DeployError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {boolean} condition
 * @param {string} code
 * @param {string} message
 * @returns {asserts condition}
 */
function ensure(condition, code, message) {
  if (!condition) {
    throw new DeployError(code, message);
  }
}

/** @param {unknown} value @returns {value is Hex} */
const isBytes32 = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {Address}
 */
function checksummed(value, field) {
  ensure(typeof value === "string" && isAddress(value, { strict: false }), "E_DATA", `${field}: not an address`);
  const address = getAddress(value);
  ensure(address === value, "E_DATA", `${field}: ${value} is not EIP-55 checksummed`);
  return address;
}

// ------------------------------------------------------------------------------------------------ data

/**
 * Validates the release data and proves its internal consistency before anything is shown or signed:
 * keccak256(initCode) is the recorded initCodeHash, the salt is keccak256 of its preimage, and the CREATE2 address is
 * the one the factory, the salt and the initCodeHash give.
 *
 * @param {unknown} json
 * @returns {ReleaseData}
 */
export function parseReleaseData(json) {
  const data = /** @type {ReleaseData} */ (json);
  ensure(data !== null && typeof data === "object" && data.schema === "paylink.deploy-page.release/1", "E_DATA", "release data: schema");
  const r = data.release;
  ensure(r.schema === "paylink.release/1" && r.contract === "PayLinkV2", "E_DATA", "release data: not a PayLinkV2 release record");
  ensure(typeof data.initCode === "string" && isHex(data.initCode, { strict: true }) && data.initCode.length > 2, "E_DATA", "release data: initCode");
  ensure(/^[0-9a-f]{40}$/.test(data.sourceCommit) || data.sourceCommit === "unknown", "E_DATA", "release data: sourceCommit");
  ensure(isHex(data.factoryRuntime, { strict: true }) && data.factoryRuntime.length > 2, "E_DATA", "release data: factoryRuntime");
  ensure(isBytes32(r.bytecode.initCodeHash) && isBytes32(r.bytecode.maskedRuntimeHash), "E_DATA", "release data: hashes");
  ensure(keccak256(data.initCode) === r.bytecode.initCodeHash, "E_INITCODE", "release data: keccak256(initCode) differs from the release initCodeHash");
  ensure(size(data.initCode) === r.bytecode.initCodeSize, "E_INITCODE", "release data: initCode size differs from the release");
  ensure(keccak256(stringToHex(r.create2.saltPreimage)) === r.create2.salt, "E_DATA", "release data: salt is not keccak256(saltPreimage)");
  const factory = checksummed(r.create2.factory, "release.create2.factory");
  const predicted = getCreate2Address({ from: factory, salt: r.create2.salt, bytecodeHash: r.bytecode.initCodeHash });
  ensure(predicted === checksummed(r.create2.address, "release.create2.address"), "E_DATA", "release data: CREATE2 address does not follow from factory, salt and initCodeHash");
  ensure(r.bytecode.immutableReferences.length === 7, "E_DATA", "release data: expected the seven EIP712 immutables");
  for (const ref of r.bytecode.immutableReferences) {
    ensure(Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.length === 32, "E_DATA", "release data: immutable reference");
  }
  return data;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {bigint}
 */
function big(value, field) {
  ensure(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "E_DATA", `${field}: not a decimal string`);
  return BigInt(value);
}

/**
 * Parses the page's chain data: the chains a PayLinkV2 deployment may target, as generated from @paylink/chains.
 *
 * @param {unknown} json
 * @returns {Map<number, ChainConfig>}
 */
export function parseChainsData(json) {
  const data = /** @type {{ schema: string; chains: Record<string, any>[] }} */ (json);
  ensure(data !== null && typeof data === "object" && data.schema === "paylink.deploy-page.chains/1", "E_DATA", "chain data: schema");
  /** @type {Map<number, ChainConfig>} */
  const chains = new Map();
  for (const c of data.chains) {
    ensure(Number.isSafeInteger(c["chainId"]) && c["chainId"] > 0 && c["caip2"] === `eip155:${String(c["chainId"])}`, "E_DATA", "chain data: chainId");
    const id = /** @type {number} */ (c["chainId"]);
    ensure(!chains.has(id), "E_DATA", `chain data: ${String(id)} listed twice`);
    const rpc = /** @type {string[]} */ (c["rpc"]);
    ensure(Array.isArray(rpc) && rpc.length > 0 && rpc.every((u) => new URL(u).protocol === "https:"), "E_DATA", `chain data: ${String(id)} rpc`);
    const gas = c["deployGas"];
    /** @param {Record<string, unknown>} e @param {string} f @returns {DeployGasEntry} */
    const entry = (e, f) => {
      const parsed = { estimate: big(e["estimate"], f), gasUsed: big(e["gasUsed"], f), floor: big(e["floor"], f), ceiling: big(e["ceiling"], f) };
      ensure(parsed.floor > 0n && parsed.floor <= parsed.ceiling, "E_DATA", `${f}: floor/ceiling`);
      return parsed;
    };
    const d = c["deployment"];
    chains.set(id, {
      chainId: id,
      caip2: c["caip2"],
      name: c["name"],
      label: c["label"],
      tier: c["tier"],
      testnet: c["testnet"] === true,
      nativeCurrency: c["nativeCurrency"],
      rpc,
      explorers: c["explorers"],
      gasModel: {
        chargesGasLimit: c["gasModel"]["chargesGasLimit"] === true,
        txGasCap: c["gasModel"]["txGasCap"] === null ? null : big(c["gasModel"]["txGasCap"], "txGasCap"),
        reserveBalance: c["gasModel"]["reserveBalance"] === null ? null : big(c["gasModel"]["reserveBalance"], "reserveBalance"),
      },
      deployGas: { ...gas, create: entry(gas["create"], `${String(id)}.create`), create2: entry(gas["create2"], `${String(id)}.create2`) },
      deployment:
        d === null
          ? null
          : {
              address: checksummed(d["address"], `${String(id)} deployment`),
              method: d["method"],
              txHash: d["txHash"],
              blockNumber: big(d["blockNumber"], "blockNumber"),
              deployer: checksummed(d["deployer"], `${String(id)} deployer`),
              status: d["status"],
            },
      notes: c["notes"],
    });
  }
  return chains;
}

/**
 * The chain config of `chainId`, or a refusal: the page and the CLI deploy and record only on the chains of the
 * registry's deploy list, never on a chain a wallet or a URL names.
 *
 * @param {Map<number, ChainConfig>} chains
 * @param {number} chainId
 * @returns {ChainConfig}
 */
export function chainOrThrow(chains, chainId) {
  const chain = chains.get(chainId);
  if (chain === undefined) {
    throw new DeployError("E_UNKNOWN_CHAIN", `chain ${String(chainId)} is not a PayLink v2 deployment target (allowed: ${[...chains.keys()].join(", ")})`, { chainId });
  }
  return chain;
}

// ------------------------------------------------------------------------------------------------ planning

/**
 * @typedef {{ kind: "deploy"; method: "CREATE2" | "CREATE"; to: Address | null; data: Hex; expectedAddress: Address;
 *   gas: DeployGasEntry }
 *   | { kind: "verify"; method: "CREATE2" | "CREATE"; address: Address; reason: "recorded" | "occupied" }} DeploymentPlan
 */

/**
 * What `Deploy.s.sol run()` would do on this chain, from read-only facts:
 * 1. a recorded deployment (`deployments/<chainId>.json`, here the registry) is only verified, unless `redeploy`;
 *    if its address has no code, `RecordedDeploymentMissing`;
 * 2. with code at the factory (and not `forceCreate`): CREATE2 with `salt ++ initCode`; if the CREATE2 address is
 *    already occupied, only verify it;
 * 3. otherwise CREATE from the deployer, at `getCreateAddress(deployer, nonce)`.
 * One strengthening: code at the factory address that is not the canonical proxy runtime is refused instead of
 * being called, since its result could not be the predicted address.
 *
 * @param {object} p
 * @param {ReleaseData} p.data
 * @param {ChainConfig} p.chain
 * @param {Hex} p.factoryCode      eth_getCode(factory)
 * @param {Hex} p.create2Code      eth_getCode(CREATE2 address)
 * @param {Hex | null} p.recordedCode  eth_getCode(recorded address), when the chain has a recorded deployment
 * @param {Address} p.deployer
 * @param {number} p.nonce         eth_getTransactionCount(deployer, "pending")
 * @param {boolean} [p.forceCreate]   PAYLINK_FORCE_CREATE
 * @param {boolean} [p.redeploy]      PAYLINK_REDEPLOY
 * @returns {DeploymentPlan}
 */
export function planDeployment({ data, chain, factoryCode, create2Code, recordedCode, deployer, nonce, forceCreate = false, redeploy = false }) {
  const r = data.release;
  if (chain.deployment !== null && !redeploy) {
    ensure(recordedCode !== null && recordedCode !== "0x", "E_RECORDED_MISSING", `the recorded deployment ${chain.deployment.address} has no code on ${chain.name} (reset testnet?): redeploy explicitly`);
    return { kind: "verify", method: chain.deployment.method, address: chain.deployment.address, reason: "recorded" };
  }
  if (factoryCode !== "0x" && !forceCreate) {
    ensure(factoryCode.toLowerCase() === data.factoryRuntime.toLowerCase(), "E_FACTORY_CODE", `unexpected code at the CREATE2 factory ${r.create2.factory} on ${chain.name}: not the deterministic-deployment proxy`);
    if (create2Code !== "0x") {
      return { kind: "verify", method: "CREATE2", address: r.create2.address, reason: "occupied" };
    }
    return { kind: "deploy", method: "CREATE2", to: r.create2.factory, data: concat([r.create2.salt, data.initCode]), expectedAddress: r.create2.address, gas: chain.deployGas.create2 };
  }
  ensure(Number.isSafeInteger(nonce) && nonce >= 0, "E_ARGUMENT", "nonce");
  return { kind: "deploy", method: "CREATE", to: null, data: data.initCode, expectedAddress: getCreateAddress({ from: deployer, nonce: BigInt(nonce) }), gas: chain.deployGas.create };
}

/**
 * `clamp(ceil(estimate × 1.10), floor, ceiling)`, refusing an estimate above the ceiling, exactly as
 * `@paylink/sdk` `clampGasLimit` (PAYLINK-V2-SPEC §3.3.6): on Monad the whole limit is charged, and a limit below a
 * genuine estimate only buys a certain out-of-gas failure.
 *
 * @param {bigint} estimate
 * @param {{ floor: bigint; ceiling: bigint }} bounds
 * @returns {bigint}
 */
export function clampGasLimit(estimate, bounds) {
  ensure(estimate > 0n, "E_ARGUMENT", "the gas estimate must be positive");
  ensure(bounds.floor > 0n && bounds.floor <= bounds.ceiling, "E_ARGUMENT", "gas bounds must satisfy 0 < floor <= ceiling");
  if (estimate > bounds.ceiling) {
    throw new DeployError("E_GAS_ABOVE_CEILING", `the gas estimate ${estimate.toString()} is above the measured ceiling ${bounds.ceiling.toString()}`, {
      estimate: estimate.toString(),
      ceiling: bounds.ceiling.toString(),
    });
  }
  const margin = (estimate * GAS_ESTIMATE_MARGIN.numerator + GAS_ESTIMATE_MARGIN.denominator - 1n) / GAS_ESTIMATE_MARGIN.denominator;
  return margin < bounds.floor ? bounds.floor : margin > bounds.ceiling ? bounds.ceiling : margin;
}

/**
 * The deployment's cost in the native coin's base units:
 * - `expected`: what the chain charges at the current base fee plus tip. Monad charges the gas **limit**; the other
 *   chains charge the gas used, here the estimate;
 * - `maximum`: gasLimit × (2 × baseFee + tip), the upper bound a wallet reserves with the usual max-fee rule;
 * - plus the native balance needed.
 * Display only: the wallet sets the fees.
 *
 * @param {object} p
 * @param {bigint} p.gasLimit
 * @param {bigint} p.estimate
 * @param {bigint} p.baseFee
 * @param {bigint} p.priorityFee
 * @param {boolean} p.chargesGasLimit
 * @returns {{ chargedGas: bigint; expected: bigint; maximum: bigint; maxFeePerGas: bigint }}
 */
export function deploymentCost({ gasLimit, estimate, baseFee, priorityFee, chargesGasLimit }) {
  const chargedGas = chargesGasLimit ? gasLimit : estimate;
  const maxFeePerGas = 2n * baseFee + priorityFee;
  return { chargedGas, expected: chargedGas * (baseFee + priorityFee), maximum: gasLimit * maxFeePerGas, maxFeePerGas };
}

// ------------------------------------------------------------------------------------------------ verification

/**
 * keccak256 of the runtime code with every immutable range zeroed and the trailing CBOR metadata (length in the last
 * two bytes, plus those two bytes) removed: `PayLinkRelease._maskedRuntimeHash`.
 *
 * @param {Hex} code
 * @param {readonly { start: number; length: number }[]} ranges
 * @returns {{ hash: Hex; cbor: Hex }}
 */
export function maskRuntime(code, ranges) {
  const bytes = hexBytes(code);
  ensure(bytes.length >= 2, "E_CODE", "runtime code too short");
  const cborLength = ((bytes[bytes.length - 2] ?? 0) << 8) | (bytes[bytes.length - 1] ?? 0);
  ensure(bytes.length >= cborLength + 2, "E_CODE", "runtime code: CBOR length");
  const cut = bytes.length - cborLength - 2;
  const masked = bytes.slice(0, cut);
  for (const r of ranges) {
    ensure(r.start + r.length <= cut, "E_CODE", "runtime code: immutable range");
    masked.fill(0, r.start, r.start + r.length);
  }
  return { hash: keccak256(masked), cbor: slice(code, cut) };
}

/**
 * The seven words OpenZeppelin `EIP712("PayLink", "2")` stores as immutables when deployed at `address` on `chainId`
 * (`PayLinkRelease._expectedImmutables`): hashed name and version, cached domain separator, chain id, address, and the
 * two ShortStrings (bytes left-aligned, length in the last byte).
 *
 * @param {number} chainId
 * @param {Address} address
 * @returns {Hex[]}
 */
export function expectedImmutables(chainId, address) {
  const nameHash = keccak256(stringToHex(DOMAIN_NAME));
  const versionHash = keccak256(stringToHex(DOMAIN_VERSION));
  const separator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [EIP712_DOMAIN_TYPEHASH, nameHash, versionHash, BigInt(chainId), address],
    ),
  );
  /** @param {string} s @returns {Hex} */
  const shortString = (s) => {
    const raw = stringToHex(s).slice(2);
    return /** @type {Hex} */ (`0x${raw.padEnd(62, "0")}${s.length.toString(16).padStart(2, "0")}`);
  };
  return [
    nameHash,
    versionHash,
    separator,
    /** @type {Hex} */ (`0x${BigInt(chainId).toString(16).padStart(64, "0")}`),
    /** @type {Hex} */ (`0x${address.slice(2).toLowerCase().padStart(64, "0")}`),
    shortString(DOMAIN_NAME),
    shortString(DOMAIN_VERSION),
  ];
}

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {string} label
 * @property {boolean} ok
 * @property {string} detail
 */

/**
 * @typedef {object} DomainResult
 * @property {Hex} fields
 * @property {string} name
 * @property {string} version
 * @property {bigint} chainId
 * @property {Address} verifyingContract
 * @property {Hex} salt
 * @property {readonly bigint[]} extensions
 */

/** Calldata of `eip712Domain()`. */
export const EIP712_DOMAIN_CALLDATA = encodeFunctionData({ abi: EIP712_DOMAIN_ABI, functionName: "eip712Domain" });

/**
 * @param {Hex} returnData
 * @returns {DomainResult}
 */
export function decodeEip712Domain(returnData) {
  const [fields, name, version, chainId, verifyingContract, salt, extensions] = decodeFunctionResult({
    abi: EIP712_DOMAIN_ABI,
    functionName: "eip712Domain",
    data: returnData,
  });
  return { fields, name, version, chainId, verifyingContract, salt, extensions };
}

/**
 * The four checks of `PayLinkRelease._verifyDeployed`, plus the CBOR metadata and the code size: the code at
 * `address` is exactly what the release init code leaves there on this chain.
 *
 * @param {object} p
 * @param {ReleaseData} p.data
 * @param {number} p.chainId
 * @param {Address} p.address
 * @param {Hex} p.code             eth_getCode(address)
 * @param {Hex | null} p.domain    eth_call eip712Domain() return data, or null if the call reverted
 * @returns {Check[]}
 */
export function verifyCode({ data, chainId, address, code: rawCode, domain }) {
  const r = data.release;
  const code = /** @type {Hex} */ (rawCode.toLowerCase());
  /** @type {Check[]} */
  const checks = [];
  const present = code !== "0x";
  checks.push({ id: "code", label: "Contract code present", ok: present, detail: present ? `${String(size(code))} bytes` : "no code at this address" });
  if (!present) {
    return checks;
  }
  /** @type {{ hash: Hex; cbor: Hex }} */
  let masked;
  try {
    masked = maskRuntime(code, r.bytecode.immutableReferences);
  } catch (error) {
    checks.push({ id: "runtime", label: "Masked runtime hash", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  checks.push({
    id: "runtime",
    label: "Masked runtime hash",
    ok: masked.hash === r.bytecode.maskedRuntimeHash,
    detail: masked.hash === r.bytecode.maskedRuntimeHash ? masked.hash : `${masked.hash}, expected ${r.bytecode.maskedRuntimeHash}`,
  });
  const sizeOk = size(code) === r.bytecode.runtimeCodeSize && masked.cbor === r.bytecode.cborMetadata;
  checks.push({
    id: "metadata",
    label: "Code size and CBOR metadata",
    ok: sizeOk,
    detail: sizeOk ? `${String(size(code))} bytes, solc metadata of the release` : `size ${String(size(code))} (release ${String(r.bytecode.runtimeCodeSize)}) or metadata differs`,
  });
  const expected = expectedImmutables(chainId, address);
  const used = expected.map(() => false);
  let immutablesOk = r.bytecode.immutableReferences.length === expected.length;
  for (const ref of r.bytecode.immutableReferences) {
    const word = slice(code, ref.start, ref.start + 32);
    const index = expected.findIndex((value, i) => !used[i] && value === word);
    if (index === -1) {
      immutablesOk = false;
    } else {
      used[index] = true;
    }
  }
  checks.push({
    id: "immutables",
    label: "EIP-712 immutables bound to this chain and address",
    ok: immutablesOk,
    detail: immutablesOk ? `chain ${String(chainId)}, ${address}` : "copied or foreign code: the immutables name another chain or address",
  });
  /** @type {DomainResult | null} */
  let d = null;
  if (domain !== null) {
    try {
      d = decodeEip712Domain(domain);
    } catch {
      d = null;
    }
  }
  const domainOk =
    d !== null &&
    d.fields === "0x0f" &&
    d.name === DOMAIN_NAME &&
    d.version === DOMAIN_VERSION &&
    d.chainId === BigInt(chainId) &&
    d.verifyingContract === address &&
    d.salt === `0x${"00".repeat(32)}` &&
    d.extensions.length === 0;
  checks.push({
    id: "domain",
    label: "eip712Domain()",
    ok: domainOk,
    detail:
      d === null
        ? "eip712Domain() reverted or returned malformed data"
        : `${d.name} v${d.version}, chain ${d.chainId.toString()}, ${d.verifyingContract}${domainOk ? "" : " (expected PayLink v2, this chain and address, fields 0x0f, no salt or extensions)"}`,
  });
  return checks;
}

/**
 * @typedef {object} TxFacts
 * @property {Hex} hash
 * @property {Address} from
 * @property {Address | null} to
 * @property {Hex} input
 * @property {number} nonce
 * @property {bigint} gas         the transaction's gas limit (what Monad charges)
 * @property {number} chainId     from the transaction, or the chain's when the transaction carries none (legacy)
 * @property {number} type        EIP-2718 type (0 legacy, 2 EIP-1559, 4 EIP-7702 set-code, ...)
 * @property {Authorization[] | null} authorizationList  a type-4 transaction's authorizations, else null
 */

/**
 * @typedef {object} ReceiptFacts
 * @property {boolean} success
 * @property {bigint} blockNumber
 * @property {Address | null} contractAddress
 * @property {bigint} gasUsed
 */

/**
 * The factory call of the release, `salt ‖ initCode`: the whole input of a direct CREATE2 deployment (Deploy.s.sol).
 * @param {ReleaseData} data
 * @returns {Hex}
 */
export const factoryPayload = (data) => concat([data.release.create2.salt, data.initCode]);

/**
 * Byte offset of `needle` inside `haystack` (both hex, compared case-insensitively) on a byte boundary, or -1.
 *
 * @param {Hex} haystack
 * @param {Hex} needle
 * @returns {number}
 */
export function byteOffset(haystack, needle) {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().slice(2);
  for (let i = h.indexOf(n, 2); i !== -1; i = h.indexOf(n, i + 1)) {
    if (i % 2 === 0) {
      return (i - 2) / 2;
    }
  }
  return -1;
}

/**
 * How a transaction may have deployed the release:
 * - "direct": the transaction is the deployment, a call to the factory (CREATE2) or a contract creation (CREATE), and
 *   is judged exactly as `Deploy.s.sol _fromBroadcast` judges a broadcast;
 * - "relayed": a call to some other contract (a smart account, a relayer's entry point, an EIP-7702 delegation manager)
 *   whose input carries the factory call `salt ‖ initCode` byte for byte: a candidate CREATE2 by the factory inside it,
 *   which `verifyDeploymentTx` accepts only with the on-chain evidence of `RelayEvidence`;
 * - null: neither; not a deployment of the release.
 *
 * @param {ReleaseData} data
 * @param {TxFacts} tx
 * @returns {"direct" | "relayed" | null}
 */
export function deploymentRoute(data, tx) {
  if (tx.to === null || tx.to === data.release.create2.factory) {
    return "direct";
  }
  return byteOffset(tx.input, factoryPayload(data)) >= 0 ? "relayed" : null;
}

/**
 * One authorization of a type-4 transaction, with the authority recovered from its signature.
 * @typedef {object} AuthorizationEntry
 * @property {bigint} chainId
 * @property {Address} address           the code the authority delegated to
 * @property {bigint} nonce
 * @property {Address | null} authority  null when the protocol skips the tuple (another chain, invalid signature)
 */

/**
 * A type-4 transaction's authorizations and their authorities, or null for a transaction without an authorization list.
 *
 * @param {TxFacts} tx
 * @param {number} chainId
 * @returns {AuthorizationEntry[] | null}
 */
export function authorizationEntries(tx, chainId) {
  if (tx.authorizationList === null) {
    return null;
  }
  return tx.authorizationList.map((a) => ({ chainId: a.chainId, address: a.address, nonce: a.nonce, authority: authorizationAuthority(a, chainId) }));
}

/**
 * @param {TxFacts} tx
 * @param {Address} account
 */
const namedIn = (tx, account) => tx.to === account || byteOffset(tx.input, account) >= 0;

/**
 * The authorities of this transaction's authorizations that it names (as its target or inside its input): the accounts
 * that may have called the factory. lib/verify.js reads their code; `verifyDeploymentTx` keeps the delegated one.
 *
 * @param {TxFacts} tx
 * @param {number} chainId
 * @returns {Address[]}
 */
export function authorityCandidates(tx, chainId) {
  /** @type {Set<Address>} */
  const named = new Set();
  for (const e of authorizationEntries(tx, chainId) ?? []) {
    if (e.authority !== null && namedIn(tx, e.authority)) {
      named.add(e.authority);
    }
  }
  return [...named];
}

/**
 * `eth_getCode` at one block for the relayed route. `code` is null when the RPC serves no state there (not an archive
 * node), with its answer in `error`; `block` is "latest" when the reading fell back to the latest block.
 * @typedef {{ block: bigint | "latest"; code: Hex | null; error: string | null }} CodeReading
 */

/**
 * The on-chain evidence of a relayed deployment, read by lib/verify.js `relayEvidence` (reads only, no judgement).
 * @typedef {object} RelayEvidence
 * @property {CodeReading} before   the address at block N − 1, N being the transaction's block
 * @property {CodeReading} after    the address at block N, or at the latest block when the RPC serves no state at N
 * @property {{ source: string | null; result: unknown; errors: string[] }} trace  the transaction's trace when the RPC
 *   serves one (geth debug_traceTransaction with callTracer, or trace_transaction), else the RPC's refusals
 * @property {Record<string, CodeReading>} authorities  each of `authorityCandidates` at block N (or the latest block)
 */

/** @param {unknown} a @param {string} b */
const sameHex = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Finds in a transaction trace the factory's CREATE2 of the release at `address` and the account that called the factory
 * with `salt ‖ initCode`. Reads geth's callTracer tree or the parity/erigon `trace_transaction` list. Only creations that
 * stand count: neither the CREATE2 frame, the factory call, nor any frame around them reverted.
 *
 * @param {unknown} trace
 * @param {{ factory: Address; address: Address; initCode: Hex; payload: Hex }} expected
 * @returns {{ caller: Address } | null}
 */
export function create2InTrace(trace, { factory, address, initCode, payload }) {
  if (Array.isArray(trace)) {
    const entries = /** @type {Record<string, any>[]} */ (trace.filter((t) => t !== null && typeof t === "object" && Array.isArray(t.traceAddress)));
    /** @param {number[]} path */
    const at = (path) => entries.find((t) => t["traceAddress"].length === path.length && path.every((x, i) => t["traceAddress"][i] === x));
    for (const t of entries) {
      const path = /** @type {number[]} */ (t["traceAddress"]);
      if (t["type"] !== "create" || path.length === 0 || !sameHex(t["action"]?.from, factory) || !sameHex(t["action"]?.init, initCode) || !sameHex(t["result"]?.address, address)) {
        continue;
      }
      const parent = at(path.slice(0, -1));
      const action = parent?.["action"];
      const standing = path.every((_, i) => at(path.slice(0, i))?.["error"] === undefined) && t["error"] === undefined;
      if (standing && parent?.["type"] === "call" && (action?.callType ?? "call") === "call" && sameHex(action?.to, factory) && sameHex(action?.input, payload) && isAddress(action?.from ?? "")) {
        return { caller: getAddress(action.from) };
      }
    }
    return null;
  }
  /** @param {unknown} node @returns {{ caller: Address } | null} */
  const visit = (node) => {
    const frame = /** @type {Record<string, any> | null} */ (node !== null && typeof node === "object" ? node : null);
    if (frame === null || frame["error"] !== undefined) {
      return null;
    }
    const calls = /** @type {unknown[]} */ (Array.isArray(frame["calls"]) ? frame["calls"] : []);
    const created = calls.some((c) => {
      const f = /** @type {Record<string, any> | null} */ (c !== null && typeof c === "object" ? c : null);
      return f !== null && f["type"] === "CREATE2" && f["error"] === undefined && sameHex(f["from"], factory) && sameHex(f["to"], address) && sameHex(f["input"], initCode);
    });
    if (created && frame["type"] === "CALL" && sameHex(frame["to"], factory) && sameHex(frame["input"], payload) && isAddress(frame["from"] ?? "")) {
      return { caller: getAddress(frame["from"]) };
    }
    for (const c of calls) {
      const found = visit(c);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return visit(trace);
}

/**
 * The verdict on a deployment transaction.
 * @typedef {object} TxVerdict
 * @property {Check[]} checks
 * @property {"CREATE2" | "CREATE" | null} method
 * @property {"direct" | "relayed" | null} route
 * @property {Address | null} deployer   the account whose call reached the factory, or that sent the creation; null when
 *   a relayed deployment does not show it
 * @property {Address | null} submitter  the transaction's sender (a relayer on the relayed route)
 * @property {AuthorizationEntry[] | null} authorization  a type-4 transaction's authorizations, else null
 */

/** @param {CodeReading} reading */
const atBlock = (reading) => (reading.block === "latest" ? "the latest block" : `block ${reading.block.toString()}`);

/**
 * The deployment transaction is the release deployment that put the contract at `address`.
 *
 * Direct route (`Deploy.s.sol _fromBroadcast`, unchanged): sent on this chain, succeeded, and either a call to the factory
 * with exactly `salt ++ initCode` that lands on the CREATE2 address, or a contract creation with the init code whose
 * address follows from sender and nonce. The deployer is the sender.
 *
 * Relayed route (a smart account or a relayer, for example MetaMask's EIP-7702 smart account: the wallet signs, a relayer
 * submits a transaction to a delegation contract, and the user's account calls the factory), CREATE2 through the
 * canonical factory only, with every one of: this chain; success; `salt ‖ initCode` contiguous in the input; the
 * address is the CREATE2 prediction; no code at the address at block N − 1 and code at block N (`relay.before` and
 * `relay.after`; without archive state, the evidence the RPC still serves, said so in the detail); and, when the RPC
 * serves a trace, the factory's CREATE2 of the release in it. Integrity is CREATE2's own (the address commits to the
 * factory, the salt and keccak256 of the init code) plus verifyCode. The deployer is the account that called the factory:
 * the trace's caller, else the one EIP-7702 authority of this transaction that the transaction names and that is
 * delegated to its authorization's address at block N, else null, with the reason in the check's detail.
 *
 * @param {object} p
 * @param {ReleaseData} p.data
 * @param {number} p.chainId
 * @param {Address} p.address
 * @param {TxFacts | null} p.tx
 * @param {ReceiptFacts | null} p.receipt
 * @param {RelayEvidence | null} [p.relay]  required to accept the relayed route
 * @returns {TxVerdict}
 */
export function verifyDeploymentTx({ data, chainId, address, tx, receipt, relay = null }) {
  const r = data.release;
  /** @type {Check[]} */
  const checks = [];
  if (tx === null || receipt === null) {
    checks.push({ id: "tx", label: "Deployment transaction", ok: false, detail: tx === null ? "transaction not found" : "receipt not found (not mined yet?)" });
    return { checks, method: null, route: null, deployer: null, submitter: null, authorization: null };
  }
  checks.push({ id: "tx-chain", label: "Transaction chain", ok: tx.chainId === chainId, detail: `chain ${String(tx.chainId)}` });
  checks.push({ id: "tx-status", label: "Transaction succeeded", ok: receipt.success, detail: `block ${receipt.blockNumber.toString()}, ${receipt.gasUsed.toString()} gas used` });
  const direct = { route: /** @type {const} */ ("direct"), deployer: tx.from, submitter: tx.from, authorization: null };
  if (tx.to !== null && tx.to === r.create2.factory) {
    const expectedInput = factoryPayload(data).toLowerCase();
    checks.push({ id: "tx-input", label: "Factory call carries salt and release init code", ok: tx.input.toLowerCase() === expectedInput, detail: `salt ${r.create2.salt}` });
    checks.push({ id: "tx-address", label: "Lands on the CREATE2 address", ok: address === r.create2.address, detail: r.create2.address });
    return { checks, method: "CREATE2", ...direct };
  }
  if (tx.to === null) {
    const initOk = tx.input.toLowerCase() === data.initCode.toLowerCase();
    checks.push({ id: "tx-input", label: "Creation carries the release init code", ok: initOk, detail: initOk ? r.bytecode.initCodeHash : `keccak256 ${keccak256(tx.input)}` });
    const computed = getCreateAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
    checks.push({
      id: "tx-address",
      label: "Address follows from deployer and nonce",
      ok: computed === address && receipt.contractAddress === address,
      detail: `${computed} (nonce ${String(tx.nonce)})`,
    });
    return { checks, method: "CREATE", ...direct };
  }
  const payload = factoryPayload(data);
  const offset = byteOffset(tx.input, payload);
  if (offset < 0) {
    checks.push({
      id: "tx-input",
      label: "Deployment transaction",
      ok: false,
      detail: `a call to ${tx.to}, neither the CREATE2 factory nor a contract creation, and its input does not carry the factory call (salt ‖ release init code)`,
    });
    return { checks, method: null, route: null, deployer: null, submitter: tx.from, authorization: null };
  }

  // Relayed: CREATE2 by the factory inside a call to another contract.
  const authorization = authorizationEntries(tx, chainId);
  checks.push({
    id: "tx-route",
    label: "Relayed transaction",
    ok: true,
    detail: `${tx.type === 4 ? "EIP-7702 set-code transaction (type 4)" : `type ${String(tx.type)} transaction`} from ${tx.from} to ${tx.to}`,
  });
  checks.push({ id: "tx-input", label: "Input carries the factory call (salt ‖ release init code)", ok: true, detail: `${String(size(payload))} bytes at byte ${String(offset)} of ${String(size(tx.input))}` });
  checks.push({ id: "tx-address", label: "Lands on the CREATE2 address", ok: address === r.create2.address, detail: r.create2.address });

  const n = receipt.blockNumber;
  const created = { id: "tx-created", label: "Code created in the transaction's block" };
  if (relay === null) {
    checks.push({ ...created, ok: false, detail: "no state evidence was read for this relayed transaction" });
  } else if (relay.before.block !== (n === 0n ? 0n : n - 1n) || (relay.after.block !== n && relay.after.block !== "latest")) {
    checks.push({ ...created, ok: false, detail: `the state evidence is not for blocks ${String(n - 1n)} and ${String(n)}` });
  } else if (relay.after.code === null || relay.after.code === "0x") {
    checks.push({ ...created, ok: false, detail: relay.after.code === null ? `no state at ${atBlock(relay.after)}: ${relay.after.error ?? ""}` : `no code at the address at ${atBlock(relay.after)}` });
  } else if (relay.before.code !== null && relay.before.code !== "0x") {
    checks.push({ ...created, ok: false, detail: `code was already at the address at ${atBlock(relay.before)}: this transaction did not create it` });
  } else if (relay.before.code === null) {
    checks.push({
      ...created,
      ok: true,
      detail: `code at ${atBlock(relay.after)}; absence at ${atBlock(relay.before)} not proven, the RPC serves no state there (${relay.before.error ?? "no answer"})`,
    });
  } else {
    checks.push({ ...created, ok: true, detail: `no code at ${atBlock(relay.before)}, code at ${atBlock(relay.after)} (historical eth_getCode)` });
  }

  /** @type {{ caller: Address } | null} */
  let traced = null;
  if (relay !== null && relay.trace.result !== null && relay.trace.result !== undefined) {
    traced = create2InTrace(relay.trace.result, { factory: r.create2.factory, address, initCode: data.initCode, payload });
    const source = relay.trace.source ?? "trace";
    checks.push({
      id: "tx-trace",
      label: "Trace shows the factory's CREATE2",
      ok: traced !== null,
      detail: traced !== null ? `${source}: ${traced.caller} called the factory, which created ${address}` : `${source}: no standing CREATE2 of the release at ${address} by the factory`,
    });
  }

  /** @type {Address | null} */
  let deployer = null;
  /** @type {string} */
  let why;
  if (traced !== null) {
    deployer = traced.caller;
    why = `${deployer}, the caller of the factory in the trace`;
  } else if (authorization === null) {
    why = "not determinable: the transaction carries no EIP-7702 authorization and the RPC serves no trace; recorded as null";
  } else {
    /** @type {Map<Address, string>} */
    const qualified = new Map();
    for (const e of authorization) {
      const reading = e.authority === null ? undefined : relay?.authorities[e.authority];
      if (e.authority !== null && reading !== undefined && reading.code !== null && namedIn(tx, e.authority) && delegationOf(reading.code) === e.address) {
        qualified.set(e.authority, `delegated to ${e.address} at ${atBlock(reading)}`);
      }
    }
    const [only] = qualified;
    if (qualified.size === 1 && only !== undefined) {
      deployer = only[0];
      why = `${deployer}: signed this transaction's EIP-7702 authorization, is named in it and is ${only[1]}`;
    } else if (qualified.size > 1) {
      why = `not determinable: several authorities qualify (${[...qualified.keys()].join(", ")}); recorded as null`;
    } else {
      why = "not determinable: no authority of this transaction's authorizations is named in it and delegated at its block, and the RPC serves no trace; recorded as null";
    }
  }
  checks.push({ id: "tx-deployer", label: "Account that called the factory", ok: true, detail: why });
  return { checks, method: "CREATE2", route: "relayed", deployer, submitter: tx.from, authorization };
}

// ------------------------------------------------------------------------------------------------ record

/** Deterministic JSON writer of `protocol/script/utils/Json.sol`: two-space indentation, fixed key order. */
const Json = {
  /** @param {string} value @returns {string} */
  escape(value) {
    let out = "";
    for (const c of value) {
      ensure((c.codePointAt(0) ?? 0) >= 0x20, "E_ARGUMENT", "Json: control character");
      out += c === '"' || c === "\\" ? `\\${c}` : c;
    }
    return out;
  },
  /** @param {string} key @param {string} value */
  str: (key, value) => `"${Json.escape(key)}": "${Json.escape(value)}"`,
  /** @param {string} key @param {string} json */
  raw: (key, json) => `"${Json.escape(key)}": ${json}`,
  /** @param {string} key @param {number | bigint} value */
  num: (key, value) => Json.raw(key, BigInt(value).toString()),
  /** @param {string} key @param {boolean} value */
  boolean: (key, value) => Json.raw(key, value ? "true" : "false"),
  /** @param {number} indent */
  pad: (indent) => "  ".repeat(indent),
  /** @param {string[]} parts @param {number} indent */
  join: (parts, indent) => parts.map((p) => Json.pad(indent) + p).join(",\n"),
  /** @param {string[]} members @param {number} indent */
  obj: (members, indent) => (members.length === 0 ? "{}" : `{\n${Json.join(members, indent + 1)}\n${Json.pad(indent)}}`),
  /** @param {string[]} items @param {number} indent */
  arr: (items, indent) => (items.length === 0 ? "[]" : `[\n${Json.join(items, indent + 1)}\n${Json.pad(indent)}]`),
  /** @param {string[]} members */
  oneLine: (members) => `{${members.join(", ")}}`,
};

/**
 * @typedef {object} DeploymentFacts
 * @property {Address} address
 * @property {"CREATE2" | "CREATE"} method
 * @property {Address | null} deployer  null only on the relayed route, when the account that called the factory is not shown
 * @property {Hex} txHash
 * @property {bigint} blockNumber
 * @property {Hex} runtimeCode
 * @property {string} commit
 * @property {{ submitter: Address; authorization: AuthorizationEntry[] | null }} [relayed]  the relayed route; absent: direct
 */

/**
 * `deployments/<chainId>.json` (schema `paylink.deployment/1`) exactly as `PayLinkRelease._deploymentJson` writes it:
 * same keys, same order, same layout, trailing newline. A relayed deployment (no forge equivalent: forge broadcasts
 * directly) appends three keys to `deployment`, after the forge ones: `route` ("relayed"), `submitter` (the relayer that
 * sent the transaction) and `authorization` (the type-4 authorizations with their recovered authorities, else null).
 * A record without `route` is direct, so the direct records of the page, the CLI and forge stay the same bytes.
 *
 * @param {ReleaseData} data
 * @param {ChainConfig} chain
 * @param {DeploymentFacts} d
 * @returns {string}
 */
export function deploymentRecordJson(data, chain, d) {
  const r = data.release;
  const address = getAddress(d.address);
  ensure(isBytes32(d.txHash), "E_ARGUMENT", "txHash must be a lowercase bytes32");
  const caip2 = `eip155:${String(chain.chainId)}`;
  const viaFactory = d.method === "CREATE2";
  const relayed = d.relayed ?? null;
  ensure(relayed === null ? d.deployer !== null : viaFactory, "E_ARGUMENT", "a direct deployment names its deployer; a relayed one is a CREATE2 through the factory");
  /** @param {string} key @param {Address | null} value */
  const addressOrNull = (key, value) => (value === null ? Json.raw(key, "null") : Json.str(key, getAddress(value)));
  const members = [
    Json.str("method", d.method),
    addressOrNull("deployer", d.deployer),
    Json.str("txHash", d.txHash),
    Json.num("blockNumber", d.blockNumber),
    viaFactory ? Json.str("factory", r.create2.factory) : Json.raw("factory", "null"),
    viaFactory ? Json.str("salt", r.create2.salt) : Json.raw("salt", "null"),
    viaFactory ? Json.str("saltPreimage", r.create2.saltPreimage) : Json.raw("saltPreimage", "null"),
  ];
  if (relayed !== null) {
    const authorization =
      relayed.authorization === null
        ? "null"
        : Json.arr(
            relayed.authorization.map((e) =>
              Json.oneLine([Json.num("chainId", e.chainId), Json.str("address", getAddress(e.address)), Json.num("nonce", e.nonce), addressOrNull("authority", e.authority)]),
            ),
            2,
          );
    members.push(Json.str("route", "relayed"), Json.str("submitter", getAddress(relayed.submitter)), Json.raw("authorization", authorization));
  }
  const tx = Json.obj(members, 1);
  const ranges = Json.arr(
    r.bytecode.immutableReferences.map((x) => Json.oneLine([Json.num("start", x.start), Json.num("length", x.length)])),
    2,
  );
  const bytecode = Json.obj(
    [
      Json.str("initCodeHash", r.bytecode.initCodeHash),
      Json.str("maskedRuntimeHash", r.bytecode.maskedRuntimeHash),
      Json.str("runtimeCodeHash", keccak256(d.runtimeCode)),
      Json.num("runtimeCodeSize", size(d.runtimeCode)),
      Json.str("masking", r.bytecode.masking),
      Json.raw("immutableReferences", ranges),
    ],
    1,
  );
  const c = r.compiler;
  const compiler = Json.obj(
    [
      Json.str("solc", c.solc),
      Json.str("evmVersion", c.evmVersion),
      Json.boolean("optimizer", c.optimizer),
      Json.num("optimizerRuns", c.optimizerRuns),
      Json.boolean("viaIR", c.viaIR),
      Json.str("bytecodeHash", c.bytecodeHash),
      Json.str("settings", c.settings),
      Json.str("settingsHash", c.settingsHash),
    ],
    1,
  );
  const dependencies = Json.obj(
    [Json.str("@openzeppelin/contracts", r.dependencies["@openzeppelin/contracts"] ?? ""), Json.str("forge-std", r.dependencies["forge-std"] ?? "")],
    1,
  );
  const source = Json.obj([Json.str("repository", r.source.repository), Json.str("path", r.source.path), Json.str("commit", d.commit)], 1);
  const domain = Json.obj(
    [Json.str("name", DOMAIN_NAME), Json.str("version", DOMAIN_VERSION), Json.num("chainId", chain.chainId), Json.str("verifyingContract", address)],
    1,
  );
  const explorers = Json.arr(
    chain.explorers.map((e) =>
      Json.obj([Json.str("name", e.name), Json.str("address", `${e.url}/address/${address}`), Json.str("tx", `${e.url}/tx/${d.txHash}`)], 2),
    ),
    1,
  );
  const top = [
    Json.str("schema", "paylink.deployment/1"),
    Json.str("contract", r.contract),
    Json.str("release", r.release),
    Json.num("chainId", chain.chainId),
    Json.str("caip2", caip2),
    Json.str("network", chain.name),
    Json.str("address", address),
    Json.str("caip10", `${caip2}:${address}`),
    Json.raw("deployment", tx),
    Json.raw("bytecode", bytecode),
    Json.raw("compiler", compiler),
    Json.raw("dependencies", dependencies),
    Json.raw("source", source),
    Json.raw("eip712Domain", domain),
    Json.raw("explorers", explorers),
  ];
  return `${Json.obj(top, 0)}\n`;
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * @param {Hex} hex
 * @returns {Uint8Array}
 */
function hexBytes(hex) {
  ensure(isHex(hex, { strict: true }) && hex.length % 2 === 0, "E_CODE", "not hex bytes");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  }
  return out;
}

/** @param {readonly Check[]} checks */
export const allPassed = (checks) => checks.length > 0 && checks.every((c) => c.ok);

/**
 * Explorer links of a chain (EIP-3091 layout).
 * @param {ChainConfig} chain
 * @param {"address" | "tx"} kind
 * @param {string} value
 */
export const explorerLinks = (chain, kind, value) => chain.explorers.map((e) => ({ name: e.name, href: `${e.url}/${kind}/${value}` }));
