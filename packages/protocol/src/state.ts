import { txHash } from './tx';
import type { Block, ChainState, ElectionEntry, Tx, VoteRecord } from './types';

/**
 * The chain state is a pure fold over blocks: applyBlock assumes the block was
 * already validated (validation.ts) and only records its effects. Rebuilding
 * state = replaying the best chain from genesis, which is also exactly what
 * the independent audit script does.
 */

export function createInitialState(chainId: string): ChainState {
  return {
    chainId,
    height: 0,
    elections: new Map(),
    credentialModuli: new Set(),
    txLocations: new Map(),
  };
}

export function applyBlock(state: ChainState, block: Block): void {
  state.height = block.height;
  for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
    const tx = block.txs[txIndex]!;
    const hash = txHash(tx);
    state.txLocations.set(hash, { blockHeight: block.height, txIndex });
    applyTx(state, tx, hash, block.height, txIndex);
  }
}

function applyTx(state: ChainState, tx: Tx, hash: string, blockHeight: number, txIndex: number): void {
  switch (tx.type) {
    case 'ELECTION_CREATE': {
      const entry: ElectionEntry = {
        definition: tx.election,
        createdAtHeight: blockHeight,
        cancelled: false,
        votesByToken: new Map(),
      };
      state.elections.set(tx.election.electionId, entry);
      state.credentialModuli.add(tx.election.credentialPublicKeyJwk.n);
      break;
    }
    case 'ELECTION_CANCEL': {
      const entry = state.elections.get(tx.electionId);
      if (entry) {
        entry.cancelled = true;
        if (tx.reason !== undefined) entry.cancelReason = tx.reason;
      }
      break;
    }
    case 'VOTE_CAST': {
      const entry = state.elections.get(tx.electionId);
      if (!entry) break;
      const record: VoteRecord = {
        txHash: hash,
        blockHeight,
        txIndex,
        nonce: tx.nonce,
        token: tx.token,
        answers: tx.answers,
      };
      const existing = entry.votesByToken.get(tx.token);
      if (existing) existing.push(record);
      else entry.votesByToken.set(tx.token, [record]);
      break;
    }
    case 'ISSUANCE_COMMIT': {
      const entry = state.elections.get(tx.electionId);
      if (entry) {
        entry.commit = {
          issuedCount: tx.issuedCount,
          resetCount: tx.resetCount,
          issuanceRoot: tx.issuanceRoot,
          blockHeight,
        };
      }
      break;
    }
  }
}
