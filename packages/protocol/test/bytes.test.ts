import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes, isBase64Url, randomBytes } from '@votechain/protocol';

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33, 64, 100]) {
      const bytes = randomBytes(len);
      const encoded = bytesToBase64Url(bytes);
      expect(base64UrlToBytes(encoded)).toEqual(bytes);
    }
  });

  it('matches Node Buffer base64url encoding', () => {
    const bytes = randomBytes(48);
    expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('rejects non-canonical encodings (trailing-bit malleability guard)', () => {
    // 'B' = 000001: for a 2-char tail only the top 4 bits may be set.
    expect(() => base64UrlToBytes('AB')).toThrow(/non-canonical/);
    // 3-char tail: low 2 bits of the last char must be zero.
    expect(() => base64UrlToBytes('AAB')).toThrow(/non-canonical/);
    // The canonical encodings decode fine.
    expect(base64UrlToBytes('AQ')).toEqual(Uint8Array.from([1]));
    expect(base64UrlToBytes('AAE')).toEqual(Uint8Array.from([0, 1]));
  });

  it('two distinct 32-byte tokens can never be the same string', () => {
    const bytes = randomBytes(32);
    const canonical = bytesToBase64Url(bytes);
    // flip unused low bits of the final character — must be rejected
    const last = canonical[canonical.length - 1]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tampered = canonical.slice(0, -1) + alphabet[(alphabet.indexOf(last) ^ 1) % 64];
    expect(() => base64UrlToBytes(tampered)).toThrow();
  });

  it('rejects invalid characters, padding, and impossible lengths', () => {
    expect(() => base64UrlToBytes('a+b/')).toThrow(/invalid character/);
    expect(() => base64UrlToBytes('AQ==')).toThrow(/invalid character/);
    expect(() => base64UrlToBytes('AAAAA')).toThrow(/invalid length/);
    expect(isBase64Url('AQ')).toBe(true);
    expect(isBase64Url('AQ==')).toBe(false);
    expect(isBase64Url(42)).toBe(false);
  });
});

describe('hex', () => {
  it('round-trips and enforces lowercase', () => {
    const bytes = randomBytes(32);
    const hex = bytesToHex(bytes);
    expect(hexToBytes(hex)).toEqual(bytes);
    expect(() => hexToBytes(hex.toUpperCase())).toThrow(/hex/);
    expect(() => hexToBytes('abc')).toThrow(/hex/);
  });
});
