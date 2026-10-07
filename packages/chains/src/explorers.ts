// SPDX-License-Identifier: MIT
/** Explorer links in the EIP-3091 layout shared by every explorer in the registry. */
import type { Address, Hash } from "viem";
import type { Explorer } from "./types.ts";

/** `<explorer>/tx/<hash>`. */
export function explorerTxUrl(explorer: Explorer, txHash: Hash): string {
  return `${explorer.url}/tx/${txHash}`;
}

/** `<explorer>/address/<address>`. */
export function explorerAddressUrl(explorer: Explorer, address: Address): string {
  return `${explorer.url}/address/${address}`;
}

/** `<explorer>/block/<number>`. */
export function explorerBlockUrl(explorer: Explorer, blockNumber: bigint): string {
  return `${explorer.url}/block/${blockNumber.toString()}`;
}
