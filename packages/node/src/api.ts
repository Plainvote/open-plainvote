import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  electionStatusAt,
  integrityInfo,
  resultsVisibleAt,
  selectCountedVote,
  slotOfTimestamp,
  tallyElection,
  txShapeError,
  type ElectionDetail,
  type ElectionEntry,
  type ElectionSummary,
  type FinalityInfo,
  type NodeStatusInfo,
  type ResultsResponse,
  type Tx,
  type VoteLookupRecord,
  type VoteLookupResponse,
} from '@votechain/protocol';
import type { Chain } from './chain';
import type { Mempool } from './mempool';
import type { P2PNetwork } from './p2p';

export interface ApiDeps {
  chain: Chain;
  mempool: Mempool;
  p2p: P2PNetwork;
  nodeName: string;
  isValidator: boolean;
}

function maxVoteBlockHeight(entry: ElectionEntry): number {
  let max = entry.createdAtHeight;
  for (const records of entry.votesByToken.values()) {
    for (const r of records) if (r.blockHeight > max) max = r.blockHeight;
  }
  if (entry.commit && entry.commit.blockHeight > max) max = entry.commit.blockHeight;
  return max;
}

export async function createNodeApi(deps: ApiDeps): Promise<FastifyInstance> {
  const { chain, mempool, p2p } = deps;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: true });

  const finality = (entry?: ElectionEntry): FinalityInfo => {
    const finalizedHeight = chain.finalizedHeight();
    return {
      headHash: chain.headBlockHash,
      height: chain.height,
      finalizedHeight,
      tallyIsFinal: entry
        ? electionStatusAt(entry.definition, entry.cancelled, Date.now()) !== 'open' &&
          maxVoteBlockHeight(entry) <= finalizedHeight
        : chain.height === finalizedHeight,
    };
  };

  app.get('/status', async (): Promise<NodeStatusInfo> => {
    return {
      chainId: chain.chainId,
      nodeName: deps.nodeName,
      height: chain.height,
      headHash: chain.headBlockHash,
      finalizedHeight: chain.finalizedHeight(),
      slot: slotOfTimestamp(chain.genesis, Date.now()),
      time: Date.now(),
      validators: chain.genesis.validators,
      peerCount: p2p.peerCount,
      mempoolSize: mempool.size,
      isValidator: deps.isValidator,
      equivocations: chain.equivocations,
    };
  });

  app.get('/genesis', async () => ({ chainId: chain.chainId, genesis: chain.genesis }));

  app.get<{ Querystring: { from?: string; limit?: string } }>('/blocks', async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    const fromParam = parseInt(req.query.from ?? '', 10);
    const from = Number.isSafeInteger(fromParam) && fromParam >= 1 ? fromParam : Math.max(1, chain.height - limit + 1);
    return { blocks: chain.bestChainSlice(from, limit), height: chain.height };
  });

  app.get<{ Params: { height: string } }>('/blocks/:height', async (req, reply) => {
    const height = parseInt(req.params.height, 10);
    const block = Number.isSafeInteger(height) ? chain.blockAtHeight(height) : undefined;
    if (!block) return reply.code(404).send({ error: 'not_found', message: 'no block at that height on the best chain' });
    return block;
  });

  app.get<{ Params: { hash: string } }>('/transactions/:hash', async (req, reply) => {
    const location = chain.getTxLocation(req.params.hash);
    if (!location) return reply.code(404).send({ error: 'not_found', message: 'transaction not on the best chain' });
    const block = chain.blockAtHeight(location.blockHeight);
    const tx = block?.txs[location.txIndex];
    if (!block || !tx) return reply.code(404).send({ error: 'not_found', message: 'transaction not on the best chain' });
    return { txHash: req.params.hash, blockHeight: location.blockHeight, txIndex: location.txIndex, tx };
  });

  app.get('/elections', async () => {
    const now = Date.now();
    const elections: ElectionSummary[] = [...chain.state.elections.values()]
      .map((entry) => ({
        electionId: entry.definition.electionId,
        title: entry.definition.title,
        status: electionStatusAt(entry.definition, entry.cancelled, now),
        startTime: entry.definition.startTime,
        endTime: entry.definition.endTime,
        resultsVisibility: entry.definition.resultsVisibility,
        allowRevote: entry.definition.allowRevote,
        eligibleCount: entry.definition.eligibleCount,
        questionCount: entry.definition.questions.length,
        turnout: entry.votesByToken.size,
        createdAtHeight: entry.createdAtHeight,
      }))
      .sort((a, b) => a.startTime - b.startTime || a.electionId.localeCompare(b.electionId));
    return { elections };
  });

  app.get<{ Params: { id: string } }>('/elections/:id', async (req, reply) => {
    const entry = chain.state.elections.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'not_found', message: 'unknown election' });
    const detail: ElectionDetail = {
      definition: entry.definition,
      status: electionStatusAt(entry.definition, entry.cancelled, Date.now()),
      cancelled: entry.cancelled,
      ...(entry.cancelReason !== undefined ? { cancelReason: entry.cancelReason } : {}),
      createdAtHeight: entry.createdAtHeight,
      turnout: entry.votesByToken.size,
      commit: entry.commit ?? null,
    };
    return detail;
  });

  app.get<{ Params: { id: string } }>('/elections/:id/results', async (req, reply) => {
    const entry = chain.state.elections.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'not_found', message: 'unknown election' });
    const now = Date.now();
    const tally = tallyElection(entry);
    const visible = resultsVisibleAt(entry.definition, entry.cancelled, now);
    const response: ResultsResponse = {
      electionId: entry.definition.electionId,
      title: entry.definition.title,
      status: electionStatusAt(entry.definition, entry.cancelled, now),
      resultsVisibility: entry.definition.resultsVisibility,
      startTime: entry.definition.startTime,
      endTime: entry.definition.endTime,
      allowRevote: entry.definition.allowRevote,
      turnout: { distinctTokens: tally.distinctTokens, voteTxCount: tally.voteTxCount },
      resultsVisible: visible,
      questions: visible ? tally.questions : null,
      integrity: integrityInfo(entry, tally),
      finality: finality(entry),
    };
    return response;
  });

  app.get<{ Params: { id: string; token: string } }>('/elections/:id/votes/:token', async (req, reply) => {
    const entry = chain.state.elections.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'not_found', message: 'unknown election' });
    const records = entry.votesByToken.get(req.params.token) ?? [];
    const answersVisible = resultsVisibleAt(entry.definition, entry.cancelled, Date.now());
    const counted = selectCountedVote(records);
    const finalizedHeight = chain.finalizedHeight();
    const lookupRecords: VoteLookupRecord[] = records.map((r) => ({
      txHash: r.txHash,
      blockHeight: r.blockHeight,
      txIndex: r.txIndex,
      nonce: r.nonce,
      counted: counted !== undefined && r.txHash === counted.txHash,
      supersededByTxHash: counted !== undefined && r.txHash !== counted.txHash ? counted.txHash : null,
      answers: answersVisible ? r.answers : null,
    }));
    const response: VoteLookupResponse = {
      found: records.length > 0,
      electionId: req.params.id,
      token: req.params.token,
      answersVisible,
      records: lookupRecords,
      countedTxHash: counted?.txHash ?? null,
      isFinal: records.length > 0 && records.every((r) => r.blockHeight <= finalizedHeight),
    };
    return response;
  });

  app.post<{ Body: { tx?: Tx } }>('/transactions', async (req, reply) => {
    const tx = req.body?.tx;
    const shapeErr = txShapeError(tx);
    if (shapeErr) {
      return reply.code(400).send({ accepted: false, reason: shapeErr });
    }
    const result = await mempool.admit(tx as Tx);
    if (!result.accepted) {
      const conflict = /duplicate|already/.test(result.reason ?? '');
      return reply.code(conflict ? 409 : 400).send({ accepted: false, txHash: result.txHash, reason: result.reason });
    }
    if (result.isNew) p2p.broadcastTx(tx as Tx);
    return reply.code(202).send({ accepted: true, txHash: result.txHash });
  });

  return app;
}
