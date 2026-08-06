import { EventEmitter } from 'node:events';
import {
  applyBlock,
  blockHash,
  blockHeaderOf,
  createInitialState,
  finalityThreshold,
  validateBlock,
  type Block,
  type ChainState,
  type EquivocationRecord,
  type Genesis,
  type TxLocation,
} from '@votechain/protocol';
import type { BlockStore } from './blockStore';

export interface AddBlockResult {
  accepted: boolean;
  isNew: boolean;
  newHead: boolean;
  reorg: boolean;
  reason?: string;
}

export interface HeadEvent {
  block: Block;
  height: number;
  headHash: string;
  reorg: boolean;
}

/**
 * Block tree + fork choice + state management.
 *
 * Invariant: every block in the tree was fully validated against the state at
 * its parent when it was inserted. Fork choice: greatest height, tie-break
 * lowest block hash. On reorg the head state is rebuilt by replaying the new
 * best branch from genesis (cheap at this chain's scale, trivially correct).
 *
 * Finality (accountable): a block is final once floor(n/2)+1 DISTINCT
 * validators have proposed blocks in the chain from it to the head (inclusive)
 * — two conflicting finalized branches would require a validator to sign two
 * blocks for the same slot, which is recorded as equivocation evidence.
 */
export class Chain {
  private readonly blocksByHash = new Map<string, Block>();
  private readonly childrenByPrev = new Map<string, string[]>();
  private readonly byProposerSlot = new Map<string, string[]>();
  private headHash: string | null = null;
  /** best chain, ascending by height (index = height - 1) */
  private bestBlocks: Block[] = [];
  /** height of the last best-chain block that carries transactions */
  private _contentHeight = 0;
  /** state at head */
  state: ChainState;
  readonly equivocations: EquivocationRecord[] = [];
  private readonly emitter = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly genesis: Genesis,
    readonly chainId: string,
    private readonly store?: BlockStore,
  ) {
    this.state = createInitialState(chainId);
  }

  get height(): number {
    return this.bestBlocks.length;
  }

  get headBlockHash(): string {
    return this.headHash ?? this.chainId;
  }

  get headBlock(): Block | null {
    return this.bestBlocks[this.bestBlocks.length - 1] ?? null;
  }

  /**
   * Height of the last block with transactions. Proposers keep producing
   * (empty heartbeat) blocks until this is finalized, then quiesce — so all
   * content reaches finality without the chain growing forever.
   */
  get contentHeight(): number {
    return this._contentHeight;
  }

  onHead(listener: (e: HeadEvent) => void): void {
    this.emitter.on('head', listener);
  }

  /** Best-chain slice, ascending, starting at `fromHeight` (1-based). */
  bestChainSlice(fromHeight: number, limit: number): Block[] {
    const start = Math.max(0, fromHeight - 1);
    return this.bestBlocks.slice(start, start + limit);
  }

  blockAtHeight(height: number): Block | undefined {
    return this.bestBlocks[height - 1];
  }

  getBlock(hash: string): Block | undefined {
    return this.blocksByHash.get(hash);
  }

  getTxLocation(hash: string): TxLocation | undefined {
    return this.state.txLocations.get(hash);
  }

  finalizedHeight(): number {
    const threshold = finalityThreshold(this.genesis);
    const distinct = new Set<string>();
    for (let i = this.bestBlocks.length - 1; i >= 0; i--) {
      distinct.add(this.bestBlocks[i]!.proposer);
      if (distinct.size >= threshold) return this.bestBlocks[i]!.height;
    }
    return 0;
  }

  async loadFromStore(): Promise<number> {
    if (!this.store) return 0;
    let loaded = 0;
    for (const block of this.store.loadAll()) {
      // Re-validate everything on boot — a tampered blocks.jsonl line is
      // rejected here (and its descendants fall off as unknown-parent).
      const result = await this.addBlock(block, { skipStore: true, skipClockCheck: true });
      if (result.accepted) loaded++;
      else console.warn(`[chain] rejected stored block at height ${block.height}: ${result.reason}`);
    }
    return loaded;
  }

  /** Serialized: concurrent calls (p2p, proposer, API) run one at a time. */
  addBlock(block: Block, opts: { skipStore?: boolean; skipClockCheck?: boolean } = {}): Promise<AddBlockResult> {
    const run = this.queue.then(() => this.addBlockInner(block, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async addBlockInner(
    block: Block,
    opts: { skipStore?: boolean; skipClockCheck?: boolean },
  ): Promise<AddBlockResult> {
    const hash = blockHash(block);
    if (this.blocksByHash.has(hash)) {
      return { accepted: true, isNew: false, newHead: false, reorg: false };
    }

    const parent: Block | null =
      block.prevHash === this.chainId ? null : (this.blocksByHash.get(block.prevHash) ?? null);
    if (block.prevHash !== this.chainId && parent === null) {
      return { accepted: false, isNew: false, newHead: false, reorg: false, reason: 'unknown parent' };
    }

    // State at the parent: fast path when extending the current head,
    // otherwise replay the (already-validated) branch from genesis.
    const extendsHead = (parent === null && this.headHash === null) || (parent !== null && blockHash(parent) === this.headHash);
    const stateAtParent = extendsHead ? this.state : this.rebuildStateTo(parent);

    const result = await validateBlock(stateAtParent, this.genesis, block, parent ? blockHeaderOf(parent) : null, {
      ...(opts.skipClockCheck ? {} : { localNowMs: Date.now() }),
    });
    if (!result.ok) {
      return { accepted: false, isNew: false, newHead: false, reorg: false, reason: result.reason };
    }

    // Insert into the tree.
    this.blocksByHash.set(hash, block);
    const siblings = this.childrenByPrev.get(block.prevHash);
    if (siblings) siblings.push(hash);
    else this.childrenByPrev.set(block.prevHash, [hash]);
    if (!opts.skipStore) this.store?.append(block);

    // Equivocation detection: same proposer signing two blocks for one slot.
    const slotKey = `${block.proposer}|${block.timestamp}`;
    const sameSlot = this.byProposerSlot.get(slotKey);
    if (sameSlot) {
      sameSlot.push(hash);
      this.equivocations.push({ height: block.height, proposer: block.proposer, blockHashes: [...sameSlot] });
      console.warn(`[chain] EQUIVOCATION: ${block.proposer} signed ${sameSlot.length} blocks for slot at ${block.timestamp}`);
    } else {
      this.byProposerSlot.set(slotKey, [hash]);
    }

    // Fork choice: does the new block beat the current head?
    const head = this.headBlock;
    const beatsHead = !head || block.height > head.height || (block.height === head.height && hash < blockHash(head));
    if (!beatsHead) {
      return { accepted: true, isNew: true, newHead: false, reorg: false };
    }

    let reorg = false;
    if (extendsHead) {
      applyBlock(this.state, block);
      this.bestBlocks.push(block);
      if (block.txs.length > 0) this._contentHeight = block.height;
    } else {
      // Reorg: rebuild state along the new best branch.
      this.state = this.rebuildStateTo(block);
      this.bestBlocks = this.branchTo(block);
      this._contentHeight = 0;
      for (let i = this.bestBlocks.length - 1; i >= 0; i--) {
        if (this.bestBlocks[i]!.txs.length > 0) {
          this._contentHeight = this.bestBlocks[i]!.height;
          break;
        }
      }
      reorg = true;
    }
    this.headHash = hash;
    this.emitter.emit('head', { block, height: block.height, headHash: hash, reorg } satisfies HeadEvent);
    return { accepted: true, isNew: true, newHead: true, reorg };
  }

  /** Ancestor path from genesis to `tip` (inclusive), ascending. */
  private branchTo(tip: Block): Block[] {
    const branch: Block[] = [];
    let current: Block | undefined = tip;
    while (current) {
      branch.push(current);
      current = current.prevHash === this.chainId ? undefined : this.blocksByHash.get(current.prevHash);
    }
    branch.reverse();
    return branch;
  }

  private rebuildStateTo(tip: Block | null): ChainState {
    const state = createInitialState(this.chainId);
    if (!tip) return state;
    for (const block of this.branchTo(tip)) applyBlock(state, block);
    return state;
  }
}
