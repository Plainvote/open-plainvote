/**
 * Shared plumbing for the Plainvote voter and results apps.
 *
 * Scope, deliberately narrow: the mechanism two apps genuinely share, and
 * nothing page-level. A component that knows what an election is belongs in
 * the app that renders it.
 *
 * `console-ui` does NOT depend on this package. It is the one commercial
 * surface (UNLICENSED) and this package is AGPL, so importing components into
 * it would push the copyleft boundary somewhere it is not today. The console
 * consumes the theme's CSS, which is a far weaker linkage, and that is where
 * the line stays until somebody decides otherwise on purpose.
 */
export * from './lib/config';
export * from './lib/nodes';
export * from './lib/hashRouter';
export * from './components/GateMark';
