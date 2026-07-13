import { scryptAsync } from "@noble/hashes/scrypt.js";

/**
 * Runtime-agnostic (WebCrypto only, no Node built-ins) scrypt password hashing.
 * Stored format: `scrypt$N=<N>,r=<r>,p=<p>$<saltB64>$<hashB64>`.
 *
 * `verifyPassword` parses `N`/`r`/`p` and the key length back out of the stored
 * string rather than assuming today's constants, so changing `SCRYPT_PARAMS`
 * never invalidates hashes already on disk.
 */

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const DK_LEN = 32;

/** Base64-encodes raw bytes using the platform's `btoa` (avoids the Buffer built-in). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

/** Decodes base64 to raw bytes; throws on malformed input (caller must catch). */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const derived = await scryptAsync(pw, salt, { ...SCRYPT_PARAMS, dkLen: DK_LEN });
  const params = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
  return `scrypt$${params}$${toBase64(salt)}$${toBase64(derived)}`;
}

interface ParsedScryptString {
  N: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

// Hostile-input DoS guard: a legitimate stored string's params segment is
// ~20 chars and its base64 segments 24/44 chars, so these caps are generous
// while refusing to base64-decode (or scrypt over) megabytes of
// attacker-controlled "hash".
const MAX_PARAMS_SEGMENT_CHARS = 256;
const MAX_BASE64_SEGMENT_CHARS = 1024;

/**
 * Parses a `scrypt$N=...,r=...,p=...$<saltB64>$<hashB64>` string. Params are
 * looked up by key (not position) so a future reordering stays parseable.
 * Returns `undefined` for anything malformed; never throws.
 */
function parseStored(stored: string): ParsedScryptString | undefined {
  const segments = stored.split("$");
  if (segments.length !== 4) return undefined;
  const [scheme, paramsStr, saltB64, hashB64] = segments;
  if (scheme !== "scrypt") return undefined;
  if (!paramsStr || !saltB64 || !hashB64) return undefined;
  // Length caps before any decoding (see the MAX_* constants above).
  if (paramsStr.length > MAX_PARAMS_SEGMENT_CHARS) return undefined;
  if (saltB64.length > MAX_BASE64_SEGMENT_CHARS || hashB64.length > MAX_BASE64_SEGMENT_CHARS) return undefined;

  const params: Record<string, number> = {};
  for (const pair of paramsStr.split(",")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0 || eqIndex === pair.length - 1) return undefined;
    const key = pair.slice(0, eqIndex);
    const value = Number(pair.slice(eqIndex + 1));
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
    params[key] = value;
  }
  const { N, r, p } = params;
  if (N === undefined || r === undefined || p === undefined) return undefined;

  try {
    const salt = fromBase64(saltB64);
    const hash = fromBase64(hashB64);
    return { N, r, p, salt, hash };
  } catch {
    return undefined;
  }
}

/**
 * Constant-time byte comparison: accumulates XOR differences over the full
 * length of the longer array (never short-circuits), including on a length
 * mismatch, so comparison timing does not vary with where the arrays differ.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const av = i < a.length ? (a[i] as number) : 0;
    const bv = i < b.length ? (b[i] as number) : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;

  const { N, r, p, salt, hash } = parsed;
  try {
    const candidate = await scryptAsync(pw, salt, { N, r, p, dkLen: hash.length });
    return constantTimeEqual(candidate, hash);
  } catch {
    // Malformed-but-parseable params (e.g. a non-power-of-two N) can make scrypt
    // throw; never let a corrupt stored string surface as a 500.
    return false;
  }
}
