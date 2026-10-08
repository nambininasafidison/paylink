// SPDX-License-Identifier: MIT
/**
 * The registry: a validated, frozen set of chain definitions with the lookups that clients need.
 *
 * `createRegistry` refuses any definition that breaks an invariant a client relies on (EIP-55 addresses,
 * HTTPS endpoints, one default token, gas bounds, no unverified facts on an enabled chain, …), so a
 * hand-built registry for tests or e2e gets the same guarantees as the shipped one.
 */
import { getAddress, isAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import type { ChainDefinition, DeniedAddress, Deployment, Edition, PayLinkFunction, Token, TokenCapabilities } from "./types.ts";

/** Every edition and every function, for validation. */
const EDITIONS: ReadonlySet<Edition> = new Set(["all", "monad", "base", "mezo"]);
const FUNCTIONS: readonly PayLinkFunction[] = ["payWithAuthorization", "pay", "payWithPermit", "payNative", "cancel", "cancelBySig"];
const MAX_UINT53 = 2 ** 53 - 1;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * Largest relay margin (`RelayTiming.minRemainingSeconds`): half of the recommended 600 s EIP-3009 authorization
 * window (invoice spec §8.3), so that a payer client's default authorization stays relayable for most of its life.
 */
const MAX_RELAY_MARGIN_SECONDS = 300;

/** Thrown by `createRegistry` with every problem found, one per line. */
export class RegistryError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid chain registry:\n- ${issues.join("\n- ")}`);
    this.name = "RegistryError";
    this.issues = issues;
  }
}

/** Thrown when a chain ID is not in the registry. */
export class UnknownChainError extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(`chain ${chainId} is not in the PayLink registry`);
    this.name = "UnknownChainError";
    this.chainId = chainId;
  }
}

/** A chain together with its canonical, non-null PayLinkV2 deployment. */
export interface V2Target {
  readonly chain: ChainDefinition;
  readonly deployment: Deployment;
}

export interface Registry {
  /** Chains in the order they were defined. */
  readonly chains: readonly ChainDefinition[];
  /** The chain with this ID, if any. */
  get(chainId: number): ChainDefinition | undefined;
  /** The chain with this ID; throws `UnknownChainError` otherwise. */
  getOrThrow(chainId: number): ChainDefinition;
  /**
   * The chain and its canonical PayLinkV2 deployment, or `undefined` when the chain is unknown, runs v1 or has
   * no recorded deployment. This is the only way clients obtain `verifyingContract` (invoice spec §4.2).
   */
  v2Target(chainId: number): V2Target | undefined;
  /** An allowlisted token of the chain (address compared case-insensitively). Never returns a denied address. */
  findToken(chainId: number, address: string): Token | undefined;
  /** The deny-list entry for this address on the chain, if any. */
  findDenied(chainId: number, address: string): DeniedAddress | undefined;
  /** Chains of an edition (enabled ones only unless `includeDisabled`). */
  forEdition(edition: Edition, options?: { readonly includeDisabled?: boolean }): readonly ChainDefinition[];
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function checkAddress(issues: string[], where: string, value: string): void {
  if (!isAddress(value, { strict: false })) {
    issues.push(`${where}: ${value} is not an address`);
  } else if (getAddress(value) !== value) {
    issues.push(`${where}: ${value} is not EIP-55 checksummed (expected ${getAddress(value)})`);
  }
}

function checkUrl(issues: string[], where: string, value: string, allowLocal: boolean, originOnly: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${where}: ${value} is not a URL`);
    return;
  }
  const local = allowLocal && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    issues.push(`${where}: ${value} must use https`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    issues.push(`${where}: ${value} must not carry credentials, a query or a fragment`);
  }
  if (originOnly && value !== url.origin) {
    issues.push(`${where}: ${value} must be a bare origin (no path, no trailing slash)`);
  }
}

