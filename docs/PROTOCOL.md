# VoteChain Protocol Specification (v1)

This document specifies the wire formats and consensus rules precisely enough to write an
independent implementation or auditor. The reference implementation lives in
[`packages/protocol`](../packages/protocol/src) - where prose and code disagree, the code is the
spec and the disagreement is a bug worth reporting.

## 1. Canonical encoding

Every hash and signature is computed over **canonical JSON** (`canonicalJson.ts`):

- Object keys sorted by UTF-16 code unit; no whitespace; UTF-8 bytes.
- Numbers MUST be JavaScript-safe integers (`|n| ≤ 2^53−1`). Floats, `-0`, `NaN`, `Infinity`,
  and exponents are rejected. All timestamps are integer **milliseconds since the Unix epoch**.
- `undefined` values are rejected - optional fields are *omitted*, never null-ed or undefined-ed.
- Only plain objects/arrays/strings/booleans/null allowed; max nesting depth 64.

Byte fields are **base64url without padding**, and decoding is *strict*: an encoding whose unused
trailing bits are non-zero is rejected. This matters for consensus - without it, two distinct
strings could decode to the same 32-byte voting token and bypass duplicate detection.

Hashes are lowercase hex SHA-256. `hashJson(x) = sha256(utf8(canonicalJson(x)))`.

## 2. Genesis and chain identity

```jsonc
{
  "name": "VoteChain Local Demo Network",
  "genesisTime": 1782963000000,      // start of slot 0 (ms)
  "slotSeconds": 2,
  "validators": [ { "name": "City Election Commission", "publicKey": "<b64url ed25519>" }, … ],
  "commissionPublicKey": "<b64url ed25519>",   // signs election lifecycle txs
  "registrarPublicKey":  "<b64url ed25519>"    // attests credential keys + issuance commitments
}
```

`chainId = hashJson(genesis)`. The chainId is:
1. embedded in **every transaction's signed body** (cross-chain / testnet replay protection), and
2. block 1's `prevHash`, transitively binding every block to this exact genesis.

P2P peers exchange `chainId` at handshake and disconnect on mismatch. Genesis validation requires
≥ 1 validator, unique validator keys, and distinct commission/registrar keys.

## 3. Transactions

`txHash = hashJson(tx)` over the **full** transaction including signatures. The tally/dedup key
for votes is `(electionId, token)` - never the txHash.

All signature payloads include `type` and `chainId` (domain separation + replay protection).
Ed25519 signatures are RFC 8032-canonical (via `@noble/curves`).

### 3.1 ELECTION_CREATE

```jsonc
{
  "type": "ELECTION_CREATE",
  "chainId": "<hex32>",
  "election": {
    "electionId": "<id>",                    // ids match [A-Za-z0-9_-]{1,64}
    "title": "…", "description": "…",        // description optional (omit when absent)
    "questions": [ { "id", "text", "options": [ { "id", "text" }, … ] }, … ],
    "startTime": ms, "endTime": ms,          // startTime < endTime
    "resultsVisibility": "live" | "afterClose",
    "allowRevote": true | false,
    "eligibleCount": n,                      // public size of the eligible roll
    "credentialPublicKeyJwk": { "e": "AQAB", "kty": "RSA", "n": "<b64url>" },  // EXACTLY these 3 keys
    "registrarKeyAttestationSig": "<b64url ed25519>"
  },
  "commissionSig": "<b64url ed25519>"
}
```

- `commissionSig` = sign(canonical(`{type, chainId, election}`)) by `commissionPublicKey`.
- `registrarKeyAttestationSig` = sign(canonical(`{chainId, electionId, credentialPublicKeyJwk}`))
  by `registrarPublicKey` - the chain only accepts elections whose credential key the registrar
  actually holds.

