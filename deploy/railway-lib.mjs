import { execFileSync } from 'node:child_process';

/**
 * Shared Railway CLI plumbing.
 *
 * Extracted so `railway-up.mjs` (provisions a whole network) and
 * `console-up.mjs` (adds the control plane to an existing one) cannot drift
 * apart on the CLI quirks below — each of which cost real time to find.
 */

/**
 * On Windows the CLI is an npm .cmd shim, and Node refuses to spawn .cmd
 * without a shell. That is safe only because every argument passed below is a
 * program-controlled identifier — a service name, a port, a repo slug, a mount
 * path. Secrets always travel over stdin and never reach argv.
 */
const WINDOWS = process.platform === 'win32';
const RAILWAY_BIN = WINDOWS ? 'railway.cmd' : 'railway';

export function createRailway({ repo, branch, port }) {
  function railway(args, { input } = {}) {
    return execFileSync(RAILWAY_BIN, args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: WINDOWS,
    });
  }

  function existingServices() {
    const out = railway(['service', 'list', '--json']);
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : (parsed.services ?? []);
    return new Map(list.map((s) => [s.name, s]));
  }

  function ensureService(name) {
    if (existingServices().has(name)) {
      console.log(`  service ${name} — already exists`);
      return;
    }
    console.log(`  service ${name} — creating from ${repo}@${branch}`);
    railway(['add', '--service', name, '--repo', repo, '--branch', branch]);
  }

  function ensureVolume(service, mountPath) {
    // `service list` reports each service's attached volumes, which is a more
    // direct answer than correlating `volume list` back to services.
    const existing = existingServices().get(service);
    if ((existing?.volumes ?? []).length > 0) {
      console.log(`  volume  ${service} — already attached`);
      return;
    }
    console.log(`  volume  ${service} — attaching at ${mountPath}`);
    // `volume add --service X` panics in railway 5.2.0; linking the service and
    // letting `volume add` use the linked one is the path that works.
    railway(['service', 'link', service]);
    railway(['volume', 'add', '--mount-path', mountPath]);
  }

  /** Set variables one at a time via stdin so secrets never reach argv. */
  function setVars(service, vars) {
    let n = 0;
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) continue;
      railway(['variable', 'set', key, '--stdin', '--service', service, '--skip-deploys'], {
        input: String(value),
      });
      n++;
    }
    console.log(`  vars    ${service} — set ${n}`);
  }

  function ensureDomain(service) {
    const out = railway(['domain', '--service', service, '--port', port, '--json']);
    // The shape differs between creating a domain and reporting an existing one:
    // `{domain}` vs `{domains: [...]}`, whose entries may be strings or objects.
    let domain;
    try {
      const parsed = JSON.parse(out);
      const first = parsed.domains?.[0];
      domain = parsed.domain ?? (typeof first === 'string' ? first : first?.domain) ?? parsed.url;
    } catch {
      domain = out.match(/[a-z0-9-]+\.up\.railway\.app/i)?.[0];
    }
    if (!domain) throw new Error(`could not determine a domain for ${service} from: ${out}`);
    const url = domain.startsWith('http') ? domain : `https://${domain}`;
    console.log(`  domain  ${service} — ${url}`);
    return url;
  }

  function redeploy(service) {
    console.log(`  deploy  ${service}`);
    railway(['service', 'redeploy', '--service', service, '--yes', '--from-source']);
  }

  return { railway, existingServices, ensureService, ensureVolume, setVars, ensureDomain, redeploy };
}
