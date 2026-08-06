# How VoteChain Was Built

This document records the design and development process behind VoteChain - the decisions, the
adversarial review that shaped the protocol, the order things were built in, and how each stage was
verified. It is a companion to [`PROTOCOL.md`](PROTOCOL.md) (what the system *is*) and
[`SECURITY.md`](SECURITY.md) (what it does and does not guarantee).

## 1. Goal

Build an open-source blockchain mechanism that lets verified citizens vote remotely from their own
devices, with results that are fully transparent and independently auditable by anyone, while
individual ballots remain untraceable to the people who cast them. Voters hold a
government-issued code (assumed eligibility-verified and not linkable to the person after
issuance); codes are reusable across elections and regeneratable if compromised. Supporting
infrastructure required: a voter UI, an election-commission UI, and a public results UI. Elections
are free-form - candidate races, ideals, or ballot measures, whatever the commission writes.

## 2. Decisions taken up front

| Decision | Choice | Why |
|---|---|---|
| Language / stack | TypeScript everywhere, npm workspaces monorepo, React + Vite UIs | The crypto that runs in the voter's browser is the *same* code the nodes run - one auditable implementation |
| Chain | Custom proof-of-authority chain (not Ethereum/Fabric) | No tokens/gas/wallets; every line auditable; a full multi-node network runs on a laptop; the anonymity protocol integrates natively |
| Anonymity | RFC 9474 blind-signature credentials (RSABSSA) | Lets the registrar authorize a ballot without being able to link it to the voter - even if it logs everything |
| License | AGPL-3.0 | Anyone deploying a modified version (e.g. a government) must publish their changes - for election software, a trust feature |
| Results visibility | Per-election commission setting (`live` / `afterClose`) | Commissions decide; documented honestly as a v1 convention (ballots are plaintext on chain) |
| No build step | `exports` → `src`, run via `tsx`/Vite, `tsc --noEmit` | Fewest moving parts; the source *is* the artifact |

## 3. Adversarial design review (before writing code)

The protocol was red-teamed against the RFC 9474 literature and known internet-voting failure modes
*before* implementation, and the findings were folded into the consensus rules. The load-bearing
outcomes:

- **Replay protection** - `chainId` + `electionId` + domain tags are bound into every signature and
  into the blind-signed credential message; per-election RSA keys are a hard consensus rule. Without
  these, a ballot or credential from one election/chain could be replayed into another.
- **Replay-proof revoting** - the counted ballot is the one with the highest client-chosen `nonce`,
  never chain position, so re-broadcasting an old captured ballot can never override a newer one.
- **Deterministic validity** - election open/close is enforced by the *block* timestamp (which must
  equal its slot start), never wall clock, so every replayer reaches the same verdict.
- **Accountable finality** - results are final once a majority of *distinct* validators build on
  top; a contradicting fork would force a validator to sign two blocks for one slot, which is
  recorded and published as equivocation evidence.
- **Ballot-stuffing detection** - elections commit to an eligible-roll size and the registrar posts
  a signed on-chain issuance commitment, so anyone can reconcile `ballots ≤ issued ≤ eligible`.
- **Anonymity survives a dishonest issuer** - one red-team suggestion (derive the ballot key
  deterministically from the code, for crash recovery) was **rejected**: it would let anyone who
  ever learns a code deanonymize that ballot offline, silently voiding the blind-signature
  guarantee. Crash recovery is instead handled by persisting the blinded request and relying on the
  registrar's idempotent retry. This is the single most important design call in the project.

The full honest threat model - including what is deliberately *not* solved (coercion resistance,
device malware, the registrar's trust for enfranchisement) - lives in [`SECURITY.md`](SECURITY.md).

## 4. Build order

Built bottom-up so every layer stood on a tested one, committed per milestone:

| Stage | Deliverable | Verified by |
|---|---|---|
| M0 | Monorepo scaffold, tooling, CI, license | `npm install` + typecheck + vitest clean on Windows |
| M1 | `packages/protocol` - canonical encoding, Ed25519, RFC 9474 credentials, transactions, consensus validation, tally | 57 unit tests incl. blind-signature roundtrip + every rejection path |
| M2 | `packages/registrar` - hashed code registry, race-safe blind signing, revoke/regenerate, issuance commitments | Tests incl. a 10-way parallel double-issuance race (exactly one wins) |
| M3 | `packages/node` - PoA consensus, fork choice, finality, gossip, REST/WS API, storage | Live two-node sync + fork-resolution integration test |
| M4 | `scripts/setup.ts` + `demo.ts` | Cold-start on a fresh clone; end-to-end smoke against live services |
| M5 | Voter app + `scripts/audit.ts` | Credential prefetch, multi-node submission, receipt; audit rejects a tampered block |
| M6 / M7 | Commission app + public results app | Election wizard → on chain; live tallies, explorer, receipt verification |
| M8 | Full `npm run demo` + independent auditor | Live-chain audit recomputes an identical tally |
| M9 | End-to-end suite | Whole system over real HTTP: create → vote → revote → commit → audit-equal recount |
| M10 | README, PROTOCOL.md, SECURITY.md, CONTRIBUTING.md, this document | A fresh reader can run the quickstart from the README alone |

## 5. How the finished system was verified

Beyond the automated suite (**83 tests**, all seven workspaces typechecking, all three UIs
building), the complete flow was exercised through the **real browser UIs** against a live
three-node + registrar network:

1. The commission app created an election ("City Ballot 2026": a mayoral race and a school-tax
   measure, `afterClose` visibility) - the four-step wizard produced a registrar-attested key, a
   commission-signed `ELECTION_CREATE`, and on-chain confirmation.
2. A voter entered a demo code, opened the ballot (watching the "anonymous credential secured"
   step complete), cast Alice/Yes, then **revoted** to Bob/No - the chain recorded the replacement
   and marked the first ballot superseded.
3. The commission posted the issuance commitment from the Elections tab.
4. The public results app revealed the tally after close (Bob 1, No 1), with both integrity
   reconciliation checks passing and a "results final" finality badge; the explorer showed the raw
   blocks with proposer names, and receipt verification located the token's two records
   (one counted, one superseded).
5. `npm run audit:record -- --url http://127.0.0.1:4001` independently replayed every block through
   full consensus validation and recomputed a tally **identical** to the node's published results:
   `distinct 1 ≤ issued 1 ≤ eligible 20`.

## 5a. Post-launch enhancement: return codes

After the initial build, the first of the roadmap's "hard problem" mitigations was implemented:
**return codes** for cast-as-intended verification against a compromised device (see
[RETURN-CODES.md](RETURN-CODES.md)). It was deliberately built to touch only the registrar and the
apps - **consensus, the node, and tallying are untouched** - so it adds none of the
consensus-critical risk. The registrar gained a Return-Code Authority role (opt-in, off by
default, with a disclosed control-component trust assumption); the voter app gained a verification
panel; the commission app gained sheet generation. Manipulation detection is covered by tests
(a ballot flipped on chain returns the *wrong* option's code).

## 6. What a reader should do next

- Run it: `npm install && npm run demo`, then follow the five-minute walkthrough in the
  [README](../README.md).
- Understand it: [`PROTOCOL.md`](PROTOCOL.md) for byte-exact formats and rules.
- Trust it (or not): [`SECURITY.md`](SECURITY.md) for the honest threat model and roadmap.
- Don't trust the website: `npm run audit:record -- --url <any node>` recounts everything yourself.
