import { readFileSync } from 'node:fs';

export interface NodeConfig {
  nodeName: string;
  port: number;
  host?: string;
  /** directory for blocks.jsonl */
  dataDir: string;
  genesisPath: string;
  /** present only on validator nodes */
  validatorSecretKey?: string;
  /** ws:// or http:// URLs of peer nodes (http is converted to ws) */
  peers: string[];
}

export function validateNodeConfig(value: unknown): NodeConfig {
  if (typeof value !== 'object' || value === null) throw new Error('node config: must be an object');
  const c = value as Record<string, unknown>;
  if (typeof c.nodeName !== 'string' || c.nodeName.length === 0) throw new Error('node config: nodeName required');
  if (!Number.isSafeInteger(c.port) || (c.port as number) < 0 || (c.port as number) > 65535) {
    throw new Error('node config: port must be 0..65535');
  }
  if (typeof c.dataDir !== 'string' || c.dataDir.length === 0) throw new Error('node config: dataDir required');
  if (typeof c.genesisPath !== 'string' || c.genesisPath.length === 0) throw new Error('node config: genesisPath required');
  if (c.validatorSecretKey !== undefined && typeof c.validatorSecretKey !== 'string') {
    throw new Error('node config: validatorSecretKey must be a string');
  }
  if (!Array.isArray(c.peers) || c.peers.some((p) => typeof p !== 'string')) {
    throw new Error('node config: peers must be an array of URLs');
  }
  return value as NodeConfig;
}

export function loadNodeConfig(path: string): NodeConfig {
  return validateNodeConfig(JSON.parse(readFileSync(path, 'utf8')));
}
