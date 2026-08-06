import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HeadEvent } from './chain';

/**
 * Push channel for UIs (/ws): a hello on connect, then one message per head
 * change. Clients refetch REST endpoints when they hear a head event.
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly chainId: string,
    private readonly currentHead: () => { height: number; headHash: string },
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      const { height, headHash } = this.currentHead();
      ws.send(JSON.stringify({ type: 'hello', chainId: this.chainId, height, headHash }));
    });
  }

  broadcastHead(event: HeadEvent): void {
    const payload = JSON.stringify({
      type: 'head',
      height: event.height,
      headHash: event.headHash,
      reorg: event.reorg,
      timestamp: event.block.timestamp,
      txCount: event.block.txs.length,
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  close(): void {
    for (const ws of this.clients) ws.close();
    this.wss.close();
  }
}
