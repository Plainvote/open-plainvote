import { blockHash, computeTxRoot } from './block';
import { applyBlock, createInitialState } from './state';
import { integrityInfo, tallyElection, type ElectionTally } from './tally';
import type { Block, ChainState, IntegrityInfo, QuestionTally } from './types';

/**
 * Recounting an election from the raw record, in whatever runs this code.
 *
 * The claim on the front of this product is that anyone can add up the ballots
 * themselves and get the same answer. Until now the only way to exercise it was
 * to clone the repository and run a command, which is not a thing a co-op
 * member is going to do. This module is the same arithmetic, isomorphic, so a
 * browser can do it while they watch.
 *
 * It lives in the protocol package for two reasons: it is pure, taking blocks
 * in and giving a verdict out with no transport of its own, and `packages/*`
 * is where vitest actually collects tests. It deliberately does not reuse the
 * node's `Chain` class, which pulls in `node:events` and a server's worth of
 * dependencies; replay only needs the primitives beside this file.
 *
 * What it checks, and what it does not:
 *
 *  - every page names the fingerprint of the page before it, so the history
 *    cannot be rewritten without breaking the links from there onward;
 *  - every page's entry fingerprint matches the entries it carries, so no
 *    entry was added or removed after the fact;
 *  - the totals, recomputed from the ballots themselves, match the ones the
 *    record-keeper publishes.
 *
 * It does NOT verify signatures. Ballot credentials and page signatures are a
 * separate, much more expensive pass (Ed25519 verification is ~2.8ms each,
 * which is minutes for a large election), and conflating the two would make a
 * cheap and honest check feel broken. `verifiedSignatures: false` says so
 * rather than implying more than was done.
 */

export interface RecountProgress {
  phase: 'reading' | 'checking' | 'counting' | 'done';
  blocksRead: number;
  /** Null until a record-keeper has told us how tall the record is. */
  blocksTotal: number | null;
  ballotsSeen: number;
}

export type RecountProblem =
  | { kind: 'broken-link'; height: number; expected: string; found: string }
  | { kind: 'entries-altered'; height: number; expected: string; found: string }
  | { kind: 'gap'; height: number }
  | { kind: 'election-missing'; electionId: string }
  | { kind: 'totals-differ'; questionId: string; optionId: string; ours: number; theirs: number }
  | { kind: 'turnout-differs'; ours: number; theirs: number };

export interface RecountResult {
  ok: boolean;
  problems: RecountProblem[];
  blocksRead: number;
  ballotsCounted: number;
  /** Our own tally, computed here from the raw entries. */
  tally: ElectionTally | null;
  integrity: IntegrityInfo | null;
  /** Always false for now: see the note above. */
  verifiedSignatures: boolean;
}

/**
 * Replay a run of pages onto chain state, checking the links as it goes.
 *
 * Blocks must be contiguous and ascending from height 1: replay is the whole
 * point, and starting midway would mean trusting a summary of everything
 * before it.
 */
export function replayBlocks(
  chainId: string,
  blocks: readonly Block[],
): { state: ChainState; problems: RecountProblem[] } {
  const state = createInitialState(chainId);
  const problems: RecountProblem[] = [];
  // Block 1's prevHash is the chain id itself, which is what roots the history
  // in the founding parameters rather than in whatever the first page claims.
  let expectedPrev = chainId;
  let expectedHeight = 1;

  for (const block of blocks) {
    if (block.height !== expectedHeight) {
      problems.push({ kind: 'gap', height: expectedHeight });
      return { state, problems };
    }
    if (block.prevHash !== expectedPrev) {
      problems.push({ kind: 'broken-link', height: block.height, expected: expectedPrev, found: block.prevHash });
      return { state, problems };
    }
    const root = computeTxRoot(block.txs);
    if (root !== block.txRoot) {
      problems.push({ kind: 'entries-altered', height: block.height, expected: block.txRoot, found: root });
      return { state, problems };
    }
    applyBlock(state, block);
    expectedPrev = blockHash(block);
    expectedHeight += 1;
  }

  return { state, problems };
}

export interface PublishedTotals {
  questions: QuestionTally[] | null;
  distinctTokens: number;
}

/**
 * Compare our recount with what the record-keeper published.
 *
 * Only compares what the caller was actually given: an election whose results
 * are withheld until close publishes no per-question totals, and the turnout
 * comparison still means something on its own.
 */
export function compareWithPublished(ours: ElectionTally, theirs: PublishedTotals): RecountProblem[] {
  const problems: RecountProblem[] = [];

  if (ours.distinctTokens !== theirs.distinctTokens) {
    problems.push({ kind: 'turnout-differs', ours: ours.distinctTokens, theirs: theirs.distinctTokens });
  }

  if (theirs.questions === null) return problems;

  const published = new Map(theirs.questions.map((q) => [q.questionId, q]));
  for (const q of ours.questions) {
    const other = published.get(q.questionId);
    if (other === undefined) continue;
    const otherCounts = new Map(other.options.map((o) => [o.optionId, o.count]));
    for (const option of q.options) {
      const theirCount = otherCounts.get(option.optionId);
      if (theirCount !== undefined && theirCount !== option.count) {
        problems.push({
          kind: 'totals-differ',
          questionId: q.questionId,
          optionId: option.optionId,
          ours: option.count,
          theirs: theirCount,
        });
      }
    }
  }
  return problems;
}

/** Pull every page from a record-keeper, reporting progress as it streams. */
export async function fetchAllBlocks(
  fetchPage: (from: number, limit: number) => Promise<Block[]>,
  options: { pageSize?: number; onProgress?: (read: number) => void; signal?: { aborted: boolean } } = {},
): Promise<Block[]> {
  const pageSize = options.pageSize ?? 200;
  const all: Block[] = [];
  let from = 1;
  for (;;) {
    if (options.signal?.aborted === true) break;
    const page = await fetchPage(from, pageSize);
    if (page.length === 0) break;
    all.push(...page);
    options.onProgress?.(all.length);
    if (page.length < pageSize) break;
    from = all.length + 1;
  }
  return all;
}

/**
 * The whole check, given the raw pages and what the record-keeper claims.
 *
 * Returns `ok` only when the history holds together AND our own totals match
 * theirs. Anything else comes back as a named problem rather than a boolean,
 * because "it does not add up" is the one result that has to be specific.
 */
export function recountElection(args: {
  chainId: string;
  electionId: string;
  blocks: readonly Block[];
  published: PublishedTotals;
}): RecountResult {
  const { state, problems } = replayBlocks(args.chainId, args.blocks);
  const base: RecountResult = {
    ok: false,
    problems: [...problems],
    blocksRead: args.blocks.length,
    ballotsCounted: 0,
    tally: null,
    integrity: null,
    verifiedSignatures: false,
  };
  if (problems.length > 0) return base;

  const entry = state.elections.get(args.electionId);
  if (entry === undefined) {
    return { ...base, problems: [{ kind: 'election-missing', electionId: args.electionId }] };
  }

  const tally = tallyElection(entry);
  const compared = compareWithPublished(tally, args.published);

  return {
    ok: compared.length === 0,
    problems: compared,
    blocksRead: args.blocks.length,
    ballotsCounted: tally.distinctTokens,
    tally,
    integrity: integrityInfo(entry, tally),
    verifiedSignatures: false,
  };
}
