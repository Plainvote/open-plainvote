import {
  bytesToBase64Url,
  bytesToHex,
  deriveCastCode,
  deriveReturnCode,
  NodeClient,
  randomBytes,
  type ReturnCodeAnswerCode,
  type ReturnCodeLookup,
  type ReturnCodeSheet,
  type VoteCastTx,
} from '@votechain/protocol';
import type { RegistrarConfig } from './config';
import type { RegistrarDb } from './db';

/**
 * The registrar, in its Return-Code Authority (RCA) role.
 *
 * Sheet generation stores ONLY (sheetId -> secret) — never a link to a voter
 * or voting code — so retrieving codes by sheetId cannot rejoin an anonymous
 * ballot to a person. Retrieval reads the ballot from the PUBLIC chain (never
 * from what the client claims), so a device that flipped the vote on chain
 * gets back the code for the flipped option, which will not match the voter's
 * mailed sheet.
 *
 * NOTE (trust model, see docs/RETURN-CODES.md): in a hardened deployment the
 * party that MAILS sheets (which transiently knows voter <-> sheetId) must be
 * separate from, and not collude with, the party that answers retrieval; and
 * the retrieval key should be threshold-held. This reference implementation
 * runs both roles in one service for the demo and documents the assumption.
 */

/** Thrown when a request references a sheet the RCA does not hold. */
export class UnknownSheetError extends Error {
  constructor() {
    super('unknown return-code sheet');
    this.name = 'UnknownSheetError';
  }
}

export async function generateReturnCodeSheets(
  db: RegistrarDb,
  config: RegistrarConfig,
  electionId: string,
  count: number,
): Promise<ReturnCodeSheet[]> {
  const client = new NodeClient(config.nodeUrl);
  // The ballot structure (questions/options) comes from the on-chain election.
  const detail = await client.election(electionId);
  const definition = detail.definition;

  const sheets: ReturnCodeSheet[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const sheetId = bytesToHex(randomBytes(8));
    const secret = bytesToBase64Url(randomBytes(32));
    db.insertReturnCodeSheet({ sheetId, electionId, secret, createdAt: now });
    sheets.push({
      sheetId,
      electionId,
      electionTitle: definition.title,
      castCode: deriveCastCode(secret, electionId),
      questions: definition.questions.map((q) => ({
        questionId: q.id,
        text: q.text,
        options: q.options.map((o) => ({
          optionId: o.id,
          text: o.text,
          code: deriveReturnCode(secret, electionId, q.id, o.id),
        })),
      })),
    });
  }
  return sheets;
}

export async function computeReturnCodes(
  config: RegistrarConfig,
  secret: string,
  electionId: string,
  token: string,
): Promise<ReturnCodeLookup> {
  const client = new NodeClient(config.nodeUrl);
  const lookup = await client.voteLookup(electionId, token);
  if (!lookup.found || !lookup.countedTxHash) {
    return { found: false, isFinal: false, answers: [], castCode: null };
  }
  // Read the raw recorded ballot (plaintext on chain regardless of the
  // results-visibility convention) so codes reflect what is ACTUALLY on chain.
  const txResp = await client.transaction(lookup.countedTxHash);
  const tx = txResp.tx as VoteCastTx;
  const answers: ReturnCodeAnswerCode[] = tx.answers.map((a) => ({
    questionId: a.questionId,
    optionId: a.optionId,
    code: deriveReturnCode(secret, electionId, a.questionId, a.optionId),
  }));
  return {
    found: true,
    isFinal: lookup.isFinal,
    answers,
    castCode: deriveCastCode(secret, electionId),
  };
}
