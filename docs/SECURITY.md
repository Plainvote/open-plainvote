# VoteChain Security Model

This is an honest accounting of what VoteChain does and does not protect. Election software that
overstates its guarantees is dangerous; read the **Not provided** section as carefully as the rest.

> **Status: reference implementation.** VoteChain demonstrates a serious protocol design, but it
> has not undergone independent cryptographic or software audit and is **not production-ready for
> a binding political election** without that work (see Roadmap).

> **Scope note.** This document covers the engine. Plainvote's hosted commercial layer (accounts,
> billing, emailed code delivery) is a separate proprietary service with its own threat model; it
> talks to the engine only over the same public HTTP APIs documented here.

## 1. The stated assumption this system builds on

A government registrar issues each eligible voter a secret code, verifying eligibility at issuance,
and the issuance channel does not retain a code→person link. This assumption comes from the project
brief and is honored, with one deliberate hardening:

**Ballot anonymity survives even if that assumption fails.** Votes are authorized by RFC 9474
*blind-signature* credentials: the registrar signs the voter's ballot key without ever seeing it.
Even an issuer that secretly retained a complete code→person ledger, and a registrar that logged
every request, cannot link an on-chain ballot to a code or a person - the cryptographic blinding
prevents it. (For exactly this reason, credentials are random, never *derived* from codes: a
derivation would let anyone who ever learns a code deanonymize that ballot offline.)

What the registrar *does* learn is **participation**: which codes obtained a credential per
election - the digital equivalent of a poll book. It never learns which ballot is whose.

## 2. Trust matrix - who can do what

| Actor | Trusted for | Can do (limits) | Cannot do |
|---|---|---|---|
| **Registrar** | Enfranchisement integrity; not logging IP↔code | Deny credentials (visible to the voter, disenfranchising); mint ghost credentials - **detectable** by the public reconciliation `distinct ballots ≤ issuedCount ≤ eligibleCount` but not preventable in v1 | Link a ballot to a code/person; alter or forge a cast ballot; issue two credentials for one code (PK-enforced, audited resets are publicly counted) |
| **Commission** | Honest ballot text and scheduling | Create/cancel elections (signed, public, cancel only pre-start) | Forge or alter votes; create an election with a credential key the registrar doesn't hold (attestation rule) |
| **Single validator** | - | Propose blocks in its slots; briefly delay txs | Forge votes; include invalid txs (every node re-validates); censor for long (other proposers include the tx; clients submit to all nodes) |
| **Validator majority (colluding)** | Liveness, censorship-resistance | Censor transactions; reorg below finality - but conflicting finalized branches force **detectable equivocation** (signed evidence, published) | Forge votes or credentials; alter recorded ballots undetectably |
| **Voter's device** | Everything the voter does | A compromised device can steal the code/credential, vote as the voter, and deanonymize that voter | - |
| **Anyone (public)** | - | Recount every ballot, re-verify every signature and credential, reconcile issuance counts: `npm run audit:record` | Learn who cast any ballot |

## 3. Security properties provided

- **Eligibility & one-ballot-per-voter.** Every counted ballot carries a valid RSABSSA credential
  under the election's registrar-attested key. One credential per code per election at issuance
  (race-safe primary key); one counted ballot per credential on chain. RFC 9474
  one-more-unforgeability: N issued credentials can never produce N+1 valid ballots.
- **Electorate scoping (multi-tenant registrars).** Codes carry a `rollId` and an election can be
  bound to one roll; the registrar then issues credentials only to codes from that roll. Without
  this, every active code on a registrar is eligible for *every* election on it - which is correct
  for a single-tenant deployment and is a cross-tenant enfranchisement hole for a shared one, and
  a silent one: the extra ballots stay under `eligibleCount`, so the public reconciliation never
  fires. **Any registrar serving more than one organization must set `requireRollBinding: true`,**
  which additionally refuses to issue anything for an election with no roll bound. A regenerated
  code inherits its roll, so the support path cannot accidentally disenfranchise the voter it was
  meant to rescue.
- **Ballot anonymity.** Blindness of the credential (unconditional against the registrar/issuer)
  plus fresh per-election keys and tokens (no cross-election linkage of a voter's ballots).
- **Integrity in transit.** Ballots are signed by the voter-held ephemeral key; interceptors can
  neither alter answers nor use a stolen credential.
- **Replay protection.** `chainId` + `electionId` are bound into every signature and into the
  blind-signed credential message; per-election RSA keys are a consensus rule; the revote rule
  counts the highest client nonce, so replaying an old ballot can never override a newer one;
  exact duplicates are rejected.
- **Universal verifiability.** Plaintext ballots (under anonymous tokens) + public signatures →
  anyone recounts everything, offline, with the included auditor.
- **Individual verifiability.** A voter's receipt (token) locates their ballot, shows whether it
  is counted or superseded, and whether it is finalized.
- **Ballot-stuffing detection.** Elections publicly commit to `eligibleCount`; the registrar must
  publish a signed on-chain issuance commitment (count + salted Merkle root, audited resets
  included). `distinct tokens > issuedCount` or `> eligibleCount` fails the audit loudly.
- **Accountable finality.** Results are final once a majority of distinct validators build on
  them; conflicting finality requires signed, stored, published equivocation evidence.
- **Tamper-evident storage.** Nodes re-validate all persisted blocks at boot; a modified byte in
  a stored ballot invalidates the block and its descendants.

## 4. Explicitly NOT provided (v1)

- **Coercion resistance / receipt-freeness.** A receipt *proves* how a ballot voted once results
  are visible - that is what makes votes verifiable, and it equally serves a coercer or a
  vote-buyer. `allowRevote` (latest ballot counts) blunts one-shot coercion: a coerced voter can
  revote later. It does **not** defeat a coercer who monitors the public token until close, and it
  fails entirely if the coercer holds the voter's *code* (they can obtain the credential first, or
  revote last). Remote voting from uncontrolled devices is inherently exposed here; this is the
  central open problem of internet voting, not an implementation bug.
