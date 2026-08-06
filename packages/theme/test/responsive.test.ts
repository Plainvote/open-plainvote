import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakpoints, touchTargetPx } from '../src/tokens';

/**
 * The responsive invariants.
 *
 * Media queries cannot read custom properties, so components.css repeats the
 * breakpoint literals and nothing structural stops a fifth arbitrary width
 * appearing the next time somebody fixes one screen in a hurry. These tests are
 * that structure. They also pin the two rules whose reason is not visible from
 * the rule itself, and which were each a real defect before this: the 16px form
 * control, and the touch target.
 *
 * Deliberately reads ONLY this package. `siteParity.test.ts` reads
 * apps/site/index.html, which the public open-plainvote export does not carry,
 * so that file already fails collection there. Do not add a second one.
 */

const css = readFileSync(join(__dirname, '..', 'css', 'components.css'), 'utf8');

/** The body of the first rule whose selector list matches exactly. */
function rule(selector: string, within = css): string {
  const re = new RegExp(
    `(^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const match = re.exec(within);
  expect(match, `rule not found: ${selector}`).not.toBeNull();
  return match![2]!;
}

/** The contents of an `@media (...)` block, braces balanced. */
function media(condition: string): string {
  const start = css.indexOf(`@media ${condition}`);
  expect(start, `media query not found: ${condition}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(open + 1, i - 1);
}

describe('breakpoints are the ones tokens.ts declares', () => {
  it('every width-based query uses a canonical breakpoint', () => {
    const known = new Set(Object.values(breakpoints).map(String));
    const used = [...css.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px/g)].map((m) => m[1]!);
    expect(used.length, 'no width-based media queries found at all').toBeGreaterThan(0);
    for (const width of used) {
      expect(known.has(width), `${width}px is not one of ${[...known].join(', ')}`).toBe(true);
    }
  });

  it('does not reintroduce min-width queries alongside the max-width set', () => {
    // One direction only. Mixing both is how two rules end up both applying at
    // a boundary width and quietly cancelling each other.
    expect(/@media\s*\(\s*min-width:/.test(css)).toBe(false);
  });
});

describe('form controls cannot trigger the iOS focus zoom', () => {
  it('body is at least 16px, which the controls inherit', () => {
    const size = /font:\s*(\d+(?:\.\d+)?)px\s*\//.exec(rule('body'));
    expect(size, 'body font shorthand not in the expected `font: <size>px/<lh>` form').not.toBeNull();
    expect(Number(size![1])).toBeGreaterThanOrEqual(16);
  });

  it('controls still inherit that size rather than setting their own', () => {
    const controls = css.slice(css.indexOf("input[type='text']"));
    expect(/font:\s*inherit/.test(controls.slice(0, 400))).toBe(true);
  });
});

describe('touch targets', () => {
  const coarse = media('(pointer: coarse)');

  it('primary buttons meet the target on touch devices', () => {
    expect(rule('.btn', coarse)).toContain(`min-height: ${touchTargetPx}px`);
  });

  it('small buttons are enlarged too, if not all the way', () => {
    const small = rule('.btn.small', coarse);
    const min = /min-height:\s*(\d+)px/.exec(small);
    expect(min, '.btn.small has no min-height under pointer: coarse').not.toBeNull();
    // 40, deliberately: see the comment in components.css about console tables.
    expect(Number(min![1])).toBeGreaterThanOrEqual(40);
  });

  it('is keyed to pointer, not to width', () => {
    // A narrow desktop window is still driven by a mouse.
    expect(/@media\s*\(\s*max-width:[^)]*\)\s*\{[^@]*\.btn\s*\{[^}]*min-height/.test(css)).toBe(false);
  });
});

describe('the app chrome compacts on a phone', () => {
  const md = media(`(max-width: ${breakpoints.md}px)`);

  it('drops the decorative tagline', () => {
    expect(rule('.app-header .tagline', md)).toContain('display: none');
  });

  it('scrolls the nav instead of wrapping it onto more lines', () => {
    const nav = rule('.top-nav', md);
    expect(nav).toContain('flex-wrap: nowrap');
    expect(nav).toContain('overflow-x: auto');
  });
});

describe('utilities the apps need to stop pushing phones sideways', () => {
  it('.table-scroll still exists for wide tables', () => {
    expect(rule('.table-scroll')).toContain('overflow-x: auto');
  });

  it('.hide-sm exists and wins over any display value', () => {
    const sm = media(`(max-width: ${breakpoints.sm}px)`);
    expect(rule('.hide-sm', sm)).toMatch(/display:\s*none\s*!important/);
  });
});
