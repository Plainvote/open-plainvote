import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64UrlToBytes, utf8ToBytes } from './bytes';

/**
 * Return codes — a cast-as-intended verification layer against a compromised
 * voting device.
 *
 * Before an election, a Return-Code Authority (RCA) mails each voter a code
 * sheet listing a short, secret code for every voting option, derived from a
 * per-sheet secret the voter's device never holds. After a ballot is recorded,
 * the RCA reads the ballot from the public chain and returns the code(s) for
 * the option(s) actually recorded. The voter checks those against the mailed
 * sheet: malware that silently flipped the vote produces the code for the
 * WRONG option, which will not match the sheet — so the manipulation is
 * detected.
 *
 * These helpers are the single, shared derivation used by the RCA to build
 * sheets and to answer verification requests. Determinism matters: the same
 * (secret, election, question, option) MUST always yield the same code, and
 * different options MUST yield different codes.
 */

export const RETURN_CODE_DOMAIN = 'VBC-RC-v1';
export const CAST_CODE_DOMAIN = 'VBC-RC-CAST-v1';
export const RETURN_CODE_LENGTH = 4;
export const CAST_CODE_LENGTH = 6;

// Crockford base32 (no I, L, O, U) — unambiguous for humans reading a sheet.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode the leading bits of `mac` as `chars` Crockford-base32 characters. */
function shortCode(mac: Uint8Array, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < mac.length && out.length < chars; i++) {
    value = (value << 8) | mac[i]!;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  return out;
}

/**
 * The secret code shown on the voter's sheet for a single option, and returned
 * by the RCA when that option is the one recorded on chain.
 */
export function deriveReturnCode(
  sheetSecretB64: string,
  electionId: string,
  questionId: string,
  optionId: string,
): string {
  const key = base64UrlToBytes(sheetSecretB64);
  const msg = utf8ToBytes(`${RETURN_CODE_DOMAIN}|${electionId}|${questionId}|${optionId}`);
  return shortCode(hmac(sha256, key, msg), RETURN_CODE_LENGTH);
}

/**
 * A per-sheet, per-election "your ballot was seen on chain" confirmation code,
 * independent of the chosen options. Lets a voter confirm the RCA is looking at
 * a real recorded ballot before trusting the option codes.
 */
export function deriveCastCode(sheetSecretB64: string, electionId: string): string {
  const key = base64UrlToBytes(sheetSecretB64);
  const msg = utf8ToBytes(`${CAST_CODE_DOMAIN}|${electionId}`);
  return shortCode(hmac(sha256, key, msg), CAST_CODE_LENGTH);
}
