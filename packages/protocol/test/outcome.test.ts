import { describe, expect, it } from 'vitest';
import { questionOutcome } from '../src/outcome';
import type { QuestionTally } from '../src/types';

/**
 * Reading a standing off a tally. The interesting cases are all the ones a
 * naive "highest count wins" would get wrong: exact ties, an unopposed option,
 * a question nobody answered, and the partial-ballot case where a question's
 * answers do not add up to the number of voters.
 */

function q(counts: Record<string, number>, totalAnswers?: number): QuestionTally {
  const options = Object.entries(counts).map(([text, count]) => ({ optionId: text, text, count }));
  return {
    questionId: 'q1',
    text: 'Who should hold the seat?',
    totalAnswers: totalAnswers ?? options.reduce((n, o) => n + o.count, 0),
    options,
  };
}

describe('questionOutcome', () => {
  it('names a single leader and the margin over the runner-up', () => {
    const o = questionOutcome(q({ Amara: 5, Bo: 3, Priya: 1 }));
    expect(o.kind).toBe('decided');
    expect(o.leaders.map((l) => l.text)).toEqual(['Amara']);
    expect(o.topCount).toBe(5);
    expect(o.margin).toBe(2);
    expect(o.topShare).toBeCloseTo(5 / 9);
  });

  it('reports a two-way tie rather than picking the first', () => {
    const o = questionOutcome(q({ Amara: 4, Bo: 4, Priya: 1 }));
    expect(o.kind).toBe('tied');
    expect(o.leaders.map((l) => l.text)).toEqual(['Amara', 'Bo']);
    expect(o.margin).toBe(0);
  });

  it('reports a tie across every option when all are level', () => {
    const o = questionOutcome(q({ Yes: 2, No: 2 }));
    expect(o.kind).toBe('tied');
    expect(o.leaders).toHaveLength(2);
    expect(o.topShare).toBeCloseTo(0.5);
  });

  it('treats a question nobody answered as having no outcome', () => {
    const o = questionOutcome(q({ Yes: 0, No: 0 }));
    expect(o.kind).toBe('no-answers');
    expect(o.leaders).toEqual([]);
    expect(o.topShare).toBe(0);
  });

  it('gives an unopposed option a margin equal to its own count', () => {
    const o = questionOutcome(q({ Yes: 7, No: 0 }));
    expect(o.kind).toBe('decided');
    expect(o.margin).toBe(7);
    expect(o.topShare).toBe(1);
  });

  it('takes share from answers to this question, not from ballots cast', () => {
    // Partial ballots are legal, so 10 voters may leave only 4 answers here.
    const o = questionOutcome(q({ Yes: 3, No: 1 }, 4));
    expect(o.topShare).toBeCloseTo(0.75);
  });

  it('does not treat a zero-count option as a leader when totals disagree', () => {
    // Defensive: a totalAnswers that disagrees with the counts must not produce
    // a "leader" holding no votes.
    const o = questionOutcome(q({ Yes: 0, No: 0 }, 5));
    expect(o.kind).toBe('no-answers');
  });
});
