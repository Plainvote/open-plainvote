/** The public engine repository, for the specification links at the foot. */
const REPO_URL = 'https://github.com/Plainvote/open-plainvote';

export function AuditPage() {
  return (
    <>
      <section className="card">
        <h1 className="page-title">Recount it yourself</h1>
        <p>
          Trusting these results should not require trusting whoever runs this website. Every number shown here is
          derived from a public record you can download and add up yourself.
        </p>
        {/*
          The page used to open by explaining how to clone a repository and run
          a command, which is not a thing most readers of a results page will
          ever do. The button on each election does the same arithmetic in the
          browser, so that comes first and the command line stays below for
          anyone who wants to check this page too.
        */}
        <div className="notice ok">
          <strong>You do not need any of this to check a result.</strong> Open any election and use{' '}
          <em>Check this result yourself</em>: your browser fetches every ballot and adds them up in front of you.{' '}
          <a href="#/">Pick an election</a>.
        </div>
      </section>

      <section className="card">
        <h2>How the record works</h2>
        <div className="grid two">
          <div>
            <h3>Pages &amp; entries</h3>
            <p className="small">
              Every action (opening an election, casting a ballot, committing credential issuance) is written as a
              signed <em>entry</em>. Entries are grouped onto numbered <em>pages</em>, and each page locks in the
              fingerprint of the page before it. Rewriting anything in the past therefore breaks every page after it,
              visibly, on every copy. Any record-keeper will hand you the whole history over ordinary HTTP.
            </p>
          </div>
          <div>
            <h3>Record-keepers &amp; confirmation</h3>
            <p className="small">
              A fixed, named set of record-keepers take turns writing pages. A page counts as <em>confirmed</em> once
              enough of the others have built on top of it. If a record-keeper ever signs two different versions of the
              same page, that contradiction is captured as signed evidence and shown publicly in{' '}
              <a href="#/record">the record</a>, where it cannot be denied later.
            </p>
          </div>
          <div>
            <h3>Anonymous credentials</h3>
            <p className="small">
              Your device makes up a random ballot token and has the registrar sign it inside a sealed envelope: the
              registrar confirms you are eligible and signs, but never sees the token. The recorded ballot carries only
              the token and that signature, which proves "authorized, exactly once" without naming anybody. Where
              revoting is allowed, a later ballot from the same token replaces the earlier one.
            </p>
          </div>
          <div>
            <h3>Public by design</h3>
            <p className="small">
              Election definitions, every raw ballot, and the registrar's issuance commitments are all in the public
              record. What is <em>not</em> there: names, member registrations, or anything at all linking a ballot token
              to a person.
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Three things anyone can check</h2>
        <ol className="stack">
          <li>
            <strong>The totals are just a recount.</strong> Replay every ballot from the raw record, keep the latest
            version from each token, and count. The result has to match the published totals exactly; there is no
            other source of truth to fall back on.
          </li>
          <li>
            <strong>Every ballot carries a valid credential.</strong> Each counted ballot must verify against the
            election's published credential key. Forged ballots fail this check, are refused by every honest
            record-keeper, and would fail your recount too.
          </li>
          <li>
            <strong>distinct ballots ≤ credentials issued ≤ eligible voters.</strong> The stuffing check, computed from
            public numbers alone. If it ever fails, the election is invalid on its face, and it is shown on every
            results page here.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>Run the independent recount</h2>
        <p className="small">
          The repository ships an auditor that performs all three checks from scratch, against a live record-keeper,
          or against one's on-disk copy with no network at all:
        </p>
        <pre className="mono">{`# recount against a live record-keeper
npm run audit:record -- --url http://127.0.0.1:4001

# or fully offline, from a record-keeper's data directory
npm run audit:record -- --data .data/node1`}</pre>
        <p className="small">
          Prefer the raw data? Every record-keeper serves the entire record and its founding parameters over plain
          HTTP, with no key, no account, and no permission needed:
        </p>
        <pre className="mono">{`curl http://127.0.0.1:4001/blocks?from=1
curl http://127.0.0.1:4001/genesis`}</pre>
        <p className="hint">
          Point any of this at whichever record-keeper you like, or run your own and let it catch up. Honest
          record-keepers must agree on every confirmed page, so disagreement is itself the alarm.
        </p>
        <p className="hint">
          A note on wording: the developer-facing API and source code use standard engineering terms. A page is a{' '}
          <code>block</code>, an entry is a <code>transaction</code>, a record-keeper is a <code>node</code> or{' '}
          <code>validator</code>. Same thing, named the way auditors and contributors expect to find it.
        </p>
      </section>

      <section className="card">
        <h2>Read the full design</h2>
        {/*
          Absolute links to the public repository. These were relative paths
          (`docs/PROTOCOL.md`), which resolve against this hash-routed single
          page and 404 on every deployment.
        */}
        <p className="small">
          The protocol specification and the security and threat model live in the repository:{' '}
          <a className="mono" href={`${REPO_URL}/blob/main/docs/PROTOCOL.md`} target="_blank" rel="noreferrer">
            PROTOCOL.md
          </a>{' '}
          ·{' '}
          <a className="mono" href={`${REPO_URL}/blob/main/docs/SECURITY.md`} target="_blank" rel="noreferrer">
            SECURITY.md
          </a>
          . The whole implementation is open source under AGPL-3.0, including the part that counts.
        </p>
      </section>
    </>
  );
}
