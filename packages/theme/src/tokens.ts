/**
 * The Plainvote design tokens: single source of truth.
 *
 * Chosen from the brand board (2026-08-03): Space Grotesk wordmark/headings,
 * Inter body, the "Gate" tally mark, and the Ledger Green palette.
 *
 * Three kinds of consumer:
 *  - the Vite apps import `css/tokens.css`, which MIRRORS these values;
 *    `test/tokens-parity.test.ts` fails if the mirror drifts;
 *  - `packages/console` (claim page, emails) imports THIS module and
 *    interpolates values, so those surfaces cannot drift by construction;
 *  - `apps/site/index.html` mirrors a subset by hand; its parity test lives
 *    here too (added with the site phase).
 *
 * Change a color here first, then make the tests green again.
 */

export interface ModeTokens {
  bg: string;
  surface: string;
  /** Raised surface: table header rows, code wells, hover fills. */
  surface2: string;
  text: string;
  muted: string;
  border: string;
  /** Stronger border for focus-adjacent outlines and table rules. */
  borderStrong: string;
  accent: string;
  onAccent: string;
  /** Hover/active shade of the accent. */
  accentStrong: string;
  /** Tinted background for accent-flavored chips and rows. */
  accentSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  /** Focus ring color (accent at full strength; ring style lives in CSS). */
  ring: string;
}

export const light: ModeTokens = {
  bg: '#F7F8F6',
  surface: '#FFFFFF',
  surface2: '#F1F3F0',
  text: '#14201B',
  muted: '#5A6B63',
  border: '#E2E7E3',
  borderStrong: '#CBD4CE',
  accent: '#0E6B53',
  onAccent: '#FFFFFF',
  accentStrong: '#0A523F',
  accentSoft: '#E3EFEA',
  ok: '#15803D',
  okSoft: '#E4F3E9',
  warn: '#B45309',
  warnSoft: '#FAEEDD',
  danger: '#B91C1C',
  dangerSoft: '#FCE9E8',
  info: '#3B6B8F',
  infoSoft: '#E9F0F4',
  ring: '#0E6B53',
};

export const dark: ModeTokens = {
  bg: '#0C1210',
  surface: '#121A16',
  surface2: '#18231E',
  text: '#E7EDE9',
  muted: '#93A39B',
  border: '#24302A',
  borderStrong: '#33443C',
  accent: '#2FB98B',
  onAccent: '#06231B',
  accentStrong: '#4ACCA0',
  accentSoft: '#16302A',
  ok: '#4ADE80',
  okSoft: '#16281E',
  warn: '#F5A952',
  warnSoft: '#2A2214',
  danger: '#F87171',
  dangerSoft: '#2C1A18',
  info: '#7FB2D9',
  infoSoft: '#16211C',
  ring: '#2FB98B',
};

/** Non-color scales, shared by both modes. */
export const scale = {
  fontSans: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontDisplay: "'Space Grotesk Variable', 'Space Grotesk', 'Inter Variable', Inter, system-ui, sans-serif",
  fontMono: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
  radiusS: '7px',
  radiusM: '10px',
  radiusL: '14px',
  /** Motion: fast enough to feel instant, slow enough to register. */
  durFast: '140ms',
  durSlow: '240ms',
  ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  /**
   * Spacing rungs. Before these, every padding in components.css was a literal
   * and the vocabulary had drifted to thirteen different values; new components
   * use these so the rhythm is inspectable rather than remembered.
   */
  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '24px',
  space6: '32px',
  space7: '48px',
  space8: '64px',
  /** Comfortable line length for prose. Data and tables are exempt. */
  measure: '68ch',
} as const;

/**
 * Breakpoints.
 *
 * Media queries cannot read custom properties, so these cannot be tokens in the
 * CSS sense: every `@media` in components.css repeats the literal. They live
 * here as the canonical record, and the theme's own test asserts the stylesheet
 * uses these widths and no others, which is what stops a fourth arbitrary
 * breakpoint appearing the next time someone fixes one screen in a hurry.
 *
 *  - `sm` phones: single column, drop what is decorative.
 *  - `md` large phones and small tablets: the app chrome compacts.
 *  - `lg` the point above which nothing needs to adapt.
 */
export const breakpoints = {
  sm: 560,
  md: 720,
  lg: 960,
} as const;

/**
 * The smallest comfortable touch target. Applied under `pointer: coarse` rather
 * than at a width, because a small window on a desktop is still driven by a
 * mouse and does not need 44px controls.
 */
export const touchTargetPx = 44;

export const tokens = { light, dark, scale, breakpoints, touchTargetPx };

/**
 * The Gate mark as inline SVG, parameterized by size. `currentColor` so it
 * inherits wherever it is placed; consumers that need a fixed color set it on
 * the wrapper. Used by the claim page and emails; the React apps and site
 * carry their own inline copies of the same geometry.
 */
export function gateMarkSvg(size: number, strokeWidth = 3): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" ` +
    `stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" aria-hidden="true">` +
    '<line x1="5" y1="5" x2="5" y2="27"/><line x1="12" y1="5" x2="12" y2="27"/>' +
    '<line x1="19" y1="5" x2="19" y2="27"/><line x1="26" y1="5" x2="26" y2="27"/>' +
    '<line x1="2" y1="25" x2="30" y2="7"/></svg>'
  );
}
