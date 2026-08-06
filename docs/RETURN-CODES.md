# Return Codes - cast-as-intended verification

Return codes let a voter detect a **compromised voting device** - malware that silently changes
their vote from A to B. They are an optional, per-election feature. This document explains how they
work in VoteChain, what they do and do not protect, and the trust assumption they introduce.

## The problem they address

VoteChain's strongest residual risk (see [SECURITY.md](SECURITY.md)) is the voter's own device:
software the voter cannot see can alter the ballot before it is ever signed. No purely-software
remote system *eliminates* this; return codes are the standard, deployable way to make silent
manipulation **detectable** by the voter.

## How it works

1. **Before the election**, the commission generates one **code sheet** per voter and mails it
   through the same trusted channel as the voting codes. Each sheet lists, for every option on the
   ballot, a secret 4-character **return code**, plus a 6-character **cast code**. The codes are
   derived from a per-sheet secret the voter's device never holds.
2. **The voter votes** as normal. Their ballot is recorded on the public chain under an anonymous
   token.
3. **The voter verifies:** they give the app their **Sheet ID** (printed on the sheet). The app
   asks the registrar - acting as a **Return-Code Authority (RCA)** - for the codes of the options
   *actually recorded on chain* for their token. The RCA reads the **real ballot from the chain**
   (not from anything the possibly-malicious device claims) and returns the corresponding codes.
4. **The voter compares:** the code the RCA returns must equal the code printed next to their
   *intended* choice on the mailed sheet.
   - **Match** → the ballot on chain is the one the voter intended.
   - **No match** → the device recorded a *different* option; the vote was altered. The device
     cannot fake a matching code because it never holds the sheet secret, and cannot guess it
     (each option's code is an independent HMAC of a 256-bit secret).

The one-credential-per-code rule reinforces this: malware cannot cast a *second*, correct-looking
ballot to fool the check - it gets only one credential, so the ballot the RCA reads is the only one
that exists for that voter.

## What it protects - and what it does not

**Protects:** a voter who follows the ritual detects a device that silently flipped their recorded
vote. This is the property mainstream remote-voting systems lack.

**Does not protect:**
- A voter who skips verification, or trusts a device that *claims* "codes match" without actually
  showing the RCA's answer. Return codes are only as strong as the voter performing the check
  against the **paper** sheet.
- Ballot *secrecy* on the device: malware that only reads (not alters) the vote is out of scope.
- The mailing channel: if sheets are intercepted, the guarantee is lost - distribute them with the
  same care as the voting codes.

## The trust assumption (important)

Return codes require the RCA to compute "the code for the option this ballot recorded." Because
VoteChain deliberately severs the voter↔ballot link, this reintroduces a **bounded, disclosed**
trust that VoteChain otherwise avoids:

- The RCA stores only `sheetId → secret` - **never** a link to a voter or voting code - and it
  reads the (already public) ballot from the chain. On its own it learns only "the ballot under
  token T recorded option O," which is already public on the chain.
- The party that **mails** sheets transiently knows `voter ↔ sheetId`. If that party fails to
  discard that mapping **and** colludes with the RCA, the two together could link a voter to their
  vote. This is exactly the control-component trust of deployed systems (Swiss Post, Norway).

**Because of this, return codes are opt-in and off by default.** An operator who cannot accept the
mailing-party/RCA separation should not enable them. The reference implementation runs the mailing
and RCA roles in one registrar service for the demo; a hardened deployment MUST:

- run the sheet-mailing party separately from the RCA, and have it discard `voter ↔ sheetId` after
  mailing;
- **threshold-share** the sheet secrets across independent organizations (the validator
  consortium), so no single party can compute codes alone;
- and, ultimately, adopt the roadmap's **threshold-encrypted ballots**, which remove the trust
  entirely by computing return codes via multiparty operations on encrypted votes (the full Swiss
  Post / Neuchâtel construction).

## Cryptographic detail

For a per-sheet secret `K` (256-bit, base64url) and an election/question/option:

```
returnCode = base32Crockford( HMAC-SHA256(K, "VBC-RC-v1|"      || electionId || "|" || questionId || "|" || optionId) )[:4]
castCode    = base32Crockford( HMAC-SHA256(K, "VBC-RC-CAST-v1|" || electionId) )[:6]
```

Codes are domain-separated by election, question, and option, so a code is meaningful only for the
exact (option, election) it was printed for. The derivation is in
[`packages/protocol/src/returnCodes.ts`](../packages/protocol/src/returnCodes.ts); the RCA logic
(sheet generation and chain-read retrieval) is in
[`packages/registrar/src/returnCodes.ts`](../packages/registrar/src/returnCodes.ts).

## Consensus is untouched

Return codes are entirely off-chain (registrar + apps). They add no transaction type, change no
validation rule, and do not affect the tally or the independent audit - so they carry none of the
consensus-critical risk. This was a deliberate design choice to keep the blast radius small.
