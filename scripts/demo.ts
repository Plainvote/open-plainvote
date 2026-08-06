import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import concurrently from 'concurrently';
import { runSetup } from './setup';

/**
 * One-command demo: 3 validator nodes + registrar + the three engine UIs,
 * plus (when its workspace is present) the buyer console and its API.
 * First run generates .data/ (keys, genesis, configs, demo voter codes).
 */

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, '.data');

/**
 * The commercial console is not part of the open-source engine. In the public
 * open-plainvote repo this workspace simply does not exist, and the demo runs
 * the engine alone; in the private company repo it exists and joins the demo.
 */
const HAS_CONSOLE = existsSync(join(ROOT, 'packages', 'console'));

const PORTS: [number, string][] = [
  [4001, 'node1'],
  [4002, 'node2'],
  [4003, 'node3'],
  [5001, 'registrar'],
  [5173, 'voter-ui'],
  [5174, 'commission-ui'],
  [5175, 'results-ui'],
  ...(HAS_CONSOLE ? ([[5177, 'console-api'], [5178, 'console-ui']] as [number, string][]) : []),
];

/**
 * The key that wraps the commission signing key at rest. Generated once and
 * kept in .data/ (gitignored) — losing it locally just means regenerating the
 * demo network, but the production equivalent is not recoverable.
 */
function consoleMasterKey(): string {
  const path = join(DATA, 'console', 'master.key');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(join(DATA, 'console'), { recursive: true });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(path, key + '\n', 'utf8');
  return key;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => probe.close(() => resolvePromise(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  // First-run setup.
  if (!existsSync(join(DATA, 'genesis.json'))) {
    console.log('[demo] no .data/ found — generating keys, genesis, and demo codes…');
    runSetup({ force: true });
  }

  // Port preflight — fail fast with a useful message.
  const busy: string[] = [];
  for (const [port, name] of PORTS) {
    if (!(await portFree(port))) busy.push(`${port} (${name})`);
  }
  if (busy.length > 0) {
    console.error(`[demo] ports already in use: ${busy.join(', ')}`);
    console.error('[demo] stop the conflicting processes (netstat -ano | findstr :<port>) and retry.');
    process.exit(1);
  }

  const registrarConfig = JSON.parse(readFileSync(join(DATA, 'registrar', 'config.json'), 'utf8')) as {
    adminApiKey: string;
    chainId: string;
  };
  const commissionKey = JSON.parse(readFileSync(join(DATA, 'commission.key.json'), 'utf8')) as {
    secretKey: string;
  };

  console.log('');
  console.log('  VoteChain demo network');
  console.log('  ======================');
  console.log(`  chain id      ${registrarConfig.chainId}`);
  console.log('');
  if (HAS_CONSOLE) console.log('  Buyer console      http://127.0.0.1:5178   <- self-serve');
  console.log('  Voter app          http://127.0.0.1:5173');
  console.log('  Commission app     http://127.0.0.1:5174');
  console.log('  Public results     http://127.0.0.1:5175');
  console.log('  Chain nodes        http://127.0.0.1:4001 · 4002 · 4003');
  console.log('  Registrar          http://127.0.0.1:5001');
  console.log('');
  console.log('  Demo voter codes   .data/demo-codes.txt');
  console.log(`  Registrar admin    ${registrarConfig.adminApiKey}`);
  console.log(`  Commission secret  ${commissionKey.secretKey}`);
  console.log('  (paste the two keys into the commission app Setup tab)');
  console.log('');
  if (HAS_CONSOLE) {
    console.log('  NO MAIL IS SENT LOCALLY. Sign-in links and voter code links are written to');
    console.log('  .data/console/outbox/ - open the newest file and click the link inside.');
    console.log('');
  }

  const consoleEnv = HAS_CONSOLE ? {
    CONSOLE_PORT: '5177',
    HOST: '127.0.0.1',
    CONSOLE_DB_PATH: join(DATA, 'console', 'console.db'),
    CONSOLE_MASTER_KEY: consoleMasterKey(),
    COMMISSION_SECRET_KEY: commissionKey.secretKey,
    // The Vite dev server proxies /api and /claim, so links point at it and
    // everything stays on one origin exactly as it does in production.
    CONSOLE_PUBLIC_URL: 'http://127.0.0.1:5178',
    VOTER_URL: 'http://127.0.0.1:5173',
    RESULTS_URL: 'http://127.0.0.1:5175',
    REGISTRAR_URL: 'http://127.0.0.1:5001',
    REGISTRAR_ADMIN_KEY: registrarConfig.adminApiKey,
    NODE_URLS: 'http://127.0.0.1:4001,http://127.0.0.1:4002,http://127.0.0.1:4003',
    MAIL_DRIVER: 'file',
    MAIL_OUTBOX_DIR: join(DATA, 'console', 'outbox'),
  } : {};

  const { result } = concurrently(
    [
      { command: 'tsx packages/node/src/main.ts --config .data/node1/config.json', name: 'node1', prefixColor: 'blue' },
      { command: 'tsx packages/node/src/main.ts --config .data/node2/config.json', name: 'node2', prefixColor: 'cyan' },
      { command: 'tsx packages/node/src/main.ts --config .data/node3/config.json', name: 'node3', prefixColor: 'magenta' },
      {
        command: 'tsx packages/registrar/src/main.ts --config .data/registrar/config.json',
        name: 'registrar',
        prefixColor: 'yellow',
      },
      { command: 'npm run dev --workspace @votechain/voter-ui', name: 'voter', prefixColor: 'green' },
      { command: 'npm run dev --workspace @votechain/commission-ui', name: 'commission', prefixColor: 'red' },
      { command: 'npm run dev --workspace @votechain/results-ui', name: 'results', prefixColor: 'white' },
      ...(HAS_CONSOLE
        ? [
            {
              command: 'tsx packages/console/src/main.ts',
              name: 'console-api',
              prefixColor: 'yellowBright' as const,
              env: consoleEnv,
            },
            { command: 'npm run dev --workspace @plainvote/console-ui', name: 'console', prefixColor: 'greenBright' as const },
          ]
        : []),
    ],
    {
      cwd: ROOT,
      prefix: 'name',
      killOthersOn: ['failure'],
    },
  );

  try {
    await result;
  } catch {
    process.exit(1);
  }
}

void main();
