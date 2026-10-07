// SPDX-License-Identifier: MIT
/**
 * Types of the PayLink chain registry (`@paylink/chains`).
 *
 * The registry is the client's root of trust for addresses: `verifyingContract` is never read from
 * a URL, only from here (invoice spec §4.2). Every external fact carries the confidence tag it has
 * in PAYLINK-V2-SPEC §3.4, so that reviewers can see what was verified and what was not.
 *
 * @packageDocumentation
 */
import type { Address, Hex } from "viem";

/**
 * Confidence legend of PAYLINK-V2-SPEC:
 * - `UV`: verified by the owner on the official page;
 * - `C`: confirmed (primary source or code read, or checked live);
 * - `L`: likely (consistent secondary sources);
 * - `U`: unverified (a single source).
 */
export type Confidence = "UV" | "C" | "L" | "U";

/** Stable identifiers of the chains in the registry. */
export type ChainKey = "monad-testnet" | "monad" | "base-sepolia" | "arbitrum-sepolia" | "mezo-testnet" | "arc" | "local";

/** Web-app editions (ADR 0008). `all` lists every registry chain. */
export type Edition = "all" | "monad" | "base" | "mezo";

/** Which PayLink contract generation a chain runs. Arc mainnet stays on v1 (ADR 0010). */
export type ProtocolVersion = "v1" | "v2";

/**
 * `enabled`: offered by the editions that list the chain (payable once it has an active deployment).
 * `disabled`: registry-only, never offered (for example Monad mainnet until tier T2).
 */
export type ChainStatus = "enabled" | "disabled";

/**
 * Delivery tier of PAYLINK-V2-SPEC §0: T0 insurance version, T1 winning features, T2 only if ahead;
 * `later` for work planned after the Oct 12 submissions (Mezo waves, §9).
 */
export type Tier = "T0" | "T1" | "T2" | "later";

/** A JSON-RPC endpoint. The order of `ChainDefinition.rpc` is the fallback order. */
export interface RpcEndpoint {
  readonly url: string;
  /** Published request-rate limit, when the spec gives one. */
  readonly rateLimitRps?: number;
  readonly confidence: Confidence;
}

/** A block explorer that follows the EIP-3091 URL layout (`/tx/<hash>`, `/address/<address>`, `/block/<n>`). */
export interface Explorer {
  readonly name: string;
  /** Origin, `https://`, no trailing slash. */
  readonly url: string;
  readonly confidence: Confidence;
}

/** What a token supports. Exactly the flags PAYLINK-V2-SPEC §3.4 states; anything not stated is `false`. */
export interface TokenCapabilities {
  /** EIP-3009 `receiveWithAuthorization` (v, r, s form): the gasless `payWithAuthorization` path. */
  readonly eip3009: boolean;
  /** EIP-2612 `permit`: the `payWithPermit` path. */
  readonly eip2612: boolean;
  /** The chain's native coin, paid with `payNative` (`Invoice.token = address(0)`). */
  readonly native: boolean;
}

/** EIP-712 domain fields of a token that signs EIP-3009 or EIP-2612 messages. */
export interface TokenDomain {
  readonly name: string;
  readonly version: string;
}

/**
 * How the web app offers a token:
 * - `default`: preselected (one per chain at most);
 * - `listed`: offered in the token picker;
 * - `hidden`: allowlisted (links in it decode and verify) but not offered when creating a link.
 */
export type TokenListing = "default" | "listed" | "hidden";

/** A fact about a token that the spec does not state and that must be confirmed on chain before the chain is enabled. */
export type PendingVerification = "decimals" | "capabilities" | "eip712Domain";

interface TokenBase {
  readonly symbol: string;
  /** Human-readable label for the UI, not the token's on-chain `name()` (that is `eip712Domain.name` where stated). */
  readonly name: string;
  /** Base-unit decimals (6 for USDC and AUSD, 18 for MUSD and native coins). */
  readonly decimals: number;
  readonly listing: TokenListing;
  readonly confidence: Confidence;
  /** Facts assumed rather than stated by the spec. An enabled chain may not carry any. */
  readonly pendingVerification: readonly PendingVerification[];
  readonly note?: string;
}

/** An ERC-20 token on the chain's allowlist. */
export interface Erc20Token extends TokenBase {
  readonly kind: "erc20";
  /** EIP-55 checksummed. */
  readonly address: Address;
  readonly capabilities: TokenCapabilities & { readonly native: false };
  /**
   * The token's EIP-712 domain, when the spec states it (invoice spec §8.3). `null` means "read
   * `eip712Domain()` (or `name()` and `version()`) from the chain; never assume".
   */
  readonly eip712Domain: TokenDomain | null;
}

