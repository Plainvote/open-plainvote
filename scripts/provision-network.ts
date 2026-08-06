import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeChainId, generateEd25519KeyPair, type Genesis } from '@votechain/protocol';

/**
 * Generate the keys and genesis for a HOSTED network, and emit them as a JSON
 * bundle for whatever provisions the services (see deploy/railway-up.ps1).
 *
 * scripts/setup.ts does the same job for the local demo, but writes .data/ with
 * absolute paths and fixed localhost ports — neither of which survives a
 * container. This writes no server state at all: just the material a deploy
 * needs to inject as environment variables.
 *
 * The output file contains every secret key in the network. It is written
 * outside the repo by default and must never be committed.
 *
 * Usage:
 *   tsx scripts/provision-network.ts --out ../plainvote-network.json \
 *     [--name "Plainvote Hosted Network"] [--validators 3] [--slot-seconds 5]
 */

export interface ProvisionedValidator {
  name: string;
  publicKey: string;
  secretKey: string;
}

export interface ProvisionedNetwork {
  chainId: string;
  genesis: Genesis;
  /** genesis as base64 JSON — the form the services take it in */
  genesisB64: string;
  validators: ProvisionedValidator[];
  registrar: { publicKey: string; secretKey: string; adminApiKey: string };
  commission: { publicKey: string; secretKey: string };
}

export function provisionNetwork(opts: {
  name: string;
  validatorCount: number;
  slotSeconds: number;
  validatorNames?: string[];
  genesisTime?: number;
}): ProvisionedNetwork {
  if (!Number.isSafeInteger(opts.validatorCount) || opts.validatorCount < 1) {
    throw new Error('--validators must be a positive integer');
  }
  if (!Number.isSafeInteger(opts.slotSeconds) || opts.slotSeconds < 1) {
    throw new Error('--slot-seconds must be a positive integer');
  }

  const validatorKeys = Array.from({ length: opts.validatorCount }, () => generateEd25519KeyPair());
  const commission = generateEd25519KeyPair();
  const registrarKey = generateEd25519KeyPair();

  const genesis: Genesis = {
    name: opts.name,
    genesisTime: opts.genesisTime ?? Date.now(),
    slotSeconds: opts.slotSeconds,
    validators: validatorKeys.map((k, i) => ({
      name: opts.validatorNames?.[i] ?? `Plainvote Node ${i + 1}`,
      publicKey: k.publicKey,
    })),
    commissionPublicKey: commission.publicKey,
    registrarPublicKey: registrarKey.publicKey,
  };

  return {
    chainId: computeChainId(genesis),
    genesis,
    genesisB64: Buffer.from(JSON.stringify(genesis), 'utf8').toString('base64'),
    validators: validatorKeys.map((k, i) => ({
      name: genesis.validators[i]!.name,
      publicKey: k.publicKey,
      secretKey: k.secretKey,
    })),
    registrar: {
      publicKey: registrarKey.publicKey,
      secretKey: registrarKey.secretKey,
      adminApiKey: randomBytes(24).toString('hex'),
    },
    commission: { publicKey: commission.publicKey, secretKey: commission.secretKey },
  };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const out = argValue('--out');
  if (!out) {
    console.error('usage: tsx scripts/provision-network.ts --out <file.json> [--name N] [--validators 3] [--slot-seconds 5]');
    process.exit(1);
  }
  const names = argValue('--validator-names');
  const network = provisionNetwork({
    name: argValue('--name') ?? 'Plainvote Hosted Network',
    validatorCount: Number(argValue('--validators') ?? 3),
    // Slower than the 2s local demo: a hosted chain quiesces when idle, and a
    // longer slot means fewer heartbeat blocks while a vote finalises.
    slotSeconds: Number(argValue('--slot-seconds') ?? 5),
    validatorNames: names ? names.split(',').map((n) => n.trim()).filter(Boolean) : undefined,
  });

  const path = resolve(out);
  writeFileSync(path, JSON.stringify(network, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('Plainvote network provisioned');
  console.log('-----------------------------');
  console.log(`  network name    ${network.genesis.name}`);
  console.log(`  chain id        ${network.chainId}`);
  console.log(`  validators      ${network.validators.length} (slot ${network.genesis.slotSeconds}s)`);
  console.log(`  secrets written ${path}`);
  console.log('');
  console.log('  This file holds every secret key in the network. Keep it out of the repo,');
  console.log('  back it up, and treat it as the thing an attacker most wants.');
  console.log('');
}
