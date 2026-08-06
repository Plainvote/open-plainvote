import { NodeClient, blockHash, type EquivocationRecord } from '@votechain/protocol';
import { NODE_URLS } from './api';

/**
 * Do the record-keepers agree?
 *
 * The page has always been able to ask this and never has: it queries one node
 * and presents whatever it says. Asking all of them is the single most
 * persuasive thing this app can do, and it costs one round of parallel fetches.
 *
 * Three things make the answer honest rather than decorative.
 *
 * **Compare at the finalized height, never at the head.** With short slots and
 * ordinary gossip lag, three honest nodes are at different heights almost all
 * the time. Comparing head hashes would raise an alarm on every page load and
 * teach the reader to ignore it. Finalized history is the part they are
 * obliged to agree on, so that is what gets compared.
 *
 * **Unreachable is not disagreement.** A node that is down, blocked by CORS, or
 * served over http from an https page produces the same bare TypeError as one
 * that is lying. Saying "2 of 3 answered, and they agree" is true; saying "one
 * disagrees" would not be.
 *
 * **A different chain id is the loudest possible result.** It does not mean the
 * nodes disagree about this election; it means one of them is not running this
 * election at all.
 */

export type NodeVerdict =
  | { url: string; state: 'agrees'; name: string; finalizedHeight: number; height: number }
  | { url: string; state: 'behind'; name: string; finalizedHeight: number; height: number }
  | { url: string; state: 'differs'; name: string; finalizedHeight: number; height: number; fingerprint: string }
  | { url: string; state: 'wrong-chain'; name: string; chainId: string }
  | { url: string; state: 'unreachable'; reason: string };

export interface AgreementReport {
  /** The height every responding node was compared at. */
  comparedAtHeight: number | null;
  /** Fingerprint of the agreed page, for a reader to check against elsewhere. */
  fingerprint: string | null;
  chainId: string | null;
  verdicts: NodeVerdict[];
  answered: number;
  agreeing: number;
  total: number;
  /** True only when every node that answered agrees and at least two did. */
  unanimous: boolean;
  /** Signed proof a record-keeper published two versions of one page. */
  equivocations: EquivocationRecord[];
}

const TIMEOUT_MS = 4000;

function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer in time')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function reasonFor(error: unknown, url: string): string {
  if (error instanceof TypeError) {
    // A browser on https will silently refuse a plain-http node. That is a
    // deployment mistake, not a dishonest record-keeper, and it is worth
    // naming because nothing else in the console explains it.
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://')) {
      return 'blocked: this page is secure but that address is not';
    }
    return 'could not be reached';
  }
  return error instanceof Error ? error.message : 'could not be reached';
}

/**
 * @param extraUrls record-keepers the reader supplied, which is what turns
 *   this from a claim by the site's operator into something they can check.
 */
export async function checkAgreement(extraUrls: string[] = []): Promise<AgreementReport> {
  const urls = [...new Set([...NODE_URLS, ...extraUrls])];

  const probes = await Promise.all(
    urls.map(async (url) => {
      try {
        const status = await timed(new NodeClient(url).status(), TIMEOUT_MS);
        return { url, status, error: null as unknown };
      } catch (error) {
        return { url, status: null, error };
      }
    }),
  );

  const live = probes.filter((p) => p.status !== null) as { url: string; status: NonNullable<(typeof probes)[number]['status']>; error: unknown }[];
  if (live.length === 0) {
    return {
      comparedAtHeight: null, fingerprint: null, chainId: null, answered: 0, agreeing: 0,
      total: urls.length, unanimous: false, equivocations: [],
      verdicts: probes.map((p) => ({ url: p.url, state: 'unreachable' as const, reason: reasonFor(p.error, p.url) })),
    };
  }

  // The majority chain id is taken as this deployment's; anything else is not
  // merely disagreeing, it is a different election system.
  const idCounts = new Map<string, number>();
  for (const p of live) idCounts.set(p.status.chainId, (idCounts.get(p.status.chainId) ?? 0) + 1);
  const chainId = [...idCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const onChain = live.filter((p) => p.status.chainId === chainId);
  const compareAt = Math.min(...onChain.map((p) => p.status.finalizedHeight));

  const verdicts: NodeVerdict[] = [];
  const fingerprints = new Map<string, string>();

  if (compareAt > 0) {
    await Promise.all(
      onChain.map(async (p) => {
        try {
          const block = await timed(new NodeClient(p.url).block(compareAt), TIMEOUT_MS);
          fingerprints.set(p.url, blockHash(block));
        } catch {
          /* Falls through to 'behind' below rather than being called a liar. */
        }
      }),
    );
  }

  const tallies = new Map<string, number>();
  for (const fp of fingerprints.values()) tallies.set(fp, (tallies.get(fp) ?? 0) + 1);
  const agreed = [...tallies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  for (const p of probes) {
    if (p.status === null) {
      verdicts.push({ url: p.url, state: 'unreachable', reason: reasonFor(p.error, p.url) });
      continue;
    }
    const name = p.status.nodeName;
    if (p.status.chainId !== chainId) {
      verdicts.push({ url: p.url, state: 'wrong-chain', name, chainId: p.status.chainId });
      continue;
    }
    const fp = fingerprints.get(p.url);
    const common = { url: p.url, name, finalizedHeight: p.status.finalizedHeight, height: p.status.height };
    if (fp === undefined) {
      verdicts.push({ ...common, state: 'behind' });
    } else if (agreed !== null && fp === agreed) {
      verdicts.push({ ...common, state: 'agrees' });
    } else {
      verdicts.push({ ...common, state: 'differs', fingerprint: fp });
    }
  }

  const agreeing = verdicts.filter((v) => v.state === 'agrees').length;
  const answered = verdicts.filter((v) => v.state !== 'unreachable').length;

  return {
    comparedAtHeight: compareAt > 0 ? compareAt : null,
    fingerprint: agreed,
    chainId,
    verdicts,
    answered,
    agreeing,
    total: urls.length,
    unanimous: agreeing >= 2 && agreeing === answered,
    equivocations: onChain.flatMap((p) => p.status.equivocations ?? []),
  };
}
