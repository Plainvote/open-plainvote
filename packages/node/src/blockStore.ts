import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Block } from '@votechain/protocol';

/**
 * Append-only JSONL block persistence: one block per line, in acceptance
 * order (parents always precede children). Every accepted block is stored,
 * including side branches — the in-memory tree re-derives the best chain on
 * boot. Deliberately boring and greppable: the audit script reads this file
 * directly.
 */
export class BlockStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(block: Block): void {
    appendFileSync(this.filePath, JSON.stringify(block) + '\n', 'utf8');
  }

  loadAll(): Block[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const blocks: Block[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      blocks.push(JSON.parse(line) as Block);
    }
    return blocks;
  }
}
