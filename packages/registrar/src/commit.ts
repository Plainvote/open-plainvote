import {
  buildIssuanceCommitTx,
  merkleRoot,
  NodeClient,
  sha256Hex,
  txHash,
} from '@votechain/protocol';
import type { RegistrarConfig } from './config';
import type { RegistrarDb } from './db';

export interface CommitResult {
  txHash: string;
  issuedCount: number;
  resetCount: number;
  issuanceRoot: string;
  accepted: boolean;
  reason?: string;
}

/**
 * Public commitment of the issuance log. issuedCount counts every credential
 * ever issued for the election (current rows + audited resets), so the
 * auditor invariant `distinct voting tokens <= issuedCount <= eligibleCount`
 * holds even when resets were used. The Merkle root commits to the current
 * issuance set (salted leaves — codes are not enumerable from the root).
 */
export async function buildAndSubmitIssuanceCommit(
  db: RegistrarDb,
  config: RegistrarConfig,
  electionId: string,
): Promise<CommitResult> {
  const keysRow = db.getElectionKeys(electionId);
  if (!keysRow) throw new Error(`no election keys for ${electionId}`);

  const codeHashes = db.listIssuanceCodeHashes(electionId);
  const resetCount = db.countResets(electionId);
  const issuedCount = codeHashes.length + resetCount;
  const leaves = codeHashes.map((codeHash) => sha256Hex(`${codeHash}|${electionId}|${keysRow.salt}`)).sort();
  const issuanceRoot = merkleRoot(leaves);

  const tx = buildIssuanceCommitTx(
    { chainId: config.chainId, electionId, issuedCount, resetCount, issuanceRoot },
    config.registrarSecretKey,
  );
  const client = new NodeClient(config.nodeUrl);
  const submit = await client.submitTx(tx);
  return {
    txHash: txHash(tx),
    issuedCount,
    resetCount,
    issuanceRoot,
    accepted: submit.accepted,
    ...(submit.reason !== undefined ? { reason: submit.reason } : {}),
  };
}
