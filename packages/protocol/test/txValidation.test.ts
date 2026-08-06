import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyBlock,
  buildElectionCancelTx,
  buildElectionCreateTx,
  buildIssuanceCommitTx,
  buildVoteCastTx,
  generateEd25519KeyPair,
  merkleRoot,
  registrarAttestationPayload,
  signJson,
  validateTx,
  type ElectionDefinition,
  type VoteCastTx,
} from '@votechain/protocol';
import { GENESIS_TIME, makeFixture, type Fixture } from './fixtures';

let f: Fixture;
const OPEN_TIME = GENESIS_TIME + 10_000; // block timestamp within the voting window

beforeAll(async () => {
  f = await makeFixture();
}, 60_000);

function expectReject(result: { ok: boolean; reason?: string }, pattern: RegExp) {
  expect(result.ok).toBe(false);
  expect((result as { reason: string }).reason).toMatch(pattern);
}

describe('ELECTION_CREATE validation', () => {
  it('accepts a well-formed creation', async () => {
    const state = f.freshState();
    expect(await validateTx(state, f.genesis, f.createTx, GENESIS_TIME)).toEqual({ ok: true });
  });

  it('rejects a duplicate electionId', async () => {
    const { state } = f.stateAfterBlock1();
    expectReject(await validateTx(state, f.genesis, f.createTx, OPEN_TIME), /duplicate transaction/);
    // A *different* tx re-creating the same election id:
    const again = buildElectionCreateTx(f.chainId, { ...f.election, title: 'Same id, new title' }, f.commissionKey.secretKey);
    expectReject(await validateTx(state, f.genesis, again, OPEN_TIME), /already exists/);
  });

  it('rejects reuse of a credential key by a second election', async () => {
    const { state } = f.stateAfterBlock1();
    const def: ElectionDefinition = {
      ...f.election,
      electionId: 'election-2',
      registrarKeyAttestationSig: signJson(
        registrarAttestationPayload(f.chainId, 'election-2', f.credentialKeys.publicJwk),
        f.registrarKey.secretKey,
      ),
    };
    const tx = buildElectionCreateTx(f.chainId, def, f.commissionKey.secretKey);
    expectReject(await validateTx(state, f.genesis, tx, OPEN_TIME), /credential key already used/);
  });

  it('rejects a missing or forged registrar attestation', async () => {
    const state = f.freshState();
    const forgedKey = generateEd25519KeyPair();
    const def: ElectionDefinition = {
      ...f.election,
      electionId: 'election-3',
      registrarKeyAttestationSig: signJson(
        registrarAttestationPayload(f.chainId, 'election-3', f.credentialKeys.publicJwk),
        forgedKey.secretKey, // not the genesis registrar key
      ),
    };
    const tx = buildElectionCreateTx(f.chainId, def, f.commissionKey.secretKey);
    expectReject(await validateTx(state, f.genesis, tx, OPEN_TIME), /registrar key attestation/);
  });

  it('rejects a commission signature from the wrong key', async () => {
    const state = f.freshState();
    const mallory = generateEd25519KeyPair();
    const tx = buildElectionCreateTx(f.chainId, f.election, mallory.secretKey);
    expectReject(await validateTx(state, f.genesis, tx, OPEN_TIME), /commission signature/);
  });

  it('rejects the wrong chainId (cross-chain replay)', async () => {
    const state = f.freshState();
    const otherChain = 'f'.repeat(64);
    const tx = buildElectionCreateTx(otherChain, f.election, f.commissionKey.secretKey);
    expectReject(await validateTx(state, f.genesis, tx, OPEN_TIME), /wrong chainId/);
  });

  it('rejects structural garbage: bad times, empty questions, dup ids, spoofing chars', async () => {
    const state = f.freshState();
    const base = { ...f.election, electionId: 'e-x' };
    const cases: [Partial<ElectionDefinition>, RegExp][] = [
      [{ startTime: f.election.endTime, endTime: f.election.startTime }, /before endTime/],
      [{ questions: [] }, /non-empty array/],
      [
        {
          questions: [
            { id: 'q1', text: 'A?', options: [{ id: 'x', text: 'X' }, { id: 'x', text: 'Y' }] },
          ],
        },
        /duplicate option id/,
      ],
      [
        {
          questions: [
            { id: 'q1', text: 'A?', options: [{ id: 'x', text: 'Same' }, { id: 'y', text: 'same' }] },
          ],
        },
        /same label/,
      ],
      [{ questions: [{ id: 'q1', text: 'A?', options: [{ id: 'x', text: 'Only one' }] }] }, /between 2 and/],
      [{ title: 'evil ‮ title' }, /forbidden/],
      [{ eligibleCount: 0 }, /eligibleCount/],
    ];
    for (const [patch, pattern] of cases) {
      const def = { ...base, ...patch } as ElectionDefinition;
      const tx = buildElectionCreateTx(f.chainId, def, f.commissionKey.secretKey);
      expectReject(await validateTx(state, f.genesis, tx, OPEN_TIME), pattern);
    }
  });
});

