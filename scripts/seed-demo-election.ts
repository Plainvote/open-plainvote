import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NodeClient,
  RegistrarClient,
  buildElectionCreateTx,
  type ElectionDefinition,
} from '@votechain/protocol';

/**
 * Seed a deployed network with voter codes and one open demo election, so the
 * hosted URLs are immediately usable end to end.
 *
 * Runs from an operator's machine against the PUBLIC service URLs — the
 * commission secret key is passed in on stdin-adjacent env and never lands on
 * a server. That mirrors how a real election is created: the signing key lives
 * with the commission, not with the host.
 *
 * Usage:
 *   COMMISSION_SECRET_KEY=... ADMIN_API_KEY=... \
 *   tsx scripts/seed-demo-election.ts --node https://… --registrar https://… \
 *     [--codes 25] [--days 30] [--out codes.txt]
 */

const DEMO_QUESTIONS = [
  {
    id: 'board-seat',
    text: 'Who should hold the open seat on the board of directors?',
    options: [
      { id: 'okonkwo', text: 'Amara Okonkwo' },
      { id: 'lindqvist', text: 'Bo Lindqvist' },
      { id: 'reyes', text: 'Priya Reyes' },
      { id: 'abstain', text: 'Abstain' },
    ],
  },
  {
    id: 'dues-2027',
    text: 'Should annual membership dues increase from $120 to $135 in 2027?',
    options: [
      { id: 'yes', text: 'Yes' },
      { id: 'no', text: 'No' },
      { id: 'abstain', text: 'Abstain' },
    ],
  },
];

export interface SeedResult {
  electionId: string;
  title: string;
  codes: string[];
  txHash: string | undefined;
  onChain: boolean;
}

async function waitForElection(node: NodeClient, electionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await node.election(electionId);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

export async function seedDemoElection(opts: {
  nodeUrl: string;
  registrarUrl: string;
  adminApiKey: string;
  commissionSecretKey: string;
  codeCount: number;
  days: number;
}): Promise<SeedResult> {
  const node = new NodeClient(opts.nodeUrl);
  const registrar = new RegistrarClient(opts.registrarUrl, opts.adminApiKey);

  const status = await node.status();
  console.log(`[seed] node ${opts.nodeUrl} — chain ${status.chainId.slice(0, 12)}…, height ${status.height}`);

  console.log(`[seed] generating ${opts.codeCount} voter codes…`);
  const { codes } = await registrar.generateCodes(opts.codeCount);

  const electionId = randomUUID();
  console.log(`[seed] requesting the per-election credential key (election ${electionId})…`);
  const keys = await registrar.createElectionKeys(electionId);

  // Backdate the start a little so the election is unambiguously open even if
  // the first block lands a few seconds from now.
  const now = Date.now();
  const definition: ElectionDefinition = {
    electionId,
    title: 'Demo — 2027 Board Election and Dues Proposal',
    description:
      'A sample election seeded when this network was deployed, so the apps can be tried end to end. ' +
      'Every ballot cast here is public and recountable by anyone.',
    questions: DEMO_QUESTIONS,
    startTime: now - 60_000,
    endTime: now + opts.days * 24 * 60 * 60 * 1000,
    resultsVisibility: 'live',
    allowRevote: false,
    eligibleCount: codes.length,
    credentialPublicKeyJwk: keys.publicKeyJwk,
    registrarKeyAttestationSig: keys.attestationSig,
  };

  console.log('[seed] signing ELECTION_CREATE and submitting…');
  const tx = buildElectionCreateTx(status.chainId, definition, opts.commissionSecretKey);
  const result = await node.submitTx(tx);
  if (!result.accepted) throw new Error(`node rejected ELECTION_CREATE: ${result.reason ?? 'no reason given'}`);

  console.log('[seed] waiting for the election to appear on-chain…');
  const onChain = await waitForElection(node, electionId, 60_000);

  return { electionId, title: definition.title, codes, txHash: result.txHash, onChain };
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
  const nodeUrl = argValue('--node');
  const registrarUrl = argValue('--registrar');
  const adminApiKey = process.env.ADMIN_API_KEY;
  const commissionSecretKey = process.env.COMMISSION_SECRET_KEY;

  const missing = [
    !nodeUrl && '--node',
    !registrarUrl && '--registrar',
    !adminApiKey && 'ADMIN_API_KEY (env)',
    !commissionSecretKey && 'COMMISSION_SECRET_KEY (env)',
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`missing: ${missing.join(', ')}`);
    console.error(
      'usage: COMMISSION_SECRET_KEY=… ADMIN_API_KEY=… tsx scripts/seed-demo-election.ts --node URL --registrar URL [--codes 25] [--days 30] [--out file]',
    );
    process.exit(1);
  }

  try {
    const result = await seedDemoElection({
      nodeUrl: nodeUrl!,
      registrarUrl: registrarUrl!,
      adminApiKey: adminApiKey!,
      commissionSecretKey: commissionSecretKey!,
      codeCount: Number(argValue('--codes') ?? 25),
      days: Number(argValue('--days') ?? 30),
    });

    const out = argValue('--out');
    if (out) {
      const path = resolve(out);
      writeFileSync(
        path,
        [
          `# Plainvote demo voter codes for election ${result.electionId}`,
          '# Each code votes once. Only SHA-256(code) is stored by the registrar.',
          ...result.codes,
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      );
      console.log(`[seed] codes written to ${path}`);
    }

    console.log('');
    console.log(`  election id   ${result.electionId}`);
    console.log(`  title         ${result.title}`);
    console.log(`  tx            ${result.txHash ?? 'unknown'}`);
    console.log(`  on chain      ${result.onChain ? 'yes' : 'not yet — check the results app shortly'}`);
    console.log(`  voter codes   ${result.codes.length}`);
    if (!out) {
      console.log('');
      for (const code of result.codes) console.log(`    ${code}`);
    }
    console.log('');
  } catch (e) {
    console.error(`[seed] failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
