import { sha256Hex } from './hash';

/**
 * Minimal Merkle root over hex leaves, used for the registrar's issuance
 * commitment. Odd nodes are paired with themselves. Leaves and inner nodes are
 * domain-separated so a leaf can never be confused with an inner node.
 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex('VBC-MERKLE-EMPTY');
  let level = leaves.map((l) => sha256Hex('VBC-MERKLE-LEAF:' + l));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(sha256Hex('VBC-MERKLE-NODE:' + a + ':' + b));
    }
    level = next;
  }
  return level[0]!;
}
