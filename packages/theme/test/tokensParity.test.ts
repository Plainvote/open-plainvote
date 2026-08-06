import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dark, light, scale, type ModeTokens } from '../src/tokens';

/**
 * css/tokens.css mirrors src/tokens.ts by hand (the apps need plain CSS; the
 * claim page and emails need TS). This test is what makes that mirror safe:
 * change a value in one place and not the other, and CI goes red naming the
 * token. Without it this repo would have a fourth drifting copy of the
 * palette, which is exactly the disease the theme package exists to cure.
 */

const css = readFileSync(join(__dirname, '..', 'css', 'tokens.css'), 'utf8');

/** Extract `--name: value;` pairs from one balanced `{ ... }` block. */
function block(afterMarker: string): Record<string, string> {
  const start = css.indexOf(afterMarker);
  expect(start, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start + afterMarker.length);
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < css.length) {
    if (css[index] === '{') depth++;
    if (css[index] === '}') depth--;
    index++;
  }
  const body = css.slice(open + 1, index - 1);
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1]!] = match[2]!.trim();
  }
  return vars;
}

/** tokens.ts camelCase -> tokens.css kebab-case. */
const cssName: Record<keyof ModeTokens, string> = {
  bg: 'bg',
  surface: 'surface',
  surface2: 'surface-2',
  text: 'text',
  muted: 'muted',
  border: 'border',
  borderStrong: 'border-strong',
  accent: 'accent',
  onAccent: 'on-accent',
  accentStrong: 'accent-strong',
  accentSoft: 'accent-soft',
  ok: 'ok',
  okSoft: 'ok-soft',
  warn: 'warn',
  warnSoft: 'warn-soft',
  danger: 'danger',
  dangerSoft: 'danger-soft',
  info: 'info',
  infoSoft: 'info-soft',
  ring: 'ring',
};

describe('tokens.css mirrors tokens.ts', () => {
  const lightVars = block(':root');
  const darkVars = block('.inked,');

  it('light mode matches', () => {
    for (const [key, value] of Object.entries(light) as [keyof ModeTokens, string][]) {
      expect(lightVars[cssName[key]], `light --${cssName[key]}`).toBe(value);
    }
  });

  it('dark mode matches', () => {
    for (const [key, value] of Object.entries(dark) as [keyof ModeTokens, string][]) {
      expect(darkVars[cssName[key]], `dark --${cssName[key]}`).toBe(value);
    }
  });

  it('scales match', () => {
    expect(lightVars['font-sans']).toBe(scale.fontSans.replace(/"/g, "'"));
    expect(lightVars['font-display']).toBe(scale.fontDisplay.replace(/"/g, "'"));
    expect(lightVars['font-mono']).toBe(scale.fontMono.replace(/"/g, "'"));
    expect(lightVars['radius-s']).toBe(scale.radiusS);
    expect(lightVars['radius-m']).toBe(scale.radiusM);
    expect(lightVars['radius-l']).toBe(scale.radiusL);
    expect(lightVars['dur-fast']).toBe(scale.durFast);
    expect(lightVars['dur-slow']).toBe(scale.durSlow);
    expect(lightVars['ease']).toBe(scale.ease);
  });

  it('spacing rungs and measure match', () => {
    expect(lightVars['space-1']).toBe(scale.space1);
    expect(lightVars['space-2']).toBe(scale.space2);
    expect(lightVars['space-3']).toBe(scale.space3);
    expect(lightVars['space-4']).toBe(scale.space4);
    expect(lightVars['space-5']).toBe(scale.space5);
    expect(lightVars['space-6']).toBe(scale.space6);
    expect(lightVars['space-7']).toBe(scale.space7);
    expect(lightVars['space-8']).toBe(scale.space8);
    expect(lightVars['measure']).toBe(scale.measure);
  });

  it('dark mode declares no token light mode lacks', () => {
    for (const name of Object.keys(darkVars)) {
      expect(lightVars[name], `--${name} exists in dark but not light`).toBeDefined();
    }
  });
});
