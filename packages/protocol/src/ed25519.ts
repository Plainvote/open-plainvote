import { ed25519 } from '@noble/curves/ed25519.js';
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from './bytes';
import { canonicalJson } from './canonicalJson';

/**
 * Ed25519 via @noble/curves (pure JS, RFC 8032 canonical signatures) rather
 * than WebCrypto: identical behavior in every browser and in Node, which is
 * what consensus verification requires.
 */

export interface Ed25519KeyPair {
  /** base64url, 32 bytes */
  publicKey: string;
  /** base64url, 32 bytes */
  secretKey: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    secretKey: bytesToBase64Url(secretKey),
    publicKey: bytesToBase64Url(publicKey),
  };
}

export function ed25519PublicKeyFromSecret(secretKeyB64: string): string {
  return bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(secretKeyB64)));
}

export function signBytes(message: Uint8Array, secretKeyB64: string): string {
  return bytesToBase64Url(ed25519.sign(message, base64UrlToBytes(secretKeyB64)));
}

export function verifyBytes(signatureB64: string, message: Uint8Array, publicKeyB64: string): boolean {
  try {
    const sig = base64UrlToBytes(signatureB64);
    const pub = base64UrlToBytes(publicKeyB64);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}

/** Sign the canonical JSON serialization of `value`. */
export function signJson(value: unknown, secretKeyB64: string): string {
  return signBytes(utf8ToBytes(canonicalJson(value)), secretKeyB64);
}

/** Verify a signature over the canonical JSON serialization of `value`. Never throws. */
export function verifyJson(signatureB64: string, value: unknown, publicKeyB64: string): boolean {
  try {
    return verifyBytes(signatureB64, utf8ToBytes(canonicalJson(value)), publicKeyB64);
  } catch {
    return false;
  }
}

export function isEd25519PublicKey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    return base64UrlToBytes(s).length === 32;
  } catch {
    return false;
  }
}
