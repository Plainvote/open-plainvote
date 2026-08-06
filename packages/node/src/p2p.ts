import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { blockHash, txHash, type Block, type Tx } from '@votechain/protocol';
import type { Chain } from './chain';
import type { Mempool } from './mempool';

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const SYNC_BATCH = 500;
const SYNC_OVERLAP = 32;
const RECONNECT_MS = 5_000;

type P2PMessage =
  | { type: 'hello'; chainId: string; height: number; headHash: string }
  | { type: 'tx'; tx: Tx }
  | { type: 'block'; block: Block }
  | { type: 'getBlocks'; fromHeight: number }
  | { type: 'blocks'; blocks: Block[] };

/** Bounded remember-set so gossip never re-floods known items. */
class SeenSet {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.order.push(key);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }
}

/**
 * Flood-gossip mesh over WebSocket. Verify-before-relay: transactions and
 * blocks are only forwarded after this node accepted them, so invalid data is
 * never amplified. Sync-on-connect: a behind node requests batches from a
 * peer's best chain (with overlap, so short forks resolve).
 */
export class P2PNetwork {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private readonly peers = new Set<WebSocket>();
  private readonly seenTxs = new SeenSet(20_000);
  private readonly seenBlocks = new SeenSet(20_000);
  private stopped = false;

  constructor(
    private readonly chain: Chain,
    private readonly mempool: Mempool,
    private readonly peerUrls: string[],
    private readonly nodeName: string,
  ) {}

  get peerCount(): number {
    return this.peers.size;
  }

  /** Handle an HTTP upgrade for the /p2p path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.setupPeer(ws));
  }

  connectToPeers(): void {
    for (const url of this.peerUrls) {
      this.connectLoop(url.replace(/^http/, 'ws').replace(/\/$/, '') + '/p2p');
    }
  }

  stop(): void {
    this.stopped = true;
    for (const ws of this.peers) ws.close();
    this.wss.close();
  }

  private connectLoop(wsUrl: string): void {
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl, { maxPayload: MAX_PAYLOAD_BYTES });
    ws.on('open', () => this.setupPeer(ws));
    ws.on('error', () => {
      /* handled by close */
    });
    ws.on('close', () => {
      this.peers.delete(ws);
      if (!this.stopped) setTimeout(() => this.connectLoop(wsUrl), RECONNECT_MS);
    });
  }

  private setupPeer(ws: WebSocket): void {
    this.peers.add(ws);
    ws.on('message', (data) => {
      void this.handleMessage(ws, data as Buffer).catch((e) => {
        console.warn(`[p2p:${this.nodeName}] dropping misbehaving peer: ${(e as Error).message}`);
        ws.close();
      });
    });
    ws.on('close', () => this.peers.delete(ws));
    ws.on('error', () => this.peers.delete(ws));
    this.send(ws, { type: 'hello', chainId: this.chain.chainId, height: this.chain.height, headHash: this.chain.headBlockHash });
  }

  private send(ws: WebSocket, message: P2PMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: P2PMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers) {
      if (peer !== exclude && peer.readyState === WebSocket.OPEN) peer.send(payload);
    }
  }

  broadcastTx(tx: Tx): void {
    this.seenTxs.add(txHash(tx));
    this.broadcast({ type: 'tx', tx });
  }

  broadcastBlock(block: Block): void {
    this.seenBlocks.add(blockHash(block));
    this.broadcast({ type: 'block', block });
  }

  private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const message = JSON.parse(data.toString('utf8')) as P2PMessage;
    switch (message.type) {
      case 'hello': {
        if (message.chainId !== this.chain.chainId) {
          console.warn(`[p2p:${this.nodeName}] peer on different chain — disconnecting`);
          ws.close();
          return;
        }
        if (message.height > this.chain.height) {
          this.send(ws, { type: 'getBlocks', fromHeight: Math.max(1, this.chain.height - SYNC_OVERLAP) });
        }
        return;
      }
      case 'tx': {
        const hash = txHash(message.tx);
        if (this.seenTxs.has(hash)) return;
        this.seenTxs.add(hash);
        const result = await this.mempool.admit(message.tx);
        if (result.accepted && result.isNew) {
          this.broadcast({ type: 'tx', tx: message.tx }, ws);
        }
        return;
      }
      case 'block': {
        const hash = blockHash(message.block);
        if (this.seenBlocks.has(hash)) return;
        this.seenBlocks.add(hash);
        const result = await this.chain.addBlock(message.block);
        if (result.accepted && result.isNew) {
          this.mempool.prune();
          this.broadcast({ type: 'block', block: message.block }, ws);
        } else if (result.reason === 'unknown parent') {
          this.send(ws, { type: 'getBlocks', fromHeight: Math.max(1, this.chain.height - SYNC_OVERLAP) });
        }
        return;
      }
      case 'getBlocks': {
        const from = Number.isSafeInteger(message.fromHeight) ? Math.max(1, message.fromHeight) : 1;
        this.send(ws, { type: 'blocks', blocks: this.chain.bestChainSlice(from, SYNC_BATCH) });
        return;
      }
      case 'blocks': {
        if (!Array.isArray(message.blocks) || message.blocks.length > SYNC_BATCH) return;
        let progressed = false;
        for (const block of message.blocks) {
          const result = await this.chain.addBlock(block);
          if (result.accepted && result.isNew) progressed = true;
        }
        if (progressed) {
          this.mempool.prune();
          // keep pulling if the batch was full
          if (message.blocks.length === SYNC_BATCH) {
            this.send(ws, { type: 'getBlocks', fromHeight: this.chain.height + 1 });
          }
        }
        return;
      }
    }
  }
}
