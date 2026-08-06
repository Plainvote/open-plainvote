import type { OptionTally, QuestionTally } from './types';

/**
 * Reading a result off a tally.
 *
 * Separate from tally.ts on purpose: that module counts, this one interprets,
 * and the interpretation stops well short of adjudicating. Plainvote knows how
 * many votes each option received. It does NOT know the organization's rules —
 * whether a plurality carries, whether a majority is required, whether quorum
 * was met, or whether the top candidate is even eligible to take the seat.
 * Those live in bylaws we never see.
 *
 * So this reports the standing and names ties, and callers phrase it as an
 * observation ("has the most votes") rather than a verdict ("wins"). Declaring
 * a winner under rules we cannot read would be the kind of claim the rest of
 * this system exists to avoid making.
 */

export type QuestionOutcomeKind =
  /** Nobody has answered this question, so there is nothing to report. */
  | 'no-answers'
  /** Exactly one option holds the top count. */
  | 'decided'
  /** Two or more options share the top count. */
  | 'tied';

export interface QuestionOutcome {
  kind: QuestionOutcomeKind;
  /** Every option sharing the top count: one when decided, several when tied. */
  leaders: OptionTally[];
  /** Votes held by each leader. Zero when there are no answers. */
  topCount: number;
  /** The leader's share of answers to THIS question, 0..1. */
  topShare: number;
  /**
   * Votes between the leader and the next distinct count. Zero when tied, and
   * equal to topCount when every other option scored nothing.
   */
  margin: number;
}

export function questionOutcome(question: QuestionTally): QuestionOutcome {
  const total = question.totalAnswers;
  const topCount = question.options.reduce((m, o) => Math.max(m, o.count), 0);

  // A question can carry zero answers even in an election with ballots cast:
  // partial ballots are legal, so voters may skip it entirely.
  if (total <= 0 || topCount <= 0) {
    return { kind: 'no-answers', leaders: [], topCount: 0, topShare: 0, margin: 0 };
  }

  const leaders = question.options.filter((o) => o.count === topCount);
  const runnerUp = question.options
    .filter((o) => o.count < topCount)
    .reduce((m, o) => Math.max(m, o.count), 0);

  return {
    kind: leaders.length > 1 ? 'tied' : 'decided',
    leaders,
    topCount,
    topShare: topCount / total,
    margin: leaders.length > 1 ? 0 : topCount - runnerUp,
  };
}
