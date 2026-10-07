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

/** @typedef {`0x${string}`} Hex */
/** @typedef {`0x${string}`} Address */

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
 */

/**
 * @typedef {object} ReceiptFacts
 * @property {boolean} success
 * @property {bigint} blockNumber
 * @property {Address | null} contractAddress
 * @property {bigint} gasUsed
 */

/**
 * The deployment transaction is the release deployment that put the contract at `address` (`Deploy.s.sol
 * _fromBroadcast`): sent on this chain, succeeded, and either a call to the factory with `salt ++ initCode` that lands
 * on the CREATE2 address, or a contract creation with the init code whose address follows from sender and nonce.
 *
 * @param {object} p
 * @param {ReleaseData} p.data
 * @param {number} p.chainId
 * @param {Address} p.address
 * @param {TxFacts | null} p.tx
 * @param {ReceiptFacts | null} p.receipt
 * @returns {{ checks: Check[]; method: "CREATE2" | "CREATE" | null }}
 */
export function verifyDeploymentTx({ data, chainId, address, tx, receipt }) {
  const r = data.release;
  /** @type {Check[]} */
  const checks = [];
  if (tx === null || receipt === null) {
    checks.push({ id: "tx", label: "Deployment transaction", ok: false, detail: tx === null ? "transaction not found" : "receipt not found (not mined yet?)" });
    return { checks, method: null };
  }
  checks.push({ id: "tx-chain", label: "Transaction chain", ok: tx.chainId === chainId, detail: `chain ${String(tx.chainId)}` });
  checks.push({ id: "tx-status", label: "Transaction succeeded", ok: receipt.success, detail: `block ${receipt.blockNumber.toString()}, ${receipt.gasUsed.toString()} gas used` });
  /** @type {"CREATE2" | "CREATE" | null} */
  let method = null;
  if (tx.to !== null && tx.to === r.create2.factory) {
    method = "CREATE2";
    const expectedInput = concat([r.create2.salt, data.initCode]).toLowerCase();
    checks.push({ id: "tx-input", label: "Factory call carries salt and release init code", ok: tx.input.toLowerCase() === expectedInput, detail: `salt ${r.create2.salt}` });
    checks.push({ id: "tx-address", label: "Lands on the CREATE2 address", ok: address === r.create2.address, detail: r.create2.address });
  } else if (tx.to === null) {
    method = "CREATE";
    const initOk = tx.input.toLowerCase() === data.initCode.toLowerCase();
    checks.push({ id: "tx-input", label: "Creation carries the release init code", ok: initOk, detail: initOk ? r.bytecode.initCodeHash : `keccak256 ${keccak256(tx.input)}` });
    const computed = getCreateAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
    checks.push({
      id: "tx-address",
      label: "Address follows from deployer and nonce",
      ok: computed === address && receipt.contractAddress === address,
      detail: `${computed} (nonce ${String(tx.nonce)})`,
    });
  } else {
    checks.push({ id: "tx-input", label: "Deployment transaction", ok: false, detail: `a call to ${tx.to}, neither the CREATE2 factory nor a contract creation` });
  }
  return { checks, method };
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
 * @property {Address} deployer
 * @property {Hex} txHash
 * @property {bigint} blockNumber
 * @property {Hex} runtimeCode
 * @property {string} commit
 */

/**
 * `deployments/<chainId>.json` (schema `paylink.deployment/1`) exactly as `PayLinkRelease._deploymentJson` writes it:
 * same keys, same order, same layout, trailing newline.
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
  const tx = Json.obj(
    [
      Json.str("method", d.method),
      Json.str("deployer", getAddress(d.deployer)),
      Json.str("txHash", d.txHash),
      Json.num("blockNumber", d.blockNumber),
      viaFactory ? Json.str("factory", r.create2.factory) : Json.raw("factory", "null"),
      viaFactory ? Json.str("salt", r.create2.salt) : Json.raw("salt", "null"),
      viaFactory ? Json.str("saltPreimage", r.create2.saltPreimage) : Json.raw("saltPreimage", "null"),
    ],
    1,
  );
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
