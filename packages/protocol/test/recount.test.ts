import { describe, expect, it } from 'vitest';
import { blockHash, computeTxRoot } from '../src/block';
import { compareWithPublished, fetchAllBlocks, recountElection, replayBlocks } from '../src/recount';
import { tallyElection } from '../src/tally';
import { createInitialState, applyBlock } from '../src/state';
import type { Block, ElectionDefinition, Tx } from '../src/types';

/**
 * The recount has to be right about two opposite things: it must agree with an
 * honest record, and it must refuse a tampered one. The tampering cases below
 * are the whole reason the feature exists, so they are the ones with teeth:
 * a rewritten ballot, a page spliced out, an entry added after the fact, and a
 * record-keeper publishing totals that do not match its own entries.
 */

const CHAIN_ID = 'c'.repeat(64);

const DEFINITION: ElectionDefinition = {
  electionId: 'e1',
  title: 'Board seat',
  questions: [
    { id: 'q1', text: 'Who takes the seat?', options: [{ id: 'a', text: 'Ada' }, { id: 'g', text: 'Grace' }] },
  ],
  startTime: 1,
  endTime: 9_999_999_999_999,
  resultsVisibility: 'live',
  allowRevote: true,
  eligibleCount: 10,
  credentialPublicKeyJwk: { kty: 'RSA', e: 'AQAB', n: 'stub-modulus' },
  registrarKeyAttestationSig: 'sig',
};

function electionTx(): Tx {
  return { type: 'ELECTION_CREATE', chainId: CHAIN_ID, election: DEFINITION, commissionSig: 'sig' } as unknown as Tx;
}

function voteTx(token: string, optionId: string, nonce = 1): Tx {
  return {
    type: 'VOTE_CAST',
    chainId: CHAIN_ID,
    electionId: 'e1',
    token,
    tokenPrefix: 'p',
    credentialSig: 'cs',
    answers: [{ questionId: 'q1', optionId }],
    nonce,
    voteSig: 'vs',
  } as unknown as Tx;
}

/** Build a well-formed run of pages: correct links, correct entry roots. */
function chainOf(txsPerBlock: Tx[][]): Block[] {
  const blocks: Block[] = [];
  let prevHash = CHAIN_ID;
  txsPerBlock.forEach((txs, i) => {
    const block: Block = {
      height: i + 1,
      prevHash,
      timestamp: 1000 * (i + 1),
      proposer: 'v1',
      txRoot: computeTxRoot(txs),
      txs,
      proposerSig: 'psig',
    };
    blocks.push(block);
    prevHash = blockHash(block);
  });
  return blocks;
}

const HONEST = chainOf([[electionTx()], [voteTx('t1', 'a'), voteTx('t2', 'a')], [voteTx('t3', 'g')]]);

/** What the node would publish for the honest chain, computed the same way. */
function publishedFor(blocks: Block[]) {
  const state = createInitialState(CHAIN_ID);
  for (const b of blocks) applyBlock(state, b);
  const tally = tallyElection(state.elections.get('e1')!);
  return { questions: tally.questions, distinctTokens: tally.distinctTokens };
}

