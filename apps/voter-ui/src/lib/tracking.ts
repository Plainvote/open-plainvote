import { NodeClient, type VoteLookupRecord } from '@votechain/protocol';
import { NODE_URLS } from './config';

/**
 * Where a ballot actually is, asked of every record-keeper.
 *
 * The receipt used to describe the ballot's whereabouts from a single node's
 * answer, and to claim it had been "sent to all N record-keepers" from the
 * length of the configured list. Neither is something we know.
 *
 * What the submission responses tell us is especially misleading: a node that
 * answers 409 has *already got* the ballot by gossip, and is counted as a
 * refusal, while a node that accepts into its mempool may still drop it. The
 * only honest question is the one asked afterwards, of each of them: do you
 * have this ballot, and where did you put it.
 *
 * That is also the property worth showing a voter. One record-keeper saying
 * "recorded" is a promise. Three saying it independently is the thing that
 * makes a ballot hard to quietly lose.
 */

export type KeeperState =
  /** Answered, and holds this exact ballot. */
  | { url: string; name: string; state: 'has'; blockHeight: number; counted: boolean }
  /** Answered, but has not seen it yet. Normal for a few seconds after casting. */
  | { url: string; name: string; state: 'not-yet' }
  /** Did not answer. A browser cannot tell "down" from "hiding it". */
  | { url: string; state: 'unreachable' };

export interface BallotWhereabouts {
  keepers: KeeperState[];
  /** Record-keepers that answered at all. */
  answered: number;
  /** Record-keepers that confirm they hold this ballot. */
  holding: number;
  total: number;
  /** Lowest page number any record-keeper filed it on. */
  blockHeight: number | null;
  /** True once at least one record-keeper reports the ballot settled. */
  isFinal: boolean;
  /** True when a later ballot from the same voter replaced this one. */
  superseded: boolean;
}

const TIMEOUT_MS = 5000;

function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer in time')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function trackBallot(args: {
  electionId: string;
  token: string;
  txHash: string;
}): Promise<BallotWhereabouts> {
  const results = await Promise.all(
    NODE_URLS.map(async (url): Promise<KeeperState & { mine?: VoteLookupRecord; final?: boolean }> => {
      try {
        const client = new NodeClient(url);
        // Two calls: who this record-keeper is, and what it holds for the token.
        const [status, lookup] = await Promise.all([
          timed(client.status(), TIMEOUT_MS),
          timed(client.voteLookup(args.electionId, args.token), TIMEOUT_MS),
        ]);
        const mine = lookup.records.find((r) => r.txHash === args.txHash);
        if (mine === undefined) {
          return { url, name: status.nodeName, state: 'not-yet' };
        }
        return {
          url,
          name: status.nodeName,
          state: 'has',
          blockHeight: mine.blockHeight,
          counted: mine.counted,
          mine,
          final: lookup.isFinal,
        };
      } catch {
        return { url, state: 'unreachable' };
      }
    }),
  );

  const keepers: KeeperState[] = results.map((r) =>
    r.state === 'has'
      ? { url: r.url, name: r.name, state: 'has', blockHeight: r.blockHeight, counted: r.counted }
      : r.state === 'not-yet'
        ? { url: r.url, name: r.name, state: 'not-yet' }
        : { url: r.url, state: 'unreachable' },
  );

  const holders = results.filter((r) => r.state === 'has');
  const heights = holders.map((r) => (r.state === 'has' ? r.blockHeight : 0)).filter((h) => h > 0);

  return {
    keepers,
    answered: keepers.filter((k) => k.state !== 'unreachable').length,
    holding: holders.length,
    total: NODE_URLS.length,
    blockHeight: heights.length > 0 ? Math.min(...heights) : null,
    isFinal: results.some((r) => r.final === true),
    // `counted: false` on a held ballot means a later one from the same voter
    // took its place, which is a normal outcome of revoting, not a failure.
    superseded: holders.length > 0 && holders.every((r) => r.state === 'has' && !r.counted),
  };
}

export function keeperLabel(k: KeeperState): string {
  switch (k.state) {
    case 'has':
      return `has it, page ${k.blockHeight}`;
    case 'not-yet':
      return 'not yet';
    case 'unreachable':
      return 'no answer';
  }
}

export function keeperName(k: KeeperState): string {
  return 'name' in k ? k.name : hostOf(k.url);
}
