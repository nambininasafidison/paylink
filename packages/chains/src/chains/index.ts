// SPDX-License-Identifier: MIT
import { arbitrumSepolia } from "./arbitrum-sepolia.ts";
import { arc } from "./arc.ts";
import { baseSepolia } from "./base-sepolia.ts";
import { mezoTestnet } from "./mezo-testnet.ts";
import { monad } from "./monad.ts";
import { monadTestnet } from "./monad-testnet.ts";

export { arbitrumSepolia, arc, baseSepolia, mezoTestnet, monad, monadTestnet };

/** Every chain of PAYLINK-V2-SPEC §3.4 that the product uses, in band-selector order. */
export const CHAIN_DEFINITIONS = [monadTestnet, monad, baseSepolia, arbitrumSepolia, mezoTestnet, arc] as const;
