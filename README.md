# Plainvote

**Open-source online elections your members can verify for themselves.**

Plainvote runs board, officer, and membership elections online - and publishes a result that any
candidate, member, or observer can **independently recount**, while individual ballots stay
cryptographically unlinkable to the people who cast them. No accounts, no apps, no tokens, no
wallets.

```
                   ┌──────────────────────────────────────────────┐
                   │   The public record                          │
 Commission app ──▶│   kept in parallel by 3+ independent         │◀── Public results app
 (creates the      │   record-keeping organizations               │    tallies · browse every
  election)        │   - every ballot, every signature            │    ballot · verify a receipt
                   └──────────────────▲───────────────────────────┘
                                      │ anonymous ballot
 Voter app ── code ──▶ Registrar ── blind signature ──▶ Voter app
 (any browser)         knows only SHA256(code);          unblinds → a credential the
                       CANNOT link ballot ↔ code         registrar has never seen
```

## How a vote stays anonymous *and* verifiable

1. The organization issues each eligible member a secret **voting code** (reusable across elections,
   regenerable if compromised). Only its hash is ever stored - never the code itself.
2. To vote, the member's device generates a fresh **ballot key** and *blinds* it - a sealed envelope
   with carbon paper inside.
3. The registrar verifies the code is eligible and unused for this election, then signs the envelope
   **without opening it** (an [RFC 9474](https://www.rfc-editor.org/rfc/rfc9474) blind signature).
   One credential per code per election, enforced by the database itself.
4. The device unblinds the signature: it now holds an anonymous **voting credential** that even the
   registrar has never seen and cannot recognize.
5. The ballot - signed by the ballot key, authorized by the credential - is published to a public,
   tamper-evident record, kept in parallel by several independent organizations, so no single
   operator can quietly change it.
6. **Anyone can recount every ballot and re-verify every signature.** A voter's receipt lets them
   confirm their own ballot counted. Nobody can trace it back to them.

Elections are free-form: officer and board races, bylaw amendments, budget approvals, or any
yes/no question the commission writes - one or more questions per election, with per-election
settings for revoting and results visibility.

## Who it's for

Built for **organizational elections** - professional and trade associations, cooperatives,
credit-union and nonprofit boards, learned societies - where a contested result has to hold up.

> **Scope, stated plainly.** Plainvote is designed for *low-coercion organizational elections*. It
> is **not** offered for binding governmental/public elections, and
> [docs/SECURITY.md](docs/SECURITY.md) explains exactly why, along with everything the system does
> and does not protect against.

## Quickstart

Requirements: Node.js ≥ 24, npm ≥ 10.

```bash
npm install
npm run demo
```

One command starts the whole network on your machine: **3 record-keeper nodes** (ports 4001–4003),
the **registrar** (5001), and four apps:

| App | URL | For |
|---|---|---|
| Voter | http://127.0.0.1:5173 | casting anonymous ballots |
| Commission | http://127.0.0.1:5174 | creating elections, managing voter codes |
| Public results | http://127.0.0.1:5175 | live tallies, browsing the record, verifying receipts |




The banner prints the **registrar admin key** and **commission signing key** - paste both into the
commission app's *Setup* tab. Twenty demo voter codes are in `.data/demo-codes.txt`.

### Five-minute walkthrough

1. **Commission app → Setup**: paste the two keys from the demo banner, *Test connections*.
2. **Commission app → Elections → New election**: write a title, add a candidate question and a
   yes/no measure, set the end time ~10 minutes out, click through the three-step submit
   (registrar key → commission signature → published).
3. **Commission app → Voter Codes**: see the 20 demo codes' hashes (or generate more - codes are
   shown exactly once).
4. **Voter app**: enter a code from `.data/demo-codes.txt`, open the ballot - watch the
   *"anonymous credential secured"* badge - vote, download your receipt.
5. **Results app**: watch turnout live (tallies unlock at close for `afterClose` elections), browse
   every recorded ballot, paste your receipt under *Verify a ballot*.
6. **Revote** (if enabled): vote again with the same code - only the latest ballot counts.
7. **Audit it yourself** - don't trust the website:

   ```bash
   npm run audit:record -- --url http://127.0.0.1:4001   # live: recount + diff vs the node
   npm run audit:record -- --data .data/node1            # offline: from the raw record files
   ```

   The auditor replays the entire record through full validation - every record-keeper signature,
   every blind credential, every timing rule - recomputes all tallies from scratch, and reconciles
   `distinct ballots ≤ credentials issued ≤ eligible voters`. Flip one byte in
   `.data/node1/blocks.jsonl` and watch it fail.

`npm run demo:reset` regenerates the network from scratch. `npm test` runs the full suite
(protocol, registrar, node, end-to-end).

## What's in the box

| Path | What |
|---|---|
| `packages/protocol` | Isomorphic core: canonical encoding, Ed25519 + RFC 9474 blind credentials, return codes, transactions, validation rules, tally - the same code runs in the browser and in every node |
| `packages/node` | A record-keeper node: slot-based proof-of-authority record-keeping, fork choice, accountable finality, equivocation evidence, gossip, REST/WS API, tamper-evident JSONL storage |
| `packages/registrar` | Credential authority: hashed code registry, race-safe blind signing with idempotent retries, revoke/regenerate, public issuance commitments, Return-Code Authority |
| `apps/voter-ui` · `apps/commission-ui` · `apps/results-ui` | The three engine web apps |

| `scripts/audit.ts` | The independent auditor |
| `docs/PROTOCOL.md` | Byte-exact wire format + validation rules (full technical precision) |
| `docs/SECURITY.md` | **Read this** - the honest threat model: what is guaranteed, by which mechanism, and what is explicitly not solved (coercion resistance, device malware, …) |
| `docs/RETURN-CODES.md` | Cast-as-intended verification against a compromised device, and its trust assumption |
| `docs/DEVELOPMENT.md` | How this was built: design decisions, the adversarial protocol review, and how the finished system was verified |

## Design highlights

- **Anonymity that survives a dishonest issuer.** Credentials are blind-signed, never derived from
  codes - even a registrar that logs everything cannot link ballots to people.
- **Stolen credentials are useless.** Ballots are signed by a voter-held ephemeral key.
- **Replay-proof revoting.** The counted ballot is the one with the highest client nonce, not the
  latest position in the record - re-broadcasting an old ballot can never override a newer one.
  Revoting is also a (partial) anti-coercion measure.
- **Ballot-box arithmetic in public.** Elections commit to the eligible-roll size; the registrar
  publicly commits to how many credentials it issued; anyone checks `ballots ≤ issued ≤ eligible`.
- **Catch a compromised device.** Optional mailed [return-code sheets](docs/RETURN-CODES.md) let a
  voter confirm their ballot was recorded exactly as they cast it - a check malware can't fake.
- **Accountable finality.** Results are final once a majority of distinct record-keepers build on
  them; contradicting that requires publishable, signed evidence of misbehavior.
- **Crash-safe voting.** The credential request is persisted before it is sent and retries are
  idempotent - a browser crash cannot burn a voter's only credential.

## A note on vocabulary

The record layer is a permissioned, append-only, replicated log with proof-of-authority
record-keeping - the technical details are specified precisely in
[docs/PROTOCOL.md](docs/PROTOCOL.md), and the code uses accurate engineering terms (`block`, `node`,
`validator`, `consensus`) because contributors and auditors need them.

**User-facing language deliberately avoids that jargon.** What matters to a member or a board is
that the result is publicly recountable and their ballot is anonymous - not the plumbing. Please
keep marketing and in-app copy in plain language.

*(Package names are still published under the `@votechain/*` namespace from an earlier working
title; renaming them is tracked as a housekeeping task.)*

## Status & license

Reference implementation - a serious protocol, honestly documented, and **not yet independently
audited**. Every election is publicly recountable today, which is a stronger everyday check than
most closed alternatives offer; a formal third-party security audit is on the roadmap, along with
threshold issuance, encrypted tallies, and stronger consensus (see
[docs/SECURITY.md](docs/SECURITY.md)).

Licensed **AGPL-3.0** ([LICENSE](LICENSE)): anyone who deploys a modified Plainvote must publish
their modifications. For election software, that is a security feature.
