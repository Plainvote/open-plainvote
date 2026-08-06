import { hashJson } from './hash';
import { ed25519PublicKeyFromSecret, signJson } from './ed25519';
import type {
  AnswerChoice,
  ElectionCancelTx,
  ElectionCreateTx,
  ElectionDefinition,
  IssuanceCommitTx,
  RsaPublicJwk,
  Tx,
  VoteCastTx,
} from './types';

export function txHash(tx: Tx): string {
  return hashJson(tx);
}

// ---------------------------------------------------------------------------
// Signature payloads. Each payload includes `type` and `chainId` — domain
// separation between transaction kinds and replay protection across chains.

export function electionCreateSigPayload(chainId: string, election: ElectionDefinition): unknown {
  return { type: 'ELECTION_CREATE', chainId, election };
}

export function electionCancelSigPayload(chainId: string, electionId: string, reason?: string): unknown {
  return reason === undefined
    ? { type: 'ELECTION_CANCEL', chainId, electionId }
    : { type: 'ELECTION_CANCEL', chainId, electionId, reason };
}

export function voteSigPayload(tx: Pick<VoteCastTx, 'chainId' | 'electionId' | 'answers' | 'token' | 'tokenPrefix' | 'nonce'>): unknown {
  return {
    type: 'VOTE_CAST',
    chainId: tx.chainId,
    electionId: tx.electionId,
    answers: tx.answers,
    token: tx.token,
    tokenPrefix: tx.tokenPrefix,
    nonce: tx.nonce,
  };
}

export function issuanceCommitSigPayload(
  tx: Pick<IssuanceCommitTx, 'chainId' | 'electionId' | 'issuedCount' | 'resetCount' | 'issuanceRoot'>,
): unknown {
  return {
    type: 'ISSUANCE_COMMIT',
    chainId: tx.chainId,
    electionId: tx.electionId,
    issuedCount: tx.issuedCount,
    resetCount: tx.resetCount,
    issuanceRoot: tx.issuanceRoot,
  };
}

/** Signed by the registrar's long-term key; embedded in ELECTION_CREATE so the
 * chain only accepts elections whose credential key the registrar actually holds. */
export function registrarAttestationPayload(chainId: string, electionId: string, credentialPublicKeyJwk: RsaPublicJwk): unknown {
  return { chainId, electionId, credentialPublicKeyJwk };
}

// ---------------------------------------------------------------------------
// Builders

export function buildElectionCreateTx(
  chainId: string,
  election: ElectionDefinition,
  commissionSecretKey: string,
): ElectionCreateTx {
  const commissionSig = signJson(electionCreateSigPayload(chainId, election), commissionSecretKey);
  return { type: 'ELECTION_CREATE', chainId, election, commissionSig };
}

export function buildElectionCancelTx(
  chainId: string,
  electionId: string,
  commissionSecretKey: string,
  reason?: string,
): ElectionCancelTx {
  const commissionSig = signJson(electionCancelSigPayload(chainId, electionId, reason), commissionSecretKey);
  return reason === undefined
    ? { type: 'ELECTION_CANCEL', chainId, electionId, commissionSig }
    : { type: 'ELECTION_CANCEL', chainId, electionId, reason, commissionSig };
}

export interface BuildVoteArgs {
  chainId: string;
  electionId: string;
  answers: AnswerChoice[];
  /** base64url secret key of the ephemeral (token) keypair */
  tokenSecretKey: string;
  tokenPrefix: string;
  credentialSig: string;
  nonce: number;
}

export function buildVoteCastTx(args: BuildVoteArgs): VoteCastTx {
  const token = ed25519PublicKeyFromSecret(args.tokenSecretKey);
  const unsigned = {
    chainId: args.chainId,
    electionId: args.electionId,
    answers: args.answers,
    token,
    tokenPrefix: args.tokenPrefix,
    nonce: args.nonce,
  };
  const voteSig = signJson(voteSigPayload(unsigned), args.tokenSecretKey);
  return {
    type: 'VOTE_CAST',
    ...unsigned,
    credentialSig: args.credentialSig,
    voteSig,
  };
}

export function buildIssuanceCommitTx(
  args: Pick<IssuanceCommitTx, 'chainId' | 'electionId' | 'issuedCount' | 'resetCount' | 'issuanceRoot'>,
  registrarSecretKey: string,
): IssuanceCommitTx {
  const registrarSig = signJson(issuanceCommitSigPayload(args), registrarSecretKey);
  return { type: 'ISSUANCE_COMMIT', ...args, registrarSig };
}
