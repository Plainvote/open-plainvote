/**
 * Byte-level encodings used across the protocol.
 *
 * All binary fields on the wire are base64url WITHOUT padding, and decoding is
 * strict: a string that is not the canonical encoding of its bytes is rejected.
 * Strictness is a consensus requirement — two distinct strings must never
 * decode to the same bytes, otherwise dedup keys (e.g. vote tokens) become
 * malleable.
 */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_CODES = new Int8Array(128).fill(-1);
for (let i = 0; i < B64URL_ALPHABET.length; i++) {
  B64URL_CODES[B64URL_ALPHABET.charCodeAt(i)] = i;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

export function base64UrlToBytes(s: string): Uint8Array {
  const rem = s.length % 4;
  if (rem === 1) throw new Error('base64url: invalid length');
  const outLen = Math.floor((s.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = codeAt(s, i);
    const c1 = codeAt(s, i + 1);
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 >= s.length) {
      // 2-char tail: low 4 bits of c1 must be zero for canonical encoding
      if ((c1 & 0x0f) !== 0) throw new Error('base64url: non-canonical encoding');
      break;
    }
    const c2 = codeAt(s, i + 2);
    out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 >= s.length) {
      // 3-char tail: low 2 bits of c2 must be zero for canonical encoding
      if ((c2 & 0x03) !== 0) throw new Error('base64url: non-canonical encoding');
      break;
    }
    const c3 = codeAt(s, i + 3);
    out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}

function codeAt(s: string, i: number): number {
  const cc = s.charCodeAt(i);
  const v = cc < 128 ? B64URL_CODES[cc]! : -1;
  if (v < 0) throw new Error(`base64url: invalid character at index ${i}`);
  return v;
}

/** True iff `s` is a canonical, unpadded base64url string. Never throws. */
export function isBase64Url(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    base64UrlToBytes(s);
    return true;
  } catch {
    return false;
  }
}

const HEX_RE = /^[0-9a-f]*$/;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new Error('invalid lowercase hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isHex(s: unknown, byteLength?: number): s is string {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !HEX_RE.test(s)) return false;
  return byteLength === undefined || s.length === byteLength * 2;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToBytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
