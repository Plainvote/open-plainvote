import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createCredentialRequest,
  finalizeCredential,
  generateEd25519KeyPair,
  issuanceCommitSigPayload,
  registrarAttestationPayload,
  verifyCredential,
  verifyJson,
  voterCodeHash,
  type IssuanceCommitTx,
  type RsaPublicJwk,
} from '@votechain/protocol';
import { createRegistrarServer } from '@votechain/registrar';

const CHAIN_ID = 'c'.repeat(64);
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';

let app: FastifyInstance;
let registrarKey: { publicKey: string; secretKey: string };
let stubNode: Server;
let stubNodeUrl: string;
let lastSubmittedTx: unknown;

beforeAll(async () => {
  registrarKey = generateEd25519KeyPair();

  stubNode = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastSubmittedTx = (JSON.parse(body) as { tx: unknown }).tx;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accepted: true, txHash: 'stub' }));
    });
  });
  await new Promise<void>((resolve) => stubNode.listen(0, '127.0.0.1', resolve));
  const address = stubNode.address();
  if (typeof address !== 'object' || address === null) throw new Error('stub node has no address');
  stubNodeUrl = `http://127.0.0.1:${address.port}`;

  app = await createRegistrarServer({
    port: 0,
    dbPath: ':memory:',
    adminApiKey: ADMIN_KEY,
    chainId: CHAIN_ID,
    registrarSecretKey: registrarKey.secretKey,
    registrarPublicKey: registrarKey.publicKey,
    nodeUrl: stubNodeUrl,
    credentialModulusBits: 2048, // fast tests; production default is 3072
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) => stubNode.close((e) => (e ? reject(e) : resolve())));
});

const admin = { 'x-admin-key': ADMIN_KEY };

async function generateCodes(count: number): Promise<string[]> {
  const res = await app.inject({ method: 'POST', url: '/admin/codes', headers: admin, payload: { count } });
  expect(res.statusCode).toBe(200);
  return res.json().codes as string[];
}

