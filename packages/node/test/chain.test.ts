import { describe, expect, it } from 'vitest';
import { blockHash } from '@votechain/protocol';
import { BlockStore, Chain } from '@votechain/node';
import { makeNodeFixture, tempDataDir } from './helpers';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

describe('Chain', () => {
  it('extends the head and applies state', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    const r = await chain.addBlock(block1);
    expect(r).toMatchObject({ accepted: true, isNew: true, newHead: true, reorg: false });
    expect(chain.height).toBe(1);
    expect(chain.state.elections.has(f.election.electionId)).toBe(true);
    expect(chain.contentHeight).toBe(1);
    // idempotent re-add
    expect(await chain.addBlock(block1)).toMatchObject({ accepted: true, isNew: false });
  });

  it('rejects blocks with unknown parents (sync trigger)', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    const block1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    const block2 = f.makeBlock({ slot: 2, txs: [], parent: block1 });
    const r = await chain.addBlock(block2);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('unknown parent');
  });

  it('fork choice: longest chain wins with a full state rebuild (reorg)', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    // Branch A: one block containing the election.
    const a1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
    await chain.addBlock(a1);
    expect(chain.headBlockHash).toBe(blockHash(a1));

    // Branch B: two empty blocks from a different starting slot.
    const b1 = f.makeBlock({ slot: 2, txs: [], parent: null });
    const rb1 = await chain.addBlock(b1);
    expect(rb1.accepted).toBe(true);
    // The a1-vs-b1 tie at height 1 resolves by lowest hash (random per run) —
    // capture the winner so the reorg expectation below is deterministic.
    const headAfterB1 = chain.headBlockHash;

    const b2 = f.makeBlock({ slot: 3, txs: [], parent: b1 });
    const rb2 = await chain.addBlock(b2);
    expect(rb2.accepted).toBe(true);
    expect(rb2.newHead).toBe(true); // height 2 always beats height 1
    // A true reorg happened iff the previous head was NOT b2's parent.
    expect(rb2.reorg).toBe(headAfterB1 !== blockHash(b1));
    expect(chain.height).toBe(2);
    expect(chain.headBlockHash).toBe(blockHash(b2));
    // Election from branch A is gone — state reflects only the winning branch.
    expect(chain.state.elections.has(f.election.electionId)).toBe(false);
    expect(chain.contentHeight).toBe(0);
    expect(chain.bestChainSlice(1, 10).map(blockHash)).toEqual([blockHash(b1), blockHash(b2)]);
  });

  it('fork choice tie-break: equal height resolves to the lowest block hash', async () => {
    const f = await makeNodeFixture();
    // Two competing height-1 blocks (different slots → both valid).
    const x = f.makeBlock({ slot: 1, txs: [], parent: null });
    const y = f.makeBlock({ slot: 2, txs: [], parent: null });
    const lowest = blockHash(x) < blockHash(y) ? blockHash(x) : blockHash(y);
    // Insertion order must not matter.
    for (const order of [
      [x, y],
      [y, x],
    ]) {
      const chain = new Chain(f.genesis, f.chainId);
      for (const b of order) await chain.addBlock(b);
      expect(chain.headBlockHash).toBe(lowest);
    }
  });

  it('records equivocation evidence (same proposer, same slot, two blocks)', async () => {
    const f = await makeNodeFixture();
    const chain = new Chain(f.genesis, f.chainId);
    const one = f.makeBlock({ slot: 1, txs: [], parent: null });
    const two = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null }); // same slot, different content
    await chain.addBlock(one);
    await chain.addBlock(two);
    expect(chain.equivocations.length).toBe(1);
    expect(chain.equivocations[0]!.proposer).toBe(f.genesis.validators[1 % f.genesis.validators.length]!.publicKey);
    expect(chain.equivocations[0]!.blockHashes).toHaveLength(2);
  });

  it('computes accountable finality over distinct proposers', async () => {
    const f = await makeNodeFixture(); // 3 validators → threshold 2
    const chain = new Chain(f.genesis, f.chainId);
    const b1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null }); // proposer v1
    await chain.addBlock(b1);
    expect(chain.finalizedHeight()).toBe(0); // one distinct proposer < 2
    const b2 = f.makeBlock({ slot: 2, txs: [], parent: b1 }); // proposer v2
    await chain.addBlock(b2);
    expect(chain.finalizedHeight()).toBe(1); // blocks 1..2 span two distinct proposers
    const b3 = f.makeBlock({ slot: 3, txs: [], parent: b2 }); // proposer v0
    await chain.addBlock(b3);
    expect(chain.finalizedHeight()).toBe(2);
  });

  it('persists to the store, restores on boot, and rejects tampered lines', async () => {
    const f = await makeNodeFixture();
    const dir = tempDataDir('store');
    const filePath = join(dir, 'blocks.jsonl');
    {
      const chain = new Chain(f.genesis, f.chainId, new BlockStore(filePath));
      const b1 = f.makeBlock({ slot: 1, txs: [f.createTx], parent: null });
      const b2 = f.makeBlock({ slot: 2, txs: [], parent: b1 });
      const b3 = f.makeBlock({ slot: 3, txs: [], parent: b2 });
      for (const b of [b1, b2, b3]) await chain.addBlock(b);
    }
    {
      const restored = new Chain(f.genesis, f.chainId, new BlockStore(filePath));
      expect(await restored.loadFromStore()).toBe(3);
      expect(restored.height).toBe(3);
      expect(restored.state.elections.has(f.election.electionId)).toBe(true);
    }
    // Tamper with block 2 on disk: it and its descendant must be rejected.
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]!) as { timestamp: number };
    tampered.timestamp += 1000;
    lines[1] = JSON.stringify(tampered);
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    {
      const restored = new Chain(f.genesis, f.chainId, new BlockStore(filePath));
      expect(await restored.loadFromStore()).toBe(1); // only block 1 survives
      expect(restored.height).toBe(1);
    }
  });
});
