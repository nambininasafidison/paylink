// SPDX-License-Identifier: MIT
/**
 * The session service (docs/paypal/SPEC.md §12.2): verifies a signed EIP-712 `PayLinkSession` and answers an HMAC token
 * under `SESSION_HMAC_KEY` (rules and token format in ./types.ts). Without the secret, the Worker opens no session and
 * accepts none (500, rule `E_SESSION_KEY_MISSING`); the Node entry uses a key that lives as long as the process.
 *
 * Signature check: ECDSA recovery first (a wallet's EOA, with the SDK's OpenZeppelin-equivalent rules: 65 bytes, low s,
 * v in {27, 28}); only if that fails, the payee's code is read through the registry's RPC and, for an account with code,
 * ERC-1271 decides (a smart account), as `verifySignature` of @paylink/sdk does for invoices. A transport failure is
 * "chain-unavailable" (503), never "invalid".
 *
 * Owner: reconciler workstream.
 */
import { SESSION_DOMAIN, SESSION_MAX_SECONDS, SESSION_TYPES } from "@paylink/api-contract";
import type { SessionRequest, SessionResponse } from "@paylink/api-contract";
import { normalizeEcdsaV, verifySignatureWithCode } from "@paylink/sdk";
import { getAddress, hashTypedData, isAddress } from "viem";
import { base64Url, fromBase64Url, hmac, hmacVerify, macKey } from "../approvals/crypto.ts";
import type { MacKey } from "../approvals/crypto.ts";
import { chainClient } from "../chain/client.ts";
import { ProblemError } from "../core/problem.ts";
import type { FactoryDeps } from "../core/runtime.ts";
import { msUntilNextUtcDay, utcDay } from "../reconciler/money.ts";
import { DEMO_RESERVE, exhausted, PAYEE_DAILY, SOURCE_DAILY } from "../store/quotas.ts";
import { SESSION_CLOCK_SKEW_S, SESSION_SIGNED_WITHIN_S, SESSIONS_PER_DAY } from "./types.ts";
import type { SessionCheck, Sessions } from "./types.ts";

const TOKEN = /^ps1\.(?<payee>[0-9a-f]{40})\.(?<exp>[1-9][0-9]{0,15})\.(?<mac>[A-Za-z0-9_-]{43})$/u;
const UINT53 = /^(?:0|[1-9][0-9]{0,15})$/u;
const macInput = (payee: string, expiresAt: number): string => `paylink.session.v1\n${payee}\n${String(expiresAt)}`;

/** The EIP-712 digest a payee signs to open a session (wallets show the domain "PayLink API" and the five fields). */
export function sessionDigest(request: SessionRequest): `0x${string}` {
  const { session } = request;
  return hashTypedData({
    domain: { ...SESSION_DOMAIN, chainId: request.chainId },
    types: SESSION_TYPES,
    primaryType: "PayLinkSession",
    message: { payee: session.payee, origin: session.origin, issuedAt: BigInt(session.issuedAt), expiresAt: BigInt(session.expiresAt), nonce: session.nonce },
  });
}

