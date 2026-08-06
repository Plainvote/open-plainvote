import { useState } from 'react';
import { NodeClient, fetchAllBlocks, recountElection, type RecountProblem, type RecountResult } from '@votechain/protocol';
import type { ResultsResponse } from '@votechain/protocol';
import { pickHealthyNode } from '../lib/api';
import { checkAgreement, type AgreementReport, type NodeVerdict } from '../lib/agreement';
import { fmtNum } from '../lib/format';

/**
 * "Recount it yourself", as a button rather than a shell command.
 *
 * The page this replaces told a co-op member to clone a repository and run
 * `npm run audit:record`, which is not a thing that was ever going to happen.
 * The same arithmetic now runs in their browser, on the raw record, while they
 * watch: read every page, check the links hold, add the ballots up, and compare
 * with the totals published above.
 *
 * Two honesty rules shape what it says afterwards. It reports what it actually
 * did, so signatures are named as NOT checked rather than quietly implied. And
 * "the record-keepers agree" is only worth something if the reader can pick a
 * record-keeper, so the field to add one is part of the feature, not a corner
 * of a settings page.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'running'; message: string; read: number; total: number | null }
  | { name: 'failed'; message: string }
  | { name: 'done'; result: RecountResult; agreement: AgreementReport };

export function RecountPanel({ results }: { results: ResultsResponse }) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [ownUrl, setOwnUrl] = useState('');
  const [ownUrlError, setOwnUrlError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setOwnUrlError(null);
    let extra: string[] = [];
    const typed = ownUrl.trim().replace(/\/$/, '');
    if (typed.length > 0) {
      if (!/^https?:\/\/.+/.test(typed)) {
        setOwnUrlError('That does not look like an address. It should start with http:// or https://');
        return;
      }
      extra = [typed];
    }

    setPhase({ name: 'running', message: 'Finding a record-keeper', read: 0, total: null });
    try {
      const { client, status } = await pickHealthyNode();
      setPhase({ name: 'running', message: 'Reading the record', read: 0, total: status.height });

      const blocks = await fetchAllBlocks(
        async (from, limit) => (await client.blocks(from, limit)).blocks,
        {
          pageSize: 200,
          onProgress: (read) =>
            setPhase({ name: 'running', message: 'Reading the record', read, total: status.height }),
        },
      );

      setPhase({ name: 'running', message: 'Checking the pages link together', read: blocks.length, total: status.height });
      // Yield once so the message paints before the synchronous replay begins.
      await new Promise((r) => setTimeout(r, 16));

      const result = recountElection({
        chainId: status.chainId,
        electionId: results.electionId,
        blocks,
        published: { questions: results.questions, distinctTokens: results.turnout.distinctTokens },
      });

      setPhase({ name: 'running', message: 'Asking the other record-keepers', read: blocks.length, total: status.height });
      const agreement = await checkAgreement(extra);

      setPhase({ name: 'done', result, agreement });
    } catch (error) {
      setPhase({
        name: 'failed',
        message:
          error instanceof TypeError
            ? 'We could not reach a record-keeper to read the record from.'
            : 'The recount could not finish. Try again in a moment.',
      });
    }
  }

  return (
    <section className="card">
      <div className="spread">
        <h2>Check this result yourself</h2>
        {phase.name === 'done' && phase.result.ok && (
          <span className="stamp">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 10.5l4 4 8-9" />
            </svg>
            Recounted here
          </span>
        )}
      </div>

      <p className="small">
        Nothing above has to be taken on trust. Your browser can fetch every ballot from the record and add them
        up itself, then compare its own total with the one published here.
      </p>

      {phase.name === 'idle' && (
        <>
          <div className="row actions-row">
            <button className="btn" onClick={() => void run()}>Recount this election</button>
          </div>
          <details className="own-node">
            <summary>Use a record-keeper of your own</summary>
            <div className="own-node-body">
              <p className="small muted">
                The record-keepers listed on this page were chosen by whoever published it. If you would rather
                not take that list on trust, name one yourself and it will be asked the same questions. Any
                record-keeper answers a browser directly.
              </p>
              <label htmlFor="own-node-url">Record-keeper address</label>
              <div className="row">
                <input
                  id="own-node-url"
                  type="url"
                  className="mono flex-input"
                  placeholder="https://…"
                  value={ownUrl}
                  onChange={(e) => setOwnUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>
              {ownUrlError !== null && <div className="notice danger" role="alert">{ownUrlError}</div>}
            </div>
          </details>
        </>
      )}

      {phase.name === 'running' && (
        <div className="recount-run" role="status" aria-live="polite">
          <p className="recount-step">{phase.message}…</p>
          {phase.total !== null && (
            <>
              <div className="recount-bar">
                <div
                  className="recount-bar-fill"
                  style={{ width: `${Math.min(100, Math.round((phase.read / Math.max(phase.total, 1)) * 100))}%` }}
                />
              </div>
              <p className="hint tabular">
                {fmtNum(phase.read)} of {fmtNum(phase.total)} pages read
              </p>
            </>
          )}
        </div>
      )}

      {phase.name === 'failed' && (
        <>
          <div className="notice danger" role="alert">{phase.message}</div>
          <div className="row actions-row">
            <button className="btn secondary" onClick={() => setPhase({ name: 'idle' })}>Try again</button>
          </div>
        </>
      )}

      {phase.name === 'done' && <Verdict phase={phase} onReset={() => setPhase({ name: 'idle' })} />}
    </section>
  );
}

function Verdict({ phase, onReset }: { phase: Extract<Phase, { name: 'done' }>; onReset: () => void }) {
  const { result, agreement } = phase;

  return (
    <>
      {result.ok ? (
        <div className="notice ok">
          <strong>The totals add up.</strong> Your browser read {fmtNum(result.blocksRead)} pages of the record,
          checked that each one names the page before it, counted {fmtNum(result.ballotsCounted)}{' '}
          {result.ballotsCounted === 1 ? 'ballot' : 'ballots'}, and got the same numbers published above.
        </div>
      ) : (
        <div className="notice danger" role="alert">
          <strong>This result does not add up.</strong> What your browser computed from the raw record does not
          match what is published here. Do not rely on these totals, and tell the organization running the
          election.
          <ul className="problem-list">
            {result.problems.map((p, i) => (
              <li key={i}>{describeProblem(p)}</li>
            ))}
          </ul>
        </div>
      )}

      <h3>What the record-keepers say</h3>
      <p className="small muted">
        {agreement.comparedAtHeight !== null
          ? `Compared at page ${fmtNum(agreement.comparedAtHeight)}, the most recent page all of them have settled.`
          : 'No page has been settled by all of them yet.'}
      </p>
      <ul className="keeper-list">
        {agreement.verdicts.map((v) => (
          <li key={v.url} className={`keeper ${v.state}`}>
            <span className="keeper-name">{'name' in v ? v.name : hostOf(v.url)}</span>
            <span className="keeper-said">{describeVerdict(v)}</span>
          </li>
        ))}
      </ul>

      {agreement.equivocations.length > 0 && (
        <div className="notice danger" role="alert">
          <strong>A record-keeper signed two different versions of the same page.</strong> That contradiction is
          held as signed evidence in the record. Treat these results as unsettled until it is resolved.
        </div>
      )}

      {agreement.fingerprint !== null && (
        <p className="hint">
          Fingerprint of that page: <code>{agreement.fingerprint.slice(0, 24)}…</code> Compare it with what your
          organization published, or with what a record-keeper you trust reports.
        </p>
      )}

      <div className="notice info">
        <strong>What this did not check.</strong> It did not verify the signature on each ballot, which is a much
        slower pass. It checked that the record holds together and that the totals are what the ballots say.
      </div>

      <div className="row actions-row">
        <button className="btn secondary" onClick={onReset}>Run it again</button>
      </div>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describeVerdict(v: NodeVerdict): string {
  switch (v.state) {
    case 'agrees':
      return 'same record';
    case 'behind':
      return 'still catching up';
    case 'differs':
      return 'DIFFERENT record';
    case 'wrong-chain':
      return 'a different election entirely';
    case 'unreachable':
      return v.reason;
  }
}

function describeProblem(p: RecountProblem): string {
  switch (p.kind) {
    case 'broken-link':
      return `Page ${fmtNum(p.height)} does not name the page before it. History was rewritten from here.`;
    case 'entries-altered':
      return `The entries on page ${fmtNum(p.height)} are not the ones that page vouches for.`;
    case 'gap':
      return `Page ${fmtNum(p.height)} is missing from the record.`;
    case 'election-missing':
      return 'This election is not in the record at all.';
    case 'totals-differ':
      return `An option is published as ${fmtNum(p.theirs)} but the ballots add up to ${fmtNum(p.ours)}.`;
    case 'turnout-differs':
      return `Turnout is published as ${fmtNum(p.theirs)} but the ballots add up to ${fmtNum(p.ours)}.`;
  }
}