/** The chain's native coin, payable through `payNative` with `Invoice.token = address(0)`. */
export interface NativeToken extends TokenBase {
  readonly kind: "native";
  /** Always the zero address: the value of `Invoice.token` for native invoices. */
  readonly address: Address;
  readonly capabilities: { readonly eip3009: false; readonly eip2612: false; readonly native: true };
}

export type Token = Erc20Token | NativeToken;

/** An address that must never be offered or accepted, with the reason shown to the user. */
export interface DeniedAddress {
  readonly address: Address;
  readonly reason: string;
  readonly confidence: Confidence;
}

/** Well-known helper contracts. Only the ones the spec lists for a chain are present. */
export type HelperKey =
  | "multicall3"
  | "permit2"
  | "create2Deployer"
  | "ausdFaucet"
  | "agoraInstantSettlement"
  | "agoraWhitelister"
  | "btcErc20";

export interface HelperContract {
  readonly address: Address;
  readonly confidence: Confidence;
  readonly note?: string;
}

/** The six state-changing PayLinkV2 entry points that get a gas limit (spec §3.3.6). */
export type PayLinkFunction = "payWithAuthorization" | "pay" | "payWithPermit" | "payNative" | "cancel" | "cancelBySig";

/** Gas-limit bounds for one function: `gasLimit = clamp(estimate × 1.10, floor, ceiling)` (spec §3.3.6). */
export interface GasBounds {
  readonly floor: bigint;
  readonly ceiling: bigint;
}

/**
 * Gas of the PayLinkV2 deployment by one method (CREATE2 through the factory, or CREATE), measured on an anvil
 * profile, and the bounds a deployer clamps `eth_estimateGas × 1.10` to (floor = the estimate, ceiling = 1.5 × floor,
 * both rounded up to 1,000). Monad charges the whole gas limit (spec §3.3.6), so the deploy page refuses a live
 * estimate above the ceiling instead of sending an inflated limit.
 */
export interface DeployGasBounds extends GasBounds {
  /** eth_estimateGas on the anvil profile. */
  readonly estimate: bigint;
  /** gasUsed of the receipt on the anvil profile. */
  readonly gasUsed: bigint;
}

/** Deployment gas of PayLinkV2 on one chain, from the anvil profile that emulates it. */
export interface DeployGasTable {
  /** Name of the measured profile (`data/gas-measurements.json`). */
  readonly profile: string;
  /** anvil hardfork and network of the profile. */
  readonly hardfork: string;
  readonly network: string;
  /** True until re-measured on the chain itself. */
  readonly provisional: boolean;
  readonly evidence: string;
  readonly create: DeployGasBounds;
  readonly create2: DeployGasBounds;
}

/** Gas-limit bounds of every entry point on one chain. */
export interface GasTable {
  /**
   * `snapshot`: derived from the Foundry gas snapshot against mock tokens (`protocol/snapshots/PayLinkV2.json`,
   * Ethereum gas prices), and checked against eth_estimateGas on an anvil node emulating the chain;
   * `emulated`: derived from eth_estimateGas on an anvil node that emulates the chain's own gas schedule
   * (`data/gas-measurements.json`), used where the schedule differs from Ethereum's (Monad);
   * `testnet`: re-measured on the chain itself with cold slots and the real tokens (spec §3.3.6).
   */
  readonly source: "snapshot" | "emulated" | "testnet";
  /** True until the values are re-measured on the chain itself. */
  readonly provisional: boolean;
  /** Where the numbers come from, for reviewers. */
  readonly evidence: string;
  readonly limits: Readonly<Record<PayLinkFunction, GasBounds>>;
}

/** How a chain prices gas, as far as clients must care. */
export interface GasModel {
  /** Monad charges the gas **limit**, not the gas used (C): limits must be tight. */
  readonly chargesGasLimit: boolean;
  /** Per-transaction gas cap, when the spec gives one. */
  readonly txGasCap?: bigint;
  /** Minimum native balance an EOA must keep (Monad reserve balance, C). */
  readonly reserveBalance?: bigint;
}

/** Limits of the public RPC endpoints that clients must respect. */
export interface RpcLimits {
  /** Largest `eth_getLogs` block range accepted by the public endpoints. */
  readonly maxLogBlockRange?: number;
}

