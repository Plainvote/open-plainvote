import type { FastifyInstance } from 'fastify';
import {
  base64UrlToBytes,
  blindSignCredential,
  importCredentialPrivateKey,
  modulusByteLength,
  voterCodeHash,
  type RsaPublicJwk,
  type WebCryptoKey,
} from '@votechain/protocol';
import type { RegistrarConfig } from '../config';
import type { RegistrarDb } from '../db';
import { computeReturnCodes } from '../returnCodes';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Per-election private CryptoKey cache (imports are not free). */
const privateKeyCache = new Map<string, Promise<WebCryptoKey>>();

export function registerPublicRoutes(app: FastifyInstance, db: RegistrarDb, config: RegistrarConfig): void {
  app.post<{ Body: { code: string; electionId: string; blindedToken: string } }>(
    '/credentials',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'electionId', 'blindedToken'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 128 },
            electionId: { type: 'string', minLength: 1, maxLength: 64 },
            blindedToken: { type: 'string', minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (req, reply) => {
      const { code, electionId, blindedToken } = req.body;
      if (!ID_RE.test(electionId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
      }
      const codeHash = voterCodeHash(code);

      const codeRow = db.getCode(codeHash);
      if (!codeRow) {
        return reply.code(404).send({ error: 'unknown_code', message: 'This voter code is not registered.' });
      }
      if (codeRow.status === 'revoked') {
        return reply.code(403).send({
          error: 'code_revoked',
          message: 'This voter code has been revoked. If it was regenerated, use the replacement code.',
        });
      }

      const keysRow = db.getElectionKeys(electionId);
      if (!keysRow) {
        return reply.code(404).send({ error: 'unknown_election', message: 'No credential key exists for this election.' });
      }

      // Roll scoping. An election bound to a roll accepts only codes from that
      // roll; without this check every active code on a shared registrar —
      // including another organization's voters — is eligible for every
      // election, and the turnout stays under eligibleCount so the public
      // reconciliation never flags it.
      const binding = db.getElectionRoll(electionId);
      if (binding) {
        if (codeRow.rollId !== binding.rollId) {
          return reply.code(403).send({
            error: 'code_not_in_roll',
            message: 'This voter code is not on the voter roll for this election.',
          });
        }
      } else if (config.requireRollBinding === true) {
        return reply.code(409).send({
          error: 'roll_not_bound',
          message: 'This election has no voter roll bound yet, so no credentials can be issued.',
        });
      }
      const publicJwk = JSON.parse(keysRow.publicJwk) as RsaPublicJwk;

      let blindedBytes: Uint8Array;
      try {
        blindedBytes = base64UrlToBytes(blindedToken);
      } catch {
        return reply.code(400).send({ error: 'bad_request', message: 'blindedToken is not valid base64url' });
      }
      if (blindedBytes.length !== modulusByteLength(publicJwk)) {
        return reply.code(400).send({ error: 'bad_request', message: 'blindedToken has the wrong length for this election key' });
      }

      // Idempotent retry: identical blinded message => return the stored
      // signature. A different blinded message for an already-issued code is a
      // second-credential attempt and is refused.
      const existing = db.getIssuance(codeHash, electionId);
      if (existing) {
        if (existing.blindedMsg === blindedToken) {
          return reply.send({ blindSignature: existing.blindSignature });
        }
        return reply.code(409).send({
          error: 'already_issued',
          message: 'A voting credential was already issued for this code in this election.',
        });
      }

      let privateKey = privateKeyCache.get(electionId);
      if (!privateKey) {
        privateKey = importCredentialPrivateKey(JSON.parse(keysRow.privateJwk));
        privateKeyCache.set(electionId, privateKey);
        privateKey.catch(() => privateKeyCache.delete(electionId));
      }
      const blindSignature = await blindSignCredential(await privateKey, blindedToken);

      // The (codeHash, electionId) primary key is the race arbiter: concurrent
      // requests interleave at the awaits above, but exactly one INSERT wins.
      try {
        db.insertIssuance({
          codeHash,
          electionId,
          issuedAt: Date.now(),
          blindedMsg: blindedToken,
          blindSignature,
        });
      } catch {
        const raced = db.getIssuance(codeHash, electionId);
        if (raced && raced.blindedMsg === blindedToken) {
          return reply.send({ blindSignature: raced.blindSignature });
        }
        return reply.code(409).send({
          error: 'already_issued',
          message: 'A voting credential was already issued for this code in this election.',
        });
      }
      return reply.send({ blindSignature });
    },
  );

  /**
   * Return-code retrieval. Given an anonymous sheetId and the voter's token,
   * the RCA reads the recorded ballot from the chain and returns the code(s)
   * for the option(s) ACTUALLY on chain, which the voter checks against their
   * mailed sheet. The RCA never receives the voter's identity or voting code.
   */
  app.post<{ Body: { electionId: string; sheetId: string; token: string } }>(
    '/return-codes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['electionId', 'sheetId', 'token'],
          additionalProperties: false,
          properties: {
            electionId: { type: 'string', minLength: 1, maxLength: 64 },
            sheetId: { type: 'string', minLength: 1, maxLength: 64 },
            token: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const { electionId, sheetId, token } = req.body;
      if (!ID_RE.test(electionId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'invalid electionId' });
      }
      const sheet = db.getReturnCodeSheet(sheetId);
      if (!sheet || sheet.electionId !== electionId) {
        return reply.code(404).send({ error: 'unknown_sheet', message: 'No return-code sheet with that id for this election.' });
      }
      try {
        const result = await computeReturnCodes(config, sheet.secret, electionId, token);
        return reply.send(result);
      } catch (e) {
        return reply
          .code(502)
          .send({ error: 'chain_unavailable', message: `could not read the ballot from the chain: ${(e as Error).message}` });
      }
    },
  );
}