- **Registrar-proof enfranchisement.** A malicious registrar can stuff within
  `eligibleCount − real turnout` before reconciliation flags it, and can deny service. Threshold
  issuance (splitting the credential key among observers) is the roadmap fix.
- **Cryptographically hidden interim results.** Ballots are plaintext on chain; the per-election
  `afterClose` setting withholds tallies at the API/UI layer *by convention* - a determined
  observer can compute running tallies from raw blocks. Threshold-encrypted tallies are roadmap.
- **Metadata privacy.** Nodes and the registrar see IPs and timing. Mitigations implemented:
  credentials are fetched when the ballot is *opened*, not when it is cast (decorrelates registrar
  and chain timestamps), and registrar issuance rows carry coarse timestamps only. Residual risk
  remains, especially at low turnout (small anonymity sets) - use network-layer anonymity (VPN/Tor)
  for strong threat models.
- **Participation privacy from the registrar** (poll-book equivalent, see §1).
- **BFT-absolute finality.** A colluding validator majority can reorg - accountably, not silently.
- **Device security.** Malware on the voting device can alter or read a vote before it is signed.
  *Partial mitigation, opt-in:* **return codes** (see [RETURN-CODES.md](RETURN-CODES.md)) let a
  voter **detect** a device that silently flipped their recorded vote, by comparing a code the
  Return-Code Authority computes from the on-chain ballot against a code sheet mailed out of band.
  This detects integrity manipulation for voters who perform the check; it does not stop a device
  that only *reads* the vote, nor protect a voter who skips verification, and it introduces a
  disclosed control-component trust (documented in RETURN-CODES.md §"The trust assumption").

## 5. Operational guidance

- Prefer `resultsVisibility: "afterClose"` and `allowRevote: true` for real ballots.
- Voters: submit to multiple nodes (the app does), keep the receipt, verify after close, treat
  the vote as final only when the UI shows *finalized*. If the commission issued a return-code
  sheet, perform the return-code check against the **paper** sheet - a device that skips or fakes
  the check is itself a warning sign.
- Commissions: publish the genesis file hash (chainId) widely; run validators under genuinely
  independent organizations; post the issuance commitment promptly at close; investigate any
  equivocation evidence or reconciliation failure before certifying.
- Everyone: `npm run audit:record -- --url <any node>` - trust the recount, not the website.

## 6. Cryptographic inventory

| Purpose | Primitive | Notes |
|---|---|---|
| Anonymous credentials | RSABSSA-SHA384-PSS-Randomized (RFC 9474) via `@cloudflare/blindrsa-ts` | per-election keys, 3072-bit (2048 consensus floor), e=65537; sig length checked |
| Chain/tx/receipt signatures | Ed25519 via `@noble/curves` | RFC 8032-canonical; identical bytes in browser and Node |
| Hashing | SHA-256 via `@noble/hashes` | canonical-JSON preimages everywhere |
| Voter codes | 100-bit random, Crockford-style alphabet | registrar stores SHA-256 only |
| Return codes (opt-in) | HMAC-SHA256 of a 256-bit per-sheet secret | cast-as-intended check; off-chain; see [RETURN-CODES.md](RETURN-CODES.md) |

## 7. Roadmap (ordered by impact)

1. **Threshold credential issuance** - split the RSA key among registrar + observer validators so
   no single party can mint ghost credentials.
2. **Threshold-encrypted tallies** - ballots encrypted to a distributed commission key, decrypted
   and provably tallied after close (removes the plaintext-interim-results caveat).
3. **BFT consensus** (explicit votes + slashing-equivalent governance) replacing longest-chain PoA.
4. **ZK eligibility proofs** (Semaphore-style) - replace the interactive issuance round-trip.
5. **Mixnet/onion submission path** for network-metadata privacy by default.
6. **Per-voter Merkle inclusion proofs** of issuance (the root is already committed).
7. **Trustless return codes** - compute the cast-as-intended codes via multiparty operations on
   threshold-encrypted ballots (item 2), removing the control-component trust the current opt-in
   return codes assume. (Return codes themselves are **shipped** - see
   [RETURN-CODES.md](RETURN-CODES.md) - as the first device-malware *detection* mitigation.)
8. Independent security audit of protocol and implementation.

## 8. Reporting

Please report suspected vulnerabilities privately to the maintainers before public disclosure.
