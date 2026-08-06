import type { ElectionEntry, IntegrityInfo, QuestionTally, VoteRecord } from './types';

/**
 * Tallying is a pure function of chain state — anyone replaying the chain
 * computes the identical result (that is the whole point).
 *
 * Counted vote per (electionId, token): highest nonce wins, tie-break lowest
 * txHash. Chain position is deliberately NOT used, so re-broadcasting an old
 * captured vote transaction can never override a newer one.
 */
export function selectCountedVote(records: VoteRecord[]): VoteRecord | undefined {
  let best: VoteRecord | undefined;
  for (const r of records) {
    if (
      !best ||
      r.nonce > best.nonce ||
      (r.nonce === best.nonce && r.txHash < best.txHash)
    ) {
      best = r;
    }
  }
  return best;
}

export interface ElectionTally {
  distinctTokens: number;
  voteTxCount: number;
  questions: QuestionTally[];
}

export function tallyElection(entry: ElectionEntry): ElectionTally {
  const counts = new Map<string, Map<string, number>>();
  for (const q of entry.definition.questions) {
    counts.set(q.id, new Map(q.options.map((o) => [o.id, 0])));
  }

  let voteTxCount = 0;
  let distinctTokens = 0;
  for (const records of entry.votesByToken.values()) {
    voteTxCount += records.length;
    const counted = selectCountedVote(records);
    if (!counted) continue;
    distinctTokens++;
    for (const answer of counted.answers) {
      const questionCounts = counts.get(answer.questionId);
      if (!questionCounts) continue;
      questionCounts.set(answer.optionId, (questionCounts.get(answer.optionId) ?? 0) + 1);
    }
  }

  const questions: QuestionTally[] = entry.definition.questions.map((q) => {
    const questionCounts = counts.get(q.id)!;
    const options = q.options.map((o) => ({
      optionId: o.id,
      text: o.text,
      count: questionCounts.get(o.id) ?? 0,
    }));
    return {
      questionId: q.id,
      text: q.text,
      totalAnswers: options.reduce((sum, o) => sum + o.count, 0),
      options,
    };
  });

  return { distinctTokens, voteTxCount, questions };
}

/**
 * Public reconciliation: distinct voting tokens <= credentials issued <=
 * eligible roll size. A violation means ballot stuffing (or a registrar
 * failing to commit honestly) and must be surfaced loudly.
 */
export function integrityInfo(entry: ElectionEntry, tally: ElectionTally): IntegrityInfo {
  const commit = entry.commit ?? null;
  return {
    distinctTokens: tally.distinctTokens,
    voteTxCount: tally.voteTxCount,
    issuedCount: commit ? commit.issuedCount : null,
    resetCount: commit ? commit.resetCount : null,
    eligibleCount: entry.definition.eligibleCount,
    exceedsEligible:
      tally.distinctTokens > entry.definition.eligibleCount ||
      (commit !== null && tally.distinctTokens > commit.issuedCount),
    commitBlockHeight: commit ? commit.blockHeight : null,
  };
}
