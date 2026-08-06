import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from './bytes';
import { canonicalJson } from './canonicalJson';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  return bytesToHex(sha256(bytes));
}

/** The universal protocol hash: sha256 over the canonical JSON serialization. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Voter codes are normalized before hashing so trivial re-typing differences
 * (case, stray whitespace) do not change identity. The registrar stores ONLY
 * this hash — never the plaintext code.
 */
export function normalizeVoterCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export function voterCodeHash(code: string): string {
  return sha256Hex(normalizeVoterCode(code));
}
