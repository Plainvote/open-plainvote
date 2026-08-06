import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNode, validateNodeConfig } from '@votechain/node';

/**
 * Container entrypoint for a chain node.
 *
 * The local demo reads .data/nodeN/config.json written by scripts/setup.ts. A
 * hosted node has no such directory, so the same config is assembled from
 * environment variables and the genesis document is materialised onto the
 * volume (where it doubles as an auditable copy of what this node booted on).
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing required env var ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : fallback;
}

const dataDir = optional('DATA_DIR', '/data');
mkdirSync(dataDir, { recursive: true });

// Base64 so the JSON survives every environment-variable UI and shell intact.
const genesisJson = Buffer.from(required('GENESIS_B64'), 'base64').toString('utf8');
const genesisPath = join(dataDir, 'genesis.json');
writeFileSync(genesisPath, genesisJson.endsWith('\n') ? genesisJson : genesisJson + '\n', 'utf8');

const config = validateNodeConfig({
  nodeName: required('NODE_NAME'),
  port: Number(optional('PORT', '8080')),
  // Railway's private network is IPv6-only; :: is dual-stack so the public
  // HTTP proxy still reaches us over IPv4.
  host: optional('HOST', '::'),
  dataDir,
  genesisPath,
  validatorSecretKey: process.env.VALIDATOR_SECRET_KEY || undefined,
  peers: optional('PEERS', '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0),
});

const node = await createNode(config);
await node.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void node.stop().then(() => process.exit(0));
  });
}
