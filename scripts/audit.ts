import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  computeChainId,
  electionStatusAt,
  integrityInfo,
  NodeClient,
  tallyElection,
  validateGenesis,
  type Block,
  type Genesis,
  type QuestionTally,
} from '@votechain/protocol';
import { Chain } from '@votechain/node';

/**
 * Independent election auditor.
 *
 * Replays raw block data through the SAME consensus validation every node
 * runs — every signature, every blind credential, every slot rule — and
 * recomputes all tallies from scratch. Point it at a node's data directory
 * (offline) or a node URL (live), optionally diffing against the node's own
 * /results answers.
 *
 *   npm run audit:record -- --data .data/node1
 *   npm run audit:record -- --url http://127.0.0.1:4001
 */

const ROOT = resolve(import.meta.dirname, '..');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Source {
  label: string;
  genesis: Genesis;
  blocks: Block[];
  /** present only in --url mode */
  client?: NodeClient;
}

async function loadSource(): Promise<Source> {
  const url = argValue('--url');
  const dataDir = argValue('--data');

  if (url) {
    const client = new NodeClient(url);
    const { genesis } = await (async () => {
      const res = await fetch(url.replace(/\/$/, '') + '/genesis');
      if (!res.ok) throw new Error(`GET /genesis failed: HTTP ${res.status}`);
      return (await res.json()) as { genesis: unknown };
    })();
    const status = await client.status();
    const blocks: Block[] = [];
    for (let from = 1; from <= status.height; from += 200) {
      const page = await client.blocks(from, 200);
      blocks.push(...page.blocks);
    }
    return { label: url, genesis: validateGenesis(genesis), blocks, client };
  }

  const dir = resolve(ROOT, dataDir ?? '.data/node1');
  const genesisPath = argValue('--genesis') ?? join(ROOT, '.data', 'genesis.json');
  if (!existsSync(genesisPath)) throw new Error(`genesis file not found: ${genesisPath} (use --genesis)`);
  const genesis = validateGenesis(JSON.parse(readFileSync(genesisPath, 'utf8')));
  const blocksPath = join(dir, 'blocks.jsonl');
  if (!existsSync(blocksPath)) throw new Error(`no blocks.jsonl in ${dir}`);
  const blocks = readFileSync(blocksPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Block);
  return { label: blocksPath, genesis, blocks };
}

function bar(count: number, max: number): string {
  const width = max > 0 ? Math.round((count / max) * 30) : 0;
  return '█'.repeat(width).padEnd(30, '·');
}

function printQuestion(q: QuestionTally): void {
  console.log(`  ${q.text}`);
  const max = Math.max(...q.options.map((o) => o.count), 1);
  for (const o of q.options) {
    const pct = q.totalAnswers > 0 ? ((o.count / q.totalAnswers) * 100).toFixed(1).padStart(5) : '  0.0';
    console.log(`    ${o.text.padEnd(30).slice(0, 30)} ${bar(o.count, max)} ${String(o.count).padStart(6)}  ${pct}%`);
  }
}

async function main(): Promise<void> {
  const source = await loadSource();
  const chainId = computeChainId(source.genesis);
  console.log(`\nVoteChain independent audit`);
  console.log(`  source   ${source.label}`);
  console.log(`  chainId  ${chainId}`);
  console.log(`  blocks   ${source.blocks.length} to verify\n`);

  // Replay through the real consensus validation (signatures, credentials,
  // slots, in-block rules) — skipClockCheck because historical blocks are in
  // the past by definition.
  const chain = new Chain(source.genesis, chainId);
  let rejected = 0;
  for (const block of source.blocks) {
    const result = await chain.addBlock(block, { skipStore: true, skipClockCheck: true });
    if (!result.accepted) {
      rejected++;
      console.error(`  ✗ REJECTED block height=${block.height}: ${result.reason}`);
    }
  }
  const verified = source.blocks.length - rejected;
  console.log(`  ✓ ${verified}/${source.blocks.length} blocks fully re-verified (best chain height ${chain.height}, finalized ${chain.finalizedHeight()})`);
  if (chain.equivocations.length > 0) {
    console.error(`  ⚠ EQUIVOCATION EVIDENCE: ${chain.equivocations.length} record(s)`);
    for (const eq of chain.equivocations) {
      console.error(`    proposer ${eq.proposer.slice(0, 16)}… signed ${eq.blockHashes.length} blocks at height ${eq.height}`);
    }
  }

  let integrityFailures = 0;
  let mismatches = 0;
  const now = Date.now();

  for (const [electionId, entry] of chain.state.elections) {
    const tally = tallyElection(entry);
    const integrity = integrityInfo(entry, tally);
    const status = electionStatusAt(entry.definition, entry.cancelled, now);
    console.log(`\nElection: ${entry.definition.title} (${electionId.slice(0, 8)}…) — ${status}`);
    console.log(
      `  turnout  ${tally.distinctTokens} ballots counted / ${tally.voteTxCount} vote txs / ${entry.definition.eligibleCount} eligible`,
    );
    for (const q of tally.questions) printQuestion(q);

    const issued = integrity.issuedCount;
    const reconciliation =
      issued === null
        ? `distinct(${integrity.distinctTokens}) ≤ issued(?) ≤ eligible(${integrity.eligibleCount}) — awaiting issuance commitment`
        : `distinct(${integrity.distinctTokens}) ≤ issued(${issued}) ≤ eligible(${integrity.eligibleCount})`;
    if (integrity.exceedsEligible) {
      integrityFailures++;
      console.error(`  ✗ INTEGRITY FAILURE: ${reconciliation}`);
    } else {
      console.log(`  ✓ reconciliation ${reconciliation}${integrity.resetCount ? ` (audited resets: ${integrity.resetCount})` : ''}`);
    }

    // Live mode: our independently computed tally must equal the node's answer.
    if (source.client) {
      const nodeResults = await source.client.results(electionId);
      const sameTurnout =
        nodeResults.turnout.distinctTokens === tally.distinctTokens &&
        nodeResults.turnout.voteTxCount === tally.voteTxCount;
      const sameQuestions =
        nodeResults.questions === null || JSON.stringify(nodeResults.questions) === JSON.stringify(tally.questions);
      if (sameTurnout && sameQuestions) {
        console.log(`  ✓ node's published results match the independent recount`);
      } else {
        mismatches++;
        console.error(`  ✗ NODE RESULTS MISMATCH — the node's published tally differs from the recount!`);
      }
    }
  }

  console.log('');
  if (rejected > 0 || integrityFailures > 0 || mismatches > 0) {
    console.error(
      `AUDIT FAILED: ${rejected} invalid block(s), ${integrityFailures} integrity failure(s), ${mismatches} mismatch(es)`,
    );
    process.exit(1);
  }
  console.log('AUDIT PASSED: every block, signature, and credential verified; tallies recomputed independently.');
}

main().catch((e: Error) => {
  console.error(`audit error: ${e.message}`);
  process.exit(1);
});
