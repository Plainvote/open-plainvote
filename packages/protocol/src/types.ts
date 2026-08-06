/**
 * Wire types for the VoteChain protocol. Everything here crosses a trust
 * boundary (network, disk, or signature payload) and is therefore validated
 * structurally in validation.ts — never trust the TypeScript types alone.
 */

// ---------------------------------------------------------------------------
// Genesis

export interface GenesisValidator {
  name: string;
  /** base64url Ed25519 public key */
  publicKey: string;
}

export interface Genesis {
  /** Human-readable network name (part of the chainId preimage). */
  name: string;
  /** ms epoch — start of slot 0 */
  genesisTime: number;
  /** proposer slot length in seconds */
  slotSeconds: number;
  validators: GenesisValidator[];
  /** base64url Ed25519 key that signs election lifecycle transactions */
  commissionPublicKey: string;
  /** base64url Ed25519 key that attests credential keys and issuance commitments */
  registrarPublicKey: string;
}

// ---------------------------------------------------------------------------
// Elections

export type ResultsVisibility = 'live' | 'afterClose';

export interface ElectionOption {
  id: string;
  text: string;
}

export interface ElectionQuestion {
  id: string;
  text: string;
  options: ElectionOption[];
}

/** RSA public key as embedded on-chain: exactly {e, kty, n}, nothing else. */
export interface RsaPublicJwk {
  e: string;
  kty: 'RSA';
  n: string;
}

export interface ElectionDefinition {
  electionId: string;
  title: string;
  description?: string;
  questions: ElectionQuestion[];
  /** ms epoch, votes valid while startTime <= block.timestamp < endTime */
  startTime: number;
  endTime: number;
  resultsVisibility: ResultsVisibility;
  /** later vote with the same credential replaces the earlier one (anti-coercion) */
  allowRevote: boolean;
  /** size of the eligible-voter roll — public commitment for stuffing detection */
  eligibleCount: number;
  /** per-election RSABSSA public key held by the registrar */
  credentialPublicKeyJwk: RsaPublicJwk;
  /** registrar Ed25519 signature over {chainId, credentialPublicKeyJwk, electionId} */
  registrarKeyAttestationSig: string;
}

export type ElectionStatus = 'upcoming' | 'open' | 'closed' | 'cancelled';

// ---------------------------------------------------------------------------
// Transactions

export interface AnswerChoice {
  questionId: string;
  optionId: string;
}

export interface ElectionCreateTx {
  type: 'ELECTION_CREATE';
  chainId: string;
  election: ElectionDefinition;
  /** commission Ed25519 signature over canonical(tx minus commissionSig) */
  commissionSig: string;
}

export interface ElectionCancelTx {
  type: 'ELECTION_CANCEL';
  chainId: string;
  electionId: string;
  reason?: string;
  commissionSig: string;
}

export interface VoteCastTx {
  type: 'VOTE_CAST';
  chainId: string;
  electionId: string;
  answers: AnswerChoice[];
  /** base64url 32-byte ephemeral Ed25519 public key — the anonymous voting token */
  token: string;
  /** base64url 32-byte RSABSSA prepare prefix */
  tokenPrefix: string;
  /** client-chosen integer; highest nonce per (electionId, token) is counted */
  nonce: number;
  /** RSABSSA signature over tokenPrefix || credential message */
  credentialSig: string;
  /** ephemeral-key Ed25519 signature over canonical(tx minus voteSig/credentialSig) */
  voteSig: string;
}

export interface IssuanceCommitTx {
  type: 'ISSUANCE_COMMIT';
  chainId: string;
  electionId: string;
  /** number of credentials issued for this election */
  issuedCount: number;
  /** number of audited issuance resets (device-loss support hatch) */
  resetCount: number;
  /** Merkle root over sorted sha256(codeHash || electionId || salt) leaves */
  issuanceRoot: string;
  registrarSig: string;
}

