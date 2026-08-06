import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  computeChainId,
  ed25519PublicKeyFromSecret,
  validateGenesis,
  type Genesis,
} from '@votechain/protocol';
import type { NodeConfig } from './config';
import { BlockStore } from './blockStore';
import { Chain } from './chain';
import { Mempool } from './mempool';
import { Proposer } from './proposer';
import { P2PNetwork } from './p2p';
import { WsHub } from './wsHub';
import { createNodeApi } from './api';

export interface VoteChainNode {
  app: FastifyInstance;
  chain: Chain;
  mempool: Mempool;
  p2p: P2PNetwork;
  chainId: string;
  genesis: Genesis;
  /** actual port after listen (config may say 0 for tests) */
  port: number;
  url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createNode(config: NodeConfig, genesisValue?: unknown): Promise<VoteChainNode> {
  const parsedGenesis = genesisValue ?? (JSON.parse(readFileSync(config.genesisPath, 'utf8')) as unknown);
  const genesis = validateGenesis(parsedGenesis);
  const chainId = computeChainId(genesis);

  if (config.validatorSecretKey) {
    const publicKey = ed25519PublicKeyFromSecret(config.validatorSecretKey);
    if (!genesis.validators.some((v) => v.publicKey === publicKey)) {
      throw new Error(`node config: validator key ${publicKey} is not in the genesis validator set`);
    }
  }

  const store = new BlockStore(join(config.dataDir, 'blocks.jsonl'));
  const chain = new Chain(genesis, chainId, store);
  const loaded = await chain.loadFromStore();
  if (loaded > 0) console.log(`[${config.nodeName}] restored ${loaded} blocks (height ${chain.height})`);

  const mempool = new Mempool(chain);
  const p2p = new P2PNetwork(chain, mempool, config.peers, config.nodeName);
  const hub = new WsHub(chainId, () => ({ height: chain.height, headHash: chain.headBlockHash }));

  const proposer = config.validatorSecretKey
    ? new Proposer(chain, mempool, config.validatorSecretKey, (block) => p2p.broadcastBlock(block))
    : null;

  chain.onHead((event) => {
    hub.broadcastHead(event);
  });

  const app = await createNodeApi({
    chain,
    mempool,
    p2p,
    nodeName: config.nodeName,
    isValidator: proposer !== null,
  });

  let actualPort = config.port;

  return {
    app,
    chain,
    mempool,
    p2p,
    chainId,
    genesis,
    get port() {
      return actualPort;
    },
    get url() {
      return `http://${config.host ?? '127.0.0.1'}:${actualPort}`;
    },
    async start() {
      await app.listen({ port: config.port, host: config.host ?? '127.0.0.1' });
      const address = app.server.address();
      if (typeof address === 'object' && address !== null) actualPort = address.port;

      // One upgrade router for both WebSocket endpoints.
      app.server.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/p2p') p2p.handleUpgrade(req, socket, head);
        else if (path === '/ws') hub.handleUpgrade(req, socket, head);
        else socket.destroy();
      });

      p2p.connectToPeers();
      proposer?.start();
      console.log(
        `[${config.nodeName}] listening on http://${config.host ?? '127.0.0.1'}:${actualPort} ` +
          `(chain ${chainId.slice(0, 12)}…, ${proposer ? 'validator' : 'observer'})`,
      );
    },
    async stop() {
      proposer?.stop();
      p2p.stop();
      hub.close();
      await app.close();
    },
  };
}
