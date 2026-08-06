import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeClient } from '@votechain/protocol';
import { createNode, type VoteChainNode } from '@votechain/node';
import { makeNodeFixture, tempDataDir, waitFor, type NodeFixture } from './helpers';

/**
 * Full-stack integration: two validator nodes producing real blocks on real
 * slot timers, gossiping over real WebSockets, plus a late-joining observer
 * that syncs from scratch.
 */
let f: NodeFixture;
let node1: VoteChainNode;
let node2: VoteChainNode;
let node3: VoteChainNode | null = null;
let client1: NodeClient;
let client2: NodeClient;

beforeAll(async () => {
  f = await makeNodeFixture({ validatorCount: 2, slotSeconds: 1 });

  node1 = await createNode(
    {
      nodeName: 'itest-node1',
      port: 0,
      dataDir: tempDataDir('n1'),
      genesisPath: '(inline)',
      validatorSecretKey: f.validatorKeys[0]!.secretKey,
      peers: [],
    },
    f.genesis,
  );
  await node1.start();

  node2 = await createNode(
    {
      nodeName: 'itest-node2',
      port: 0,
      dataDir: tempDataDir('n2'),
      genesisPath: '(inline)',
      validatorSecretKey: f.validatorKeys[1]!.secretKey,
      peers: [node1.url],
    },
    f.genesis,
  );
  await node2.start();

  client1 = new NodeClient(node1.url);
  client2 = new NodeClient(node2.url);
  await waitFor(async () => (await client1.status()).peerCount >= 1, 10_000, 'p2p handshake');
}, 60_000);

afterAll(async () => {
  await node3?.stop();
  await node2.stop();
  await node1.stop();
});

describe('two-node network', () => {
  it('gossips a submitted election into a block on both nodes', async () => {
    const submit = await client1.submitTx(f.createTx);
    expect(submit.accepted).toBe(true);

    await waitFor(
      async () =>
        (await client1.elections()).elections.length === 1 && (await client2.elections()).elections.length === 1,
      20_000,
      'election on both nodes',
    );
    const s1 = await client1.status();
    const s2 = await client2.status();
    expect(s1.chainId).toBe(f.chainId);
    expect(s2.chainId).toBe(f.chainId);
    expect(s1.height).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('counts a vote identically on both nodes and reaches finality', async () => {
    const credential = await f.makeCredential();
    const vote = await f.makeVote({ credential, nonce: 1 });
    const submit = await client2.submitTx(vote);
    expect(submit.accepted).toBe(true);

    await waitFor(
      async () => (await client1.results(f.election.electionId)).turnout.distinctTokens === 1,
      20_000,
      'vote counted on node1',
    );
    await waitFor(
      async () => (await client2.results(f.election.electionId)).turnout.distinctTokens === 1,
      20_000,
      'vote counted on node2',
    );

    // Revote with a higher nonce — replaces the earlier ballot.
    const revote = await f.makeVote({ credential, nonce: 2, answers: [{ questionId: 'q1', optionId: 'no' }] });
    expect((await client1.submitTx(revote)).accepted).toBe(true);
    await waitFor(async () => {
      const results = await client1.results(f.election.electionId);
      const no = results.questions?.find((q) => q.questionId === 'q1')?.options.find((o) => o.optionId === 'no');
      return results.turnout.voteTxCount === 2 && no?.count === 1;
    }, 20_000, 'revote replaces earlier vote');

    // Receipt lookup shows the superseded record.
    const lookup = await client1.voteLookup(f.election.electionId, credential.token);
    expect(lookup.found).toBe(true);
    expect(lookup.records).toHaveLength(2);
    const superseded = lookup.records.find((r) => !r.counted);
    expect(superseded?.supersededByTxHash).toBe(lookup.countedTxHash);

    // Empty heartbeat blocks must finalize all content, then production quiesces.
    await waitFor(async () => {
      const results = await client1.results(f.election.electionId);
      return results.finality.finalizedHeight >= 1 && results.turnout.voteTxCount === 2;
    }, 20_000, 'content finalized');

    // Both nodes agree on the head.
    await waitFor(async () => {
      const s1 = await client1.status();
      const s2 = await client2.status();
      return s1.headHash === s2.headHash && s1.height === s2.height;
    }, 20_000, 'heads agree');
  }, 60_000);

  it('a late-joining observer node syncs the whole chain', async () => {
    node3 = await createNode(
      {
        nodeName: 'itest-node3',
        port: 0,
        dataDir: tempDataDir('n3'),
        genesisPath: '(inline)',
        peers: [node1.url, node2.url],
      },
      f.genesis,
    );
    await node3.start();
    const client3 = new NodeClient(node3.url);

    const target = (await client1.status()).height;
    await waitFor(async () => (await client3.status()).height >= target, 20_000, 'observer sync');

    const r1 = await client1.results(f.election.electionId);
    const r3 = await client3.results(f.election.electionId);
    expect(r3.turnout).toEqual(r1.turnout);
    expect(r3.questions).toEqual(r1.questions);
    expect((await client3.status()).isValidator).toBe(false);
  }, 60_000);

  it('rejects duplicate and malformed submissions at the API', async () => {
    const badShape = await client1.submitTx({ type: 'VOTE_CAST' } as never);
    expect(badShape.accepted).toBe(false);

    // Exact duplicate of an included tx → conflict.
    const dup = await client1.submitTx(f.createTx);
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toMatch(/duplicate|exists/);
  });
});
