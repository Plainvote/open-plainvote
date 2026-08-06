import { txHash, validateTx, type Tx } from '@votechain/protocol';
import type { Chain } from './chain';

export const MAX_MEMPOOL_TXS = 10_000;

export interface AdmitResult {
  accepted: boolean;
  txHash: string;
  reason?: string;
  /** false when the tx was already known (idempotent success) */
  isNew: boolean;
}

/**
 * Pending transactions. Admission validates against the current head state
 * with the wall clock as a *lenient* pre-filter — the consensus-authoritative
 * window check happens against the block timestamp when a proposer includes
 * the tx (and again in block validation on every node).
 */
export class Mempool {
  private readonly txs = new Map<string, Tx>();
  /** electionId -> token -> txHash, for no-revote conflict checks */
  private readonly tokensByElection = new Map<string, Map<string, string>>();

  constructor(
    private readonly chain: Chain,
    private readonly maxSize = MAX_MEMPOOL_TXS,
  ) {}

  get size(): number {
    return this.txs.size;
  }

  has(hash: string): boolean {
    return this.txs.has(hash);
  }

  getAll(): Tx[] {
    return [...this.txs.values()];
  }

  async admit(tx: Tx): Promise<AdmitResult> {
    const hash = txHash(tx);
    if (this.txs.has(hash)) {
      return { accepted: true, txHash: hash, isNew: false };
    }
    if (this.txs.size >= this.maxSize) {
      return { accepted: false, txHash: hash, isNew: false, reason: 'mempool full' };
    }

    const result = await validateTx(this.chain.state, this.chain.genesis, tx, Date.now());
    if (!result.ok) {
      return { accepted: false, txHash: hash, isNew: false, reason: result.reason };
    }

    if (tx.type === 'VOTE_CAST') {
      const entry = this.chain.state.elections.get(tx.electionId);
      if (entry && !entry.definition.allowRevote) {
        const tokens = this.tokensByElection.get(tx.electionId);
        if (tokens?.has(tx.token)) {
          return {
            accepted: false,
            txHash: hash,
            isNew: false,
            reason: 'another vote with this token is already pending',
          };
        }
      }
    }

    this.txs.set(hash, tx);
    if (tx.type === 'VOTE_CAST') {
      let tokens = this.tokensByElection.get(tx.electionId);
      if (!tokens) {
        tokens = new Map();
        this.tokensByElection.set(tx.electionId, tokens);
      }
      tokens.set(tx.token, hash);
    }
    return { accepted: true, txHash: hash, isNew: true };
  }

  /** Drop included and newly-conflicting transactions after a head change. */
  prune(): void {
    const state = this.chain.state;
    for (const [hash, tx] of this.txs) {
      let drop = state.txLocations.has(hash);
      if (!drop && tx.type === 'VOTE_CAST') {
        const entry = state.elections.get(tx.electionId);
        if (entry) {
          if (entry.cancelled) drop = true;
          else if (!entry.definition.allowRevote && (entry.votesByToken.get(tx.token)?.length ?? 0) > 0) drop = true;
          else if (Date.now() >= entry.definition.endTime) drop = true;
        }
      }
      if (drop) this.remove(hash, tx);
    }
  }

  remove(hash: string, tx?: Tx): void {
    const known = tx ?? this.txs.get(hash);
    this.txs.delete(hash);
    if (known && known.type === 'VOTE_CAST') {
      const tokens = this.tokensByElection.get(known.electionId);
      if (tokens && tokens.get(known.token) === hash) tokens.delete(known.token);
    }
  }
}
