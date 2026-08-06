import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createCredentialRequest,
  generateEd25519KeyPair,
  voterCodeHash,
  type RsaPublicJwk,
} from '@votechain/protocol';
import { createRegistrarServer } from '@votechain/registrar';

/**
 * Roll scoping is what makes a shared registrar safe for more than one
 * organization. Without it every active code is eligible for every election,
 * and cross-tenant voting stays under eligibleCount, so the public
 * reconciliation never flags it.
 */

const CHAIN_ID = 'd'.repeat(64);
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';

let stubNode: Server;
let stubNodeUrl: string;
let registrarKey: { publicKey: string; secretKey: string };

/** Lax registrar: unbound elections stay open to any code (single-tenant default). */
let lax: FastifyInstance;
/** Strict registrar: unbound elections issue nothing (the shared-hosting posture). */
let strict: FastifyInstance;

const admin = { 'x-admin-key': ADMIN_KEY };

beforeAll(async () => {
  registrarKey = generateEd25519KeyPair();
  stubNode = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true, txHash: 'stub' }));
  });
  await new Promise<void>((resolve) => stubNode.listen(0, '127.0.0.1', resolve));
  const address = stubNode.address();
  if (typeof address !== 'object' || address === null) throw new Error('stub node has no address');
  stubNodeUrl = `http://127.0.0.1:${address.port}`;

  const base = {
    port: 0,
    dbPath: ':memory:',
    adminApiKey: ADMIN_KEY,
    chainId: CHAIN_ID,
    registrarSecretKey: registrarKey.secretKey,
    registrarPublicKey: registrarKey.publicKey,
    nodeUrl: stubNodeUrl,
    credentialModulusBits: 2048,
  };
  lax = await createRegistrarServer(base);
  strict = await createRegistrarServer({ ...base, requireRollBinding: true });
  await Promise.all([lax.ready(), strict.ready()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([lax.close(), strict.close()]);
  await new Promise<void>((resolve, reject) => stubNode.close((e) => (e ? reject(e) : resolve())));
});

async function codes(app: FastifyInstance, count: number, rollId?: string): Promise<string[]> {
  const payload = rollId === undefined ? { count } : { count, rollId };
  const res = await app.inject({ method: 'POST', url: '/admin/codes', headers: admin, payload });
  expect(res.statusCode).toBe(200);
  return res.json().codes as string[];
}

async function electionKeys(app: FastifyInstance, electionId: string): Promise<RsaPublicJwk> {
  const res = await app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/keys`,
    headers: admin,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  return res.json().publicKeyJwk as RsaPublicJwk;
}

async function bindRoll(app: FastifyInstance, electionId: string, rollId: string) {
  return app.inject({ method: 'POST', url: `/admin/elections/${electionId}/roll`, headers: admin, payload: { rollId } });
}

/** Ask for a credential with freshly blinded material. */
async function ask(app: FastifyInstance, code: string, electionId: string, jwk: RsaPublicJwk) {
  const material = await createCredentialRequest(jwk, CHAIN_ID, electionId);
  return app.inject({
    method: 'POST',
    url: '/credentials',
    payload: { code, electionId, blindedToken: material.blindedToken },
  });
}

describe('roll scoping', () => {
  it('lets a code vote only in elections bound to its own roll', async () => {
    const jwk = await electionKeys(lax, 'el-org-a');
    expect((await bindRoll(lax, 'el-org-a', 'roll-a')).statusCode).toBe(200);

    const [codeA] = await codes(lax, 1, 'roll-a');
    const [codeB] = await codes(lax, 1, 'roll-b');

    const ok = await ask(lax, codeA!, 'el-org-a', jwk);
    expect(ok.statusCode).toBe(200);

    // The whole point: another tenant's code is refused, not silently counted.
    const refused = await ask(lax, codeB!, 'el-org-a', jwk);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('code_not_in_roll');
  });

  it('refuses an unscoped code for a bound election', async () => {
    const jwk = await electionKeys(lax, 'el-bound');
    await bindRoll(lax, 'el-bound', 'roll-c');
    const [unscoped] = await codes(lax, 1);
    const res = await ask(lax, unscoped!, 'el-bound', jwk);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('code_not_in_roll');
  });

  it('leaves unbound elections open to any code when binding is not required', async () => {
    const jwk = await electionKeys(lax, 'el-legacy');
    const [unscoped] = await codes(lax, 1);
    const [scoped] = await codes(lax, 1, 'roll-d');
    expect((await ask(lax, unscoped!, 'el-legacy', jwk)).statusCode).toBe(200);
    expect((await ask(lax, scoped!, 'el-legacy', jwk)).statusCode).toBe(200);
  });

  it('issues nothing for an unbound election when binding is required', async () => {
    const jwk = await electionKeys(strict, 'el-unbound');
    const [code] = await codes(strict, 1, 'roll-x');
    const res = await ask(strict, code!, 'el-unbound', jwk);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('roll_not_bound');

    await bindRoll(strict, 'el-unbound', 'roll-x');
    expect((await ask(strict, code!, 'el-unbound', jwk)).statusCode).toBe(200);
  });

  it('is idempotent for the same roll and refuses to re-point at another', async () => {
    await electionKeys(lax, 'el-rebind');
    expect((await bindRoll(lax, 'el-rebind', 'roll-e')).statusCode).toBe(200);

    const again = await bindRoll(lax, 'el-rebind', 'roll-e');
    expect(again.statusCode).toBe(200);
    expect(again.json().bound).toBe(false);

    const moved = await bindRoll(lax, 'el-rebind', 'roll-f');
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error).toBe('roll_conflict');
  });

  it('carries the roll across a regenerated code', async () => {
    const jwk = await electionKeys(lax, 'el-regen');
    await bindRoll(lax, 'el-regen', 'roll-g');
    const [original] = await codes(lax, 1, 'roll-g');

    const res = await lax.inject({
      method: 'POST',
      url: '/admin/codes/regenerate',
      headers: admin,
      payload: { codeHash: voterCodeHash(original!) },
    });
    expect(res.statusCode).toBe(200);
    const replacement = res.json().code as string;

    // A replacement that lost its rollId would disenfranchise the voter it was
    // issued to rescue.
    expect((await ask(lax, replacement, 'el-regen', jwk)).statusCode).toBe(200);
  });

  it('reports per-roll counts and each election’s roll in stats', async () => {
    await codes(lax, 3, 'roll-stats');
    await electionKeys(lax, 'el-stats');
    await bindRoll(lax, 'el-stats', 'roll-stats');

    const res = await lax.inject({ method: 'GET', url: '/admin/stats', headers: admin });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as {
      rolls: { rollId: string; activeCodes: number }[];
      elections: { electionId: string; rollId: string | null }[];
    };
    expect(stats.rolls.find((r) => r.rollId === 'roll-stats')?.activeCodes).toBe(3);
    expect(stats.elections.find((e) => e.electionId === 'el-stats')?.rollId).toBe('roll-stats');
  });

  it('filters the code list by roll', async () => {
    await codes(lax, 2, 'roll-filter');
    const res = await lax.inject({ method: 'GET', url: '/admin/codes?rollId=roll-filter', headers: admin });
    expect(res.statusCode).toBe(200);
    const listed = res.json().codes as { rollId: string | null }[];
    expect(listed).toHaveLength(2);
    expect(listed.every((c) => c.rollId === 'roll-filter')).toBe(true);
  });
});
