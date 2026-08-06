import type { AnswerChoice, ElectionDetail, GenesisValidator, Tx, TxType } from '@votechain/protocol';

export function shortHash(value: string, chars = 10): string {
  return value.length <= chars + 1 ? value : `${value.slice(0, chars)}…`;
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function fmtNum(value: number): string {
  return value.toLocaleString();
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return '–';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Resolve a signing public key to its record-keeper name (falls back to a short key). */
export function validatorName(validators: readonly GenesisValidator[], publicKey: string): string {
  return validators.find((v) => v.publicKey === publicKey)?.name ?? shortHash(publicKey, 12);
}

export function txTypeLabel(type: TxType): string {
  switch (type) {
    case 'VOTE_CAST':
      return 'ballot';
    case 'ELECTION_CREATE':
      return 'election opened';
    case 'ELECTION_CANCEL':
      return 'election cancelled';
    case 'ISSUANCE_COMMIT':
      return 'credentials committed';
  }
}

export function txChipClass(type: TxType): string {
  switch (type) {
    case 'VOTE_CAST':
      return 'info';
    case 'ELECTION_CREATE':
      return 'ok';
    case 'ELECTION_CANCEL':
      return 'danger';
    case 'ISSUANCE_COMMIT':
      return 'warn';
  }
}

export function txSummary(tx: Tx): string {
  switch (tx.type) {
    case 'VOTE_CAST':
      return `election ${tx.electionId} · ballot token ${shortHash(tx.token, 12)} · version ${tx.nonce}`;
    case 'ELECTION_CREATE':
      return `“${tx.election.title}” (${tx.election.electionId})`;
    case 'ELECTION_CANCEL':
      return `election ${tx.electionId}${tx.reason !== undefined ? ` (${tx.reason})` : ''}`;
    case 'ISSUANCE_COMMIT':
      return `election ${tx.electionId} · issued ${tx.issuedCount} · resets ${tx.resetCount}`;
  }
}

export interface ResolvedAnswer {
  question: string;
  answer: string;
}

/** Map raw questionId/optionId pairs to human text when the definition is available. */
export function resolveAnswers(detail: ElectionDetail | null, answers: readonly AnswerChoice[]): ResolvedAnswer[] {
  return answers.map(({ questionId, optionId }) => {
    const question = detail?.definition.questions.find((q) => q.id === questionId);
    const option = question?.options.find((o) => o.id === optionId);
    return { question: question?.text ?? questionId, answer: option?.text ?? optionId };
  });
}
