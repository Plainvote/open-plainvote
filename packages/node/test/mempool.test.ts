import { describe, expect, it } from 'vitest';
import { txHash } from '@votechain/protocol';
import { Chain, Mempool } from '@votechain/node';
import { makeNodeFixture } from './helpers';

describe('Mempool', () => {
  it('admits valid txs, is idempotent, rejects invalid ones', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    await chain.addBlock(f.makeBlock({ slot: 1, txs: [f.createTx], parent: null }));
    const mempool = new Mempool(chain);

    const vote = await f.makeVote({});
    const first = await mempool.admit(vote);
    expect(first).toMatchObject({ accepted: true, isNew: true });
    const again = await mempool.admit(vote);
    expect(again).toMatchObject({ accepted: true, isNew: false });
    expect(mempool.size).toBe(1);

    const tampered = { ...vote, nonce: vote.nonce + 1 }; // breaks voteSig
    const bad = await mempool.admit(tampered);
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toMatch(/vote signature/);
  });

  it('prunes included transactions after a head change', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    const b1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    await chain.addBlock(b1);
    const mempool = new Mempool(chain);
    const vote = await f.makeVote({});
    await mempool.admit(vote);
    expect(mempool.size).toBe(1);

    const b2 = f.makeBlock({ slot: 2, txs: [vote], parent: b1 });
    await chain.addBlock(b2);
    mempool.prune();
    expect(mempool.size).toBe(0);
    expect(mempool.has(txHash(vote))).toBe(false);
  });

  it('rejects votes for elections that are not on chain yet', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId); // election never created
    const mempool = new Mempool(chain);
    const vote = await f.makeVote({});
    const r = await mempool.admit(vote);
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unknown election/);
  });
});