describe('VOTE_CAST validation', () => {
  it('accepts a valid vote', async () => {
    const { state } = f.stateAfterBlock1();
    const vote = await f.makeVote({});
    expect(await validateTx(state, f.genesis, vote, OPEN_TIME)).toEqual({ ok: true });
  });

  it('accepts a partial ballot (subset of questions)', async () => {
    const { state } = f.stateAfterBlock1();
    const vote = await f.makeVote({ answers: [{ questionId: 'q2', optionId: 'no' }] });
    expect(await validateTx(state, f.genesis, vote, OPEN_TIME)).toEqual({ ok: true });
  });

  it('rejects votes outside the election window (block timestamp)', async () => {
    const { state } = f.stateAfterBlock1();
    const vote = await f.makeVote({});
    expectReject(await validateTx(state, f.genesis, vote, GENESIS_TIME - 1), /not started/);
    expectReject(await validateTx(state, f.genesis, vote, f.election.endTime), /ended/);
  });

  it('rejects unknown election, unknown question, unknown option, duplicate question', async () => {
    const { state } = f.stateAfterBlock1();
    const unknownElection = await f.makeVote({});
    expectReject(
      await validateTx(state, f.genesis, { ...unknownElection, electionId: 'nope' } as VoteCastTx, OPEN_TIME),
      /unknown election|invalid vote signature/,
    );
    const badQ = await f.makeVote({ answers: [{ questionId: 'zzz', optionId: 'alice' }] });
    expectReject(await validateTx(state, f.genesis, badQ, OPEN_TIME), /unknown questionId/);
    const badO = await f.makeVote({ answers: [{ questionId: 'q1', optionId: 'zzz' }] });
    expectReject(await validateTx(state, f.genesis, badO, OPEN_TIME), /unknown optionId/);
    const dupQ = await f.makeVote({
      answers: [
        { questionId: 'q1', optionId: 'alice' },
        { questionId: 'q1', optionId: 'bob' },
      ],
    });
    expectReject(await validateTx(state, f.genesis, dupQ, OPEN_TIME), /duplicate answer/);
  });

  it('rejects a tampered ballot (vote signature breaks)', async () => {
    const { state } = f.stateAfterBlock1();
    const vote = await f.makeVote({ answers: [{ questionId: 'q1', optionId: 'alice' }] });
    const tampered: VoteCastTx = { ...vote, answers: [{ questionId: 'q1', optionId: 'bob' }] };
    expectReject(await validateTx(state, f.genesis, tampered, OPEN_TIME), /invalid vote signature/);
  });

  it('rejects a stolen credential used with a different ephemeral key', async () => {
    const { state } = f.stateAfterBlock1();
    const victim = await f.makeCredential();
    const thief = generateEd25519KeyPair();
    const stolen = buildVoteCastTx({
      chainId: f.chainId,
      electionId: f.election.electionId,
      answers: [{ questionId: 'q1', optionId: 'bob' }],
      tokenSecretKey: thief.secretKey, // thief's key, victim's credential
      tokenPrefix: victim.tokenPrefix,
      credentialSig: victim.credentialSig,
      nonce: 99,
    });
    expectReject(await validateTx(state, f.genesis, stolen, OPEN_TIME), /invalid voting credential/);
  });

  it('rejects a credential blind-signed for another election', async () => {
    const { state } = f.stateAfterBlock1();
    const credential = await f.makeCredential('some-other-election');
    const vote = await f.makeVote({ credential });
    expectReject(await validateTx(state, f.genesis, vote, OPEN_TIME), /invalid voting credential/);
  });

  it('rejects a duplicate token when revoting is disabled, allows it when enabled', async () => {
    // allowRevote = true fixture election: second vote with same credential passes stateful check
    const { state, block1 } = f.stateAfterBlock1();
    const credential = await f.makeCredential();
    const vote1 = await f.makeVote({ credential, nonce: 1 });
    const block2 = f.makeBlock({ slot: 2, txs: [vote1], parent: block1 });
    applyBlock(state, block2);
    const vote2 = await f.makeVote({ credential, nonce: 2, answers: [{ questionId: 'q1', optionId: 'bob' }] });
    expect(await validateTx(state, f.genesis, vote2, OPEN_TIME)).toEqual({ ok: true });

    // Same scenario on a no-revote election
    const noRevoteKeys = await import('@votechain/protocol').then((m) => m.generateCredentialKeyPair(2048));
    const def: ElectionDefinition = {
      ...f.election,
      electionId: 'no-revote',
      allowRevote: false,
      credentialPublicKeyJwk: noRevoteKeys.publicJwk,
      registrarKeyAttestationSig: signJson(
        registrarAttestationPayload(f.chainId, 'no-revote', noRevoteKeys.publicJwk),
        f.registrarKey.secretKey,
      ),
    };
    const createTx = buildElectionCreateTx(f.chainId, def, f.commissionKey.secretKey);
    const block3 = f.makeBlock({ slot: 3, txs: [createTx], parent: block2 });
    applyBlock(state, block3);

    const { createCredentialRequest, importCredentialPrivateKey, blindSignCredential, finalizeCredential } =
      await import('@votechain/protocol');
    const material = await createCredentialRequest(noRevoteKeys.publicJwk, f.chainId, 'no-revote');
    const priv = await importCredentialPrivateKey(noRevoteKeys.privateJwk);
    const blindSig = await blindSignCredential(priv, material.blindedToken);
    const credentialSig = await finalizeCredential(noRevoteKeys.publicJwk, material, blindSig);
    const mkVote = (nonce: number) =>
      buildVoteCastTx({
        chainId: f.chainId,
        electionId: 'no-revote',
        answers: [{ questionId: 'q1', optionId: 'alice' }],
        tokenSecretKey: material.tokenSecretKey,
        tokenPrefix: material.tokenPrefix,
        credentialSig,
        nonce,
      });
    const v1 = mkVote(1);
    expect(await validateTx(state, f.genesis, v1, OPEN_TIME)).toEqual({ ok: true });
    const block4 = f.makeBlock({ slot: 4, txs: [v1], parent: block3 });
    applyBlock(state, block4);
    expectReject(await validateTx(state, f.genesis, mkVote(2), OPEN_TIME), /already voted/);
    // exact replay of the identical tx is also rejected
    expectReject(await validateTx(state, f.genesis, v1, OPEN_TIME), /duplicate transaction/);
  });
});

