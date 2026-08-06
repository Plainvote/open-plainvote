import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blindSignCredential,
  blockHash,
  buildBlock,
  buildElectionCreateTx,
  buildVoteCastTx,
  computeChainId,
  createCredentialRequest,
  finalizeCredential,
  generateCredentialKeyPair,
  generateEd25519KeyPair,
  importCredentialPrivateKey,
  registrarAttestationPayload,
  signJson,
  slotStartTime,
  type AnswerChoice,
  type Block,
  type CredentialKeyPairJwks,
  type ElectionDefinition,
  type Genesis,
  type Tx,
  type VoteCastTx,
} from '@votechain/protocol';

/**
 * Node-test fixture. genesisTime is anchored near the wall clock (unlike the
 * protocol fixture) because mempool admission and block clock checks use
 * Date.now().
 */
export interface NodeFixture {
  genesis: Genesis;
  chainId: string;
  validatorKeys: { publicKey: string; secretKey: string }[];
  commissionKey: { publicKey: string; secretKey: string };
  registrarKey: { publicKey: string; secretKey: string };
  credentialKeys: CredentialKeyPairJwks;
  election: ElectionDefinition;
  createTx: Tx;
  makeBlock(args: { slot: number; txs: Tx[]; parent: Block | null; proposerIndex?: number }): Block;
  makeCredential(electionId?: string): Promise<{
    tokenSecretKey: string;
    token: string;
    tokenPrefix: string;
    credentialSig: string;
  }>;
  makeVote(args: {
    answers?: AnswerChoice[];
    nonce?: number;
    credential?: { tokenSecretKey: string; tokenPrefix: string; credentialSig: string };
  }): Promise<VoteCastTx>;
}

export async function makeNodeFixture(opts: { validatorCount?: number; slotSeconds?: number } = {}): Promise<NodeFixture> {
  const validatorCount = opts.validatorCount ?? 3;
  const slotSeconds = opts.slotSeconds ?? 1;
  const validatorKeys = Array.from({ length: validatorCount }, () => generateEd25519KeyPair());
  const commissionKey = generateEd25519KeyPair();
  const registrarKey = generateEd25519KeyPair();

  const genesis: Genesis = {
    name: 'votechain-node-test',
    genesisTime: Date.now() - 120_000, // two minutes of past slots to build in
    slotSeconds,
    validators: validatorKeys.map((k, i) => ({ name: `validator-${i + 1}`, publicKey: k.publicKey })),
    commissionPublicKey: commissionKey.publicKey,
    registrarPublicKey: registrarKey.publicKey,
  };
  const chainId = computeChainId(genesis);

  const credentialKeys = await generateCredentialKeyPair(2048);
  const electionId = 'node-election-1';
  const election: ElectionDefinition = {
    electionId,
    title: 'Node Test Election',
    questions: [
      {
        id: 'q1',
        text: 'Approve?',
        options: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
        ],
      },
    ],
    startTime: genesis.genesisTime,
    endTime: Date.now() + 3_600_000,
    resultsVisibility: 'live',
    allowRevote: true,
    eligibleCount: 50,
    credentialPublicKeyJwk: credentialKeys.publicJwk,
    registrarKeyAttestationSig: signJson(
      registrarAttestationPayload(chainId, electionId, credentialKeys.publicJwk),
      registrarKey.secretKey,
    ),
  };
  const createTx = buildElectionCreateTx(chainId, election, commissionKey.secretKey);
  const registrarPrivateKey = await importCredentialPrivateKey(credentialKeys.privateJwk);

  async function makeCredential(forElectionId = electionId) {
    const material = await createCredentialRequest(credentialKeys.publicJwk, chainId, forElectionId);
    const blindSig = await blindSignCredential(registrarPrivateKey, material.blindedToken);
    const credentialSig = await finalizeCredential(credentialKeys.publicJwk, material, blindSig);
    return {
      tokenSecretKey: material.tokenSecretKey,
      token: material.token,
      tokenPrefix: material.tokenPrefix,
      credentialSig,
    };
  }

  return {
    genesis,
    chainId,
    validatorKeys,
    commissionKey,
    registrarKey,
    credentialKeys,
    election,
    createTx,
    makeBlock(args) {
      const proposerIndex = args.proposerIndex ?? args.slot % validatorCount;
      const key = validatorKeys[proposerIndex]!;
      return buildBlock(
        {
          height: (args.parent?.height ?? 0) + 1,
          prevHash: args.parent ? blockHash(args.parent) : chainId,
          timestamp: slotStartTime(genesis, args.slot),
          proposerPublicKey: key.publicKey,
          txs: args.txs,
        },
        key.secretKey,
      );
    },
    makeCredential,
    async makeVote(args) {
      const credential = args.credential ?? (await makeCredential());
      return buildVoteCastTx({
        chainId,
        electionId,
        answers: args.answers ?? [{ questionId: 'q1', optionId: 'yes' }],
        tokenSecretKey: credential.tokenSecretKey,
        tokenPrefix: credential.tokenPrefix,
        credentialSig: credential.credentialSig,
        nonce: args.nonce ?? 1,
      });
    },
  };
}

export function tempDataDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `votechain-${prefix}-`));
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000, label = 'condition'): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
