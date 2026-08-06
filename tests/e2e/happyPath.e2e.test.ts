import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildElectionCreateTx,
  buildVoteCastTx,
  computeChainId,
  createCredentialRequest,
  finalizeCredential,
  generateEd25519KeyPair,
  integrityInfo,
  NodeClient,
  RegistrarClient,
  tallyElection,
  type ElectionDefinition,
  type Genesis,
} from '@votechain/protocol';
import { Chain, createNode, type VoteChainNode } from '@votechain/node';
import { createRegistrarServer } from '@votechain/registrar';

/**
 * The whole system, end to end, over real HTTP:
 * commission creates an election (registrar-attested key) → two voters obtain
 * blind credentials and cast ballots → one revotes → registrar posts the
 * issuance commitment → an independent Chain replay must agree with the
 * nodes' published results exactly.
 */

const ADMIN_KEY = 'e2e-admin-key-0123456789abcdef';

let genesis: Genesis;
let chainId: string;
let commissionKey: { publicKey: string; secretKey: string };
let node1: VoteChainNode;
let node2: VoteChainNode;
let registrar: FastifyInstance;
let registrarUrl: string;
let client1: NodeClient;
let client2: NodeClient;
let registrarClient: RegistrarClient;
let electionId: string;

async function waitFor(cond: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  const validators = [generateEd25519KeyPair(), generateEd25519KeyPair()];
  commissionKey = generateEd25519KeyPair();
  const registrarKey = generateEd25519KeyPair();
  genesis = {
    name: 'votechain-e2e',
    genesisTime: Date.now() - 60_000,
    slotSeconds: 1,
    validators: validators.map((v, i) => ({ name: `v${i + 1}`, publicKey: v.publicKey })),
    commissionPublicKey: commissionKey.publicKey,
    registrarPublicKey: registrarKey.publicKey,
  };
  chainId = computeChainId(genesis);

  node1 = await createNode(
    {
      nodeName: 'e2e-node1',
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), 'vc-e2e-n1-')),
      genesisPath: '(inline)',
      validatorSecretKey: validators[0]!.secretKey,
      peers: [],
    },
    genesis,
  );
  await node1.start();
  node2 = await createNode(
    {
      nodeName: 'e2e-node2',
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), 'vc-e2e-n2-')),
      genesisPath: '(inline)',
      validatorSecretKey: validators[1]!.secretKey,
      peers: [node1.url],
    },
    genesis,
  );
  await node2.start();

  registrar = await createRegistrarServer({
    port: 0,
    dbPath: ':memory:',
    adminApiKey: ADMIN_KEY,
    chainId,
    registrarSecretKey: registrarKey.secretKey,
    registrarPublicKey: registrarKey.publicKey,
    nodeUrl: node1.url,
    credentialModulusBits: 2048,
  });
  await registrar.listen({ port: 0, host: '127.0.0.1' });
  const address = registrar.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('registrar address missing');
  registrarUrl = `http://127.0.0.1:${address.port}`;

  client1 = new NodeClient(node1.url);
  client2 = new NodeClient(node2.url);
  registrarClient = new RegistrarClient(registrarUrl, ADMIN_KEY);
}, 90_000);

afterAll(async () => {
  await registrar.close();
  await node2.stop();
  await node1.stop();
});

