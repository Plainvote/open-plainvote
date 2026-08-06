import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  bytesToHex,
  generateCredentialKeyPair,
  isHex,
  randomBytes,
  registrarAttestationPayload,
  signJson,
  voterCodeHash,
  type RegistrarStats,
} from '@votechain/protocol';
import type { RegistrarConfig } from '../config';
import type { RegistrarDb } from '../db';
import { generateVoterCode } from '../codes';
import { buildAndSubmitIssuanceCommit } from '../commit';
import { generateReturnCodeSheets } from '../returnCodes';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATCH = 10_000;

function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

export function registerAdminRoutes(app: FastifyInstance, db: RegistrarDb, config: RegistrarConfig): void {
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-admin-key'];
    if (typeof key !== 'string' || !constantTimeEqual(key, config.adminApiKey)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid x-admin-key' });
    }
  };

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    /**
     * Generate a batch of voter codes. The plaintext codes appear in this
     * response and NOWHERE else — only their hashes are stored.
     *
     * Pass `rollId` to scope the batch to one electorate; codes then work only
     * in elections bound to that roll.
     */
    admin.post<{ Body: { count: number; rollId?: string } }>(
      '/admin/codes',
      {
        schema: {
          body: {
            type: 'object',
            required: ['count'],
            additionalProperties: false,
            properties: {
              count: { type: 'integer', minimum: 1, maximum: MAX_BATCH },
              rollId: { type: 'string', minLength: 1, maxLength: 64 },
            },
          },
        },
      },
      async (req, reply) => {
        const rollId = req.body.rollId ?? null;
        if (rollId !== null && !ID_RE.test(rollId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid rollId' });
        }
        const codes: string[] = [];
        for (let i = 0; i < req.body.count; i++) codes.push(generateVoterCode());
        db.insertCodes(codes.map(voterCodeHash), Date.now(), rollId);
        return { codes };
      },
    );

    admin.get<{ Querystring: { rollId?: string } }>('/admin/codes', async (req, reply) => {
      const { rollId } = req.query;
      if (rollId !== undefined && !ID_RE.test(rollId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'invalid rollId' });
      }
      return { codes: db.listCodes(rollId) };
    });

    /**
     * Bind an election to a voter roll. Only codes carrying that rollId can
     * obtain credentials for it. Idempotent for the same roll; a different roll
     * is refused, because re-pointing a live election at another electorate
     * would change who is enfranchised without any public trace.
     */
    admin.post<{ Params: { electionId: string }; Body: { rollId: string } }>(
      '/admin/elections/:electionId/roll',
      {
        schema: {
          body: {
            type: 'object',
            required: ['rollId'],
            additionalProperties: false,
            properties: { rollId: { type: 'string', minLength: 1, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        const { electionId } = req.params;
        const { rollId } = req.body;
        if (!ID_RE.test(electionId) || !ID_RE.test(rollId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId or rollId' });
        }
        const outcome = db.bindElectionRoll(electionId, rollId, Date.now());
        if (outcome === 'conflict') {
          const existing = db.getElectionRoll(electionId);
          return reply.code(409).send({
            error: 'roll_conflict',
            message: `This election is already bound to roll ${existing?.rollId ?? 'unknown'}.`,
          });
        }
        return { electionId, rollId, bound: outcome === 'bound' };
      },
    );

    admin.get<{ Params: { electionId: string } }>('/admin/elections/:electionId/roll', async (req, reply) => {
      const { electionId } = req.params;
      if (!ID_RE.test(electionId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
      }
      const binding = db.getElectionRoll(electionId);
      return { electionId, rollId: binding?.rollId ?? null };
    });

    admin.post<{ Body: { codeHash: string } }>(
      '/admin/codes/revoke',
      {
        schema: {
          body: {
            type: 'object',
            required: ['codeHash'],
            additionalProperties: false,
            properties: { codeHash: { type: 'string', minLength: 64, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        if (!isHex(req.body.codeHash, 32)) {
          return reply.code(400).send({ error: 'bad_request', message: 'codeHash must be 32-byte hex' });
        }
        const changed = db.revokeCode(req.body.codeHash, Date.now());
        if (!changed) return reply.code(404).send({ error: 'not_found', message: 'no active code with that hash' });
        return { ok: true };
      },
    );

    /**
     * Regenerate a compromised/lost code: the new code is active immediately,
     * the old one is revoked, and issuance flags transfer so the holder cannot
     * obtain a second credential for elections the old code already used.
     */
    admin.post<{ Body: { codeHash: string } }>(
      '/admin/codes/regenerate',
      {
        schema: {
          body: {
            type: 'object',
            required: ['codeHash'],
            additionalProperties: false,
            properties: { codeHash: { type: 'string', minLength: 64, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        if (!isHex(req.body.codeHash, 32)) {
          return reply.code(400).send({ error: 'bad_request', message: 'codeHash must be 32-byte hex' });
        }
        const code = generateVoterCode();
        const done = db.regenerateCode(req.body.codeHash, voterCodeHash(code), Date.now());
        if (!done) return reply.code(404).send({ error: 'not_found', message: 'no active code with that hash' });
        return { code };
      },
    );

    /** Create the per-election RSA credential keypair + genesis-key attestation. */
    admin.post<{ Params: { electionId: string } }>(
      '/admin/elections/:electionId/keys',
      async (req, reply) => {
        const { electionId } = req.params;
        if (!ID_RE.test(electionId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
        }
        if (db.getElectionKeys(electionId)) {
          return reply.code(409).send({ error: 'exists', message: 'keys already exist for this election' });
        }
        const keyPair = await generateCredentialKeyPair(config.credentialModulusBits ?? 3072);
        const attestationSig = signJson(
          registrarAttestationPayload(config.chainId, electionId, keyPair.publicJwk),
          config.registrarSecretKey,
        );
        db.insertElectionKeys({
          electionId,
          publicJwk: JSON.stringify(keyPair.publicJwk),
          privateJwk: JSON.stringify(keyPair.privateJwk),
          salt: bytesToHex(randomBytes(32)),
          createdAt: Date.now(),
        });
        return { electionId, publicKeyJwk: keyPair.publicJwk, attestationSig };
      },
    );

    /** Build, sign, and submit the on-chain issuance commitment for an election. */
    admin.post<{ Params: { electionId: string } }>(
      '/admin/elections/:electionId/commit',
      async (req, reply) => {
        const { electionId } = req.params;
        if (!ID_RE.test(electionId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
        }
        if (!db.getElectionKeys(electionId)) {
          return reply.code(404).send({ error: 'not_found', message: 'unknown election' });
        }
        const result = await buildAndSubmitIssuanceCommit(db, config, electionId);
        return result;
      },
    );

    /**
     * Audited support hatch for device loss: clears the issuance row so the
     * voter can obtain a fresh credential. Every reset is publicly counted in
     * the issuance commitment — observers can see exactly how often this power
     * was used. NOTE: if the "lost" credential still exists, it remains valid;
     * this trades a bounded, visible integrity risk for not disenfranchising
     * voters whose devices died.
     */
    admin.post<{ Body: { codeHash: string; electionId: string } }>(
      '/admin/issuance/reset',
      {
        schema: {
          body: {
            type: 'object',
            required: ['codeHash', 'electionId'],
            additionalProperties: false,
            properties: {
              codeHash: { type: 'string', minLength: 64, maxLength: 64 },
              electionId: { type: 'string', minLength: 1, maxLength: 64 },
            },
          },
        },
      },
      async (req, reply) => {
        if (!isHex(req.body.codeHash, 32) || !ID_RE.test(req.body.electionId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid codeHash or electionId' });
        }
        const done = db.resetIssuance(req.body.codeHash, req.body.electionId, Date.now());
        if (!done) {
          return reply.code(404).send({ error: 'not_found', message: 'no issuance recorded for that code and election' });
        }
        return { ok: true, resetCount: db.countResets(req.body.electionId) };
      },
    );

    admin.get('/admin/stats', async (): Promise<RegistrarStats> => {
      const { active, revoked } = db.countCodes();
      const rollByElection = new Map(db.listElectionRolls().map((r) => [r.electionId, r.rollId]));
      const elections = db.listElectionIds().map((electionId) => ({
        electionId,
        credentialsIssued: db.countIssuance(electionId),
        resets: db.countResets(electionId),
        rollId: rollByElection.get(electionId) ?? null,
      }));
      return { activeCodes: active, revokedCodes: revoked, elections, rolls: db.countCodesByRoll() };
    });

    /**
     * Generate return-code sheets for an election (cast-as-intended
     * verification). The sheets — including the secret codes — appear in this
     * response and NOWHERE else; the commission mails one to each voter. The
     * RCA stores only sheetId -> secret, with no link to any voter.
     */
    admin.post<{ Params: { electionId: string }; Body: { count: number } }>(
      '/admin/elections/:electionId/return-codes',
      {
        schema: {
          body: {
            type: 'object',
            required: ['count'],
            additionalProperties: false,
            properties: { count: { type: 'integer', minimum: 1, maximum: MAX_BATCH } },
          },
        },
      },
      async (req, reply) => {
        const { electionId } = req.params;
        if (!ID_RE.test(electionId)) {
          return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
        }
        try {
          const sheets = await generateReturnCodeSheets(db, config, electionId, req.body.count);
          return { sheets };
        } catch (e) {
          return reply
            .code(502)
            .send({ error: 'election_unavailable', message: `could not read the election from the chain: ${(e as Error).message}` });
        }
      },
    );
  });
}