describe('ELECTION_CANCEL and ISSUANCE_COMMIT validation', () => {
  it('cancel: only before start, only by commission, only once', async () => {
    const { state } = f.stateAfterBlock1();
    const cancel = buildElectionCancelTx(f.chainId, f.election.electionId, f.commissionKey.secretKey, 'ballot error');
    // fixture election starts at GENESIS_TIME, so at OPEN_TIME it already started:
    expectReject(await validateTx(state, f.genesis, cancel, OPEN_TIME), /before it starts/);
    expect(await validateTx(state, f.genesis, cancel, GENESIS_TIME - 1)).toEqual({ ok: true });
    const mallory = generateEd25519KeyPair();
    const forged = buildElectionCancelTx(f.chainId, f.election.electionId, mallory.secretKey);
    expectReject(await validateTx(state, f.genesis, forged, GENESIS_TIME - 1), /commission signature/);
    expectReject(
      await validateTx(state, f.genesis, buildElectionCancelTx(f.chainId, 'nope', f.commissionKey.secretKey), GENESIS_TIME - 1),
      /unknown election/,
    );
  });

  it('issuance commit: registrar-signed, once per election', async () => {
    const { state, block1 } = f.stateAfterBlock1();
    const commit = buildIssuanceCommitTx(
      {
        chainId: f.chainId,
        electionId: f.election.electionId,
        issuedCount: 5,
        resetCount: 0,
        issuanceRoot: merkleRoot(['aa', 'bb']),
      },
      f.registrarKey.secretKey,
    );
    expect(await validateTx(state, f.genesis, commit, OPEN_TIME)).toEqual({ ok: true });
    const block2 = f.makeBlock({ slot: 2, txs: [commit], parent: block1 });
    applyBlock(state, block2);
    const commit2 = buildIssuanceCommitTx(
      {
        chainId: f.chainId,
        electionId: f.election.electionId,
        issuedCount: 6,
        resetCount: 0,
        issuanceRoot: merkleRoot(['aa', 'bb', 'cc']),
      },
      f.registrarKey.secretKey,
    );
    expectReject(await validateTx(state, f.genesis, commit2, OPEN_TIME), /already recorded/);
    const mallory = generateEd25519KeyPair();
    const forged = buildIssuanceCommitTx(
      { chainId: f.chainId, electionId: f.election.electionId, issuedCount: 999, resetCount: 0, issuanceRoot: merkleRoot([]) },
      mallory.secretKey,
    );
    // fresh state so the "already recorded" check doesn't mask the signature check
    const fresh = f.stateAfterBlock1().state;
    expectReject(await validateTx(fresh, f.genesis, forged, OPEN_TIME), /registrar signature/);
  });
});
