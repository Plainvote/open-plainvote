import type { ElectionStatus, ElectionSummary } from '@votechain/protocol';
import { NODE_URLS, useNodeQuery } from '../lib/api';
import { fmtDateTime, fmtNum, pct } from '../lib/format';

const STATUS_ORDER: Record<ElectionStatus, number> = { open: 0, upcoming: 1, closed: 2, cancelled: 3 };

export function ElectionsPage({ tick }: { tick: number }) {
  const q = useNodeQuery(true, [tick], (client) => client.elections());
  const elections =
    q.data !== null
      ? [...q.data.elections].sort(
          (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.startTime - b.startTime,
        )
      : null;

  return (
    <>
      <section className="card">
        <h1 className="page-title">A public window into the vote</h1>
        <p>
          Every ballot here is published in full, signed, and anonymous. You do not have to take these totals on
          trust: anyone, including you, can add up every ballot independently and get the same answer.
        </p>
        <div className="row small">
          <a href="#/audit">Recount it yourself →</a>
          <a href="#/verify">Verify your own ballot →</a>
          <a href="#/record">Read the full record →</a>
        </div>
      </section>

      {q.loading && (
        <p className="muted" role="status" aria-live="polite">
          Contacting the record-keepers…
        </p>
      )}
      {q.error !== null && q.data === null && !q.loading && (
        <div className="notice danger" role="alert">
          We could not reach a record-keeper right now.
          {/* Was "Tried http://127.0.0.1:4001, …", printed to the public. */}
          <div className="small">This page refreshes on its own; it will fill in when one answers.</div>
        </div>
      )}
      {q.error !== null && q.data !== null && (
        <div className="notice warn">Live refresh failed ({q.error}); showing the last data received.</div>
      )}

      {elections !== null && elections.length === 0 && (
        <div className="notice info">No elections published yet. Check back once the commission opens one.</div>
      )}
      {elections !== null && elections.length > 0 && (
        <div className="grid two">
          {elections.map((election) => (
            <ElectionCard key={election.electionId} election={election} />
          ))}
        </div>
      )}
    </>
  );
}

function ElectionCard({ election }: { election: ElectionSummary }) {
  const href = `#/election/${encodeURIComponent(election.electionId)}`;
  return (
    <article className="card">
      <div className="spread">
        <h2>
          <a href={href}>{election.title}</a>
        </h2>
        <span className={`chip ${election.status}`}>{election.status}</span>
      </div>
      <p className="small muted">
        {fmtDateTime(election.startTime)} → {fmtDateTime(election.endTime)}
      </p>
      <p className="small">
        Turnout <strong className="mono">{fmtNum(election.turnout)}</strong> of{' '}
        <span className="mono">{fmtNum(election.eligibleCount)}</span> eligible (
        {pct(election.turnout, election.eligibleCount)}) · {election.questionCount}{' '}
        {election.questionCount === 1 ? 'question' : 'questions'}
      </p>
      <div className="row">
        <span className="chip info">{election.resultsVisibility === 'live' ? 'live results' : 'results after close'}</span>
        <span className="chip info">{election.allowRevote ? 'revoting allowed' : 'one vote only'}</span>
      </div>
      <p style={{ marginBottom: 0 }}>
        <a className="btn small secondary" href={href}>
          Results &amp; integrity
        </a>
      </p>
    </article>
  );
}