async function createElectionKeys(electionId: string): Promise<{ publicKeyJwk: RsaPublicJwk; attestationSig: string }> {
  const res = await app.inject({ method: 'POST', url: `/admin/elections/${electionId}/keys`, headers: admin, payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function requestCredential(code: string, electionId: string, blindedToken: string) {
  return app.inject({ method: 'POST', url: '/credentials', payload: { code, electionId, blindedToken } });
}

describe('registrar', () => {
  it('rejects admin requests without a valid key', async () => {
    for (const headers of [{}, { 'x-admin-key': 'wrong' }]) {
      const res = await app.inject({ method: 'POST', url: '/admin/codes', headers, payload: { count: 1 } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('generates codes, stores only hashes, and lists them', async () => {
    const codes = await generateCodes(3);
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^VC(-[A-Z0-9]{5}){4}$/);
    const list = await app.inject({ method: 'GET', url: '/admin/codes', headers: admin });
    const rows = list.json().codes as { codeHash: string; status: string }[];
    const hashes = new Set(rows.map((r) => r.codeHash));
    for (const code of codes) {
      expect(hashes.has(voterCodeHash(code))).toBe(true);
    }
    const raw = JSON.stringify(list.json());
    for (const code of codes) expect(raw).not.toContain(code);
  });

  it('issues a credential that verifies against the attested election key', async () => {
    const [code] = await generateCodes(1);
    const { publicKeyJwk, attestationSig } = await createElectionKeys('e-verify');
    expect(
      verifyJson(attestationSig, registrarAttestationPayload(CHAIN_ID, 'e-verify', publicKeyJwk), registrarKey.publicKey),
    ).toBe(true);

    const material = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-verify');
    const res = await requestCredential(code!, 'e-verify', material.blindedToken);
    expect(res.statusCode).toBe(200);
    const credentialSig = await finalizeCredential(publicKeyJwk, material, res.json().blindSignature);
    expect(
      await verifyCredential(publicKeyJwk, CHAIN_ID, 'e-verify', material.token, material.tokenPrefix, credentialSig),
    ).toBe(true);
  });

  it('is idempotent for an identical retry, refuses a different blinded request', async () => {
    const [code] = await generateCodes(1);
    const { publicKeyJwk } = await createElectionKeys('e-idem');
    const material = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-idem');

    const first = await requestCredential(code!, 'e-idem', material.blindedToken);
    expect(first.statusCode).toBe(200);
    const retry = await requestCredential(code!, 'e-idem', material.blindedToken);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().blindSignature).toBe(first.json().blindSignature);

    const secondAttempt = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-idem');
    const refused = await requestCredential(code!, 'e-idem', secondAttempt.blindedToken);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('already_issued');
  });

  it('grants exactly one credential under a 10-way parallel race', async () => {
    const [code] = await generateCodes(1);
    const { publicKeyJwk } = await createElectionKeys('e-race');
    const materials = await Promise.all(
      Array.from({ length: 10 }, () => createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-race')),
    );
    const responses = await Promise.all(materials.map((m) => requestCredential(code!, 'e-race', m.blindedToken)));
    const successes = responses.filter((r) => r.statusCode === 200);
    const conflicts = responses.filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
  });

  it('rejects unknown codes, revoked codes, and unknown elections', async () => {
    const { publicKeyJwk } = await createElectionKeys('e-reject');
    const material = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-reject');
    const unknown = await requestCredential('VC-AAAAA-AAAAA-AAAAA-AAAAA', 'e-reject', material.blindedToken);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('unknown_code');

    const [code] = await generateCodes(1);
    const noElection = await requestCredential(code!, 'e-none', material.blindedToken);
    expect(noElection.statusCode).toBe(404);
    expect(noElection.json().error).toBe('unknown_election');

    const revoke = await app.inject({
      method: 'POST',
      url: '/admin/codes/revoke',
      headers: admin,
      payload: { codeHash: voterCodeHash(code!) },
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = await requestCredential(code!, 'e-reject', material.blindedToken);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error).toBe('code_revoked');
  });

  it('regeneration transfers issuance flags and revokes the old code', async () => {
    const [code] = await generateCodes(1);
    const { publicKeyJwk } = await createElectionKeys('e-regen');
    const material = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-regen');
    expect((await requestCredential(code!, 'e-regen', material.blindedToken)).statusCode).toBe(200);

    const regen = await app.inject({
      method: 'POST',
      url: '/admin/codes/regenerate',
      headers: admin,
      payload: { codeHash: voterCodeHash(code!) },
    });
    expect(regen.statusCode).toBe(200);
    const newCode = regen.json().code as string;
    expect(newCode).not.toBe(code);

    // old code is dead
    const material2 = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-regen');
    expect((await requestCredential(code!, 'e-regen', material2.blindedToken)).statusCode).toBe(403);
    // new code inherits the issued flag — no second credential for e-regen
    const refused = await requestCredential(newCode, 'e-regen', material2.blindedToken);
    expect(refused.statusCode).toBe(409);
    // but the new code works for a different election
    const { publicKeyJwk: jwk2 } = await createElectionKeys('e-regen-2');
    const material3 = await createCredentialRequest(jwk2, CHAIN_ID, 'e-regen-2');
    expect((await requestCredential(newCode, 'e-regen-2', material3.blindedToken)).statusCode).toBe(200);
  });

  it('audited issuance reset allows re-issue and is publicly counted', async () => {
    const [code] = await generateCodes(1);
    const { publicKeyJwk } = await createElectionKeys('e-reset');
    const material = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-reset');
    expect((await requestCredential(code!, 'e-reset', material.blindedToken)).statusCode).toBe(200);

    const reset = await app.inject({
      method: 'POST',
      url: '/admin/issuance/reset',
      headers: admin,
      payload: { codeHash: voterCodeHash(code!), electionId: 'e-reset' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().resetCount).toBe(1);

    const material2 = await createCredentialRequest(publicKeyJwk, CHAIN_ID, 'e-reset');
    expect((await requestCredential(code!, 'e-reset', material2.blindedToken)).statusCode).toBe(200);

    // the commitment counts total issuance events: 1 live row + 1 reset = 2
    const commit = await app.inject({
      method: 'POST',
      url: '/admin/elections/e-reset/commit',
      headers: admin,
      payload: {},
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().issuedCount).toBe(2);
    expect(commit.json().resetCount).toBe(1);
    expect(commit.json().accepted).toBe(true);

    const tx = lastSubmittedTx as IssuanceCommitTx;
    expect(tx.type).toBe('ISSUANCE_COMMIT');
    expect(tx.electionId).toBe('e-reset');
    expect(verifyJson(tx.registrarSig, issuanceCommitSigPayload(tx), registrarKey.publicKey)).toBe(true);
  });

  it('reports stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers: admin });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.activeCodes).toBeGreaterThan(0);
    expect(Array.isArray(stats.elections)).toBe(true);
    const eReset = stats.elections.find((e: { electionId: string }) => e.electionId === 'e-reset');
    expect(eReset.resets).toBe(1);
  });

  it('refuses duplicate election key creation', async () => {
    await createElectionKeys('e-dup');
    const res = await app.inject({ method: 'POST', url: '/admin/elections/e-dup/keys', headers: admin, payload: {} });
    expect(res.statusCode).toBe(409);
  });
});
