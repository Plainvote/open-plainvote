import { useCallback, useEffect, useState } from 'react';
import type { ElectionSummary } from '@votechain/protocol';
import { pickHealthyNode } from '../lib/nodes';
import { listReceipts } from '../lib/receipts';
import { RESULTS_URL } from '../lib/config';

function formatRange(start: number, end: number): string {
  const fmt = (t: number) => new Date(t).toLocaleString();
  return `${fmt(start)} → ${fmt(end)}`;
}

export function ElectionList(props: { onOpenBallot: (election: ElectionSummary) => void; onBack: () => void }) {
  const [elections, setElections] = useState<ElectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { client } = await pickHealthyNode();
      const { elections } = await client.elections();
      setElections(elections);
      setError(null);
    } catch {
      // Never the raw exception. "Failed to fetch" tells a voter nothing and
      // suggests nothing; this at least names a cause they can act on.
      setError('We cannot reach the election right now. Check your connection and try again.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const receipts = listReceipts();
  const open = (elections ?? []).filter((e) => e.status === 'open');
  const upcoming = (elections ?? []).filter((e) => e.status === 'upcoming');
  const past = (elections ?? []).filter((e) => e.status === 'closed' || e.status === 'cancelled');

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Choose your election.</h1>
        <p className="page-lead">These are the elections your code can vote in.</p>
      </div>

      {error !== null && <div className="notice danger" role="alert">{error}</div>}
      {elections === null && error === null && (
        <div className="card" aria-busy="true">
          <span className="skeleton" style={{ width: '58%', height: 17 }}>Loading</span>
          <div style={{ height: 10 }} />
          <span className="skeleton" style={{ width: '34%', height: 13 }}>Loading</span>
        </div>
      )}

      <div className="card">
        <div className="spread">
          <h2>Open now</h2>
          <button className="btn secondary small" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {elections !== null && open.length === 0 && (
          <p className="muted small">No election is open for voting right now.</p>
        )}
        <div className="stack">
          {open.map((e) => (
            /*
              The whole row is the control, and it is one control.
              It used to be a div with role="button" and a click handler, with a
              real button nested inside it: unreachable by keyboard, announced
              as a button it could not activate, and opening the ballot twice
              when the inner button was clicked and the event bubbled.
            */
            <button
              type="button"
              key={e.electionId}
              className="option option-row"
              onClick={() => props.onOpenBallot(e)}
            >
              <span className="option-body">
                <span className="spread">
                  <strong>{e.title}</strong>
                  <span className="chip open">open</span>
                </span>
                <span className="small muted">
                  {e.questionCount} question{e.questionCount === 1 ? '' : 's'} · closes{' '}
                  {new Date(e.endTime).toLocaleString()}
                  {e.allowRevote ? ' · you can change your vote later' : ''}
                </span>
              </span>
              <span className="option-go" aria-hidden="true">Vote →</span>
            </button>
          ))}
        </div>
      </div>

      {upcoming.length > 0 && (
        <div className="card">
          <h2>Upcoming</h2>
          <div className="stack">
            {upcoming.map((e) => (
              <div key={e.electionId} className="spread">
                <span>
                  <strong>{e.title}</strong>{' '}
                  <span className="small muted">{formatRange(e.startTime, e.endTime)}</span>
                </span>
                <span className="chip upcoming">upcoming</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div className="card">
          <h2>Past elections</h2>
          <div className="stack">
            {past.map((e) => (
              <div key={e.electionId} className="spread">
                <span>
                  <strong>{e.title}</strong>{' '}
                  <a className="small" href={`${RESULTS_URL}/#/election/${e.electionId}`} target="_blank" rel="noreferrer">
                    view results
                  </a>
                </span>
                <span className={`chip ${e.status}`}>{e.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {receipts.length > 0 && (
        <div className="card">
          <h2>Your receipts on this device</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Election</th>
                  <th>Cast</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {receipts
                  .slice()
                  .sort((a, b) => b.castAt - a.castAt)
                  .map((r) => (
                    <tr key={r.txHash}>
                      <td>{r.electionTitle}</td>
                      <td className="small muted">{new Date(r.castAt).toLocaleString()}</td>
                      <td>
                        <a href={`${RESULTS_URL}/#/verify/${r.electionId}/${encodeURIComponent(r.token)}`} target="_blank" rel="noreferrer">
                          verify
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button className="btn secondary" onClick={props.onBack}>
        ← Use a different code
      </button>
    </div>
  );
}
