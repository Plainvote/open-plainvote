import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateEd25519KeyPair, type ReturnCodeSheet } from '@votechain/protocol';
import { createRegistrarServer } from '@votechain/registrar';

/**
 * Stub node exposing just what the RCA reads: the election definition, the
 * vote lookup, and the raw counted transaction. We control the on-chain
 * ballot so we can prove that a flipped vote yields a non-matching code.
 */
const CHAIN_ID = 'd'.repeat(64);
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const ELECTION_ID = 'rc-election';

// The ballot the stub node reports as recorded for token "TOKEN". Mutated per test.
let onChainAnswers: { questionId: string; optionId: string }[] = [];
let voteFound = true;

const ELECTION_DEFINITION = {
  electionId: ELECTION_ID,
  title: 'Return-Code Test Election',
  questions: [
    {
      id: 'mayor',
      text: 'Who should be mayor?',
      options: [
        { id: 'alice', text: 'Alice' },
        { id: 'bob', text: 'Bob' },
      ],
    },
  ],
  startTime: 1,
  endTime: 2,
  resultsVisibility: 'afterClose',
  allowRevote: true,
  eligibleCount: 10,
  credentialPublicKeyJwk: { e: 'AQAB', kty: 'RSA', n: 'AA' },
  registrarKeyAttestationSig: 'sig',
};

let app: FastifyInstance;
let stubNode: Server;
let stubNodeUrl: string;

beforeAll(async () => {
  const registrarKey = generateEd25519KeyPair();

  stubNode = createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (url.startsWith(`/elections/${ELECTION_ID}/votes/`)) {
      res.end(
        JSON.stringify({
          found: voteFound,
          electionId: ELECTION_ID,
          token: 'TOKEN',
          answersVisible: false,
          records: [],
          countedTxHash: voteFound ? 'COUNTED_TX' : null,
          isFinal: true,
        }),
      );
    } else if (url.startsWith(`/elections/${ELECTION_ID}`)) {
      res.end(JSON.stringify({ definition: ELECTION_DEFINITION, status: 'open', cancelled: false, createdAtHeight: 1, turnout: 1, commit: null }));
    } else if (url.startsWith('/transactions/')) {
      res.end(
        JSON.stringify({
          txHash: 'COUNTED_TX',
          blockHeight: 2,
          txIndex: 0,
          tx: { type: 'VOTE_CAST', chainId: CHAIN_ID, electionId: ELECTION_ID, answers: onChainAnswers, token: 'TOKEN', tokenPrefix: '', nonce: 1, credentialSig: '', voteSig: '' },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    }
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
    credentialModulusBits: 2048,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) => stubNode.close((e) => (e ? reject(e) : resolve())));
});

async function generateSheet(): Promise<ReturnCodeSheet> {
  const res = await app.inject({
    method: 'POST',
    url: `/admin/elections/${ELECTION_ID}/return-codes`,
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: { count: 1 },
  });
  expect(res.statusCode).toBe(200);
  return (res.json().sheets as ReturnCodeSheet[])[0]!;
}

function codeFor(sheet: ReturnCodeSheet, optionId: string): string {
  return sheet.questions[0]!.options.find((o) => o.optionId === optionId)!.code;
}

describe('return codes (RCA)', () => {
  it('generates a sheet with a distinct code per option and a cast code', async () => {
    const sheet = await generateSheet();
    expect(sheet.sheetId).toMatch(/^[0-9a-f]{16}$/);
    expect(sheet.castCode).toHaveLength(6);
    const alice = codeFor(sheet, 'alice');
    const bob = codeFor(sheet, 'bob');
    expect(alice).toHaveLength(4);
    expect(alice).not.toBe(bob);
  });

  it('returns the code matching the option ACTUALLY on chain (cast-as-intended)', async () => {
    const sheet = await generateSheet();
    voteFound = true;
    onChainAnswers = [{ questionId: 'mayor', optionId: 'alice' }];

    const res = await app.inject({
      method: 'POST',
      url: '/return-codes',
      payload: { electionId: ELECTION_ID, sheetId: sheet.sheetId, token: 'TOKEN' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.castCode).toBe(sheet.castCode);
    expect(body.answers).toHaveLength(1);
    // The returned code equals the sheet's code for the recorded option.
    expect(body.answers[0].code).toBe(codeFor(sheet, 'alice'));
  });

  it('detects a flipped vote: an on-chain change to Bob returns Bob\'s code, not the intended Alice code', async () => {
    const sheet = await generateSheet();
    voteFound = true;
    // Voter intended Alice; malware recorded Bob on chain.
    onChainAnswers = [{ questionId: 'mayor', optionId: 'bob' }];

    const res = await app.inject({
      method: 'POST',
      url: '/return-codes',
      payload: { electionId: ELECTION_ID, sheetId: sheet.sheetId, token: 'TOKEN' },
    });
    const body = res.json();
    expect(body.answers[0].code).toBe(codeFor(sheet, 'bob'));
    // Crucially, it does NOT match the code the voter expected for Alice.
    expect(body.answers[0].code).not.toBe(codeFor(sheet, 'alice'));
  });

  it('reports not-found when no ballot is recorded for the token', async () => {
    const sheet = await generateSheet();
    voteFound = false;
    const res = await app.inject({
      method: 'POST',
      url: '/return-codes',
      payload: { electionId: ELECTION_ID, sheetId: sheet.sheetId, token: 'TOKEN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
    voteFound = true;
  });

  it('rejects an unknown sheet id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/return-codes',
      payload: { electionId: ELECTION_ID, sheetId: 'deadbeefdeadbeef', token: 'TOKEN' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_sheet');
  });

  it('requires an admin key to generate sheets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/elections/${ELECTION_ID}/return-codes`,
      payload: { count: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});
