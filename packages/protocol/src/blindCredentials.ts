import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { base64UrlToBytes, bytesToBase64Url, concatBytes, hexToBytes, utf8ToBytes } from './bytes';
import { generateEd25519KeyPair } from './ed25519';
import type { RsaPublicJwk } from './types';

/**
 * Anonymous voting credentials via RFC 9474 blind RSA signatures
 * (RSABSSA-SHA384-PSS-Randomized — the RFC-recommended variant).
 *
 * The registrar blind-signs the voter's ephemeral public key ("token") wrapped
 * in a domain-tagged message. The blindness property means the registrar
 * cannot link the finished credential to the code that requested it — even if
 * it logs everything.
 */

export const CREDENTIAL_DOMAIN_TAG = 'VBC-CRED-v1';
export const CREDENTIAL_PREFIX_LENGTH = 32;
export const TOKEN_LENGTH = 32;

// One shared suite instance. Randomized => prepare() prepends 32 fresh random
// bytes (msg_prefix), carried in the vote tx as `tokenPrefix`.
const suite = RSABSSA.SHA384.PSS.Randomized();

/**
 * WebCrypto types derived from the runtime value so this file typechecks under
 * both the DOM lib (browsers/UIs) and @types/node (services) — the ambient
 * names differ between the two environments, the value shape does not.
 */
export type WebCryptoKey = InstanceType<typeof globalThis.CryptoKey>;
type Subtle = typeof globalThis.crypto.subtle;

/** Structural JWK type usable under both DOM and Node type environments. */
export interface PrivateJwk {
  kty?: string;
  n?: string;
  e?: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  alg?: string;
  ext?: boolean;
  key_ops?: string[];
  use?: string;
}

function subtle(): Subtle {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) is unavailable in this environment');
  }
  return c.subtle;
}

const RSA_PSS_IMPORT_PARAMS = { name: 'RSA-PSS', hash: 'SHA-384' } as const;

/**
 * The exact bytes the registrar blind-signs (before the RSABSSA prepare
 * prefix): domain tag || chainId || electionId || token. Binding chainId and
 * electionId is defense-in-depth on top of the per-election key rule.
 */
export function buildCredentialMessage(chainId: string, electionId: string, tokenBytes: Uint8Array): Uint8Array {
  return concatBytes(
    utf8ToBytes(CREDENTIAL_DOMAIN_TAG),
    hexToBytes(chainId),
    utf8ToBytes(electionId),
    tokenBytes,
  );
}

// ---------------------------------------------------------------------------
// Registrar side

export interface CredentialKeyPairJwks {
  publicJwk: RsaPublicJwk;
  /** full private JWK — stored only by the registrar, never leaves it */
  privateJwk: PrivateJwk;
}

export async function generateCredentialKeyPair(modulusLength = 3072): Promise<CredentialKeyPairJwks> {
  const { privateKey, publicKey } = await RSABSSA.SHA384.generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength,
  });
  const pub = await subtle().exportKey('jwk', publicKey);
  const priv = await subtle().exportKey('jwk', privateKey);
  if (!pub.n || !pub.e) throw new Error('RSA key export failed');
  // On-chain representation is exactly {e, kty, n} so the canonical encoding
  // (and the attestation signature) is unambiguous.
  return { publicJwk: { e: pub.e, kty: 'RSA', n: pub.n }, privateJwk: priv };
}

export async function importCredentialPrivateKey(privateJwk: PrivateJwk): Promise<WebCryptoKey> {
  // blindrsa-ts requires extractable keys (it re-exports the JWK internally).
  return subtle().importKey('jwk', privateJwk, RSA_PSS_IMPORT_PARAMS, true, ['sign']);
}

/** Registrar: sign a blinded message. The registrar never sees the token. */
export async function blindSignCredential(privateKey: WebCryptoKey, blindedTokenB64: string): Promise<string> {
  const blindSig = await suite.blindSign(privateKey, base64UrlToBytes(blindedTokenB64));
  return bytesToBase64Url(blindSig);
}

// ---------------------------------------------------------------------------
// Voter side

const publicKeyCache = new Map<string, Promise<WebCryptoKey>>();