describe('replaying an honest record', () => {
  it('accepts it and rebuilds the same totals', () => {
    const result = recountElection({
      chainId: CHAIN_ID, electionId: 'e1', blocks: HONEST, published: publishedFor(HONEST),
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ballotsCounted).toBe(3);
    const q = result.tally!.questions[0]!;
    expect(q.options.find((o) => o.optionId === 'a')!.count).toBe(2);
    expect(q.options.find((o) => o.optionId === 'g')!.count).toBe(1);
  });

  it('never claims to have checked signatures', () => {
    const r = recountElection({ chainId: CHAIN_ID, electionId: 'e1', blocks: HONEST, published: publishedFor(HONEST) });
    expect(r.verifiedSignatures).toBe(false);
  });

  it('roots the first page in the chain id, not in whatever it claims', () => {
    const forged = structuredClone(HONEST);
    forged[0]!.prevHash = 'f'.repeat(64);
    const { problems } = replayBlocks(CHAIN_ID, forged);
    expect(problems[0]).toMatchObject({ kind: 'broken-link', height: 1 });
  });
});

describe('refusing a tampered record', () => {
  it('catches a ballot rewritten in place', () => {
    // Flip a vote from Ada to Grace without touching anything else. The entry
    // fingerprint on that page no longer matches its entries.
    const tampered = structuredClone(HONEST);
    (tampered[1]!.txs[0] as unknown as { answers: { questionId: string; optionId: string }[] }).answers = [
      { questionId: 'q1', optionId: 'g' },
    ];
    const { problems } = replayBlocks(CHAIN_ID, tampered);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('entries-altered');
  });

  it('catches an entry added to a page after the fact', () => {
    const tampered = structuredClone(HONEST);
    tampered[1]!.txs.push(voteTx('stuffed', 'g'));
    const { problems } = replayBlocks(CHAIN_ID, tampered);
    expect(problems[0]!.kind).toBe('entries-altered');
  });

  it('catches a page removed from the middle', () => {
    const spliced = [HONEST[0]!, HONEST[2]!];
    const { problems } = replayBlocks(CHAIN_ID, spliced);
    expect(problems[0]).toMatchObject({ kind: 'gap' });
  });

  it('catches history rewritten from some page onward', () => {
    // Rebuild page 2 with different content; page 3 still points at the old
    // fingerprint, so the links stop matching there.
    const rewritten = structuredClone(HONEST);
    rewritten[1]!.txs = [voteTx('t1', 'g'), voteTx('t2', 'g')];
    rewritten[1]!.txRoot = computeTxRoot(rewritten[1]!.txs);
    const { problems } = replayBlocks(CHAIN_ID, rewritten);
    expect(problems[0]).toMatchObject({ kind: 'broken-link', height: 3 });
  });

  it('catches published totals that disagree with the entries', () => {
    const lying = publishedFor(HONEST);
    lying.questions![0]!.options.find((o) => o.optionId === 'a')!.count = 99;
    const result = recountElection({ chainId: CHAIN_ID, electionId: 'e1', blocks: HONEST, published: lying });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatchObject({ kind: 'totals-differ', ours: 2, theirs: 99 });
  });

  it('catches an inflated turnout even when no per-question totals are published', () => {
    const problems = compareWithPublished(
      { distinctTokens: 3, voteTxCount: 3, questions: [] },
      { questions: null, distinctTokens: 50 },
    );
    expect(problems).toEqual([{ kind: 'turnout-differs', ours: 3, theirs: 50 }]);
  });

  it('reports an election that is not in the record at all', () => {
    const result = recountElection({
      chainId: CHAIN_ID, electionId: 'nope', blocks: HONEST, published: { questions: null, distinctTokens: 0 },
    });
    expect(result.problems[0]).toMatchObject({ kind: 'election-missing' });
  });
});

describe('revoting is resolved the same way the node resolves it', () => {
  it('counts only the latest ballot from a token', () => {
    const revoted = chainOf([[electionTx()], [voteTx('t1', 'a', 1)], [voteTx('t1', 'g', 2)]]);
    const result = recountElection({
      chainId: CHAIN_ID, electionId: 'e1', blocks: revoted, published: publishedFor(revoted),
    });
    expect(result.ok).toBe(true);
    expect(result.ballotsCounted).toBe(1);
    const q = result.tally!.questions[0]!;
    expect(q.options.find((o) => o.optionId === 'g')!.count).toBe(1);
    expect(q.options.find((o) => o.optionId === 'a')!.count).toBe(0);
  });

  it('ignores an older ballot replayed back into the record later', () => {
    // The captured-and-rebroadcast case: an old ballot appearing on a LATER
    // page must not override the newer one, because nonce decides, not order.
    const replayed = chainOf([[electionTx()], [voteTx('t1', 'g', 2)], [voteTx('t1', 'a', 1)]]);
    const result = recountElection({
      chainId: CHAIN_ID, electionId: 'e1', blocks: replayed, published: publishedFor(replayed),
    });
    const q = result.tally!.questions[0]!;
    expect(q.options.find((o) => o.optionId === 'g')!.count).toBe(1);
  });
});

describe('streaming the record in pages', () => {
  it('reads to the end and reports progress', async () => {
    const all = chainOf(Array.from({ length: 25 }, () => []));
    const seen: number[] = [];
    const blocks = await fetchAllBlocks(
      async (from, limit) => all.slice(from - 1, from - 1 + limit),
      { pageSize: 10, onProgress: (n) => seen.push(n) },
    );
    expect(blocks).toHaveLength(25);
    expect(seen).toEqual([10, 20, 25]);
  });

  it('stops when told to', async () => {
    const all = chainOf(Array.from({ length: 100 }, () => []));
    const signal = { aborted: false };
    const blocks = await fetchAllBlocks(
      async (from, limit) => {
        signal.aborted = true; // abort after the first page
        return all.slice(from - 1, from - 1 + limit);
      },
      { pageSize: 10, signal },
    );
    expect(blocks).toHaveLength(10);
  });
});
