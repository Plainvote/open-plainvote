import { hashJson } from './hash';
import { signJson, verifyJson } from './ed25519';
import { txHash } from './tx';
import type { Block, BlockHeader, Tx } from './types';

export function blockHeaderOf(b: BlockHeader | Block): BlockHeader {
  const { height, prevHash, timestamp, proposer, txRoot } = b;
  return { height, prevHash, timestamp, proposer, txRoot };
}

export function blockHash(b: BlockHeader | Block): string {
  return hashJson(blockHeaderOf(b));
}

export function computeTxRoot(txs: Tx[]): string {
  return hashJson(txs.map(txHash));
}

export interface BuildBlockArgs {
  height: number;
  prevHash: string;
  timestamp: number;
  proposerPublicKey: string;
  txs: Tx[];
}

export function buildBlock(args: BuildBlockArgs, proposerSecretKey: string): Block {
  const header: BlockHeader = {
    height: args.height,
    prevHash: args.prevHash,
    timestamp: args.timestamp,
    proposer: args.proposerPublicKey,
    txRoot: computeTxRoot(args.txs),
  };
  const proposerSig = signJson(header, proposerSecretKey);
  return { ...header, txs: args.txs, proposerSig };
}

export function verifyBlockSignature(b: Block): boolean {
  return verifyJson(b.proposerSig, blockHeaderOf(b), b.proposer);
}
