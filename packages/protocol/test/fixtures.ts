import {
  applyBlock,
  blindSignCredential,
  blockHash,
  buildBlock,
  buildElectionCreateTx,
  buildVoteCastTx,
  computeChainId,
  createCredentialRequest,
  createInitialState,
  finalizeCredential,
  generateCredentialKeyPair,
  generateEd25519KeyPair,
  importCredentialPrivateKey,
  proposerForSlot,
  registrarAttestationPayload,
  signJson,
  slotStartTime,
  type AnswerChoice,
  type Block,
  type ChainState,
  type CredentialKeyPairJwks,
  type ElectionDefinition,
  type Genesis,
  type Tx,
  type VoteCastTx,
} from '@votechain/protocol';

/**
 * Shared test fixture: 3 validators, commission + registrar keys, one election
 * with a real RSABSSA credential key (2048-bit for test speed; consensus floor
 * is also 2048).
 */
export interface Fixture {
  genesis: Genesis;
  chainId: string;
  validatorKeys: { publicKey: string; secretKey: string }[];
  commissionKey: { publicKey: string; secretKey: string };
  registrarKey: { publicKey: string; secretKey: string };
  credentialKeys: CredentialKeyPairJwks;
  election: ElectionDefinition;
  createTx: Tx;

  /** state with the election created in block 1 */
  freshState(): ChainState;
  stateAfterBlock1(): { state: ChainState; block1: Block };
  makeCredential(electionId?: string): Promise<{
    tokenSecretKey: string;
    token: string;
    tokenPrefix: string;
    credentialSig: string;
  }>;
  makeVote(args: {
    answers?: AnswerChoice[];
    nonce?: number;
    electionId?: string;
    credential?: { tokenSecretKey: string; tokenPrefix: string; credentialSig: string };
  }): Promise<VoteCastTx>;
  makeBlock(args: { slot: number; txs: Tx[]; parent: Block | null; proposerIndex?: number }): Block;
}

export const GENESIS_TIME = 1_750_000_000_000;
export const SLOT_SECONDS = 2;

export async function makeFixture(): Promise<Fixture> {
  const validatorKeys = [generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()];
  const commissionKey = generateEd25519KeyPair();
  const registrarKey = generateEd25519KeyPair();

  const genesis: Genesis = {
    name: 'votechain-test',
    genesisTime: GENESIS_TIME,
    slotSeconds: SLOT_SECONDS,
    validators: validatorKeys.map((k, i) => ({ name: `validator-${i + 1}`, publicKey: k.publicKey })),
    commissionPublicKey: commissionKey.publicKey,
    registrarPublicKey: registrarKey.publicKey,
  };
  const chainId = computeChainId(genesis);

  const credentialKeys = await generateCredentialKeyPair(2048);
  const electionId = 'election-1';
  const election: ElectionDefinition = {
    electionId,
    title: 'Test Election',
    questions: [
      {
        id: 'q1',
        text: 'Who should be mayor?',
        options: [
          { id: 'alice', text: 'Alice Johnson' },
          { id: 'bob', text: 'Bob Smith' },
        ],
      },
      {
        id: 'q2',
        text: 'Should the measure pass?',
        options: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
        ],
      },
    ],
    startTime: GENESIS_TIME,
    endTime: GENESIS_TIME + 3_600_000,
    resultsVisibility: 'live',
    allowRevote: true,
    eligibleCount: 100,
    credentialPublicKeyJwk: credentialKeys.publicJwk,
    registrarKeyAttestationSig: signJson(
      registrarAttestationPayload(chainId, electionId, credentialKeys.publicJwk),
      registrarKey.secretKey,
    ),
  };
  const createTx = buildElectionCreateTx(chainId, election, commissionKey.secretKey);

  const registrarPrivateKey = await importCredentialPrivateKey(credentialKeys.privateJwk);

  function makeBlock(args: { slot: number; txs: Tx[]; parent: Block | null; proposerIndex?: number }): Block {
    const proposerIndex = args.proposerIndex ?? args.slot % genesis.validators.length;
    const proposerKey = validatorKeys[proposerIndex]!;
    return buildBlock(
      {
        height: (args.parent?.height ?? 0) + 1,
        prevHash: args.parent ? blockHash(args.parent) : chainId,
        timestamp: slotStartTime(genesis, args.slot),
        proposerPublicKey: proposerKey.publicKey,
        txs: args.txs,
      },
      proposerKey.secretKey,
    );
  }

  function stateAfterBlock1(): { state: ChainState; block1: Block } {
    const state = createInitialState(chainId);
    const block1 = makeBlock({ slot: 1, txs: [createTx], parent: null });
    applyBlock(state, block1);
    return { state, block1 };
  }

  async function makeCredential(forElectionId: string = electionId) {
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

  async function makeVote(args: {
    answers?: AnswerChoice[];
    nonce?: number;
    electionId?: string;
    credential?: { tokenSecretKey: string; tokenPrefix: string; credentialSig: string };
  }): Promise<VoteCastTx> {
    const credential = args.credential ?? (await makeCredential(args.electionId ?? electionId));
    return buildVoteCastTx({
      chainId,
      electionId: args.electionId ?? electionId,
      answers: args.answers ?? [
        { questionId: 'q1', optionId: 'alice' },
        { questionId: 'q2', optionId: 'yes' },
      ],
      tokenSecretKey: credential.tokenSecretKey,
      tokenPrefix: credential.tokenPrefix,
      credentialSig: credential.credentialSig,
      nonce: args.nonce ?? 1,
    });
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
    freshState: () => createInitialState(chainId),
    stateAfterBlock1,
    makeCredential,
    makeVote,
    makeBlock,
  };
}

export function slotForProposer(genesis: Genesis, proposerIndex: number, minSlot: number): number {
  let slot = minSlot;
  while (proposerForSlot(genesis, slot).publicKey !== genesis.validators[proposerIndex]!.publicKey) {
    slot++;
  }
  return slot;
}
