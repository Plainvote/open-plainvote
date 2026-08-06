import { navigateHash, parseHashLocation, replaceHash, useHashLocation } from '@plainvote/ui';

/**
 * The voter flow's routes.
 *
 * The hash plumbing (splitting segments, re-reading on change, navigating with
 * or without a history entry) lives in @plainvote/ui. What stays here is this
 * app's own route table, because the three apps' routes genuinely differ and
 * forcing one model on all of them would be a worse abstraction than the
 * duplication it removed.
 *
 * **Nothing secret goes in a URL.** Not the voting code, not the ballot token.
 * An election id is public and already in the record, so it is safe; the token
 * is public too, but a URL carrying it lands in browser history and profile
 * sync, where a shared screen or a later reader finds it. The receipt route
 * therefore addresses an election, and the screen resolves the newest local
 * receipt for it.
 */

export type Route =
  | { name: 'code' }
  | { name: 'elections' }
  | { name: 'ballot'; electionId: string }
  | { name: 'review'; electionId: string }
  | { name: 'receipt'; electionId: string };

export function routeFromSegments(segments: readonly string[]): Route {
  const [head, first, second] = segments;
  if (head === undefined) return { name: 'code' };
  if (head === 'elections') return { name: 'elections' };
  if (head === 'vote' && first !== undefined) {
    return second === 'review' ? { name: 'review', electionId: first } : { name: 'ballot', electionId: first };
  }
  if (head === 'receipt' && first !== undefined) return { name: 'receipt', electionId: first };
  // Anything unrecognized starts at the beginning rather than showing nothing.
  return { name: 'code' };
}

/** Exported so the route table can be tested without a browser. */
export function parseRoute(hash: string): Route {
  return routeFromSegments(parseHashLocation(hash).segments);
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'code':
      return '#/';
    case 'elections':
      return '#/elections';
    case 'ballot':
      return `#/vote/${encodeURIComponent(route.electionId)}`;
    case 'review':
      return `#/vote/${encodeURIComponent(route.electionId)}/review`;
    case 'receipt':
      return `#/receipt/${encodeURIComponent(route.electionId)}`;
  }
}

/**
 * `replace` for transitions the voter must not be able to go back into: after
 * a ballot is cast, the review it came from is spent.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = hrefFor(route);
  if (options.replace === true) replaceHash(href);
  else navigateHash(href);
}

export function useRoute(): Route {
  return routeFromSegments(useHashLocation().segments);
}
