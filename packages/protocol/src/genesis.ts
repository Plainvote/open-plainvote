import { hashJson } from './hash';
import { isEd25519PublicKey } from './ed25519';
import type { Genesis, GenesisValidator } from './types';

/**
 * chainId = hash of the canonical genesis content. It doubles as block 1's
 * prevHash, so every block is transitively bound to this exact genesis, and
 * it is embedded in every transaction's signed body (cross-chain replay
 * protection).
 */
export function computeChainId(genesis: Genesis): string {
  return hashJson(genesis as unknown);
}

export function slotMs(genesis: Genesis): number {
  return genesis.slotSeconds * 1000;
}

/** Slot index containing `timestampMs`; -1 if before genesis. */
export function slotOfTimestamp(genesis: Genesis, timestampMs: number): number {
  const delta = timestampMs - genesis.genesisTime;
  if (delta < 0) return -1;
  return Math.floor(delta / slotMs(genesis));
}

export function slotStartTime(genesis: Genesis, slot: number): number {
  return genesis.genesisTime + slot * slotMs(genesis);
}

export function proposerForSlot(genesis: Genesis, slot: number): GenesisValidator {
  return genesis.validators[slot % genesis.validators.length]!;
}

/** Majority of distinct proposers required for accountable finality. */
export function finalityThreshold(genesis: Genesis): number {
  return Math.floor(genesis.validators.length / 2) + 1;
}

/**
 * Structural validation of a parsed genesis file. Throws with a descriptive
 * message on the first problem found.
 */
export function validateGenesis(value: unknown): Genesis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('genesis: must be an object');
  }
  const g = value as Record<string, unknown>;
  if (typeof g.name !== 'string' || g.name.length === 0 || g.name.length > 128) {
    throw new Error('genesis: name must be a non-empty string (max 128 chars)');
  }
  if (!Number.isSafeInteger(g.genesisTime) || (g.genesisTime as number) <= 0) {
    throw new Error('genesis: genesisTime must be a positive integer (ms epoch)');
  }
  if (!Number.isSafeInteger(g.slotSeconds) || (g.slotSeconds as number) < 1 || (g.slotSeconds as number) > 3600) {
    throw new Error('genesis: slotSeconds must be an integer between 1 and 3600');
  }
  if (!Array.isArray(g.validators) || g.validators.length === 0 || g.validators.length > 128) {
    throw new Error('genesis: validators must be a non-empty array (max 128)');
  }
  const seenKeys = new Set<string>();
  for (const v of g.validators as unknown[]) {
    if (typeof v !== 'object' || v === null) throw new Error('genesis: validator entries must be objects');
    const val = v as Record<string, unknown>;
    if (typeof val.name !== 'string' || val.name.length === 0 || val.name.length > 128) {
      throw new Error('genesis: validator name must be a non-empty string');
    }
    if (!isEd25519PublicKey(val.publicKey)) {
      throw new Error(`genesis: validator "${val.name}" publicKey is not a valid Ed25519 key`);
    }
    if (seenKeys.has(val.publicKey)) {
      throw new Error(`genesis: duplicate validator publicKey (${val.name})`);
    }
    seenKeys.add(val.publicKey);
  }
  if (!isEd25519PublicKey(g.commissionPublicKey)) {
    throw new Error('genesis: commissionPublicKey is not a valid Ed25519 key');
  }
  if (!isEd25519PublicKey(g.registrarPublicKey)) {
    throw new Error('genesis: registrarPublicKey is not a valid Ed25519 key');
  }
  if (g.commissionPublicKey === g.registrarPublicKey) {
    throw new Error('genesis: commission and registrar keys must be distinct');
  }
  return value as Genesis;
}
