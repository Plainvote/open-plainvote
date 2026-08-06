import { describe, expect, it } from 'vitest';
import {
  bytesToBase64Url,
  deriveCastCode,
  deriveReturnCode,
  randomBytes,
  CAST_CODE_LENGTH,
  RETURN_CODE_LENGTH,
} from '@votechain/protocol';

const secretA = bytesToBase64Url(randomBytes(32));
const secretB = bytesToBase64Url(randomBytes(32));
const ALPHABET = /^[0-9A-HJKMNP-TV-Z]+$/; // Crockford base32

describe('return codes', () => {
  it('produces codes of the documented length from the Crockford alphabet', () => {
    const c = deriveReturnCode(secretA, 'e1', 'q1', 'yes');
    expect(c).toHaveLength(RETURN_CODE_LENGTH);
    expect(c).toMatch(ALPHABET);
    expect(deriveCastCode(secretA, 'e1')).toHaveLength(CAST_CODE_LENGTH);
  });

  it('is deterministic for the same inputs', () => {
    expect(deriveReturnCode(secretA, 'e1', 'q1', 'yes')).toBe(deriveReturnCode(secretA, 'e1', 'q1', 'yes'));
    expect(deriveCastCode(secretA, 'e1')).toBe(deriveCastCode(secretA, 'e1'));
  });

  it('gives different codes for different options — this is what detects a flipped vote', () => {
    const yes = deriveReturnCode(secretA, 'e1', 'q1', 'yes');
    const no = deriveReturnCode(secretA, 'e1', 'q1', 'no');
    expect(yes).not.toBe(no);
  });

  it('separates by question, election, and sheet secret', () => {
    expect(deriveReturnCode(secretA, 'e1', 'q1', 'yes')).not.toBe(deriveReturnCode(secretA, 'e1', 'q2', 'yes'));
    expect(deriveReturnCode(secretA, 'e1', 'q1', 'yes')).not.toBe(deriveReturnCode(secretA, 'e2', 'q1', 'yes'));
    expect(deriveReturnCode(secretA, 'e1', 'q1', 'yes')).not.toBe(deriveReturnCode(secretB, 'e1', 'q1', 'yes'));
    expect(deriveCastCode(secretA, 'e1')).not.toBe(deriveCastCode(secretB, 'e1'));
  });

  it('spreads across the option space (no trivially colliding codes for a small ballot)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(deriveReturnCode(secretA, 'e1', 'q1', `opt-${i}`));
    // 50 codes from a 4-char/20-bit space: collisions astronomically unlikely
    expect(codes.size).toBe(50);
  });
});
