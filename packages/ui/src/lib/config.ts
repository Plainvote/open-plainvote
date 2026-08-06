/**
 * Where a deployment's settings come from, resolved once and the same way
 * everywhere.
 *
 * Three sources, in order:
 *   1. `window.__PLAINVOTE_CONFIG__`, injected into index.html by the hosting
 *      static server, so a deployment can be repointed without a rebuild;
 *   2. the `VITE_*` build-time env, which is how local dev is pointed;
 *   3. the local demo topology.
 *
 * This existed twice, verbatim, in the voter app and the results app. Two
 * copies of a resolver is how a deployment ends up with one app reading a
 * runtime override and the other quietly ignoring it.
 *
 * `readEnv` is a parameter rather than a direct `import.meta.env` read because
 * that expression is replaced at build time by whichever app is compiling this
 * file, and because it makes the resolution order testable without a bundler.
 */

declare global {
  interface Window {
    __PLAINVOTE_CONFIG__?: Record<string, string | undefined>;
  }
}

export type EnvReader = (viteName: string) => string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export function readRuntimeConfig(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return nonEmpty(window.__PLAINVOTE_CONFIG__?.[name]);
}

/** Resolve one setting. Returns undefined when nothing supplies it. */
export function resolveSetting(name: string, readEnv: EnvReader): string | undefined {
  return readRuntimeConfig(name) ?? nonEmpty(readEnv(`VITE_${name}`));
}

/** Resolve one setting, falling back to a default. */
export function settingOr(name: string, fallback: string, readEnv: EnvReader): string {
  return resolveSetting(name, readEnv) ?? fallback;
}

/** A comma-separated setting as a cleaned list. */
export function settingList(name: string, fallback: string, readEnv: EnvReader): string[] {
  return settingOr(name, fallback, readEnv)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
