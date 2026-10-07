// SPDX-License-Identifier: MIT
/** ABIs: PayLinkV2 (generated from the release artifact) and the minimal ERC-20 surface payers need. */
export { payLinkV2Abi } from "./generated/paylink-v2-abi.ts";

/** `approve` and `allowance`, for the approve + pay path (exact-amount approvals only, §13.2). */
export const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
