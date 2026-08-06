import { settingList, settingOr, resolveSetting } from '@plainvote/ui';

/**
 * This app's settings. The resolution order (runtime injection, then the
 * build-time env, then a local default) lives in @plainvote/ui, because the
 * results app resolves the same way and two copies of that logic is how one
 * app ends up honouring a deployment override and the other ignoring it.
 */
const env = (name: string): string | undefined => (import.meta.env as Record<string, string | undefined>)[name];

/** Record-keepers; votes are submitted to ALL of them (censorship resistance). */
export const NODE_URLS: string[] = settingList(
  'NODE_URLS',
  'http://127.0.0.1:4001,http://127.0.0.1:4002,http://127.0.0.1:4003',
  env,
);

export const REGISTRAR_URL: string = settingOr('REGISTRAR_URL', 'http://127.0.0.1:5001', env);

/** Public results app, for receipt-verification links. */
export const RESULTS_URL: string = settingOr('RESULTS_URL', 'http://127.0.0.1:5175', env);

/**
 * Whose election this is.
 *
 * A member has never heard of Plainvote; they have heard of their credit
 * union, and an unfamiliar name on the page where you are asked for a code is
 * a reason to close the tab. When a deployment supplies an organization the
 * header leads with it and Plainvote endorses underneath; when it does not,
 * the lockup falls back to Plainvote alone.
 */
export const ORG_NAME: string | undefined = resolveSetting('ORG_NAME', env);

/** Optional logo for the lockup. Without one, the org's initials stand in. */
export const ORG_LOGO_URL: string | undefined = resolveSetting('ORG_LOGO_URL', env);
