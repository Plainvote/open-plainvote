import type { AnswerChoice } from '@votechain/protocol';

/**
 * What the voter flow holds between screens, and deliberately does not.
 *
 * **The voting code stays in memory.** Not localStorage, not sessionStorage,
 * not a URL. It is a bearer secret that works across devices and, on a
 * registrar without roll binding, across elections — strictly more powerful
 * than the per-election credential. handoff.ts scrubs it from the address bar
 * on arrival for exactly that reason, and writing it into a storage API
 * immediately afterwards would undo that work.
 *
 * Module scope rather than React state so it survives remounts and route
 * changes within the page, and dies on reload. Session continuity across a
 * reload does not come from here: it comes from the credential the app already
 * saves (see findCredential), which is scoped to one election and is enough to
 * cast, revote and show a receipt without the code ever being needed again.
 *
 * **Ballot selections stay in memory too.** A refresh mid-ballot therefore
 * returns the voter to that ballot, still credentialed, with the questions
 * blank. That is a deliberate trade: persisting a draft would leave a record of
 * how someone intends to vote sitting on the device, and re-answering is a far
 * smaller cost than that. It is not the case this phase set out to fix, which
 * was losing the whole session.
 */

let code: string | null = null;

export function setCode(value: string): void {
  code = value.trim();
}

export function getCode(): string | null {
  return code;
}

export function clearCode(): void {
  code = null;
}

/** In-flight ballot answers, keyed by election. Never persisted. */
const drafts = new Map<string, Record<string, string>>();

export function getDraft(electionId: string): Record<string, string> {
  return drafts.get(electionId) ?? {};
}

export function setDraft(electionId: string, selections: Record<string, string>): void {
  drafts.set(electionId, selections);
}

export function clearDraft(electionId: string): void {
  drafts.delete(electionId);
}

/** Draft as the protocol's answer shape, dropping unanswered questions. */
export function draftAnswers(electionId: string): AnswerChoice[] {
  return Object.entries(getDraft(electionId)).map(([questionId, optionId]) => ({ questionId, optionId }));
}