**Validity** (against the state at the including block's parent):
unique `electionId`; **credential modulus `n` unused by any prior election** (per-election keys
are a consensus rule - they are what scopes credentials to one election); `e = AQAB`;
modulus ≥ 2048 bits (the reference registrar generates 3072); 1–64 questions; 2–64 options each;
unique question/option ids; no duplicate (case/NFC-folded) option labels within a question;
strings NFC-normalized, free of control / zero-width / bidirectional-override characters
(ballot-spoofing guard); length caps title 256 / description 4096 / question 1024 / option 256;
`eligibleCount` 1…10^9; valid commission signature and registrar attestation.

### 3.2 ELECTION_CANCEL

`{type, chainId, electionId, reason?, commissionSig}` - valid only while
`block.timestamp < startTime`, once, commission-signed.

### 3.3 VOTE_CAST

```jsonc
{
  "type": "VOTE_CAST",
  "chainId": "<hex32>",
  "electionId": "<id>",
  "answers": [ { "questionId", "optionId" }, … ],   // ≥1, ≤ #questions, unique questionIds
  "token":       "<b64url 32B>",   // ephemeral Ed25519 public key = anonymous ballot identity
  "tokenPrefix": "<b64url 32B>",   // RSABSSA prepare prefix (random, chosen by the voter's device)
  "nonce": n,                      // client-chosen integer; see revote rule
  "credentialSig": "<b64url>",     // RSABSSA signature (length == modulus length)
  "voteSig": "<b64url ed25519>"    // by the ephemeral SECRET key
}
```

- `voteSig` = sign(canonical(`{type, chainId, electionId, answers, token, tokenPrefix, nonce}`))
  under `token`. A credential thief cannot vote (no secret key); a relay cannot alter answers.
- `credentialSig` verifies under the election's `credentialPublicKeyJwk` over the byte string
  `tokenPrefix || M` where

  ```
  M = utf8("VBC-CRED-v1") || bytes(chainId) || utf8(electionId) || token
  ```

  using **RSABSSA-SHA384-PSS-Randomized** (RFC 9474; salt length 48). The prefix is the
  `prepare()` randomization and travels in the transaction.

**Validity**: election exists, not cancelled, `startTime ≤ block.timestamp < endTime`
(block time, never wall clock - deterministic for every replayer); answers well-formed against
the ballot (partial ballots allowed); token/prefix decode to exactly 32 bytes; both signatures
verify; `credentialSig` length equals the modulus length (RSA malleability guard). If a token
already voted: reject when `allowRevote=false`; otherwise additional votes are accepted.

**Revote rule (replay-proof)**: the counted ballot per `(electionId, token)` is the one with the
**highest `nonce`**, tie-broken by lowest `txHash`. Chain position is never used - re-broadcasting
an old captured vote can never override a newer one. Reference clients use `Date.now()` as nonce.

### 3.4 ISSUANCE_COMMIT

`{type, chainId, electionId, issuedCount, resetCount, issuanceRoot, registrarSig}` - registrar-signed,
at most one per election. `issuedCount` counts **every credential ever issued** for the election
(live issuance rows + audited resets). `issuanceRoot` is a Merkle root over the sorted, salted
leaves `sha256(codeHash | electionId | salt)` - a commitment to the issuance set that does not
enumerate codes. It enables the public reconciliation
`distinct voting tokens ≤ issuedCount ≤ eligibleCount`.

## 4. Blocks and consensus

```jsonc
{ "height": h, "prevHash": "<hex32>", "timestamp": ms, "proposer": "<b64url ed25519>",
  "txRoot": "<hex32>", "txs": [ … ], "proposerSig": "<b64url>" }
```

- `blockHash = hashJson(header)` (the five header fields). `txRoot = hashJson(txs.map(txHash))`.
- `proposerSig` = sign(canonical(header)) by the proposer.
- **Slots**: `slot(t) = floor((t − genesisTime) / (slotSeconds·1000))`;
  `proposer(slot) = validators[slot mod n]`. A block's `timestamp` MUST equal its slot's start
  time exactly, be strictly greater than its parent's, and (when validating live) be at most
  5000 ms in the local future. Offline proposers are simply skipped - the next scheduled
  validator's slot produces the next block.
- **Per-block rules**: `height = parent.height + 1`; `prevHash` = parent's hash (or `chainId` for
  block 1); ≤ 500 txs; ≤ 1 MB canonical; no duplicate txHash in a block; every tx valid against
  the parent state at `block.timestamp`; for `allowRevote=false` elections no two txs in a block
  share a token; no duplicate election creations / cancels / commits / credential moduli in a block.
- **Fork choice**: greatest height; tie → lexicographically lowest block hash.
- **Finality (accountable)**: a block is final once the chain from it to the head (inclusive)
  contains blocks from `floor(n/2)+1` **distinct** validators. Two conflicting finalized branches
  would require some validator to sign two blocks for one slot - recorded, stored, and surfaced
  as **equivocation evidence** (`/status`). Official results should be read at
  `finalizedHeight`; the reference proposer keeps producing empty heartbeat blocks until all
  content-bearing blocks are final, then quiesces.
- Empty blocks are valid (they exist to advance finality).

Validators re-validate everything they store; a node restarted over a tampered `blocks.jsonl`
rejects the tampered block and everything built on it.

## 5. Credential issuance (registrar protocol)

```
voter device                              registrar
────────────                              ─────────
token = new ed25519 keypair
M = "VBC-CRED-v1"‖chainId‖electionId‖pk
prepared = prefix32 ‖ M                   (RSABSSA prepare, Randomized)
blinded  = Blind(pkE, prepared)   ──────▶ verify SHA256(code) registered+active,
     (persist material BEFORE sending)     no issuance row for (codeHash, electionId)
                                           sig' = BlindSign(skE, blinded)
                                           INSERT issuance row (PK = codeHash+electionId)
              ◀──────────────────────────  { blindSignature: sig' }
credentialSig = Finalize(prepared, sig', inv)
verify locally, store
```

- **At most once**: the `(codeHash, electionId)` primary key arbitrates racing requests.
- **Idempotent retry**: replaying the *identical* blinded message returns the stored signature
  (RSA signing is deterministic per message) - a device crash between request and response does
  not burn the voter's only credential. A *different* blinded message → `409 already_issued`.
- **Unlinkability**: the registrar signs a blinded message and never sees `token`,
  `prepared`, or the finished signature. Even a registrar that logs everything cannot connect an
  on-chain ballot to a code (RFC 9474 blindness). This holds against the code *issuer* too - which
  is why credentials are deliberately NOT derived from codes.
- **Code lifecycle**: codes are reusable across elections. `revoke` kills a code;
  `regenerate` atomically replaces it and **transfers** issuance rows (a regenerated code cannot
  double-collect); the audited `issuance reset` (device loss) deletes one issuance row and
  increments the publicly-committed `resetCount`.

## 6. Public verification

Everything needed to verify an election is public:

1. **Recount**: replay blocks from genesis (§4 validity), apply the §3.3 revote rule, count.
2. **Eligibility**: every counted ballot carries a credential signature under the election's
   attested key - one-more-unforgeability (RFC 9474) means N issued credentials cannot yield N+1
   valid ballots.
3. **Reconciliation**: `distinct tokens ≤ issuedCount ≤ eligibleCount` from the ISSUANCE_COMMIT.
4. **Receipts**: a voter's `token` locates their ballot; `voteSig` proves it was cast by the
   key-holder; superseded revotes are visible and ordered by nonce.

`npm run audit:record -- --url <node>` performs all of this against a live node, or
`-- --data <dir>` against raw block files offline.
