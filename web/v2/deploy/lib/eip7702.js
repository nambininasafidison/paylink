// SPDX-License-Identifier: MIT
// @ts-check
/**
 * EIP-7702 facts the deployment verifier needs to name the account behind a relayed deployment: the signing hash of an
 * authorization tuple, the authority that signed it (secp256k1 public-key recovery, as the protocol does it), and the
 * delegation designator `0xef0100 ‖ address` an authority's code carries afterwards. Pure functions over BigInt: the
 * vendored viem subset has keccak-256 but no elliptic curve, and the page loads nothing else.
 *
 * Checked against viem's `hashAuthorization` / `recoverAuthorizationAddress` on random keys
 * (tools/deploy-page/test/eip7702.test.ts).
 *
 * @module
 */
import { getAddress, keccak256 } from "../vendor/viem.js";

/** @typedef {`0x${string}`} Hex */
/** @typedef {`0x${string}`} Address */

/**
 * One entry of a type-4 transaction's `authorizationList`, as an RPC returns it (quantities decoded).
 * @typedef {object} Authorization
 * @property {bigint} chainId
 * @property {Address} address   the code the authority delegates to
 * @property {bigint} nonce
 * @property {number} yParity
 * @property {bigint} r
 * @property {bigint} s
 */

/** EIP-7702 `MAGIC`: the authorization signing domain byte. */
const MAGIC = "05";
/** secp256k1 field prime, group order and generator. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** @type {Point} */
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const MAX_NONCE = 2n ** 64n - 1n;

/** @typedef {readonly [bigint, bigint] | null} Point  affine point, null for the point at infinity */

/** @param {bigint} a @param {bigint} m */
const mod = (a, m) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

/** Modular inverse by the extended Euclidean algorithm (m prime, a not a multiple of m). @param {bigint} a @param {bigint} m */
function invert(a, m) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

/** @param {bigint} base @param {bigint} exponent @param {bigint} m */
function power(base, exponent, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % m;
    }
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** @param {Point} p @param {Point} q @returns {Point} */
function add(p, q) {
  if (p === null) {
    return q;
  }
  if (q === null) {
    return p;
  }
  const [x1, y1] = p;
  const [x2, y2] = q;
  /** @type {bigint} */
  let slope;
  if (x1 === x2) {
    if (y1 !== y2 || y1 === 0n) {
      return null;
    }
    slope = mod(3n * x1 * x1 * invert(2n * y1, P), P);
  } else {
    slope = mod((y2 - y1) * invert(x2 - x1, P), P);
  }
  const x3 = mod(slope * slope - x1 - x2, P);
  return [x3, mod(slope * (x1 - x3) - y1, P)];
}

/** @param {bigint} k @param {Point} p @returns {Point} */
function multiply(k, p) {
  /** @type {Point} */
  let result = null;
  let addend = p;
  let e = k;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = add(result, addend);
    }
    addend = add(addend, addend);
    e >>= 1n;
  }
  return result;
}

/** Minimal big-endian bytes of a non-negative integer, as hex without 0x ("" for zero). @param {bigint} n */
const minimalHex = (n) => {
  if (n === 0n) {
    return "";
  }
  const h = n.toString(16);
  return h.length % 2 === 0 ? h : `0${h}`;
};

/** RLP length prefix. @param {number} offset 0x80 (string) or 0xc0 (list) @param {number} length */
function rlpPrefix(offset, length) {
  if (length <= 55) {
    return (offset + length).toString(16).padStart(2, "0");
  }
  const l = minimalHex(BigInt(length));
  return (offset + 55 + l.length / 2).toString(16).padStart(2, "0") + l;
}

/** RLP of a byte string given as hex without 0x. @param {string} bytes */
const rlpString = (bytes) => (bytes.length === 2 && Number.parseInt(bytes, 16) < 0x80 ? bytes : rlpPrefix(0x80, bytes.length / 2) + bytes);

/**
 * The EIP-7702 signing hash of an authorization tuple: `keccak256(0x05 ‖ rlp([chain_id, address, nonce]))`.
 *
 * @param {{ chainId: bigint; address: Address; nonce: bigint }} a
 * @returns {Hex}
 */
export function authorizationHash(a) {
  const payload = rlpString(minimalHex(a.chainId)) + rlpString(a.address.slice(2).toLowerCase()) + rlpString(minimalHex(a.nonce));
  return keccak256(/** @type {Hex} */ (`0x${MAGIC}${rlpPrefix(0xc0, payload.length / 2)}${payload}`));
}

/**
 * The address whose key produced (yParity, r, s) over `hash`, as `ecrecover` derives it, or null when the signature is
 * not a valid low-s secp256k1 signature (EIP-2, which EIP-7702 requires of authorizations).
 *
 * @param {Hex} hash
 * @param {{ yParity: number; r: bigint; s: bigint }} signature
 * @returns {Address | null}
 */
export function recoverSigner(hash, { yParity, r, s }) {
  if (r <= 0n || r >= N || s <= 0n || s > N / 2n || (yParity !== 0 && yParity !== 1)) {
    return null;
  }
  const alpha = mod(r * r * r + 7n, P);
  let y = power(alpha, (P + 1n) / 4n, P);
  if ((y * y) % P !== alpha) {
    return null;
  }
  if (Number(y & 1n) !== yParity) {
    y = P - y;
  }
  const z = mod(BigInt(hash), N);
  const rInverse = invert(r, N);
  const q = add(multiply(mod(-z * rInverse, N), G), multiply(mod(s * rInverse, N), [r, y]));
  if (q === null) {
    return null;
  }
  const digest = keccak256(/** @type {Hex} */ (`0x${q[0].toString(16).padStart(64, "0")}${q[1].toString(16).padStart(64, "0")}`));
  return getAddress(`0x${digest.slice(-40)}`);
}

/**
 * The authority of an authorization on `chainId`, or null when the tuple is one the protocol skips: another chain
 * (only 0 or this chain), a nonce of 2^64 − 1 or more, or a signature that does not recover (EIP-7702 "Behavior").
 * The authority's own nonce at the time is not checked here: the verifier requires its delegation in the state instead.
 *
 * @param {Authorization} a
 * @param {number} chainId
 * @returns {Address | null}
 */
export function authorizationAuthority(a, chainId) {
  if ((a.chainId !== 0n && a.chainId !== BigInt(chainId)) || a.nonce >= MAX_NONCE) {
    return null;
  }
  return recoverSigner(authorizationHash(a), a);
}

/**
 * The address an account delegates to when its code is an EIP-7702 delegation designator `0xef0100 ‖ address`, else null.
 *
 * @param {Hex} code
 * @returns {Address | null}
 */
export function delegationOf(code) {
  const c = code.toLowerCase();
  return /^0xef0100[0-9a-f]{40}$/.test(c) ? getAddress(`0x${c.slice(8)}`) : null;
}
