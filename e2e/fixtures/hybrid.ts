// SPDX-License-Identifier: MIT
/**
 * One passkey on two devices, for the ledger backup spec (ADR 0016).
 *
 * A synced passkey carries its PRF secret to every device of its passkey manager, and a device without it can still
 * use it through the platform's cross-device sign-in (WebAuthn hybrid transport: the phone that holds the passkey
 * answers the laptop's request). Chromium's virtual authenticator cannot reproduce either by copying the credential:
 * `WebAuthn.getCredentials` exports the private key but not the PRF (`hmac-secret`) secret, and a credential imported
 * with `WebAuthn.addCredential` evaluates no PRF at all (checked on Chromium 141: the PRF result is absent).
 *
 * `bridgePasskey` therefore lets a second browser context use the first one's authenticator, as the hybrid transport
 * does: every `navigator.credentials.get` in the second context is answered by the authenticator of `holder` (a page
 * of the same origin in the first context), with the requesting page's own options (rpId, challenge,
 * allowCredentials, user verification, PRF salts). The second context keeps its own storage and IndexedDB: it is
 * another device. `navigator.credentials.create` is not bridged.
 */
import type { BrowserContext, Page } from "@playwright/test";

/** A `PublicKeyCredentialRequestOptions` with its buffers as base64. */
export interface BridgedRequest {
  readonly rpId: string;
  readonly challenge: string;
  readonly userVerification: string;
  readonly allow: readonly string[];
  readonly prfFirst: string | null;
}

interface BridgedAnswer {
  readonly id: string;
  readonly rawId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly userHandle: string | null;
  readonly prfFirst: string | null;
}

/** Lets every page of `context` use the passkeys of `holder`'s virtual authenticator. Returns the requests seen. */
export async function bridgePasskey(context: BrowserContext, holder: Page): Promise<BridgedRequest[]> {
  const seen: BridgedRequest[] = [];
  await context.exposeBinding("__paylinkHybridGet", async (_source, request: BridgedRequest): Promise<BridgedAnswer> => {
    seen.push(request);
    return await holder.evaluate(async (r: BridgedRequest): Promise<BridgedAnswer> => {
      const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const b64 = (buffer: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const credential = (await navigator.credentials.get({
        publicKey: {
          rpId: r.rpId,
          challenge: bytes(r.challenge),
          userVerification: r.userVerification as UserVerificationRequirement,
          allowCredentials: r.allow.map((id) => ({ type: "public-key" as const, id: bytes(id) })),
          ...(r.prfFirst === null ? {} : { extensions: { prf: { eval: { first: bytes(r.prfFirst) } } } }),
        },
      })) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      const first = credential.getClientExtensionResults().prf?.results?.first;
      return {
        id: credential.id,
        rawId: b64(credential.rawId),
        clientDataJSON: b64(response.clientDataJSON),
        authenticatorData: b64(response.authenticatorData),
        signature: b64(response.signature),
        userHandle: response.userHandle === null ? null : b64(response.userHandle),
        prfFirst: first === undefined ? null : b64(first instanceof ArrayBuffer ? first : (first as ArrayBufferView).buffer as ArrayBuffer),
      };
    }, request);
  });
  await context.addInitScript(() => {
    const hybrid = (window as unknown as { __paylinkHybridGet: (request: BridgedRequest) => Promise<BridgedAnswer> }).__paylinkHybridGet;
    const bytes = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const b64 = (source: BufferSource): string => btoa(String.fromCharCode(...(source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength))));
    const original = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
      const pk = options?.publicKey;
      if (pk === undefined) {
        return await original(options);
      }
      const first = pk.extensions?.prf?.eval?.first;
      const answer = await hybrid({
        rpId: pk.rpId ?? location.hostname,
        challenge: b64(pk.challenge),
        userVerification: pk.userVerification ?? "preferred",
        allow: (pk.allowCredentials ?? []).map((c) => b64(c.id)),
        prfFirst: first === undefined ? null : b64(first),
      });
      const prfFirst = answer.prfFirst;
      return {
        type: "public-key",
        id: answer.id,
        rawId: bytes(answer.rawId),
        authenticatorAttachment: "cross-platform",
        response: {
          clientDataJSON: bytes(answer.clientDataJSON),
          authenticatorData: bytes(answer.authenticatorData),
          signature: bytes(answer.signature),
          userHandle: answer.userHandle === null ? null : bytes(answer.userHandle),
        },
        getClientExtensionResults: () => (prfFirst === null ? {} : { prf: { results: { first: bytes(prfFirst) } } }),
      } as unknown as Credential;
    };
  });
  return seen;
}

/** The PRF output of `holder`'s passkey for `salt` (base64), evaluated directly on its authenticator. */
export async function prfOf(holder: Page, credentialId: string, salt: Uint8Array): Promise<Buffer> {
  const out = await holder.evaluate(
    async ({ id, first }) => {
      const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const credential = (await navigator.credentials.get({
        publicKey: {
          rpId: location.hostname,
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          userVerification: "required",
          allowCredentials: [{ type: "public-key", id: bytes(id) }],
          extensions: { prf: { eval: { first: bytes(first) } } },
        },
      })) as PublicKeyCredential;
      const result = credential.getClientExtensionResults().prf?.results?.first;
      if (result === undefined) {
        throw new Error("no PRF output");
      }
      return btoa(String.fromCharCode(...new Uint8Array(result instanceof ArrayBuffer ? result : (result as ArrayBufferView).buffer as ArrayBuffer)));
    },
    { id: Buffer.from(credentialId, "base64url").toString("base64"), first: Buffer.from(salt).toString("base64") },
  );
  return Buffer.from(out, "base64");
}
