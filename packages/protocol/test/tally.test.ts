import { describe, expect, it } from 'vitest';
import {
  integrityInfo,
  selectCountedVote,
  tallyElection,
  type ElectionEntry,
  type VoteRecord,
} from '@votechain/protocol';

function record(partial: Partial<VoteRecord> & { txHash: string }): VoteRecord {
  return {
    blockHeight: 1,
    txIndex: 0,
    nonce: 1,
    token: 'tok',
    answers: [],
    ...partial,
  };
}

function entry(votes: Record<string, VoteRecord[]>, overrides?: Partial<ElectionEntry>): ElectionEntry {
  return {
    definition: {
      electionId: 'e1',
      title: 'T',
      questions: [
        {
          id: 'q1',
          text: 'Q1',
          options: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
        },
        {
          id: 'q2',
          text: 'Q2',
          options: [
            { id: 'yes', text: 'Yes' },
            { id: 'no', text: 'No' },
          ],
        },
      ],
      startTime: 1,
      endTime: 2,
      resultsVisibility: 'live',
      allowRevote: true,
      eligibleCount: 3,
      credentialPublicKeyJwk: { e: 'AQAB', kty: 'RSA', n: 'AA' },
      registrarKeyAttestationSig: 'sig',
    },
    createdAtHeight: 1,
    cancelled: false,
    votesByToken: new Map(Object.entries(votes)),
    ...overrides,
  };
}

describe('selectCountedVote (revote rule)', () => {
  it('picks the highest nonce regardless of chain position', () => {
    const records = [
      record({ txHash: 'cc', nonce: 5, blockHeight: 10 }), // later chain position, lower nonce
      record({ txHash: 'aa', nonce: 9, blockHeight: 2 }),
      record({ txHash: 'bb', nonce: 7, blockHeight: 5 }),
    ];
    expect(selectCountedVote(records)?.txHash).toBe('aa');
  });

  it('breaks nonce ties with the lowest txHash', () => {
    const records = [
      record({ txHash: 'ff', nonce: 5 }),
      record({ txHash: '11', nonce: 5 }),
      record({ txHash: '99', nonce: 5 }),
    ];
    expect(selectCountedVote(records)?.txHash).toBe('11');
  });

  it('a replayed old vote can never override a newer one', () => {
    const v1 = record({ txHash: 'old', nonce: 1, blockHeight: 1 });
    const v2 = record({ txHash: 'new', nonce: 2, blockHeight: 2 });
    const replayedV1 = record({ txHash: 'old', nonce: 1, blockHeight: 50 });
    expect(selectCountedVote([v1, v2, replayedV1])?.txHash).toBe('new');
  });
});

describe('tallyElection', () => {
  it('counts one vote per token (latest by nonce) across multiple questions', () => {
    const e = entry({
      t1: [
        record({
          txHash: 'a1',
          token: 't1',
          nonce: 1,
          answers: [
            { questionId: 'q1', optionId: 'a' },
            { questionId: 'q2', optionId: 'yes' },
          ],
        }),
        // revote: switches q1 to b, drops q2 (partial ballot)
        record({ txHash: 'a2', token: 't1', nonce: 2, answers: [{ questionId: 'q1', optionId: 'b' }] }),
      ],
      t2: [
        record({
          txHash: 'b1',
          token: 't2',
          nonce: 7,
          answers: [
            { questionId: 'q1', optionId: 'a' },
            { questionId: 'q2', optionId: 'no' },
          ],
        }),
      ],
    });
    const tally = tallyElection(e);
    expect(tally.distinctTokens).toBe(2);
    expect(tally.voteTxCount).toBe(3);
    const q1 = tally.questions.find((q) => q.questionId === 'q1')!;
    expect(q1.options).toEqual([
      { optionId: 'a', text: 'A', count: 1 },
      { optionId: 'b', text: 'B', count: 1 },
    ]);
    const q2 = tally.questions.find((q) => q.questionId === 'q2')!;
    expect(q2.options).toEqual([
      { optionId: 'yes', text: 'Yes', count: 0 }, // t1's revote dropped its q2 answer
      { optionId: 'no', text: 'No', count: 1 },
    ]);
    expect(q2.totalAnswers).toBe(1);
  });

  it('zero votes tallies to all zeros', () => {
    const tally = tallyElection(entry({}));
    expect(tally.distinctTokens).toBe(0);
    expect(tally.questions.every((q) => q.options.every((o) => o.count === 0))).toBe(true);
  });
});

describe('integrityInfo (stuffing detection)', () => {
  it('reconciles distinctTokens <= issuedCount <= eligibleCount', () => {
    const e = entry({
      t1: [record({ txHash: 'a', token: 't1' })],
      t2: [record({ txHash: 'b', token: 't2' })],
    });
    e.commit = { issuedCount: 2, resetCount: 0, issuanceRoot: 'r', blockHeight: 9 };
    const info = integrityInfo(e, tallyElection(e));
    expect(info.exceedsEligible).toBe(false);
    expect(info.issuedCount).toBe(2);
  });

  it('flags more distinct tokens than credentials issued', () => {
    const e = entry({
      t1: [record({ txHash: 'a', token: 't1' })],
      t2: [record({ txHash: 'b', token: 't2' })],
      t3: [record({ txHash: 'c', token: 't3' })],
    });
    e.commit = { issuedCount: 2, resetCount: 0, issuanceRoot: 'r', blockHeight: 9 };
    expect(integrityInfo(e, tallyElection(e)).exceedsEligible).toBe(true);
  });

  it('flags more distinct tokens than the eligible roll', () => {
    const votes: Record<string, VoteRecord[]> = {};
    for (let i = 0; i < 4; i++) votes[`t${i}`] = [record({ txHash: `h${i}`, token: `t${i}` })];
    const e = entry(votes); // eligibleCount = 3
    expect(integrityInfo(e, tallyElection(e)).exceedsEligible).toBe(true);
  });
});
