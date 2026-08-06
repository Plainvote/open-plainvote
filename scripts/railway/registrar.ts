import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeChainId, validateGenesis } from '@votechain/protocol';
import { createRegistrarServer, validateRegistrarConfig } from '@votechain/registrar';

/**
 * Container entrypoint for the registrar. Mirrors scripts/railway/node.ts:
 * config from environment variables instead of .data/registrar/config.json.
 *
 * The chain id is derived from the same genesis the nodes boot on rather than
 * passed separately — a mismatched pair would produce a registrar that signs
 * attestations no node will accept, and that failure is silent until the first
 * election is created.
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

const genesis = validateGenesis(JSON.parse(Buffer.from(required('GENESIS_B64'), 'base64').toString('utf8')));
const chainId = computeChainId(genesis);

const registrarPublicKey = required('REGISTRAR_PUBLIC_KEY');
if (genesis.registrarPublicKey !== registrarPublicKey) {
  throw new Error(
    `registrar key mismatch: genesis pins ${genesis.registrarPublicKey} but REGISTRAR_PUBLIC_KEY is ${registrarPublicKey}`,
  );
}

const config = validateRegistrarConfig({
  port: Number(optional('PORT', '8080')),
  host: optional('HOST', '::'),
  dbPath: optional('DB_PATH', join(dataDir, 'registrar.sqlite')),
  adminApiKey: required('ADMIN_API_KEY'),
  chainId,
  registrarSecretKey: required('REGISTRAR_SECRET_KEY'),
  registrarPublicKey,
  nodeUrl: required('NODE_URL'),
  credentialModulusBits: process.env.CREDENTIAL_MODULUS_BITS
    ? Number(process.env.CREDENTIAL_MODULUS_BITS)
    : undefined,
});

const app = await createRegistrarServer(config);
await app.listen({ port: config.port, host: config.host ?? '::' });
console.log(`[registrar] listening on :${config.port} (chain ${chainId.slice(0, 12)}…, db ${config.dbPath})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