/**
 * What a relayer must assume about inclusion on a chain (invoice spec §13.3; audit finding A-04). A relayed call
 * carries time bounds chosen by others: the payer's EIP-3009 `validBefore`, the invoice's `validUntil` and a
 * cancellation's `deadline`. A bound that ends just after the block the relayer simulated against passes `eth_call`
 * and reverts in any later block, at the relayer's expense, without any transaction from whoever chose it.
 */
export interface RelayTiming {
  /**
   * Minimum remaining validity at admission: every time bound of a relayed call must still hold in a block stamped
   * `now + minRemainingSeconds`, where `now` is the timestamp of the block simulated against. At least the
   * worst-case delay from that simulation to inclusion, fee-bump replacements included. Integer seconds in
   * [1, 300], so that at least half of the recommended 600 s authorization window (invoice spec §8.3) stays usable.
   */
  readonly minRemainingSeconds: number;
  /** True until the inclusion latency is measured on the chain itself. */
  readonly provisional: boolean;
  /** How the value was derived, for reviewers. */
  readonly basis: string;
}

/** Lifecycle of a canonical deployment (invoice spec §4.2). */
export type DeploymentStatus = "active" | "deprecated" | "revoked";

/** A canonical PayLinkV2 deployment, generated from `protocol/deployments/<chainId>.json`. */
export interface Deployment {
  /** EIP-55 checksummed `verifyingContract`. */
  readonly address: Address;
  readonly status: DeploymentStatus;
  readonly release: string;
  readonly method: "CREATE" | "CREATE2";
  readonly deployer: Address;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly initCodeHash: Hex;
  readonly maskedRuntimeHash: Hex;
  readonly runtimeCodeHash: Hex;
}

/** PayLink v1 (Arc Microgrants) facts for a v1 chain: the frozen app and its configured contract. */
export interface V1Info {
  /** The v1 `PayLink` contract from `web/config.js`; `null` until it is deployed. */
  readonly address: Address | null;
  /** RPC and explorer configured in `web/config.js`. */
  readonly rpc: string;
  readonly explorer: string | null;
  /** Where the frozen v1 app is served (GitHub Pages, spec §3.11). */
  readonly app: string;
  /** Git tag of the frozen v1 submission. */
  readonly tag: string;
}

/** Envio HyperSync endpoints used by the indexer (spec §3.4, L). */
export interface IndexingInfo {
  readonly hypersync: readonly string[];
  readonly confidence: Confidence;
}

/** One chain of the registry. */
export interface ChainDefinition {
  readonly chainId: number;
  /** CAIP-2 identifier, `eip155:<chainId>`. */
  readonly caip2: `eip155:${number}`;
  readonly key: ChainKey;
  readonly name: string;
  /** Engraved band label (MONAD · BASE · ARB · MEZO · ARC); never a brand colour (spec §3.6). */
  readonly label: string;
  readonly testnet: boolean;
  /** Local development chains (anvil) may use `http://127.0.0.1` RPCs; real chains never. */
  readonly local: boolean;
  readonly status: ChainStatus;
  /** Delivery tier of the chain in the v2 plan; `null` for v1-only chains. */
  readonly tier: Tier | null;
  readonly protocol: ProtocolVersion;
  readonly editions: readonly Edition[];
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  readonly rpc: readonly RpcEndpoint[];
  readonly rpcLimits: RpcLimits;
  readonly explorers: readonly Explorer[];
  readonly tokens: readonly Token[];
  readonly deniedTokens: readonly DeniedAddress[];
  readonly contracts: Readonly<Partial<Record<HelperKey, HelperContract>>>;
  readonly gasModel: GasModel;
  /** Gas-limit bounds per entry point; `null` on v1 chains. */
  readonly gas: GasTable | null;
  /** What a relayer must assume about inclusion latency; `null` on v1 chains (no relayer). */
  readonly relay: RelayTiming | null;
  /** The canonical PayLinkV2 deployment, or `null` while the chain has none (then no link on it can be paid). */
  readonly deployment: Deployment | null;
  readonly v1: V1Info | null;
  readonly indexing: IndexingInfo | null;
  /** Confidence of the chain-level facts (PAYLINK-V2-SPEC §3.4 "Confidence" column). */
  readonly confidence: { readonly chainId: Confidence; readonly rpc: Confidence; readonly explorers: Confidence };
  /** Engineering facts a client must know, each with its confidence tag. */
  readonly notes: readonly string[];
}
