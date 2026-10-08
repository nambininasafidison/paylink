// SPDX-License-Identifier: MIT
/**
 * The local relayer's config file: anvil chains with their mock tokens and deployment, as plain JSON (validated with
 * zod). Every chain becomes a `defineLocalChain` registry entry, so the registry's own rules still apply.
 */
import type { ChainDefinition, Erc20Token } from "@paylink/chains";
import { defineLocalChain, MONAD_GAS_TABLE, monadTestnet, SNAPSHOT_GAS_TABLE } from "@paylink/chains";
import { getAddress, zeroHash } from "viem";
import { z } from "zod";
import { AddressSchema } from "../core/schemas.ts";

const TokenSchema = z.strictObject({
  address: AddressSchema,
  symbol: z.string().min(1).max(11),
  decimals: z.int().min(0).max(36),
  eip3009: z.boolean().default(true),
  eip2612: z.boolean().default(false),
  eip712Domain: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }).nullable().default(null),
});

const ChainSchema = z.strictObject({
  chainId: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  rpcUrl: z.url({ protocol: /^http$/u, hostname: /^(127\.0\.0\.1|localhost)$/u }),
  /** The PayLinkV2 deployed on the anvil chain. */
  deployment: AddressSchema,
  /** `monad`: Monad's gas table and gas-limit charging (anvil --chain-id 10143 runs Monad's schedule); `snapshot`: Ethereum prices. */
  gas: z.enum(["monad", "snapshot"]).default("snapshot"),
  tokens: z.array(TokenSchema).min(1).max(8),
  /** A faucet with `requestFunds(address)` for onboarding (optional). */
  faucet: AddressSchema.optional(),
});

export const LocalConfigSchema = z.strictObject({
  port: z.int().min(0).max(65_535).optional(),
  allowedOrigins: z.array(z.string()).max(8).default([]),
  chains: z.array(ChainSchema).min(1).max(4),
});

export interface LocalConfig {
  readonly port: number | undefined;
  readonly allowedOrigins: readonly string[];
  readonly chains: readonly ChainDefinition[];
}

export function localChainsFromJson(json: unknown): LocalConfig {
  const config = LocalConfigSchema.parse(json);
  return {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    chains: config.chains.map((chain) => {
      const tokens = chain.tokens.map(
        (token, i): Erc20Token => ({
          kind: "erc20",
          symbol: token.symbol,
          name: token.symbol,
          address: getAddress(token.address),
          decimals: token.decimals,
          capabilities: { eip3009: token.eip3009, eip2612: token.eip2612, native: false },
          eip712Domain: token.eip712Domain,
          listing: i === 0 ? "default" : "listed",
          confidence: "C",
          pendingVerification: [],
        }),
      );
      const definition = defineLocalChain({
        chainId: chain.chainId,
        rpcUrl: chain.rpcUrl,
        tokens,
        gas: chain.gas === "monad" ? MONAD_GAS_TABLE : SNAPSHOT_GAS_TABLE,
        chargesGasLimit: chain.gas === "monad",
        deployment: {
          address: getAddress(chain.deployment),
          status: "active",
          release: "local",
          method: "CREATE",
          deployer: getAddress(chain.deployment),
          txHash: zeroHash,
          blockNumber: 0n,
          initCodeHash: zeroHash,
          maskedRuntimeHash: zeroHash,
          runtimeCodeHash: zeroHash,
        },
      });
      // A local faucet stands in for Monad testnet's AUSD faucet, with the registry's gas bounds for it.
      const faucetGas = monadTestnet.contracts.ausdFaucet?.gas;
      return chain.faucet === undefined || faucetGas === undefined
        ? definition
        : { ...definition, contracts: { ausdFaucet: { address: getAddress(chain.faucet), confidence: "C" as const, gas: faucetGas } } };
    }),
  };
}
