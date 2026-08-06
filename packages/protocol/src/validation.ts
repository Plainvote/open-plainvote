import { canonicalByteLength } from './canonicalJson';
import { isBase64Url, base64UrlToBytes, isHex } from './bytes';
import { verifyJson } from './ed25519';
import { blockHash, blockHeaderOf, computeTxRoot, verifyBlockSignature } from './block';
import {
  electionCancelSigPayload,
  electionCreateSigPayload,
  issuanceCommitSigPayload,
  registrarAttestationPayload,
  txHash,
  voteSigPayload,
} from './tx';
import { modulusBitLength, verifyCredential, CREDENTIAL_PREFIX_LENGTH, TOKEN_LENGTH } from './blindCredentials';
import { answersError } from './election';
import { proposerForSlot, slotOfTimestamp, slotStartTime } from './genesis';
import type {
  Block,
  BlockHeader,
  ChainState,
  ElectionCancelTx,
  ElectionCreateTx,
  ElectionDefinition,
  Genesis,
  IssuanceCommitTx,
  Tx,
  VoteCastTx,
} from './types';

// ---------------------------------------------------------------------------
// Consensus constants

export const MAX_TX_BYTES = 16_384;
export const MAX_BLOCK_BYTES = 1_000_000;
export const MAX_BLOCK_TXS = 500;
export const MAX_CLOCK_SKEW_MS = 5_000;
export const MAX_QUESTIONS = 64;
export const MAX_OPTIONS_PER_QUESTION = 64;
export const MIN_OPTIONS_PER_QUESTION = 2;
export const MAX_TITLE_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 4096;
export const MAX_QUESTION_LENGTH = 1024;
export const MAX_OPTION_LENGTH = 256;
export const MAX_REASON_LENGTH = 1024;
export const MAX_ELIGIBLE_COUNT = 1_000_000_000;
export const MIN_CREDENTIAL_MODULUS_BITS = 2048;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Control chars, zero-width chars, and bidirectional overrides are rejected in
 * all human-readable strings — they enable ballot-text spoofing.
 */
