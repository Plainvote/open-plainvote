import { useEffect, useState } from 'react';

/**
 * Hash-routing plumbing, without the route table.
 *
 * Three apps had a hash router and all three parsed the location differently,
 * because their routes genuinely differ: the results app has a typed page
 * union, the console has generic path segments and a query string, the voter
 * flow has an ordered set of steps. Forcing one route model on all three would
 * be a worse abstraction than the duplication.
 *
 * What they actually shared was the mechanism: split the hash into segments,
 * re-read it on `hashchange`, and navigate with or without a history entry.
 * That is what lives here. Each app keeps its own small, typed parse on top,
 * where the vocabulary belongs.
 *
 * Hash routing rather than history routing so a built bundle can be served
 * from any path by any static host with no server rewrites.
 */

export interface HashLocation {
  /** Path segments, already percent-decoded. `#/vote/abc` -> ['vote', 'abc']. */
  segments: string[];
  query: URLSearchParams;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not worth throwing a whole page away for.
    return segment;
  }
}

/** Pure: exported so each app can unit-test its own route table against it. */
export function parseHashLocation(rawHash: string): HashLocation {
  const withoutHash = rawHash.replace(/^#/, '');
  const [pathPart, queryPart] = withoutHash.split('?');
  const segments = (pathPart ?? '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
  return { segments, query: new URLSearchParams(queryPart ?? '') };
}

/** Push a history entry, so Back returns to where the reader was. */
export function navigateHash(to: string): void {
  const next = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === next) return;
  window.location.hash = next.slice(1);
}

/**
 * Navigate WITHOUT a history entry.
 *
 * For transitions the reader must not be able to go back into: a cast ballot
 * whose ballot page is now spent, or a token scrubbed out of a sign-in URL.
 * `replaceState` does not emit `hashchange`, so it is dispatched by hand or
 * nothing re-renders.
 */
export function replaceHash(to: string): void {
  const next = to.startsWith('#') ? to : `#${to}`;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** The current hash location, re-read on every change. */
export function useHashLocation(): HashLocation {
  const [location, setLocation] = useState<HashLocation>(() => parseHashLocation(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setLocation(parseHashLocation(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return location;
}
