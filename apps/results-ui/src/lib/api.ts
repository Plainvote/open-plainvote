import { useEffect, useRef, useState } from 'react';
import { HttpError, type NodeClient, type NodeStatusInfo } from '@votechain/protocol';
import {
  describeNodeError,
  pickHealthyNode as pick,
  settingList,
  type HealthyNode,
} from '@plainvote/ui';

/**
 * The setting resolver and the record-keeper selection both moved to
 * @plainvote/ui. Each existed twice, once here and once in the voter app, and
 * the two copies of the selection had already drifted: this one had a probe
 * timeout and a sticky preference, the voter app's had neither.
 */
const env = (name: string): string | undefined => (import.meta.env as Record<string, string | undefined>)[name];

/** Record-keeper nodes this read-only app can talk to; the first healthy one wins. */
export const NODE_URLS: string[] = settingList(
  'NODE_URLS',
  'http://127.0.0.1:4001,http://127.0.0.1:4002,http://127.0.0.1:4003',
  env,
);

export type { HealthyNode };

/** Try the configured nodes and return the first that answers /status. */
export function pickHealthyNode(): Promise<HealthyNode> {
  // Reads are frequent here and a page re-renders on every chain tick, so the
  // probe stays short: a slow node should be stepped past, not waited on.
  return pick(NODE_URLS, { timeoutMs: 1500 });
}

export function describeError(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return describeNodeError(error);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

export interface QueryState<T> {
  data: T | null;
  /** /status of the node that served the last successful fetch. */
  nodeStatus: NodeStatusInfo | null;
  error: string | null;
  /** True when the last failure was an HTTP 404 (unknown id). */
  notFound: boolean;
  /** True only while the FIRST load is in flight — background refreshes are silent. */
  loading: boolean;
}

/**
 * Fetch through the first healthy node, refetching whenever `deps` change
 * (pages pass the WS/poll tick in). Keeps the last good data during
 * background refreshes so live updates never blank the page.
 */
export function useNodeQuery<T>(
  enabled: boolean,
  deps: readonly unknown[],
  fetcher: (client: NodeClient, status: NodeStatusInfo) => Promise<T>,
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>(() => ({
    data: null,
    nodeStatus: null,
    error: null,
    notFound: false,
    loading: enabled,
  }));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, nodeStatus: null, error: null, notFound: false, loading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: prev.data === null }));
    void (async () => {
      try {
        const picked = await pickHealthyNode();
        const data = await fetcherRef.current(picked.client, picked.status);
        if (!cancelled) {
          setState({ data, nodeStatus: picked.status, error: null, notFound: false, loading: false });
        }
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({
            data: prev.data,
            nodeStatus: prev.nodeStatus,
            error: describeError(error),
            notFound: isNotFound(error),
            loading: false,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // deps are supplied (and owned) by the caller — typically [tick, ...ids]
  }, [enabled, ...deps]);

  return state;
}