describe('happy path', () => {
  it('runs a full election end to end with an audit-equal recount', async () => {
    // --- commission: create the election --------------------------------
    electionId = crypto.randomUUID();
    const keys = await registrarClient.createElectionKeys(electionId);
    const definition: ElectionDefinition = {
      electionId,
      title: 'E2E City Ballot',
      description: 'Complete end-to-end test election.',
      questions: [
        {
          id: 'mayor',
          text: 'Who should be mayor?',
          options: [
            { id: 'alice', text: 'Alice Johnson' },
            { id: 'bob', text: 'Bob Smith' },
          ],
        },
        {
          id: 'levy',
          text: 'Should the school levy pass?',
          options: [
            { id: 'yes', text: 'Yes' },
            { id: 'no', text: 'No' },
          ],
        },
      ],
      startTime: Date.now() - 5_000,
      endTime: Date.now() + 3_600_000,
      resultsVisibility: 'live',
      allowRevote: true,
      eligibleCount: 10,
      credentialPublicKeyJwk: keys.publicKeyJwk,
      registrarKeyAttestationSig: keys.attestationSig,
    };
    const createTx = buildElectionCreateTx(chainId, definition, commissionKey.secretKey);
    expect((await client1.submitTx(createTx)).accepted).toBe(true);
    await waitFor(async () => (await client2.elections()).elections.length === 1, 'election gossiped to node2');

    // --- voters: blind credentials + ballots ------------------------------
    const { codes } = await registrarClient.generateCodes(3);
    const voters = await Promise.all(
      codes.slice(0, 2).map(async (code) => {
        const material = await createCredentialRequest(keys.publicKeyJwk, chainId, electionId);
        const response = await registrarClient.requestCredential(code, electionId, material.blindedToken);
        if (response.status !== 'ok') throw new Error(`credential refused: ${response.status}`);
        const credentialSig = await finalizeCredential(keys.publicKeyJwk, material, response.blindSignature);
        return { material, credentialSig };
      }),
    );

    const vote1 = buildVoteCastTx({
      chainId,
      electionId,
      answers: [
        { questionId: 'mayor', optionId: 'alice' },
        { questionId: 'levy', optionId: 'yes' },
      ],
      tokenSecretKey: voters[0]!.material.tokenSecretKey,
      tokenPrefix: voters[0]!.material.tokenPrefix,
      credentialSig: voters[0]!.credentialSig,
      nonce: 1,
    });
    const vote2 = buildVoteCastTx({
      chainId,
      electionId,
      answers: [{ questionId: 'mayor', optionId: 'bob' }],
      tokenSecretKey: voters[1]!.material.tokenSecretKey,
      tokenPrefix: voters[1]!.material.tokenPrefix,
      credentialSig: voters[1]!.credentialSig,
      nonce: 1,
    });
    expect((await client1.submitTx(vote1)).accepted).toBe(true);
    expect((await client2.submitTx(vote2)).accepted).toBe(true);
    await waitFor(async () => (await client1.results(electionId)).turnout.distinctTokens === 2, 'both ballots counted');

    // --- revote: voter 1 flips to bob with a higher nonce -----------------
    const revote = buildVoteCastTx({
      chainId,
      electionId,
      answers: [
        { questionId: 'mayor', optionId: 'bob' },
        { questionId: 'levy', optionId: 'no' },
      ],
      tokenSecretKey: voters[0]!.material.tokenSecretKey,
      tokenPrefix: voters[0]!.material.tokenPrefix,
      credentialSig: voters[0]!.credentialSig,
      nonce: 2,
    });
    expect((await client1.submitTx(revote)).accepted).toBe(true);
    await waitFor(async () => {
      const r = await client1.results(electionId);
      const bob = r.questions?.find((q) => q.questionId === 'mayor')?.options.find((o) => o.optionId === 'bob');
      return r.turnout.voteTxCount === 3 && bob?.count === 2;
    }, 'revote replaces earlier ballot');

    // duplicate replay of the old vote must be rejected and must not change the tally
    const replay = await client1.submitTx(vote1);
    expect(replay.accepted).toBe(false);
    const afterReplay = await client1.results(electionId);
    expect(afterReplay.questions?.find((q) => q.questionId === 'mayor')?.options.find((o) => o.optionId === 'bob')?.count).toBe(2);

    // --- registrar: on-chain issuance commitment --------------------------
    const commit = await registrarClient.commitIssuance(electionId);
    expect(commit.accepted).toBe(true);
    expect(commit.issuedCount).toBe(2);
    await waitFor(async () => (await client1.results(electionId)).integrity.issuedCount === 2, 'commitment on chain');

    // --- receipts ----------------------------------------------------------
    const lookup = await client2.voteLookup(electionId, voters[0]!.material.token);
    expect(lookup.found).toBe(true);
    expect(lookup.records).toHaveLength(2);
    expect(lookup.records.find((r) => !r.counted)?.supersededByTxHash).toBe(lookup.countedTxHash);

    // --- finality + both nodes agree --------------------------------------
    await waitFor(async () => {
      const s1 = await client1.status();
      const s2 = await client2.status();
      return s1.headHash === s2.headHash && s1.finalizedHeight >= (await client1.results(electionId)).integrity.commitBlockHeight!;
    }, 'both nodes agree and content finalized');

    // --- independent audit-equality ---------------------------------------
    // Replay node1's raw blocks through a fresh Chain (full validation) and
    // require the recomputed tally to equal what BOTH nodes publish.
    const status1 = await client1.status();
    const blocks = (await client1.blocks(1, 200)).blocks;
    expect(blocks.length).toBe(status1.height);
    const auditChain = new Chain(genesis, chainId);
    for (const block of blocks) {
      const result = await auditChain.addBlock(block, { skipStore: true, skipClockCheck: true });
      expect(result.accepted).toBe(true);
    }
    const entry = auditChain.state.elections.get(electionId)!;
    const auditTally = tallyElection(entry);
    const auditIntegrity = integrityInfo(entry, auditTally);
    const published1 = await client1.results(electionId);
    const published2 = await client2.results(electionId);
    expect(published1.questions).toEqual(auditTally.questions);
    expect(published2.questions).toEqual(auditTally.questions);
    expect(published1.turnout).toEqual({
      distinctTokens: auditTally.distinctTokens,
      voteTxCount: auditTally.voteTxCount,
    });
    expect(auditIntegrity.exceedsEligible).toBe(false);
    expect(auditIntegrity.issuedCount).toBe(2);

    // final tallies: bob 2, alice 0; levy yes 0, no 1 (voter2 abstained on levy)
    const mayor = auditTally.questions.find((q) => q.questionId === 'mayor')!;
    expect(mayor.options).toEqual([
      { optionId: 'alice', text: 'Alice Johnson', count: 0 },
      { optionId: 'bob', text: 'Bob Smith', count: 2 },
    ]);
    const levy = auditTally.questions.find((q) => q.questionId === 'levy')!;
    expect(levy.options).toEqual([
      { optionId: 'yes', text: 'Yes', count: 0 },
      { optionId: 'no', text: 'No', count: 1 },
    ]);
  }, 120_000);

  it('a third credential request for a used code is refused, unused code works', async () => {
    const { codes } = await registrarClient.generateCodes(1);
    const keysResponse = await registrarClient.createElectionKeys(crypto.randomUUID()).catch(() => null);
    // (fresh election id — just proving the code/credential lifecycle over HTTP)
    if (!keysResponse) throw new Error('key creation failed');
    const material = await createCredentialRequest(keysResponse.publicKeyJwk, chainId, keysResponse.electionId);
    const first = await registrarClient.requestCredential(codes[0]!, keysResponse.electionId, material.blindedToken);
    expect(first.status).toBe('ok');
    // identical retry → identical signature (crash recovery)
    const retry = await registrarClient.requestCredential(codes[0]!, keysResponse.electionId, material.blindedToken);
    expect(retry.status).toBe('ok');
    if (first.status === 'ok' && retry.status === 'ok') {
      expect(retry.blindSignature).toBe(first.blindSignature);
    }
    // different blinded request for the same code → refused
    const second = await createCredentialRequest(keysResponse.publicKeyJwk, chainId, keysResponse.electionId);
    const refused = await registrarClient.requestCredential(codes[0]!, keysResponse.electionId, second.blindedToken);
    expect(refused.status).toBe('already_issued');
  }, 60_000);
});