export function createSessions(deps: FactoryDeps): Sessions {
  const { runtime, stores } = deps;
  const { config } = runtime;
  let keyPromise: Promise<MacKey> | null = null;
  const key = async (): Promise<CryptoKey | null> => {
    keyPromise ??= macKey(runtime.secrets.sessionHmacKey, runtime, "sessions");
    const k = await keyPromise;
    return k.state === "configured" || k.state === "ephemeral" ? k.key : null;
  };

  const verify = async (request: SessionRequest): Promise<boolean> => {
    const digest = sessionDigest(request);
    const payee = request.session.payee;
    // Wallets answer v in {0, 1} or {27, 28}, in any hex case: the SDK's rules take {27, 28}, lowercase.
    const signature = normalizeEcdsaV(request.signature.toLowerCase() as `0x${string}`);
    const offline = await verifySignatureWithCode({ signer: payee, digest, signature, code: undefined });
    if (offline.valid) {
      return true;
    }
    const chain = runtime.registry.get(config.chainId);
    if (chain === undefined) {
      return false;
    }
    // Not an EOA's signature: only an account with code (ERC-1271) can still prove the address.
    try {
      const client = chainClient(runtime, chain);
      const code = await client.getCode({ address: payee });
      if (code === undefined || code === "0x") {
        return false;
      }
      const onChain = await verifySignatureWithCode({ signer: payee, digest, signature, client, code });
      return onChain.valid && onChain.method === "erc1271";
    } catch {
      throw new ProblemError("chain-unavailable", "the signer's account could not be read on the chain", { rule: "E_SESSION_ERC1271_UNREADABLE" });
    }
  };

  return {
    open: async (request, now, context = { source: "unknown" }): Promise<SessionResponse> => {
      const k = await key();
      if (k === null) {
        throw new ProblemError("internal", "sessions are not configured", { rule: runtime.secrets.sessionHmacKey === undefined ? "E_SESSION_KEY_MISSING" : "E_SESSION_KEY_INVALID" });
      }
      const { session } = request;
      if (request.chainId !== config.chainId) {
        throw new ProblemError("invalid-request", `sessions are signed for chain ${String(config.chainId)}`, { rule: "E_SESSION_CHAIN" });
      }
      if (!config.allowedOrigins.includes(session.origin)) {
        throw new ProblemError("forbidden", "the session was signed for another origin", { rule: "E_SESSION_ORIGIN" });
      }
      if (!isAddress(session.payee, { strict: true }) || !UINT53.test(session.issuedAt) || !UINT53.test(session.expiresAt) || !/^0x[0-9a-fA-F]{64}$/u.test(session.nonce)) {
        throw new ProblemError("invalid-request", "the session's fields are malformed", { rule: "E_SESSION_FIELDS" });
      }
      const nowS = Math.floor(now / 1000);
      const issuedAt = Number(session.issuedAt);
      const expiresAt = Number(session.expiresAt);
      if (issuedAt > nowS + SESSION_CLOCK_SKEW_S || issuedAt < nowS - SESSION_SIGNED_WITHIN_S || expiresAt <= nowS || expiresAt <= issuedAt || expiresAt - issuedAt > SESSION_MAX_SECONDS) {
        throw new ProblemError("invalid-request", "the session's times are outside the accepted window", { rule: "E_SESSION_TIME" });
      }
      if (!(await verify(request))) {
        throw new ProblemError("unauthorized", "the signature does not prove the payee's address", { rule: "E_SESSION_SIGNATURE" });
      }
      const global = stores.global();
      // The nonce first: a replayed body is refused before it can count against any limit (T-60).
      if ((await global.markNonce("session", session.nonce.toLowerCase(), expiresAt * 1000, now)) === "seen") {
        throw new ProblemError("unauthorized", "this signed session was already used", { rule: "E_SESSION_REPLAYED" });
      }
      const payee = getAddress(session.payee);
      const day = utcDay(now);
      const demo = config.demoPayees.some((p) => p.toLowerCase() === payee.toLowerCase());
      if (demo) {
        if (!(await global.useQuota(day, "sessionsDemo", DEMO_RESERVE.sessions)).allowed) {
          throw new ProblemError("quota-exhausted", "the demo opened its sessions for today", { rule: "E_SESSION_QUOTA", retryAfter: Math.ceil(msUntilNextUtcDay(now) / 1000) });
        }
      } else {
        if (!(await global.useSubjectQuota(day, "sessions-source", context.source, 1, SOURCE_DAILY.sessions)).allowed) {
          throw exhausted("sessions", "source", now);
        }
        if (!(await global.useSubjectQuota(day, "sessions-payee", payee, 1, PAYEE_DAILY.sessions)).allowed) {
          throw exhausted("sessions", "payee", now);
        }
        if (!(await global.useQuota(day, "sessions", SESSIONS_PER_DAY)).allowed) {
          throw new ProblemError("quota-exhausted", "the demo opened its sessions for today", { rule: "E_SESSION_QUOTA", retryAfter: Math.ceil(msUntilNextUtcDay(now) / 1000) });
        }
      }
      const expiresAtMs = Math.min(expiresAt * 1000, now + SESSION_MAX_SECONDS * 1000);
      const lowerPayee = payee.toLowerCase().slice(2);
      const mac = base64Url(await hmac(k, macInput(lowerPayee, expiresAtMs)));
      return { token: `ps1.${lowerPayee}.${String(expiresAtMs)}.${mac}`, payee, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    check: async (token, now): Promise<SessionCheck> => {
      if (token === null) {
        return { ok: false, reason: "missing" };
      }
      const groups = TOKEN.exec(token)?.groups;
      const mac = fromBase64Url(groups?.["mac"] ?? "");
      if (groups === undefined || mac?.length !== 32) {
        return { ok: false, reason: "malformed" };
      }
      const k = await key();
      const payee = groups["payee"] ?? "";
      const expiresAt = Number(groups["exp"]);
      if (k === null || !(await hmacVerify(k, mac, macInput(payee, expiresAt)))) {
        return { ok: false, reason: "bad-mac" };
      }
      if (now >= expiresAt) {
        return { ok: false, reason: "expired" };
      }
      return { ok: true, payee: getAddress(`0x${payee}`), expiresAt };
    },
  };
}
