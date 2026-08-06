import { readFileSync } from 'node:fs';
import { isEd25519PublicKey, isHex } from '@votechain/protocol';

export interface RegistrarConfig {
  port: number;
  host?: string;
  /** better-sqlite3 path, or ':memory:' for tests */
  dbPath: string;
  adminApiKey: string;
  chainId: string;
  /** long-term registrar Ed25519 keypair (public key is pinned in genesis) */
  registrarSecretKey: string;
  registrarPublicKey: string;
  /** chain node the registrar submits ISSUANCE_COMMIT transactions to */
  nodeUrl: string;
  /** RSA modulus size for per-election credential keys (default 3072) */
  credentialModulusBits?: number;
  /**
   * Refuse to issue credentials for an election that has no voter roll bound.
   *
   * Leave false for a single-tenant deployment, where every registered code is
   * by definition part of the one electorate. Set true for any registrar shared
   * by more than one organization: without it, an unbound election is open to
   * every active code on the registrar, including other tenants' voters.
   */
  requireRollBinding?: boolean;
}

export function validateRegistrarConfig(value: unknown): RegistrarConfig {
  if (typeof value !== 'object' || value === null) throw new Error('registrar config: must be an object');
  const c = value as Record<string, unknown>;
  if (!Number.isSafeInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535) {
    throw new Error('registrar config: port must be 1..65535');
  }
  if (typeof c.dbPath !== 'string' || c.dbPath.length === 0) throw new Error('registrar config: dbPath required');
  if (typeof c.adminApiKey !== 'string' || c.adminApiKey.length < 16) {
    throw new Error('registrar config: adminApiKey must be at least 16 characters');
  }
  if (!isHex(c.chainId, 32)) throw new Error('registrar config: chainId must be 32-byte hex');
  if (typeof c.registrarSecretKey !== 'string') throw new Error('registrar config: registrarSecretKey required');
  if (!isEd25519PublicKey(c.registrarPublicKey)) throw new Error('registrar config: registrarPublicKey invalid');
  if (typeof c.nodeUrl !== 'string' || !/^https?:\/\//.test(c.nodeUrl)) {
    throw new Error('registrar config: nodeUrl must be an http(s) URL');
  }
  if (c.credentialModulusBits !== undefined) {
    if (!Number.isSafeInteger(c.credentialModulusBits) || (c.credentialModulusBits as number) < 2048) {
      throw new Error('registrar config: credentialModulusBits must be >= 2048');
    }
  }
  if (c.requireRollBinding !== undefined && typeof c.requireRollBinding !== 'boolean') {
    throw new Error('registrar config: requireRollBinding must be a boolean');
  }
  return value as RegistrarConfig;
}

export function loadRegistrarConfig(path: string): RegistrarConfig {
  return validateRegistrarConfig(JSON.parse(readFileSync(path, 'utf8')));
}
