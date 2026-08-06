/**
 * Commission app settings: persisted in localStorage (demo-grade key handling),
 * plus factories for the protocol REST clients and small shared helpers.
 */
import { HttpError, NodeClient, RegistrarClient } from '@votechain/protocol';

export interface CommissionSettings {
  nodeUrl: string;
  registrarUrl: string;
  registrarAdminKey: string;
  commissionSecretKey: string;
}

const STORAGE_KEY = 'vc:commission:settings';

declare global {
  interface Window {
    __PLAINVOTE_CONFIG__?: Record<string, string | undefined>;
  }
}

/**
 * Service URLs come from window.__PLAINVOTE_CONFIG__ when a hosting static
 * server injected one (lets a deployment be repointed without a rebuild),
 * otherwise from the VITE_* build-time env, otherwise the local demo topology.
 * These are only DEFAULTS — the Setup tab's saved settings win.
 */
function setting(name: string, fallback: string): string {
  const runtime = typeof window === 'undefined' ? undefined : window.__PLAINVOTE_CONFIG__?.[name];
  if (typeof runtime === 'string' && runtime.trim().length > 0) return runtime.trim();
  const built: unknown = (import.meta.env as Record<string, unknown>)[`VITE_${name}`];
  if (typeof built === 'string' && built.trim().length > 0) return built.trim();
  return fallback;
}

export const DEFAULT_NODE_URLS: readonly string[] = setting(
  'NODE_URLS',
  'http://127.0.0.1:4001,http://127.0.0.1:4002,http://127.0.0.1:4003',
)
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

export const DEFAULT_REGISTRAR_URL: string = setting('REGISTRAR_URL', 'http://127.0.0.1:5001');

/** Public results app (a separate deployment; port 5175 in the local demo). */
export const RESULTS_APP_URL: string = setting('RESULTS_URL', 'http://127.0.0.1:5175');

export function resultsAppElectionUrl(electionId: string): string {
  return `${RESULTS_APP_URL}/#/election/${encodeURIComponent(electionId)}`;
}

export function defaultSettings(): CommissionSettings {
  return {
    nodeUrl: DEFAULT_NODE_URLS[0] ?? 'http://127.0.0.1:4001',
    registrarUrl: DEFAULT_REGISTRAR_URL,
    registrarAdminKey: '',
    commissionSecretKey: '',
  };
}

export function loadSettings(): CommissionSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    const p = parsed as Record<string, unknown>;
    return {
      nodeUrl: typeof p.nodeUrl === 'string' && p.nodeUrl.trim().length > 0 ? p.nodeUrl : base.nodeUrl,
      registrarUrl:
        typeof p.registrarUrl === 'string' && p.registrarUrl.trim().length > 0 ? p.registrarUrl : base.registrarUrl,
      registrarAdminKey: typeof p.registrarAdminKey === 'string' ? p.registrarAdminKey : '',
      commissionSecretKey: typeof p.commissionSecretKey === 'string' ? p.commissionSecretKey : '',
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: CommissionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private mode, quota) — settings stay in memory.
  }
}

export type SettingKey = keyof CommissionSettings;

const SETTING_LABELS: Record<SettingKey, string> = {
  nodeUrl: 'node URL',
  registrarUrl: 'registrar URL',
  registrarAdminKey: 'registrar admin key',
  commissionSecretKey: 'commission secret key',
};

export const ALL_SETTING_KEYS: readonly SettingKey[] = [
  'nodeUrl',
  'registrarUrl',
  'registrarAdminKey',
  'commissionSecretKey',
];

/** Human-readable labels of the requested settings that are still blank. */
export function missingSettings(
  settings: CommissionSettings,
  keys: readonly SettingKey[] = ALL_SETTING_KEYS,
): string[] {
  return keys.filter((key) => settings[key].trim().length === 0).map((key) => SETTING_LABELS[key]);
}

export function makeNodeClient(settings: CommissionSettings): NodeClient {
  return new NodeClient(settings.nodeUrl.trim());
}

export function makeRegistrarClient(settings: CommissionSettings): RegistrarClient {
  const adminKey = settings.registrarAdminKey.trim();
  return new RegistrarClient(settings.registrarUrl.trim(), adminKey.length > 0 ? adminKey : undefined);
}

/** Uniform error → message helper. HttpError carries the server's message. */
export function errorMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof TypeError) return `${e.message}. Is the service running and reachable?`;
  if (e instanceof Error) return e.message;
  return String(e);
}
