/**
 * The Gate mark: four tallies and the fifth stroke across them.
 *
 * The same geometry was hand-inlined in four places (both app headers, the
 * voter brand lockup, the theme's TS helper for emails), which is how a logo
 * ends up subtly different depending on where you look at it. One copy, in
 * `currentColor` so it takes the colour of wherever it is placed.
 */
export function GateMark({ size = 19, strokeWidth = 3.2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="5" y1="5" x2="5" y2="27" />
      <line x1="12" y1="5" x2="12" y2="27" />
      <line x1="19" y1="5" x2="19" y2="27" />
      <line x1="26" y1="5" x2="26" y2="27" />
      <line x1="2" y1="25" x2="30" y2="7" />
    </svg>
  );
}
