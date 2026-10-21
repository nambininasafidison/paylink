// SPDX-License-Identifier: MIT
/**
 * The registry the app trusts: `@paylink/chains`, scoped to the edition's enabled chains (spec §3.6: links for other
 * chains are rejected as unknown, and `?chain=` switches only among the edition's own chains).
 *
 * The Mezo edition also takes its own chain while the registry keeps Mezo testnet `disabled`, the state in which no
 * other edition offers it (ADR 0008, ADR 0017: the edition takes the chain explicitly). Its facts are the registry's
 * own, the contract address included: until `protocol/deployments/31611.json` is recorded, the chain reads "Not
 * deployed yet" and nothing can be signed or paid there. The edition invoices in MUSD only: the registry's other tokens
 * there (native BTC) stay on the allowlist, so their links still decode and verify, but are not offered when creating
 * one, because the edition's words are about MUSD. The branch is folded at build time, so other editions are unchanged.
 *
 * The PayPal edition takes Ethereum Sepolia the same way (ADR 0018): disabled in the registry, offered by that edition
 * only, "Not deployed yet" until `protocol/deployments/11155111.json` is recorded. Each build bundles only the chain
 * definitions it can serve (`shippedChains`): the PayPal build Ethereum Sepolia alone, the other builds every other
 * chain, so a chain added for one edition does not grow the others' pay route (PAYLINK-V2-SPEC §4.4 budget).
 *
 * End-to-end builds only: `__PAYLINK_E2E_CHAINS__` replaces chains by chain ID with definitions that point at local
 * anvil deployments and mock tokens (e2e/). Production builds define it as `null`, so the branch and its marker
 * string are removed by the minifier; `test/bundle.test.ts` checks the built files for the marker.
 */
import { arbitrumSepolia, arc, baseSepolia, createRegistry, ethereumSepolia, mezoTestnet, monad, monadTestnet, scopeToEdition } from "@paylink/chains";
import type { ChainDefinition, Edition, Registry } from "@paylink/chains";
import type { Address, Hex } from "viem";

declare const __PAYLINK_E2E_CHAINS__: string | null;
declare const __PAYLINK_EDITION__: Edition;

interface E2eChain {
  readonly base: number;
  readonly rpcUrl: string;
  readonly chargesGasLimit?: boolean;
  readonly tokens: readonly {
    readonly symbol: string;
    readonly name: string;
    readonly address: Address;
    readonly decimals: number;
    readonly eip3009: boolean;
    readonly eip2612: boolean;
    readonly domain: { readonly name: string; readonly version: string } | null;
  }[];
  readonly deployment: { readonly address: Address; readonly txHash: Hex; readonly blockNumber: string; readonly deployer: Address };
}

function e2eChains(definitions: readonly ChainDefinition[]): ChainDefinition[] {
  if (__PAYLINK_E2E_CHAINS__ === null) {
    return [...definitions];
  }
  const overrides = JSON.parse(__PAYLINK_E2E_CHAINS__) as E2eChain[];
  return definitions.map((chain) => {
    const o = overrides.find((c) => c.base === chain.chainId);
    if (o === undefined) {
      return chain;
    }
    // The real chain's identity and RPC URL (routed to anvil by the test), local contracts. The name carries a marker
    // that scripts/build.ts refuses to find in a production bundle.
    return {
      ...chain,
      name: `${chain.name} (e2e-local)`,
      rpc: [{ url: o.rpcUrl, confidence: "C" as const }],
      gasModel: { ...chain.gasModel, chargesGasLimit: o.chargesGasLimit ?? chain.gasModel.chargesGasLimit },
      tokens: o.tokens.map((t, i) => ({
        kind: "erc20" as const,
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        capabilities: { eip3009: t.eip3009, eip2612: t.eip2612, native: false as const },
        eip712Domain: t.domain,
        listing: i === 0 ? ("default" as const) : ("listed" as const),
        confidence: "C" as const,
        pendingVerification: [],
      })),
      deniedTokens: [],
      deployment: {
        address: o.deployment.address,
        status: "active" as const,
        release: "2.0.0",
        method: "CREATE2" as const,
        deployer: o.deployment.deployer,
        txHash: o.deployment.txHash,
        blockNumber: BigInt(o.deployment.blockNumber),
        initCodeHash: "0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5",
        maskedRuntimeHash: "0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d",
        runtimeCodeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
  });
}

/** `chain` with every token but its default one hidden: allowlisted, never offered when creating a link. */
function defaultTokenOnly(chain: ChainDefinition): ChainDefinition {
  return { ...chain, tokens: chain.tokens.map((token) => (token.listing === "default" ? token : { ...token, listing: "hidden" as const })) };
}

/**
 * The chain definitions this build may serve, compared with the build constant so the minifier keeps one branch: the
 * PayPal build carries Ethereum Sepolia alone; every other build carries the chains it carried before that edition.
 */
function shippedChains(): readonly ChainDefinition[] {
  return __PAYLINK_EDITION__ === "paypal" ? [ethereumSepolia] : [monadTestnet, monad, baseSepolia, arbitrumSepolia, mezoTestnet, arc];
}

/**
 * The edition's registry (enabled chains only; the Mezo and PayPal builds also have their own disabled chain), validated
 * by `createRegistry`.
 */
export function appRegistry(edition: Edition): Registry {
  const shipped = createRegistry(shippedChains());
  if (__PAYLINK_EDITION__ === "mezo") {
    const chains = scopeToEdition(shipped, edition, { includeDisabled: edition === "mezo" }).chains;
    return createRegistry(e2eChains(edition === "mezo" ? chains.map(defaultTokenOnly) : chains));
  }
  if (__PAYLINK_EDITION__ === "paypal") {
    // USDC (default) and PayPal USD (listed) are both offered: the edition invoices in either (ADR 0018).
    return createRegistry(e2eChains(scopeToEdition(shipped, edition, { includeDisabled: edition === "paypal" }).chains));
  }
  return createRegistry(e2eChains(scopeToEdition(shipped, edition).chains));
}

/** Chains the edition offers, in registry order, with whether each has a canonical deployment. */
export function editionChains(registry: Registry): readonly { readonly chain: ChainDefinition; readonly deployed: boolean }[] {
  return registry.chains.map((chain) => ({ chain, deployed: registry.v2Target(chain.chainId) !== undefined }));
}
