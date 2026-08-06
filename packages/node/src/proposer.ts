import {
  buildBlock,
  canonicalByteLength,
  ed25519PublicKeyFromSecret,
  MAX_BLOCK_BYTES,
  MAX_BLOCK_TXS,
  proposerForSlot,
  slotOfTimestamp,
  slotStartTime,
  validateTx,
  type Block,
  type Tx,
} from '@votechain/protocol';
import type { Chain } from './chain';
import type { Mempool } from './mempool';

const BLOCK_BYTE_BUDGET = MAX_BLOCK_BYTES - 4096; // header + signature headroom

/**
 * Slot-driven block production. In our slot the node proposes iff there is
 * pending work: mempool transactions, or a not-yet-finalized head (empty
 * heartbeat blocks advance accountable finality, then production quiesces).
 */
export class Proposer {
  private readonly publicKey: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly chain: Chain,
    private readonly mempool: Mempool,
    private readonly secretKey: string,
    private readonly broadcast: (block: Block) => void,
  ) {
    this.publicKey = ed25519PublicKeyFromSecret(secretKey);
  }

  get validatorPublicKey(): string {
    return this.publicKey;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const genesis = this.chain.genesis;
    const now = Date.now();
    const nextSlot = Math.max(slotOfTimestamp(genesis, now) + 1, 0);
    const delay = Math.max(slotStartTime(genesis, nextSlot) - now, 10);
    this.timer = setTimeout(() => {
      void this.onSlot(nextSlot).finally(() => this.scheduleNext());
    }, delay + 5); // small offset so Date.now() is past the slot boundary
  }

  private async onSlot(slot: number): Promise<void> {
    const genesis = this.chain.genesis;
    if (proposerForSlot(genesis, slot).publicKey !== this.publicKey) return;

    // Quiesce once every content-bearing block is finalized and nothing is pending.
    const contentIsFinal = this.chain.finalizedHeight() >= this.chain.contentHeight;
    if (this.mempool.size === 0 && contentIsFinal) return;

    const timestamp = slotStartTime(genesis, slot);
    const head = this.chain.headBlock;
    if (head && timestamp <= head.timestamp) return; // stale slot after a race

    const txs = await this.selectTxs(timestamp);
    if (txs.length === 0 && contentIsFinal) return;

    const block = buildBlock(
      {
        height: this.chain.height + 1,
        prevHash: this.chain.headBlockHash,
        timestamp,
        proposerPublicKey: this.publicKey,
        txs,
      },
      this.secretKey,
    );
    const result = await this.chain.addBlock(block);
    if (result.accepted) {
      this.mempool.prune();
      this.broadcast(block);
    } else {
      console.warn(`[proposer] own block rejected: ${result.reason}`);
    }
  }

  /**
   * Pick mempool txs that are valid against the head state AT the block
   * timestamp, respecting in-block conflict rules and the block byte budget.
   */
  private async selectTxs(blockTimestamp: number): Promise<Tx[]> {
    const selected: Tx[] = [];
    const seenTokens = new Map<string, Set<string>>();
    const seenCreates = new Set<string>();
    const seenModuli = new Set<string>();
    const seenCancels = new Set<string>();
    const seenCommits = new Set<string>();
    let bytes = 0;

    for (const tx of this.mempool.getAll()) {
      if (selected.length >= MAX_BLOCK_TXS) break;
      const result = await validateTx(this.chain.state, this.chain.genesis, tx, blockTimestamp);
      if (!result.ok) continue;

      if (tx.type === 'ELECTION_CREATE') {
        if (seenCreates.has(tx.election.electionId) || seenModuli.has(tx.election.credentialPublicKeyJwk.n)) continue;
      } else if (tx.type === 'ELECTION_CANCEL') {
        if (seenCancels.has(tx.electionId)) continue;
      } else if (tx.type === 'ISSUANCE_COMMIT') {
        if (seenCommits.has(tx.electionId)) continue;
      } else if (tx.type === 'VOTE_CAST') {
        const entry = this.chain.state.elections.get(tx.electionId);
        const allowRevote = entry?.definition.allowRevote ?? false;
        if (!allowRevote && seenTokens.get(tx.electionId)?.has(tx.token)) continue;
      }

      const txBytes = canonicalByteLength(tx);
      if (bytes + txBytes > BLOCK_BYTE_BUDGET) break;
      bytes += txBytes;
      selected.push(tx);

      if (tx.type === 'ELECTION_CREATE') {
        seenCreates.add(tx.election.electionId);
        seenModuli.add(tx.election.credentialPublicKeyJwk.n);
      } else if (tx.type === 'ELECTION_CANCEL') {
        seenCancels.add(tx.electionId);
      } else if (tx.type === 'ISSUANCE_COMMIT') {
        seenCommits.add(tx.electionId);
      } else if (tx.type === 'VOTE_CAST') {
        let tokens = seenTokens.get(tx.electionId);
        if (!tokens) {
          tokens = new Set();
          seenTokens.set(tx.electionId, tokens);
        }
        tokens.add(tx.token);
      }
    }
    return selected;
  }
}
