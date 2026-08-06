import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dark, light, type ModeTokens } from '../src/tokens';

/**
 * apps/site/index.html cannot import anything: it is a single no-build static
 * file (the serve-time config injection depends on that). It mirrors the
 * palette by hand in TWO scopes: :root is the paper half, .inked is the ink
 * half. There is no dark mode on the landing page; the two halves are one
 * fixed composition, and this test is what keeps both mirrors honest.
 */

const ROOT = join(__dirname, '..', '..', '..');
const html = readFileSync(join(ROOT, 'apps', 'site', 'index.html'), 'utf8');

/** site var name -> theme token key, for the tokens the site shares. */
const MAP: Record<string, keyof ModeTokens> = {
  paper: 'bg',
  panel: 'surface',
  ink: 'text',
  muted: 'muted',
  rule: 'border',
  'rule-strong': 'borderStrong',
  accent: 'accent',
  'accent-ink': 'accentStrong',
  'accent-weak': 'accentSoft',
};

function block(afterMarker: string): Record<string, string> {
  const start = html.indexOf(afterMarker);
  expect(start, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  // From `start`, not past the marker: a marker that itself ends in "{" must
  // find that brace, not the next block's.
  const open = html.indexOf('{', start);
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < html.length) {
    if (html[index] === '{') depth++;
    if (html[index] === '}') depth--;
    index++;
  }
  const body = html.slice(open + 1, index - 1);
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1]!] = match[2]!.trim();
  }
  return vars;
}

function check(vars: Record<string, string>, mode: ModeTokens, label: string): void {
  for (const [siteName, tokenKey] of Object.entries(MAP)) {
    expect(vars[siteName], `${label} --${siteName}`).toBe(mode[tokenKey]);
  }
}

describe('the site mirrors the theme palette', () => {
  it('paper: :root', () => {
    check(block(':root {'), light, 'paper');
  });
  it('ink: .inked scope', () => {
    check(block('.inked {'), dark, 'ink');
  });
  it('paper again: .papered scope (artifacts on ink)', () => {
    check(block('.papered {'), light, 'papered');
  });
});

/**
 * The four Vite apps serve the favicon straight out of packages/theme/public,
 * so they cannot drift. The static site is the one copy: deploy/site.Dockerfile
 * ships apps/site alone, so the file has to physically live there too. Same
 * bargain as the palette above, so it gets the same guard.
 */
describe('the site mirrors the brand favicon', () => {
  it('is byte-identical to the canonical mark in the theme package', () => {
    const canonical = readFileSync(join(ROOT, 'packages', 'theme', 'public', 'favicon.svg'), 'utf8');
    const siteCopy = readFileSync(join(ROOT, 'apps', 'site', 'favicon.svg'), 'utf8');
    expect(siteCopy).toBe(canonical);
  });
});