export type Tx = ElectionCreateTx | ElectionCancelTx | VoteCastTx | IssuanceCommitTx;
export type TxType = Tx['type'];

// ---------------------------------------------------------------------------
// Blocks

export interface BlockHeader {
  height: number;
  /** blockHash of the parent; for block 1 this is the chainId (genesis hash) */
  prevHash: string;
  /** ms epoch — MUST equal the slot start time */
  timestamp: number;
  /** base64url Ed25519 public key of the scheduled slot proposer */
  proposer: string;
  /** hashJson of the array of txHashes */
  txRoot: string;
}

export interface Block extends BlockHeader {
  txs: Tx[];
  /** proposer Ed25519 signature over canonical(header) */
  proposerSig: string;
}

// ---------------------------------------------------------------------------
// Chain state (derived, in-memory)

export interface VoteRecord {
  txHash: string;
  blockHeight: number;
  txIndex: number;
  nonce: number;
  token: string;
  answers: AnswerChoice[];
}

export interface IssuanceCommitInfo {
  issuedCount: number;
  resetCount: number;
  issuanceRoot: string;
  blockHeight: number;
}

export interface ElectionEntry {
  definition: ElectionDefinition;
  createdAtHeight: number;
  cancelled: boolean;
  cancelReason?: string;
  commit?: IssuanceCommitInfo;
  /** token -> all vote records for that token, in chain order */
  votesByToken: Map<string, VoteRecord[]>;
}

export interface TxLocation {
  blockHeight: number;
  txIndex: number;
}

export interface ChainState {
  chainId: string;
  height: number;
  elections: Map<string, ElectionEntry>;
  /** JWK `n` values already used by an election (per-election-key consensus rule) */
  credentialModuli: Set<string>;
  txLocations: Map<string, TxLocation>;
}

// ---------------------------------------------------------------------------
// Tally

export interface OptionTally {
  optionId: string;
  text: string;
  count: number;
}

export interface QuestionTally {
  questionId: string;
  text: string;
  totalAnswers: number;
  options: OptionTally[];
}

export interface IntegrityInfo {
  distinctTokens: number;
  voteTxCount: number;
  /** null until the registrar posts ISSUANCE_COMMIT */
  issuedCount: number | null;
  resetCount: number | null;
  eligibleCount: number;
  /** true when distinct tokens exceed the eligible roll — loud red flag */
  exceedsEligible: boolean;
  commitBlockHeight: number | null;
}

// ---------------------------------------------------------------------------
// Node API DTOs

export interface EquivocationRecord {
  height: number;
  proposer: string;
  blockHashes: string[];
}

export interface NodeStatusInfo {
  chainId: string;
  nodeName: string;
  height: number;
  headHash: string;
  finalizedHeight: number;
  slot: number;
  time: number;
  validators: GenesisValidator[];
  peerCount: number;
  mempoolSize: number;
  isValidator: boolean;
  equivocations: EquivocationRecord[];
}

export interface ElectionSummary {
  electionId: string;
  title: string;
  status: ElectionStatus;
  startTime: number;
  endTime: number;
  resultsVisibility: ResultsVisibility;
  allowRevote: boolean;
  eligibleCount: number;
  questionCount: number;
  turnout: number;
  createdAtHeight: number;
}

export interface ElectionDetail {
  definition: ElectionDefinition;
  status: ElectionStatus;
  cancelled: boolean;
  cancelReason?: string;
  createdAtHeight: number;
  turnout: number;
  commit: IssuanceCommitInfo | null;
}

export interface FinalityInfo {
  headHash: string;
  height: number;
  finalizedHeight: number;
  /** all blocks contributing to this tally are finalized */
  tallyIsFinal: boolean;
}

export interface ResultsResponse {
  electionId: string;
  title: string;
  status: ElectionStatus;
  resultsVisibility: ResultsVisibility;
  startTime: number;
  endTime: number;
  allowRevote: boolean;
  turnout: { distinctTokens: number; voteTxCount: number };
  /** false while an afterClose election is still open (results withheld) */
  resultsVisible: boolean;
  questions: QuestionTally[] | null;
  integrity: IntegrityInfo;
  finality: FinalityInfo;
}

