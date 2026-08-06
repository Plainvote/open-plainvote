import type { AnswerChoice, ElectionDefinition, ElectionStatus } from './types';

export function electionStatusAt(
  definition: Pick<ElectionDefinition, 'startTime' | 'endTime'>,
  cancelled: boolean,
  atTimeMs: number,
): ElectionStatus {
  if (cancelled) return 'cancelled';
  if (atTimeMs < definition.startTime) return 'upcoming';
  if (atTimeMs < definition.endTime) return 'open';
  return 'closed';
}

/**
 * Whether per-vote answers and tallies may be shown at `atTimeMs`.
 * NOTE: this is an API/UI convention — v1 records ballots in plaintext on the
 * public chain, so raw transactions remain visible in the explorer regardless.
 */
export function resultsVisibleAt(
  definition: Pick<ElectionDefinition, 'startTime' | 'endTime' | 'resultsVisibility'>,
  cancelled: boolean,
  atTimeMs: number,
): boolean {
  if (definition.resultsVisibility === 'live') return true;
  const status = electionStatusAt(definition, cancelled, atTimeMs);
  return status === 'closed' || status === 'cancelled';
}

/**
 * Structural check of a ballot's answers against an election definition.
 * Returns an error string or null. Partial ballots (answering only some
 * questions) are allowed; duplicate or unknown question/option ids are not.
 */
export function answersError(definition: ElectionDefinition, answers: AnswerChoice[]): string | null {
  if (!Array.isArray(answers) || answers.length === 0) return 'answers must be a non-empty array';
  if (answers.length > definition.questions.length) return 'more answers than questions';
  const questionsById = new Map(definition.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const a of answers) {
    if (typeof a !== 'object' || a === null) return 'answer entries must be objects';
    if (typeof a.questionId !== 'string' || typeof a.optionId !== 'string') {
      return 'answer questionId/optionId must be strings';
    }
    if (seen.has(a.questionId)) return `duplicate answer for question ${a.questionId}`;
    seen.add(a.questionId);
    const question = questionsById.get(a.questionId);
    if (!question) return `unknown questionId ${a.questionId}`;
    if (!question.options.some((o) => o.id === a.optionId)) {
      return `unknown optionId ${a.optionId} for question ${a.questionId}`;
    }
  }
  return null;
}
