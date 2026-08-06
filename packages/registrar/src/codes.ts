import { randomBytes } from 'node:crypto';

/**
 * Voter code format: VC-XXXXX-XXXXX-XXXXX-XXXXX
 * 20 symbols from a 32-char alphabet (no I, L, O, U — Crockford-style,
 * avoids lookalikes) = 100 bits of entropy.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

export function generateVoterCode(): string {
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) {
    // 256 % 32 === 0, so the modulo is uniform
    s += CODE_ALPHABET[bytes[i]! % 32]!;
  }
  return `VC-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