function checkToken(issues: string[], chain: ChainDefinition, token: Token, index: number): void {
  const where = `chain ${chain.chainId} token[${index}] ${token.symbol}`;
  checkAddress(issues, where, token.address);
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
    issues.push(`${where}: decimals must be an integer in [0, 36]`);
  }
  if (token.symbol.trim() === "" || token.name.trim() === "") {
    issues.push(`${where}: symbol and name are required`);
  }
  // Widened on purpose: definitions built in plain JavaScript or by casting must be checked too.
  const capabilities: TokenCapabilities = token.capabilities;
  if (token.kind === "native") {
    if (token.address !== zeroAddress || !capabilities.native || capabilities.eip3009 || capabilities.eip2612) {
      issues.push(`${where}: a native token has the zero address and only the native capability`);
    }
  } else if (token.address === zeroAddress || capabilities.native) {
    issues.push(`${where}: an ERC-20 token has a non-zero address and no native capability`);
  }
  if (chain.deployment !== null && sameAddress(token.address, chain.deployment.address)) {
    issues.push(`${where}: the token cannot be the PayLinkV2 deployment (invoice shape rule)`);
  }
  if (chain.deniedTokens.some((denied) => sameAddress(denied.address, token.address))) {
    issues.push(`${where}: the token is on the chain's deny list`);
  }
  if (chain.status === "enabled" && token.pendingVerification.length > 0) {
    issues.push(`${where}: an enabled chain cannot carry unverified facts (${token.pendingVerification.join(", ")})`);
  }
}

function checkChain(issues: string[], chain: ChainDefinition): void {
  const where = `chain ${chain.chainId}`;
  if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1 || chain.chainId > MAX_UINT53) {
    issues.push(`${where}: chainId must be an integer in [1, 2^53 - 1]`);
  }
  if (chain.caip2 !== `eip155:${chain.chainId}`) {
    issues.push(`${where}: caip2 must be eip155:${chain.chainId}`);
  }
  if (chain.local && (!chain.testnet || chain.key !== "local")) {
    issues.push(`${where}: a local chain has key "local" and is a testnet`);
  }
  for (const edition of chain.editions) {
    if (!EDITIONS.has(edition)) {
      issues.push(`${where}: unknown edition ${edition}`);
    }
  }
  chain.rpc.forEach((rpc, i) => {
    checkUrl(issues, `${where} rpc[${i}]`, rpc.url, chain.local, false);
  });
  chain.explorers.forEach((explorer, i) => {
    checkUrl(issues, `${where} explorer[${i}]`, explorer.url, chain.local, true);
  });
  if (chain.status === "enabled" && chain.rpc.length === 0) {
    issues.push(`${where}: an enabled chain needs at least one RPC endpoint`);
  }
  const seen = new Set<string>();
  let defaults = 0;
  chain.tokens.forEach((token, i) => {
    checkToken(issues, chain, token, i);
    const id = token.address.toLowerCase();
    if (seen.has(id)) {
      issues.push(`${where}: token ${token.address} is listed twice`);
    }
    seen.add(id);
    defaults += token.listing === "default" ? 1 : 0;
  });
  if (defaults > 1) {
    issues.push(`${where}: at most one default token`);
  }
  for (const denied of chain.deniedTokens) {
    checkAddress(issues, `${where} denied`, denied.address);
  }
  for (const [name, helper] of Object.entries(chain.contracts)) {
    checkAddress(issues, `${where} contracts.${name}`, helper.address);
    if (helper.gas !== undefined && (helper.gas.floor <= 0n || helper.gas.ceiling < helper.gas.floor)) {
      issues.push(`${where}: gas bounds of contracts.${name} must satisfy 0 < floor <= ceiling`);
    }
  }
  if (chain.protocol === "v2") {
    if (chain.gas === null) {
      issues.push(`${where}: a v2 chain needs a gas table`);
    } else {
      for (const fn of FUNCTIONS) {
        const bounds = chain.gas.limits[fn];
        if (bounds.floor <= 0n || bounds.ceiling < bounds.floor) {
          issues.push(`${where}: gas bounds of ${fn} must satisfy 0 < floor <= ceiling`);
        }
      }
    }
    if (chain.relay === null) {
      issues.push(`${where}: a v2 chain needs relay timing`);
    } else if (!Number.isSafeInteger(chain.relay.minRemainingSeconds) || chain.relay.minRemainingSeconds < 1 || chain.relay.minRemainingSeconds > MAX_RELAY_MARGIN_SECONDS) {
      issues.push(`${where}: relay.minRemainingSeconds must be an integer in [1, ${String(MAX_RELAY_MARGIN_SECONDS)}]`);
    }
    if (chain.v1 !== null) {
      issues.push(`${where}: a v2 chain carries no v1 info`);
    }
    if (chain.deployment !== null) {
      checkAddress(issues, `${where} deployment`, chain.deployment.address);
      if (chain.deployment.address === zeroAddress) {
        issues.push(`${where}: the deployment address cannot be zero`);
      }
    }
  } else {
    if (chain.gas !== null || chain.relay !== null || chain.deployment !== null || chain.editions.length > 0) {
      issues.push(`${where}: a v1 chain has no v2 gas table, relay timing, deployment or edition`);
    }
    if (chain.v1 === null) {
      issues.push(`${where}: a v1 chain needs its v1 info`);
    } else if (chain.v1.address !== null) {
      checkAddress(issues, `${where} v1.address`, chain.v1.address);
    }
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
  }
  return value;
}