export interface VoteLookupRecord {
  txHash: string;
  blockHeight: number;
  txIndex: number;
  nonce: number;
  counted: boolean;
  supersededByTxHash: string | null;
  /** null when results are not yet visible for this election */
  answers: AnswerChoice[] | null;
}

export interface VoteLookupResponse {
  found: boolean;
  electionId: string;
  token: string;
  answersVisible: boolean;
  records: VoteLookupRecord[];
  countedTxHash: string | null;
  isFinal: boolean;
}

export interface TxLookupResponse {
  txHash: string;
  blockHeight: number;
  txIndex: number;
  tx: Tx;
}

export interface SubmitTxResult {
  accepted: boolean;
  txHash?: string;
  reason?: string;
}

/** What the voter's device stores after casting — enough to verify inclusion. */
export interface Receipt {
  chainId: string;
  electionId: string;
  electionTitle: string;
  token: string;
  txHash: string;
  nonce: number;
  castAt: number;
  nodeUrls: string[];
}

// ---------------------------------------------------------------------------
// Registrar API DTOs

export interface CredentialRequestBody {
  code: string;
  electionId: string;
  /** base64url RSABSSA blinded message */
  blindedToken: string;
}

export type CredentialResult =
  | { status: 'ok'; blindSignature: string }
  | {
      status:
        | 'unknown_code'
        | 'unknown_election'
        | 'code_revoked'
        | 'already_issued'
        | 'code_not_in_roll'
        | 'roll_not_bound'
        | 'error';
      message: string;
    };

export interface CodeInfo {
  codeHash: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
  replacedBy: string | null;
  issuedElections: string[];
  /**
   * Voter roll this code belongs to, or null for an unscoped code. A code may
   * only obtain credentials for elections bound to its own roll — this is what
   * keeps one organization's voters out of another's ballot.
   */
  rollId: string | null;
}

export interface RegistrarElectionStats {
  electionId: string;
  credentialsIssued: number;
  resets: number;
  /** Roll this election draws its electorate from, or null if unbound. */
  rollId: string | null;
}

export interface RegistrarRollStats {
  rollId: string;
  activeCodes: number;
  revokedCodes: number;
}

export interface RegistrarStats {
  activeCodes: number;
  revokedCodes: number;
  elections: RegistrarElectionStats[];
  rolls: RegistrarRollStats[];
}

export interface ElectionKeysResponse {
  electionId: string;
  publicKeyJwk: RsaPublicJwk;
  attestationSig: string;
}

// ---------------------------------------------------------------------------
// Return codes (cast-as-intended verification; see returnCodes.ts)

export interface ReturnCodeSheetOption {
  optionId: string;
  text: string;
  /** secret code the voter checks against the RCA's answer */
  code: string;
}

export interface ReturnCodeSheetQuestion {
  questionId: string;
  text: string;
  options: ReturnCodeSheetOption[];
}

/**
 * A single voter's mailed code sheet. `sheetId` is a random handle with NO
 * link to the voter's identity or voting code stored at the RCA — the voter
 * presents it to retrieve return codes for their anonymous ballot.
 */
export interface ReturnCodeSheet {
  sheetId: string;
  electionId: string;
  electionTitle: string;
  /** confirms the RCA is looking at a recorded ballot at all */
  castCode: string;
  questions: ReturnCodeSheetQuestion[];
}

export interface ReturnCodeAnswerCode {
  questionId: string;
  optionId: string;
  code: string;
}

/** RCA response: the return code(s) for the options actually recorded on chain. */
export interface ReturnCodeLookup {
  found: boolean;
  isFinal: boolean;
  answers: ReturnCodeAnswerCode[];
  /** null when no ballot is recorded for the token yet */
  castCode: string | null;
}
