import { NodeClient, type NodeStatusInfo } from '@votechain/protocol';

/**
 * Choosing a record-keeper to read from.
 *
 * There were two of these, and they had already drifted apart: the results app
 * had a probe timeout and remembered which node answered last, the voter app
 * had neither. The voter app is the one where the difference matters most,
 * because a record-keeper that accepts a connection and then never replies
 * would hang a voter mid-ballot with no timeout to fall past.
 *
 * This is the union of the two, which is to say the better one, in one place.
 *
 * Note what this is NOT for: submitting a ballot goes to every record-keeper
 * at once (see allNodeClients), so that no single one can quietly drop it.
 * Picking one is only ever for reading.
 */

export interface HealthyNode {
  client: NodeClient;
  status: NodeStatusInfo;
  url: string;
}

export type StatusProbe = (url: string) => Promise<NodeStatusInfo>;

const DEFAULT_TIMEOUT_MS = 4000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Sticky preference: start at whichever node answered last so a page making
 * several reads does not keep paying for a dead node at the front of the list.
 * Module-level and per-app-bundle, which is the right lifetime.
 */
let preferredIndex = 0;

/** Reset between tests; not used by app code. */
export function resetNodePreference(): void {
  preferredIndex = 0;
}

export async function pickHealthyNode(
  urls: readonly string[],
  options: { timeoutMs?: number; probe?: StatusProbe } = {},
): Promise<HealthyNode> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe: StatusProbe = options.probe ?? ((url) => new NodeClient(url).status());

  if (urls.length === 0) throw new Error('no record-keepers are configured for this site');

  let lastError: unknown;
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const index = (preferredIndex + attempt) % urls.length;
    const url = urls[index];
    if (url === undefined) continue;
    try {
      const status = await withTimeout(probe(url), timeoutMs);
      preferredIndex = index;
      return { client: new NodeClient(url), status, url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no record-keeper could be reached');
}

/** Every record-keeper, for writes that must not depend on one of them. */
export function allNodeClients(urls: readonly string[]): NodeClient[] {
  return urls.map((url) => new NodeClient(url));
}

/**
 * An error a reader can act on.
 *
 * A bare `TypeError` from fetch means the request never completed, which in a
 * browser covers a node being down, DNS failing, CORS refusing, and a secure
 * page refusing to call an insecure address. Naming the last one matters
 * because it is a deployment mistake nothing else reports.
 */
export function describeNodeError(error: unknown, url?: string): string {
  if (error instanceof TypeError) {
    if (
      url !== undefined &&
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      url.startsWith('http://')
    ) {
      return 'blocked: this page is secure but that record-keeper address is not';
    }
    return 'no record-keeper could be reached';
  }
  return error instanceof Error ? error.message : String(error);
}
