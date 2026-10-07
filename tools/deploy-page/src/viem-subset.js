// SPDX-License-Identifier: MIT
// Entry point of the viem subset vendored into the deploy page (web/v2/deploy/vendor/viem.js).
// Pure functions only: hashing, ABI coding, addresses and units. No transport, client, chain or wallet code:
// the page speaks JSON-RPC itself (web/v2/deploy/lib/rpc.js), so nothing here touches the network.
// Rebuild: pnpm --filter @paylink/deploy-page run vendor (checked by `vendor:check` and test/vendor.test.ts).
export {
  bytesToHex,
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  getCreate2Address,
  getCreateAddress,
  hexToBigInt,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  numberToHex,
  size,
  slice,
  stringToHex,
} from "viem";