export function importCredentialPublicKey(publicJwk: RsaPublicJwk): Promise<WebCryptoKey> {
  const cacheKey = publicJwk.n + '.' + publicJwk.e;
  let cached = publicKeyCache.get(cacheKey);
  if (!cached) {
    cached = subtle().importKey(
      'jwk',
      { kty: 'RSA', n: publicJwk.n, e: publicJwk.e },
      RSA_PSS_IMPORT_PARAMS,
      true,
      ['verify'],
    );
    publicKeyCache.set(cacheKey, cached);
    cached.catch(() => publicKeyCache.delete(cacheKey));
  }
  return cached;
}

/**
 * Everything the voter's device must persist to survive a crash between
 * requesting and finalizing a credential: replaying the identical blindedToken
 * lets the registrar respond idempotently with the stored blind signature.
 */
export interface CredentialRequestMaterial {
  electionId: string;
  tokenSecretKey: string;
  token: string;
  tokenPrefix: string;
  preparedMsg: string;
  blindedToken: string;
  inv: string;
}

export async function createCredentialRequest(
  publicJwk: RsaPublicJwk,
  chainId: string,
  electionId: string,
): Promise<CredentialRequestMaterial> {
  const keyPair = generateEd25519KeyPair();
  const tokenBytes = base64UrlToBytes(keyPair.publicKey);
  const message = buildCredentialMessage(chainId, electionId, tokenBytes);
  const prepared = suite.prepare(message);
  const tokenPrefix = prepared.slice(0, CREDENTIAL_PREFIX_LENGTH);
  const publicKey = await importCredentialPublicKey(publicJwk);
  const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
  return {
    electionId,
    tokenSecretKey: keyPair.secretKey,
    token: keyPair.publicKey,
    tokenPrefix: bytesToBase64Url(tokenPrefix),
    preparedMsg: bytesToBase64Url(prepared),
    blindedToken: bytesToBase64Url(blindedMsg),
    inv: bytesToBase64Url(inv),
  };
}

/** Unblind the registrar's response into the final credential signature. Throws if invalid. */
export async function finalizeCredential(
  publicJwk: RsaPublicJwk,
  material: Pick<CredentialRequestMaterial, 'preparedMsg' | 'inv'>,
  blindSignatureB64: string,
): Promise<string> {
  const publicKey = await importCredentialPublicKey(publicJwk);
  const sig = await suite.finalize(
    publicKey,
    base64UrlToBytes(material.preparedMsg),
    base64UrlToBytes(blindSignatureB64),
    base64UrlToBytes(material.inv),
  );
  return bytesToBase64Url(sig);
}

// ---------------------------------------------------------------------------
// Verifier side (every node, every auditor)

export function modulusByteLength(publicJwk: RsaPublicJwk): number {
  return base64UrlToBytes(publicJwk.n).length;
}

export function modulusBitLength(publicJwk: RsaPublicJwk): number {
  const bytes = base64UrlToBytes(publicJwk.n);
  if (bytes.length === 0) return 0;
  let bits = (bytes.length - 1) * 8;
  let first = bytes[0]!;
  while (first > 0) {
    bits++;
    first >>= 1;
  }
  return bits;
}

/** Verify a credential signature. Never throws. */
export async function verifyCredential(
  publicJwk: RsaPublicJwk,
  chainId: string,
  electionId: string,
  tokenB64: string,
  tokenPrefixB64: string,
  credentialSigB64: string,
): Promise<boolean> {
  try {
    const tokenBytes = base64UrlToBytes(tokenB64);
    const prefixBytes = base64UrlToBytes(tokenPrefixB64);
    if (tokenBytes.length !== TOKEN_LENGTH || prefixBytes.length !== CREDENTIAL_PREFIX_LENGTH) return false;
    const sigBytes = base64UrlToBytes(credentialSigB64);
    // Canonical RSA signature length == modulus length (malleability guard).
    if (sigBytes.length !== modulusByteLength(publicJwk)) return false;
    const prepared = concatBytes(prefixBytes, buildCredentialMessage(chainId, electionId, tokenBytes));
    const publicKey = await importCredentialPublicKey(publicJwk);
    return await suite.verify(publicKey, sigBytes, prepared);
  } catch {
    return false;
  }
}
