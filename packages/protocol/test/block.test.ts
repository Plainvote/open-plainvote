import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyBlock,
  blockHash,
  buildBlock,
  slotStartTime,
  validateBlock,
  type Block,
} from '@votechain/protocol';
import { makeFixture, type Fixture } from './fixtures';

let f: Fixture;

beforeAll(async () => {
  f = await makeFixture();
}, 60_000);

describe('validateBlock', () => {
  it('accepts a well-formed block chain', async () => {
    const state = f.freshState();
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    expect(await validateBlock(state, f.genesis, block1, null)).toEqual({ ok: true });
    applyBlock(state, block1);

    const vote = await f.makeVote({});
    const block2 = f.makeBlock({ slot: 2, txs: [vote], parent: block1 });
    expect(await validateBlock(state, f.genesis, block2, block1)).toEqual({ ok: true });
  });

  it('rejects a block whose prevHash does not match the parent', async () => {
    const state = f.freshState();
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    const bad: Block = { ...block1, prevHash: 'a'.repeat(64) };
    const r = await validateBlock(state, f.genesis, bad, null);
    expect(r.ok).toBe(false);
  });

  it('rejects the wrong proposer for a slot', async () => {
    const state = f.freshState();
    // slot 1 belongs to validator index 1; sign with index 2 instead
    const block = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null, proposerIndex: 2 });
    const r = await validateBlock(state, f.genesis, block, null);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/wrong proposer/);
  });

  it('rejects a timestamp that is not exactly the slot start', async () => {
    const state = f.freshState();
    const proposer = f.validatorKeys[1]!; // slot 1 proposer
    const block = buildBlock(
      {
        height: 1,
        prevHash: f.chainId,
        timestamp: slotStartTime(f.genesis, 1) + 1,
        proposerPublicKey: proposer.publicKey,
        txs: [f.createTx],
      },
      proposer.secretKey,
    );
    const r = await validateBlock(state, f.genesis, block, null);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/slot start/);
  });

  it('rejects far-future blocks when a local clock is provided', async () => {
    const state = f.freshState();
    const block = f.makeBlock({ slot: 100, txs: [f.createTx], parent: null });
    const now = slotStartTime(f.genesis, 1);
    const r = await validateBlock(state, f.genesis, block, null, { localNowMs: now });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/future/);
    // same block is fine once the clock catches up
    expect(await validateBlock(state, f.genesis, block, null, { localNowMs: slotStartTime(f.genesis, 100) })).toEqual({
      ok: true,
    });
  });

  it('rejects a tampered transaction list (txRoot mismatch)', async () => {
    const state = f.freshState();
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    applyBlock(state, block1);
    const vote = await f.makeVote({});
    const otherVote = await f.makeVote({ answers: [{ questionId: 'q1', optionId: 'bob' }] });
    const block2 = f.makeBlock({ slot: 2, txs: [vote], parent: block1 });
    const tampered: Block = { ...block2, txs: [otherVote] };
    const r = await validateBlock(state, f.genesis, tampered, block1);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/txRoot/);
  });

  it('rejects a forged proposer signature', async () => {
    const state = f.freshState();
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    const forged: Block = { ...block1, timestamp: slotStartTime(f.genesis, 4) };
    // header changed but signature not re-made (also moves to a different slot/proposer,
    // so craft one that stays in the same proposer's slot: slot 1 + 3 = validator 1 again)
    const r = await validateBlock(state, f.genesis, forged, null);
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate tokens within a block for a no-revote election, duplicate txs always', async () => {
    // Build a no-revote election in block 1, then two same-token votes in block 2.
    const { generateCredentialKeyPair, createCredentialRequest, importCredentialPrivateKey, blindSignCredential,
      finalizeCredential, buildElectionCreateTx, buildVoteCastTx, signJson, registrarAttestationPayload } =
      await import('@votechain/protocol');
    const keys = await generateCredentialKeyPair(2048);
    const def = {
      ...f.election,
      electionId: 'block-no-revote',
      allowRevote: false,
      credentialPublicKeyJwk: keys.publicJwk,
      registrarKeyAttestationSig: signJson(
        registrarAttestationPayload(f.chainId, 'block-no-revote', keys.publicJwk),
        f.registrarKey.secretKey,
      ),
    };
    const createTx = buildElectionCreateTx(f.chainId, def, f.commissionKey.secretKey);
    const state = f.freshState();
    const block1 = f.makeBlock({ slot: 1, txs: [createTx], parent: null });
    applyBlock(state, block1);

    const material = await createCredentialRequest(keys.publicJwk, f.chainId, 'block-no-revote');
    const priv = await importCredentialPrivateKey(keys.privateJwk);
    const blindSig = await blindSignCredential(priv, material.blindedToken);
    const credentialSig = await finalizeCredential(keys.publicJwk, material, blindSig);
    const mkVote = (nonce: number) =>
      buildVoteCastTx({
        chainId: f.chainId,
        electionId: 'block-no-revote',
        answers: [{ questionId: 'q1', optionId: 'alice' }],
        tokenSecretKey: material.tokenSecretKey,
        tokenPrefix: material.tokenPrefix,
        credentialSig,
        nonce,
      });
    const v1 = mkVote(1);
    const v2 = mkVote(2);
    const dupToken = f.makeBlock({ slot: 2, txs: [v1, v2], parent: block1 });
    const r1 = await validateBlock(state, f.genesis, dupToken, block1);
    expect(r1.ok).toBe(false);
    expect((r1 as { reason: string }).reason).toMatch(/duplicate token/);

    const dupTx = f.makeBlock({ slot: 2, txs: [v1, v1], parent: block1 });
    const r2 = await validateBlock(state, f.genesis, dupTx, block1);
    expect(r2.ok).toBe(false);
    expect((r2 as { reason: string }).reason).toMatch(/duplicate transaction within block/);
  });

  it('block hashes chain: block2.prevHash === hash(block1 header)', () => {
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    const block2 = f.makeBlock({ slot: 2, txs: [], parent: block1 });
    expect(block2.prevHash).toBe(blockHash(block1));
    expect(block1.prevHash).toBe(f.chainId);
  });
});
