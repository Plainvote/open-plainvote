import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHashLocation } from '../src/lib/hashRouter';
import { resolveSetting, settingList, settingOr } from '../src/lib/config';
import { describeNodeError, pickHealthyNode, resetNodePreference, withTimeout } from '../src/lib/nodes';
import type { NodeStatusInfo } from '@votechain/protocol';

/**
 * The pure half of the shared package. The React hooks are exercised in a
 * browser against the running apps, where hashchange and focus actually
 * happen; asserting them here would mean adding jsdom for coverage a real
 * browser already provides.
 *
 * The node-picking tests matter most: that code existed twice and had already
 * drifted, and the timeout is the part the voter app was missing.
 */

const noEnv = () => undefined;

afterEach(() => {
  resetNodePreference();
  vi.unstubAllGlobals();
});

describe('parsing a hash location', () => {
  it('splits path segments and decodes them', () => {
    expect(parseHashLocation('#/vote/abc%20def/review').segments).toEqual(['vote', 'abc def', 'review']);
  });

  it('treats an empty or bare hash as the root', () => {
    expect(parseHashLocation('').segments).toEqual([]);
    expect(parseHashLocation('#').segments).toEqual([]);
    expect(parseHashLocation('#/').segments).toEqual([]);
  });

  it('tolerates extra slashes rather than inventing empty segments', () => {
    expect(parseHashLocation('#///record//').segments).toEqual(['record']);
  });

  it('keeps a query string out of the segments', () => {
    const loc = parseHashLocation('#/verify?token=abc&x=1');
    expect(loc.segments).toEqual(['verify']);
    expect(loc.query.get('token')).toBe('abc');
  });

  it('treats a hand-off fragment as one unrecognized segment, not a crash', () => {
    // The voter app is handed a code as `#code=VC-…`. That is not a route, and
    // what matters is that it parses to something an app can fall back on
    // rather than throwing or being mistaken for a path.
    const loc = parseHashLocation('#code=VC-ABCDE-FGHIJ-KLMNO-PQRST');
    expect(loc.segments).toEqual(['code=VC-ABCDE-FGHIJ-KLMNO-PQRST']);
    expect(loc.segments[0]).not.toBe('vote');
  });

  it('does not throw on a malformed escape', () => {
    // A truncated percent-escape would make decodeURIComponent throw and take
    // the whole page with it.
    expect(() => parseHashLocation('#/vote/%E0%A4%A')).not.toThrow();
    expect(parseHashLocation('#/vote/%E0%A4%A').segments).toEqual(['vote', '%E0%A4%A']);
  });
});

describe('resolving a setting', () => {
  it('prefers runtime config over the build-time env', () => {
    vi.stubGlobal('window', { __PLAINVOTE_CONFIG__: { NODE_URLS: 'https://runtime' } });
    expect(resolveSetting('NODE_URLS', () => 'https://built')).toBe('https://runtime');
  });

  it('falls through to the env, then to the default', () => {
    vi.stubGlobal('window', {});
    expect(settingOr('NODE_URLS', 'https://default', (n) => (n === 'VITE_NODE_URLS' ? 'https://built' : undefined)))
      .toBe('https://built');
    expect(settingOr('NODE_URLS', 'https://default', noEnv)).toBe('https://default');
  });

  it('ignores a blank runtime value instead of treating it as set', () => {
    // A static server that injects an empty placeholder must not blank out a
    // perfectly good build-time value.
    vi.stubGlobal('window', { __PLAINVOTE_CONFIG__: { NODE_URLS: '   ' } });
    expect(settingOr('NODE_URLS', 'https://default', () => 'https://built')).toBe('https://built');
  });

  it('splits and cleans a comma-separated list', () => {
    vi.stubGlobal('window', {});
    expect(settingList('NODE_URLS', ' a , ,b,, c ', noEnv)).toEqual(['a', 'b', 'c']);
  });
});

describe('picking a record-keeper', () => {
  const status = (name: string) => ({ nodeName: name }) as unknown as NodeStatusInfo;

  it('returns the first that answers', async () => {
    const picked = await pickHealthyNode(['http://a', 'http://b'], { probe: async (u) => status(u) });
    expect(picked.url).toBe('http://a');
  });

  it('falls past one that is down', async () => {
    const picked = await pickHealthyNode(['http://down', 'http://up'], {
      probe: async (u) => {
        if (u === 'http://down') throw new TypeError('failed to fetch');
        return status(u);
      },
    });
    expect(picked.url).toBe('http://up');
  });

  it('does not hang on a node that accepts and never answers', async () => {
    // The case the voter app had no defence against: a connection that opens
    // and then goes quiet would have left a voter waiting mid-ballot.
    const picked = await pickHealthyNode(['http://silent', 'http://up'], {
      timeoutMs: 30,
      probe: async (u) => (u === 'http://silent' ? new Promise<NodeStatusInfo>(() => {}) : status(u)),
    });
    expect(picked.url).toBe('http://up');
  });

  it('remembers which one answered and starts there next time', async () => {
    const tried: string[] = [];
    const probe = async (u: string) => {
      tried.push(u);
      if (u === 'http://a') throw new Error('down');
      return status(u);
    };
    await pickHealthyNode(['http://a', 'http://b'], { probe });
    tried.length = 0;
    await pickHealthyNode(['http://a', 'http://b'], { probe });
    expect(tried[0]).toBe('http://b');
  });

  it('reports when nothing answers rather than resolving with nothing', async () => {
    await expect(
      pickHealthyNode(['http://a'], { probe: async () => { throw new Error('down'); } }),
    ).rejects.toThrow('down');
  });

  it('says so when none are configured at all', async () => {
    await expect(pickHealthyNode([])).rejects.toThrow(/no record-keepers are configured/);
  });
});

describe('withTimeout', () => {
  it('passes a value through', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it('rejects when the promise never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow(/no answer within/);
  });
});

describe('describing a node failure', () => {
  it('names mixed content, which nothing else in the browser reports usefully', () => {
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    expect(describeNodeError(new TypeError('failed to fetch'), 'http://insecure')).toMatch(/secure/);
  });

  it('does not blame mixed content when the page is not secure', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    const message = describeNodeError(new TypeError('failed to fetch'), 'http://plain');
    expect(message).toMatch(/no record-keeper could be reached/);
    expect(message).not.toMatch(/secure/);
  });
});
