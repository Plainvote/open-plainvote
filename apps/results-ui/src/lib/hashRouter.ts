import { navigateHash, parseHashLocation, useHashLocation } from '@plainvote/ui';

/**
 * Views this app can render; unknown hashes fall back to the elections list.
 *
 * The internal names stay technical (`block`, `tx`) because they mirror the
 * protocol types. The URLs and every visible label use the reader-facing
 * vocabulary instead: the record is a numbered sequence of PAGES, and each
 * page holds ENTRIES (a ballot, a new election, an issuance commitment).
 *
 * The hash plumbing moved to @plainvote/ui; this file is now just the route
 * table, which is the part that is genuinely this app's own.
 */
export type Page = 'elections' | 'election' | 'explorer' | 'block' | 'tx' | 'verify' | 'audit';

export interface RouteParams {
  electionId?: string;
  token?: string;
  height?: number;
  hash?: string;
}

export interface Route {
  page: Page;
  params: RouteParams;
}

export function routeFromSegments(segments: readonly string[]): Route {
  const [head, first, second] = segments;
  switch (head) {
    case undefined:
      return { page: 'elections', params: {} };
    case 'election':
      return first !== undefined
        ? { page: 'election', params: { electionId: first } }
        : { page: 'elections', params: {} };
    case 'record':
      return { page: 'explorer', params: {} };
    case 'page':
      return { page: 'block', params: { height: first !== undefined ? Number(first) : Number.NaN } };
    case 'entry':
      return first !== undefined ? { page: 'tx', params: { hash: first } } : { page: 'explorer', params: {} };
    case 'verify':
      return first !== undefined && second !== undefined
        ? { page: 'verify', params: { electionId: first, token: second } }
        : { page: 'verify', params: {} };
    case 'audit':
      return { page: 'audit', params: {} };
    default:
      return { page: 'elections', params: {} };
  }
}

/** Parse a location.hash value like "#/election/abc" or "#/page/12". */
export function parseHash(rawHash: string): Route {
  return routeFromSegments(parseHashLocation(rawHash).segments);
}

/** Programmatic navigation; plain <a href="#/..."> links work just as well. */
export function navigate(hash: string): void {
  navigateHash(hash);
}

/** Current route, re-parsed on every hashchange. */
export function useHashRoute(): Route {
  return routeFromSegments(useHashLocation().segments);
}
