import { beforeAll, describe, expect, it } from 'vitest';
import {
  blindSignCredential,
  createCredentialRequest,
  finalizeCredential,
  generateCredentialKeyPair,
  generateEd25519KeyPair,
  importCredentialPrivateKey,
  modulusBitLength,
  modulusByteLength,
  verifyCredential,
  type CredentialKeyPairJwks,
} from '@votechain/protocol';

const CHAIN_ID = 'a'.repeat(64);
const ELECTION_ID = 'election-blind-test';

let keys: CredentialKeyPairJwks;
let privateKey: CryptoKey;

beforeAll(async () => {
  keys = await generateCredentialKeyPair(2048);
  privateKey = await importCredentialPrivateKey(keys.privateJwk);
});

describe('blind credentials (RFC 9474 RSABSSA)', () => {
  it('exports a minimal on-chain public JWK with e=65537', () => {
    expect(Object.keys(keys.publicJwk).sort()).toEqual(['e', 'kty', 'n']);
    expect(keys.publicJwk.e).toBe('AQAB');
    expect(keys.publicJwk.kty).toBe('RSA');
    expect(modulusBitLength(keys.publicJwk)).toBe(2048);
    expect(modulusByteLength(keys.publicJwk)).toBe(256);
  });

  it('completes the blind → blindSign → finalize → verify roundtrip', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const blindSig = await blindSignCredential(privateKey, material.blindedToken);
    const credentialSig = await finalizeCredential(keys.publicJwk, material, blindSig);
    const ok = await verifyCredential(
      keys.publicJwk,
      CHAIN_ID,
      ELECTION_ID,
      material.token,
      material.tokenPrefix,
      credentialSig,
    );
    expect(ok).toBe(true);
  });

  it('the blinded message never reveals the token (basic sanity)', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    expect(material.blindedToken).not.toContain(material.token);
    expect(material.preparedMsg).not.toBe(material.blindedToken);
  });

  it('rejects a credential presented for a different token', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const blindSig = await blindSignCredential(privateKey, material.blindedToken);
    const credentialSig = await finalizeCredential(keys.publicJwk, material, blindSig);
    const otherToken = generateEd25519KeyPair().publicKey;
    expect(
      await verifyCredential(keys.publicJwk, CHAIN_ID, ELECTION_ID, otherToken, material.tokenPrefix, credentialSig),
    ).toBe(false);
  });

  it('rejects a credential presented for a different election or chain', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const blindSig = await blindSignCredential(privateKey, material.blindedToken);
    const credentialSig = await finalizeCredential(keys.publicJwk, material, blindSig);
    expect(
      await verifyCredential(keys.publicJwk, CHAIN_ID, 'other-election', material.token, material.tokenPrefix, credentialSig),
    ).toBe(false);
    expect(
      await verifyCredential(keys.publicJwk, 'b'.repeat(64), ELECTION_ID, material.token, material.tokenPrefix, credentialSig),
    ).toBe(false);
  });

  it('rejects a tampered prefix or signature', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const blindSig = await blindSignCredential(privateKey, material.blindedToken);
    const credentialSig = await finalizeCredential(keys.publicJwk, material, blindSig);
    const otherMaterial = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    expect(
      await verifyCredential(keys.publicJwk, CHAIN_ID, ELECTION_ID, material.token, otherMaterial.tokenPrefix, credentialSig),
    ).toBe(false);
    const flipped = (credentialSig[0] === 'A' ? 'B' : 'A') + credentialSig.slice(1);
    expect(
      await verifyCredential(keys.publicJwk, CHAIN_ID, ELECTION_ID, material.token, material.tokenPrefix, flipped),
    ).toBe(false);
  });

  it('rejects a credential from a different key (per-election keys)', async () => {
    const otherKeys = await generateCredentialKeyPair(2048);
    const material = await createCredentialRequest(otherKeys.publicJwk, CHAIN_ID, ELECTION_ID);
    const otherPriv = await importCredentialPrivateKey(otherKeys.privateJwk);
    const blindSig = await blindSignCredential(otherPriv, material.blindedToken);
    const credentialSig = await finalizeCredential(otherKeys.publicJwk, material, blindSig);
    expect(
      await verifyCredential(keys.publicJwk, CHAIN_ID, ELECTION_ID, material.token, material.tokenPrefix, credentialSig),
    ).toBe(false);
  });

  it('finalize itself rejects a forged blind signature', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const forged = material.blindedToken; // random-looking group element, not a signature
    await expect(finalizeCredential(keys.publicJwk, material, forged)).rejects.toThrow();
  });

  it('replaying the identical blinded request yields the identical blind signature (idempotent retry)', async () => {
    const material = await createCredentialRequest(keys.publicJwk, CHAIN_ID, ELECTION_ID);
    const sig1 = await blindSignCredential(privateKey, material.blindedToken);
    const sig2 = await blindSignCredential(privateKey, material.blindedToken);
    expect(sig1).toBe(sig2); // RSA signing is deterministic for a fixed blinded message
  });
});
