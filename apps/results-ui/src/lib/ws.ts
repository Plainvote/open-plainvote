import { useEffect, useState } from 'react';
import { NODE_URLS } from './api';

const RECONNECT_DELAY_MS = 3000;
const FALLBACK_POLL_MS = 10_000;

export interface ChainTick {
  /** Increments on every new head (and on the fallback poll) — use in effect deps. */
  tick: number;
  /** True while a node's /ws head stream is connected. */
  connected: boolean;
  /** Chain height reported by the most recent WS message, if any. */
  wsHeight: number | null;
}

function wsUrl(nodeUrl: string): string {
  return nodeUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
}

/**
 * Live-update hook: subscribes to a chain node's WebSocket head stream
 * ({type:'hello'|'head', height, ...}) and bumps `tick` on every new block.
 * Reconnects 3s after a drop (rotating through the configured nodes) and
 * keeps a 10s poll tick as a fallback so pages refresh even with no socket.
 */
export function useChainTick(): ChainTick {
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [wsHeight, setWsHeight] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let urlIndex = 0;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = () => {
      if (disposed || NODE_URLS.length === 0) return;
      const url = NODE_URLS[urlIndex % NODE_URLS.length];
      urlIndex += 1; // next attempt tries the next node
      if (url === undefined) return;
      try {
        socket = new WebSocket(wsUrl(url));
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        if (!disposed) setConnected(true);
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(String(event.data)) as { type?: unknown; height?: unknown };
          if (message.type === 'head' || message.type === 'hello') {
            if (typeof message.height === 'number') setWsHeight(message.height);
            setTick((t) => t + 1);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        scheduleReconnect();
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    const poll = setInterval(() => {
      if (!disposed) setTick((t) => t + 1);
    }, FALLBACK_POLL_MS);

    return () => {
      disposed = true;
      clearInterval(poll);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (socket !== null) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, []);

  return { tick, connected, wsHeight };
}
