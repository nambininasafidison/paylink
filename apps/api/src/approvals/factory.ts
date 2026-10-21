// SPDX-License-Identifier: MIT
/**
 * The approval service (docs/paypal/SPEC.md §10.5): canonical proposal hash and HMAC tokens under `APPROVAL_HMAC_KEY`.
 * Without the secret, the Worker refuses to issue or accept any token (500, rule `E_APPROVAL_KEY_MISSING`); the Node
 * entry uses a key that lives as long as the process (tests, e2e, the offline demo).
 *
 * Owner: reconciler workstream.
 */
import type { Address, Hex } from "@paylink/api-contract";
import type { FactoryDeps } from "../core/runtime.ts";
import { ProblemError } from "../core/problem.ts";
import { base64Url, canonicalJson, fromBase64Url, hmac, hmacVerify, macKey, sha256Hex } from "./crypto.ts";
import type { MacKey } from "./crypto.ts";
import { APPROVAL_TTL_MS } from "./types.ts";
import type { ApprovalCheck, ApprovalToken, Approvals, CanonicalProposal } from "./types.ts";

const TOKEN = /^pa1\.(?<hash>[0-9a-f]{64})\.(?<payee>[0-9a-f]{40})\.(?<exp>[1-9][0-9]{0,15})\.(?<mac>[A-Za-z0-9_-]{43})$/u;

const macInput = (hash: string, payee: string, expiresAt: number): string => `paylink.approval.v1\n${hash}\n${payee}\n${String(expiresAt)}`;

/** The canonical object a proposal's hash covers. */
export function canonicalProposal(proposal: CanonicalProposal): string {
  return canonicalJson({
    id: proposal.id,
    kind: proposal.kind,
    key: proposal.key.toLowerCase(),
    payee: proposal.payee.toLowerCase(),
    chainId: proposal.chainId,
    args: proposal.args,
  });
}

export function createApprovals(deps: FactoryDeps): Approvals {
  const { runtime } = deps;
  let keyPromise: Promise<MacKey> | null = null;
  const key = async (): Promise<CryptoKey> => {
    keyPromise ??= macKey(runtime.secrets.approvalHmacKey, runtime, "approvals");
    const k = await keyPromise;
    if (k.state === "configured" || k.state === "ephemeral") {
      return k.key;
    }
    throw new ProblemError("internal", "approvals are not configured", { rule: k.state === "missing" ? "E_APPROVAL_KEY_MISSING" : "E_APPROVAL_KEY_INVALID" });
  };
  const hash = async (proposal: CanonicalProposal): Promise<Hex> => await sha256Hex(canonicalProposal(proposal));

  return {
    hash,
    issue: async (proposal, now, notAfter): Promise<ApprovalToken> => {
      const h = await hash(proposal);
      const payee = proposal.payee.toLowerCase();
      const expiresAt = Math.min(now + APPROVAL_TTL_MS, notAfter ?? Number.POSITIVE_INFINITY);
      const mac = base64Url(await hmac(await key(), macInput(h.slice(2), payee.slice(2), expiresAt)));
      return { token: `pa1.${h.slice(2)}.${payee.slice(2)}.${String(expiresAt)}.${mac}`, hash: h, payee: proposal.payee, expiresAt };
    },
    verify: async (token, proposal, sessionPayee: Address, now): Promise<ApprovalCheck> => {
      const groups = TOKEN.exec(token)?.groups;
      const mac = fromBase64Url(groups?.["mac"] ?? "");
      if (groups === undefined || mac?.length !== 32) {
        return { ok: false, reason: "malformed" };
      }
      const [tokenHash = "", tokenPayee = "", exp = ""] = [groups["hash"], groups["payee"], groups["exp"]];
      const expiresAt = Number(exp);
      if (!(await hmacVerify(await key(), mac, macInput(tokenHash, tokenPayee, expiresAt)))) {
        return { ok: false, reason: "bad-mac" };
      }
      if (`0x${tokenHash}` !== (await hash(proposal))) {
        return { ok: false, reason: "hash-mismatch" };
      }
      if (`0x${tokenPayee}` !== sessionPayee.toLowerCase() || `0x${tokenPayee}` !== proposal.payee.toLowerCase()) {
        return { ok: false, reason: "other-payee" };
      }
      if (now > expiresAt) {
        return { ok: false, reason: "expired" };
      }
      return { ok: true };
    },
  };
}