const FORBIDDEN_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200d\\ufeff\\u202a-\\u202e\\u2066-\\u2069]');

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const OK: ValidationResult = { ok: true };
const err = (reason: string): ValidationResult => ({ ok: false, reason });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function textError(value: unknown, name: string, maxLength: number): string | null {
  if (typeof value !== 'string') return `${name} must be a string`;
  if (value.length === 0) return `${name} must not be empty`;
  if (value.length > maxLength) return `${name} exceeds ${maxLength} characters`;
  if (value !== value.normalize('NFC')) return `${name} must be NFC-normalized`;
  if (FORBIDDEN_CHARS.test(value)) return `${name} contains forbidden control/invisible characters`;
  return null;
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

// ---------------------------------------------------------------------------
// Election definition validation (stateless)

export function electionDefinitionError(def: unknown): string | null {
  if (!isPlainObject(def)) return 'election must be an object';
  const d = def as Partial<ElectionDefinition> & Record<string, unknown>;

  if (!isValidId(d.electionId)) return 'electionId must match [A-Za-z0-9_-]{1,64}';
  const titleErr = textError(d.title, 'title', MAX_TITLE_LENGTH);
  if (titleErr) return titleErr;
  if (d.description !== undefined) {
    const descErr = textError(d.description, 'description', MAX_DESCRIPTION_LENGTH);
    if (descErr) return descErr;
  }
  if (!isTimestamp(d.startTime)) return 'startTime must be a positive integer (ms epoch)';
  if (!isTimestamp(d.endTime)) return 'endTime must be a positive integer (ms epoch)';
  if ((d.startTime as number) >= (d.endTime as number)) return 'startTime must be before endTime';
  if (d.resultsVisibility !== 'live' && d.resultsVisibility !== 'afterClose') {
    return "resultsVisibility must be 'live' or 'afterClose'";
  }
  if (typeof d.allowRevote !== 'boolean') return 'allowRevote must be a boolean';
  if (!Number.isSafeInteger(d.eligibleCount) || (d.eligibleCount as number) < 1 || (d.eligibleCount as number) > MAX_ELIGIBLE_COUNT) {
    return `eligibleCount must be an integer between 1 and ${MAX_ELIGIBLE_COUNT}`;
  }

  if (!Array.isArray(d.questions) || d.questions.length === 0 || d.questions.length > MAX_QUESTIONS) {
    return `questions must be a non-empty array (max ${MAX_QUESTIONS})`;
  }
  const questionIds = new Set<string>();
  for (const q of d.questions) {
    if (!isPlainObject(q)) return 'question entries must be objects';
    if (!isValidId(q.id)) return 'question id must match [A-Za-z0-9_-]{1,64}';
    if (questionIds.has(q.id as string)) return `duplicate question id ${q.id}`;
    questionIds.add(q.id as string);
    const qErr = textError(q.text, `question ${q.id} text`, MAX_QUESTION_LENGTH);
    if (qErr) return qErr;
    const options = q.options;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS_PER_QUESTION || options.length > MAX_OPTIONS_PER_QUESTION) {
      return `question ${q.id} must have between ${MIN_OPTIONS_PER_QUESTION} and ${MAX_OPTIONS_PER_QUESTION} options`;
    }
    const optionIds = new Set<string>();
    const optionLabels = new Set<string>();
    for (const o of options) {
      if (!isPlainObject(o)) return 'option entries must be objects';
      if (!isValidId(o.id)) return `option id in question ${q.id} must match [A-Za-z0-9_-]{1,64}`;
      if (optionIds.has(o.id as string)) return `duplicate option id ${o.id} in question ${q.id}`;
      optionIds.add(o.id as string);
      const oErr = textError(o.text, `option ${o.id} text`, MAX_OPTION_LENGTH);
      if (oErr) return oErr;
      const normalizedLabel = (o.text as string).normalize('NFC').toLowerCase();
      if (optionLabels.has(normalizedLabel)) {
        return `question ${q.id} has two options with the same label "${o.text}"`;
      }
      optionLabels.add(normalizedLabel);
    }
  }

  const jwk = d.credentialPublicKeyJwk;
  if (!isPlainObject(jwk)) return 'credentialPublicKeyJwk must be an object';
  if (jwk.kty !== 'RSA') return "credentialPublicKeyJwk.kty must be 'RSA'";
  if (jwk.e !== 'AQAB') return 'credentialPublicKeyJwk.e must be AQAB (65537)';
  if (!isBase64Url(jwk.n)) return 'credentialPublicKeyJwk.n must be base64url';
  if (Object.keys(jwk).length !== 3) return 'credentialPublicKeyJwk must contain exactly {e, kty, n}';
  const bits = modulusBitLength({ e: 'AQAB', kty: 'RSA', n: jwk.n as string });
  if (bits < MIN_CREDENTIAL_MODULUS_BITS) {
    return `credential key modulus must be at least ${MIN_CREDENTIAL_MODULUS_BITS} bits (got ${bits})`;
  }
  if (!isBase64Url(d.registrarKeyAttestationSig)) return 'registrarKeyAttestationSig must be base64url';

  const knownKeys = new Set([
    'electionId', 'title', 'description', 'questions', 'startTime', 'endTime',
    'resultsVisibility', 'allowRevote', 'eligibleCount', 'credentialPublicKeyJwk', 'registrarKeyAttestationSig',
  ]);
  for (const k of Object.keys(d)) {
    if (!knownKeys.has(k)) return `unknown election field "${k}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stateless transaction shape checks

export function txShapeError(tx: unknown): string | null {
  if (!isPlainObject(tx)) return 'tx must be an object';
  const t = tx as Record<string, unknown>;
  if (!isHex(t.chainId, 32)) return 'chainId must be 32-byte lowercase hex';

  try {
    if (canonicalByteLength(tx) > MAX_TX_BYTES) return `tx exceeds ${MAX_TX_BYTES} canonical bytes`;
  } catch (e) {
    return `tx is not canonically serializable: ${(e as Error).message}`;
  }

  switch (t.type) {
    case 'ELECTION_CREATE': {
      if (!isBase64Url(t.commissionSig)) return 'commissionSig must be base64url';
      const keys = new Set(['type', 'chainId', 'election', 'commissionSig']);
      for (const k of Object.keys(t)) if (!keys.has(k)) return `unknown tx field "${k}"`;
      return electionDefinitionError(t.election);
    }
    case 'ELECTION_CANCEL': {
      if (!isValidId(t.electionId)) return 'electionId must match [A-Za-z0-9_-]{1,64}';
      if (t.reason !== undefined) {
        const rErr = textError(t.reason, 'reason', MAX_REASON_LENGTH);
        if (rErr) return rErr;
      }
      if (!isBase64Url(t.commissionSig)) return 'commissionSig must be base64url';
      const keys = new Set(['type', 'chainId', 'electionId', 'reason', 'commissionSig']);
      for (const k of Object.keys(t)) if (!keys.has(k)) return `unknown tx field "${k}"`;
      return null;
    }
    case 'VOTE_CAST': {
      if (!isValidId(t.electionId)) return 'electionId must match [A-Za-z0-9_-]{1,64}';
      if (!Array.isArray(t.answers)) return 'answers must be an array';
      for (const a of t.answers) {
        if (!isPlainObject(a)) return 'answer entries must be objects';
        if (!isValidId(a.questionId) || !isValidId(a.optionId)) return 'answer ids must match [A-Za-z0-9_-]{1,64}';
        if (Object.keys(a).length !== 2) return 'answer entries must contain exactly {questionId, optionId}';
      }
      if (!isBase64Url(t.token) || base64UrlToBytes(t.token as string).length !== TOKEN_LENGTH) {
        return `token must be base64url of ${TOKEN_LENGTH} bytes`;
      }
      if (!isBase64Url(t.tokenPrefix) || base64UrlToBytes(t.tokenPrefix as string).length !== CREDENTIAL_PREFIX_LENGTH) {
        return `tokenPrefix must be base64url of ${CREDENTIAL_PREFIX_LENGTH} bytes`;
      }
      if (!Number.isSafeInteger(t.nonce) || (t.nonce as number) < 0) return 'nonce must be a non-negative integer';
      if (!isBase64Url(t.credentialSig)) return 'credentialSig must be base64url';
      if (!isBase64Url(t.voteSig)) return 'voteSig must be base64url';
      const keys = new Set(['type', 'chainId', 'electionId', 'answers', 'token', 'tokenPrefix', 'nonce', 'credentialSig', 'voteSig']);
      for (const k of Object.keys(t)) if (!keys.has(k)) return `unknown tx field "${k}"`;
      return null;
    }
    case 'ISSUANCE_COMMIT': {
      if (!isValidId(t.electionId)) return 'electionId must match [A-Za-z0-9_-]{1,64}';
      if (!Number.isSafeInteger(t.issuedCount) || (t.issuedCount as number) < 0) return 'issuedCount must be a non-negative integer';
      if (!Number.isSafeInteger(t.resetCount) || (t.resetCount as number) < 0) return 'resetCount must be a non-negative integer';
      if (!isHex(t.issuanceRoot, 32)) return 'issuanceRoot must be 32-byte lowercase hex';
      if (!isBase64Url(t.registrarSig)) return 'registrarSig must be base64url';
      const keys = new Set(['type', 'chainId', 'electionId', 'issuedCount', 'resetCount', 'issuanceRoot', 'registrarSig']);
      for (const k of Object.keys(t)) if (!keys.has(k)) return `unknown tx field "${k}"`;
      return null;
    }
    default:
      return `unknown tx type "${String(t.type)}"`;
  }
}

// ---------------------------------------------------------------------------
// Stateful transaction validation. Deterministic in (state, blockTimestamp):
// every honest node and auditor reaches the same verdict for the same chain.

export async function validateTx(
  state: ChainState,
  genesis: Genesis,
  tx: Tx,
  blockTimestamp: number,
): Promise<ValidationResult> {
  const shapeErr = txShapeError(tx);
  if (shapeErr) return err(shapeErr);
  if (tx.chainId !== state.chainId) return err('wrong chainId');
  if (state.txLocations.has(txHash(tx))) return err('duplicate transaction');

  switch (tx.type) {
    case 'ELECTION_CREATE':
      return validateElectionCreate(state, genesis, tx);
    case 'ELECTION_CANCEL':
      return validateElectionCancel(state, genesis, tx, blockTimestamp);
    case 'VOTE_CAST':
      return validateVoteCast(state, tx, blockTimestamp);
    case 'ISSUANCE_COMMIT':
      return validateIssuanceCommit(state, genesis, tx);
  }
}

function validateElectionCreate(state: ChainState, genesis: Genesis, tx: ElectionCreateTx): ValidationResult {
  const election = tx.election;
  if (state.elections.has(election.electionId)) return err('electionId already exists');
  if (state.credentialModuli.has(election.credentialPublicKeyJwk.n)) {
    return err('credential key already used by another election (per-election keys are required)');
  }
  const attestationOk = verifyJson(
    election.registrarKeyAttestationSig,
    registrarAttestationPayload(tx.chainId, election.electionId, election.credentialPublicKeyJwk),
    genesis.registrarPublicKey,
  );
  if (!attestationOk) return err('invalid registrar key attestation');
  const sigOk = verifyJson(tx.commissionSig, electionCreateSigPayload(tx.chainId, election), genesis.commissionPublicKey);
  if (!sigOk) return err('invalid commission signature');
  return OK;
}

function validateElectionCancel(
  state: ChainState,
  genesis: Genesis,
  tx: ElectionCancelTx,
  blockTimestamp: number,
): ValidationResult {
  const entry = state.elections.get(tx.electionId);
  if (!entry) return err('unknown election');
  if (entry.cancelled) return err('election already cancelled');
  if (blockTimestamp >= entry.definition.startTime) return err('election can only be cancelled before it starts');
  const sigOk = verifyJson(tx.commissionSig, electionCancelSigPayload(tx.chainId, tx.electionId, tx.reason), genesis.commissionPublicKey);
  if (!sigOk) return err('invalid commission signature');
  return OK;
}

async function validateVoteCast(state: ChainState, tx: VoteCastTx, blockTimestamp: number): Promise<ValidationResult> {
  const entry = state.elections.get(tx.electionId);
  if (!entry) return err('unknown election');
  if (entry.cancelled) return err('election is cancelled');
  const def = entry.definition;
  if (blockTimestamp < def.startTime) return err('election has not started');
  if (blockTimestamp >= def.endTime) return err('election has ended');

  const aErr = answersError(def, tx.answers);
  if (aErr) return err(aErr);

  const existing = entry.votesByToken.get(tx.token);
  if (existing && existing.length > 0) {
    if (!def.allowRevote) return err('token has already voted (revoting is disabled for this election)');
  }

  const voteSigOk = verifyJson(tx.voteSig, voteSigPayload(tx), tx.token);
  if (!voteSigOk) return err('invalid vote signature');

  const credentialOk = await verifyCredential(
    def.credentialPublicKeyJwk,
    tx.chainId,
    tx.electionId,
    tx.token,
    tx.tokenPrefix,
    tx.credentialSig,
  );
  if (!credentialOk) return err('invalid voting credential');
  return OK;
}

function validateIssuanceCommit(state: ChainState, genesis: Genesis, tx: IssuanceCommitTx): ValidationResult {
  const entry = state.elections.get(tx.electionId);
  if (!entry) return err('unknown election');
  if (entry.commit) return err('issuance commitment already recorded for this election');
  const sigOk = verifyJson(tx.registrarSig, issuanceCommitSigPayload(tx), genesis.registrarPublicKey);
  if (!sigOk) return err('invalid registrar signature');
  return OK;
}

// ---------------------------------------------------------------------------
// Block validation. `state` MUST be the state at the parent block.

export interface ValidateBlockOptions {
  /** Wall-clock reference for the future-block check; omit to skip (audits of historical chains). */
  localNowMs?: number;
}

export async function validateBlock(
  state: ChainState,
  genesis: Genesis,
  block: Block,
  parent: BlockHeader | null,
  opts: ValidateBlockOptions = {},
): Promise<ValidationResult> {
  if (!isPlainObject(block)) return err('block must be an object');
  const expectedHeight = (parent?.height ?? 0) + 1;
  if (block.height !== expectedHeight) return err(`height must be ${expectedHeight}`);
  const expectedPrev = parent ? blockHash(parent) : state.chainId;
  if (block.prevHash !== expectedPrev) return err('prevHash does not match parent');
  if (!Number.isSafeInteger(block.timestamp)) return err('timestamp must be an integer');
  if (!Array.isArray(block.txs)) return err('txs must be an array');
  if (block.txs.length > MAX_BLOCK_TXS) return err(`block exceeds ${MAX_BLOCK_TXS} transactions`);

  try {
    if (canonicalByteLength({ ...blockHeaderOf(block), txs: block.txs, proposerSig: block.proposerSig }) > MAX_BLOCK_BYTES) {
      return err(`block exceeds ${MAX_BLOCK_BYTES} canonical bytes`);
    }
  } catch (e) {
    return err(`block is not canonically serializable: ${(e as Error).message}`);
  }

  // Slot rules: timestamp must be exactly a slot start, strictly after the
  // parent, not in the future (beyond skew), and proposed by the scheduled
  // validator for that slot.
  const slot = slotOfTimestamp(genesis, block.timestamp);
  if (slot < 0) return err('timestamp before genesis');
  if (slotStartTime(genesis, slot) !== block.timestamp) return err('timestamp must equal the slot start time');
  if (parent && block.timestamp <= parent.timestamp) return err('timestamp must be after parent block');
  if (opts.localNowMs !== undefined && block.timestamp > opts.localNowMs + MAX_CLOCK_SKEW_MS) {
    return err('block timestamp is in the future');
  }
  const scheduled = proposerForSlot(genesis, slot);
  if (block.proposer !== scheduled.publicKey) {
    return err(`wrong proposer for slot ${slot} (expected ${scheduled.name})`);
  }
  if (block.txRoot !== computeTxRoot(block.txs)) return err('txRoot mismatch');
  if (!verifyBlockSignature(block)) return err('invalid proposer signature');

  // Per-tx validation against parent state, plus in-block conflict rules.
  const seenTxHashes = new Set<string>();
  const seenElectionCreates = new Set<string>();
  const seenModuli = new Set<string>();
  const seenCancels = new Set<string>();
  const seenCommits = new Set<string>();
  const seenTokens = new Map<string, Set<string>>();

  for (const tx of block.txs) {
    const hash = txHash(tx);
    if (seenTxHashes.has(hash)) return err('duplicate transaction within block');
    seenTxHashes.add(hash);

    const result = await validateTx(state, genesis, tx, block.timestamp);
    if (!result.ok) return err(`tx ${hash.slice(0, 12)}…: ${result.reason}`);

    switch (tx.type) {
      case 'ELECTION_CREATE': {
        if (seenElectionCreates.has(tx.election.electionId)) return err('duplicate election creation within block');
        seenElectionCreates.add(tx.election.electionId);
        if (seenModuli.has(tx.election.credentialPublicKeyJwk.n)) return err('duplicate credential key within block');
        seenModuli.add(tx.election.credentialPublicKeyJwk.n);
        break;
      }
      case 'ELECTION_CANCEL': {
        if (seenCancels.has(tx.electionId)) return err('duplicate election cancel within block');
        seenCancels.add(tx.electionId);
        break;
      }
      case 'VOTE_CAST': {
        const entry = state.elections.get(tx.electionId);
        const allowRevote = entry?.definition.allowRevote ?? false;
        let tokens = seenTokens.get(tx.electionId);
        if (!tokens) {
          tokens = new Set();
          seenTokens.set(tx.electionId, tokens);
        }
        if (!allowRevote && tokens.has(tx.token)) return err('duplicate token within block');
        tokens.add(tx.token);
        break;
      }
      case 'ISSUANCE_COMMIT': {
        if (seenCommits.has(tx.electionId)) return err('duplicate issuance commitment within block');
        seenCommits.add(tx.electionId);
        break;
      }
    }
  }
  return OK;
}
