import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  computeChainId,
  generateEd25519KeyPair,
  voterCodeHash,
  type Genesis,
} from '@votechain/protocol';
import { RegistrarDb, generateVoterCode } from '@votechain/registrar';

/**
 * One-time local network setup: keys, genesis, per-service configs, and a
 * batch of demo voter codes — everything lands in .data/ (gitignored).
 */

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, '.data');

const NODE_PORTS = [4001, 4002, 4003];
const REGISTRAR_PORT = 5001;
const DEMO_CODE_COUNT = 20;

export interface SetupResult {
  chainId: string;
  adminApiKey: string;
  commissionKeyPath: string;
  demoCodesPath: string;
}

export function runSetup(opts: { force?: boolean } = {}): SetupResult {
  if (existsSync(DATA)) {
    if (!opts.force) {
      throw new Error(`.data already exists — run "npm run demo:reset" to regenerate from scratch`);
    }
    rmSync(DATA, { recursive: true, force: true });
  }
  mkdirSync(DATA, { recursive: true });

  // --- keys ---------------------------------------------------------------
  const validatorKeys = NODE_PORTS.map(() => generateEd25519KeyPair());
  const commissionKey = generateEd25519KeyPair();
  const registrarKey = generateEd25519KeyPair();

  // --- genesis ------------------------------------------------------------
  const genesis: Genesis = {
    name: 'VoteChain Local Demo Network',
    genesisTime: Date.now(),
    slotSeconds: 2,
    validators: validatorKeys.map((k, i) => ({
      name: ['City Election Commission', 'League of Observers', 'University Audit Lab'][i] ?? `validator-${i + 1}`,
      publicKey: k.publicKey,
    })),
    commissionPublicKey: commissionKey.publicKey,
    registrarPublicKey: registrarKey.publicKey,
  };
  const chainId = computeChainId(genesis);
  const genesisPath = join(DATA, 'genesis.json');
  writeFileSync(genesisPath, JSON.stringify(genesis, null, 2) + '\n', 'utf8');

  // --- node configs ---------------------------------------------------------
  NODE_PORTS.forEach((port, i) => {
    const dir = join(DATA, `node${i + 1}`);
    mkdirSync(dir, { recursive: true });
    const peers = NODE_PORTS.filter((p) => p !== port).map((p) => `http://127.0.0.1:${p}`);
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify(
        {
          nodeName: `node${i + 1}`,
          port,
          dataDir: dir,
          genesisPath,
          validatorSecretKey: validatorKeys[i]!.secretKey,
          peers,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  });

  // --- registrar ------------------------------------------------------------
  const registrarDir = join(DATA, 'registrar');
  mkdirSync(registrarDir, { recursive: true });
  const adminApiKey = randomBytes(24).toString('hex');
  const dbPath = join(registrarDir, 'registrar.sqlite');
  writeFileSync(
    join(registrarDir, 'config.json'),
    JSON.stringify(
      {
        port: REGISTRAR_PORT,
        dbPath,
        adminApiKey,
        chainId,
        registrarSecretKey: registrarKey.secretKey,
        registrarPublicKey: registrarKey.publicKey,
        nodeUrl: `http://127.0.0.1:${NODE_PORTS[0]}`,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // --- commission key -------------------------------------------------------
  const commissionKeyPath = join(DATA, 'commission.key.json');
  writeFileSync(commissionKeyPath, JSON.stringify(commissionKey, null, 2) + '\n', 'utf8');

  // --- demo voter codes -----------------------------------------------------
  const db = new RegistrarDb(dbPath);
  const codes: string[] = [];
  const now = Date.now();
  for (let i = 0; i < DEMO_CODE_COUNT; i++) {
    const code = generateVoterCode();
    db.insertCode(voterCodeHash(code), now);
    codes.push(code);
  }
  db.close();
  const demoCodesPath = join(DATA, 'demo-codes.txt');
  writeFileSync(
    demoCodesPath,
    [
      '# VoteChain demo voter codes',
      '# In a real deployment these are issued by the government registrar and',
      '# delivered to verified voters. Only their SHA-256 hashes are stored.',
      ...codes,
      '',
    ].join('\n'),
    'utf8',
  );

  return { chainId, adminApiKey, commissionKeyPath, demoCodesPath };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const force = process.argv.includes('--force');
  try {
    const result = runSetup({ force });
    console.log('');
    console.log('VoteChain local network generated in .data/');
    console.log('--------------------------------------------');
    console.log(`  chain id            ${result.chainId}`);
    console.log(`  validators          3 (ports 4001-4003)`);
    console.log(`  registrar           port 5001`);
    console.log(`  registrar admin key ${result.adminApiKey}`);
    console.log(`  commission keypair  ${result.commissionKeyPath}`);
    console.log(`  demo voter codes    ${result.demoCodesPath} (20 codes)`);
    console.log('');
    console.log('Next: npm run demo');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