/**
 * Validates the definitions and returns a frozen registry. Throws `RegistryError` listing every problem.
 * Chain IDs must be unique, and so must the keys of non-local chains.
 */
export function createRegistry(definitions: readonly ChainDefinition[]): Registry {
  const issues: string[] = [];
  const byId = new Map<number, ChainDefinition>();
  const keys = new Set<string>();
  for (const chain of definitions) {
    checkChain(issues, chain);
    if (byId.has(chain.chainId)) {
      issues.push(`chain ${chain.chainId}: defined twice`);
    }
    if (!chain.local && keys.has(chain.key)) {
      issues.push(`chain ${chain.chainId}: key ${chain.key} is used twice`);
    }
    byId.set(chain.chainId, chain);
    keys.add(chain.key);
  }
  if (issues.length > 0) {
    throw new RegistryError(issues);
  }
  const chains = freezeDeep([...definitions]);

  const registry: Registry = {
    chains,
    get: (chainId) => byId.get(chainId),
    getOrThrow: (chainId) => {
      const chain = byId.get(chainId);
      if (chain === undefined) {
        throw new UnknownChainError(chainId);
      }
      return chain;
    },
    v2Target: (chainId) => {
      const chain = byId.get(chainId);
      if (chain?.protocol !== "v2" || chain.deployment === null) {
        return undefined;
      }
      return { chain, deployment: chain.deployment };
    },
    findToken: (chainId, address) => byId.get(chainId)?.tokens.find((token) => sameAddress(token.address, address)),
    findDenied: (chainId, address) => byId.get(chainId)?.deniedTokens.find((denied) => sameAddress(denied.address, address)),
    forEdition: (edition, options) =>
      chains.filter(
        (chain) =>
          (edition === "all" ? chain.editions.length > 0 : chain.editions.includes(edition)) &&
          (options?.includeDisabled === true || chain.status === "enabled"),
      ),
  };
  return Object.freeze(registry);
}

/**
 * A registry restricted to one edition's chains (enabled ones only unless `includeDisabled`), so that links
 * for chains outside the edition are rejected as unknown (spec §3.6: `?chain=` switches only among the
 * edition's own chains).
 */
export function scopeToEdition(registry: Registry, edition: Edition, options?: { readonly includeDisabled?: boolean }): Registry {
  return createRegistry(registry.forEdition(edition, options));
}

/** `address` in EIP-55 form when it is a valid address, else `undefined`. Accepts any case. */
export function toChecksumAddress(address: string): Address | undefined {
  return isAddress(address, { strict: false }) ? getAddress(address) : undefined;
}
