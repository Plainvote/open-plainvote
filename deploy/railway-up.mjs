import { readFileSync } from 'node:fs';
import { createRailway } from './railway-lib.mjs';

/**
 * Provision the Plainvote services in the linked Railway project.
 *
 * Reads the secret bundle written by scripts/provision-network.ts and pushes it
 * into per-service environment variables, so no key is ever typed on a command
 * line or committed.
 *
 * Idempotent: re-running skips services, volumes, and domains that already
 * exist, and re-sets variables to their current intended values.
 *
 *   node deploy/railway-up.mjs <network.json> [--repo owner/name] [--no-deploy]
 *
 * Prerequisites: `railway login`, and `railway link` to the target project.
 */

const [, , networkPath, ...rest] = process.argv;
if (!networkPath) {
  console.error('usage: node deploy/railway-up.mjs <network.json> [--repo owner/name] [--no-deploy]');
  process.exit(1);
}

const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const REPO = flag('--repo', 'cnyako/plainvote');
const BRANCH = flag('--branch', 'main');
const DEPLOY = !rest.includes('--no-deploy');

const net = JSON.parse(readFileSync(networkPath, 'utf8'));

/** Every service listens here; Railway's private DNS needs a fixed port. */
const PORT = '8080';
const NODE_NAMES = net.validators.map((_, i) => `node${i + 1}`);
const internal = (name) => `http://${name}.railway.internal:${PORT}`;

const { ensureService, ensureVolume, setVars, ensureDomain, redeploy } = createRailway({
  repo: REPO,
  branch: BRANCH,
  port: PORT,
});

// ---------------------------------------------------------------------------

const UI_SERVICES = ['voter-ui', 'commission-ui', 'results-ui'];
const ALL = [...NODE_NAMES, 'registrar', ...UI_SERVICES];

console.log(`\nProvisioning ${ALL.length} services from ${REPO}@${BRANCH}\n`);

console.log('1. services');
for (const name of ALL) ensureService(name);

console.log('\n2. volumes (chain data and the registrar database must survive redeploys)');
for (const name of [...NODE_NAMES, 'registrar']) ensureVolume(name, '/data');

console.log('\n3. chain + registrar variables');
NODE_NAMES.forEach((name, i) => {
  setVars(name, {
    RAILWAY_DOCKERFILE_PATH: 'deploy/chain-node.Dockerfile',
    PORT,
    NODE_NAME: name,
    GENESIS_B64: net.genesisB64,
    VALIDATOR_SECRET_KEY: net.validators[i].secretKey,
    // Gossip stays on the private network — never over the public internet.
    PEERS: NODE_NAMES.filter((p) => p !== name).map(internal).join(','),
  });
});
setVars('registrar', {
  RAILWAY_DOCKERFILE_PATH: 'deploy/registrar.Dockerfile',
  PORT,
  GENESIS_B64: net.genesisB64,
  REGISTRAR_SECRET_KEY: net.registrar.secretKey,
  REGISTRAR_PUBLIC_KEY: net.registrar.publicKey,
  ADMIN_API_KEY: net.registrar.adminApiKey,
  NODE_URL: internal(NODE_NAMES[0]),
});

console.log('\n4. public domains');
const urls = {};
for (const name of ALL) urls[name] = ensureDomain(name);

console.log('\n5. app variables (browser-facing, so these are the PUBLIC urls)');
const nodeUrls = NODE_NAMES.map((n) => urls[n]).join(',');
for (const name of UI_SERVICES) {
  setVars(name, {
    RAILWAY_DOCKERFILE_PATH: `deploy/${name}.Dockerfile`,
    PORT,
    NODE_URLS: nodeUrls,
    REGISTRAR_URL: urls.registrar,
    RESULTS_URL: urls['results-ui'],
    VOTER_URL: urls['voter-ui'],
  });
}

if (DEPLOY) {
  console.log('\n6. deploying');
  for (const name of ALL) {
    redeploy(name);
  }
}

console.log('\nDone.\n');
for (const name of ALL) console.log(`  ${name.padEnd(15)} ${urls[name]}`);
console.log('');
