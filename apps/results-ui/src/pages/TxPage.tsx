import type { ElectionDetail, Tx, TxLookupResponse } from '@votechain/protocol';
import { useNodeQuery } from '../lib/api';
import { fmtDateTime, fmtNum, resolveAnswers, shortHash, txChipClass, txTypeLabel } from '../lib/format';

interface Loaded {
  lookup: TxLookupResponse;
  detail: ElectionDetail | null;
}

export function TxPage({ hash, tick }: { hash: string; tick: number }) {
  const q = useNodeQuery<Loaded>(hash !== '', [hash, tick], async (client) => {
    const lookup = await client.transaction(hash);
    const electionId = lookup.tx.type === 'ELECTION_CREATE' ? lookup.tx.election.electionId : lookup.tx.electionId;
    let detail: ElectionDetail | null = null;
    try {
      detail = await client.election(electionId);
    } catch {
      detail = null;
    }
    return { lookup, detail };
  });

  if (hash === '') {
    return (
      <div className="notice danger">
        Missing entry id. Try <a href="#/record">browsing the record</a>.
      </div>
    );
  }
  if (q.notFound && q.data === null) {
    return (
      <div className="notice danger">
        Entry <code>{shortHash(hash, 16)}</code> is not in the record. <a href="#/record">Back to the record</a>
      </div>
    );
  }
  if (q.loading) return <p className="muted">Loading entry…</p>;
  if (q.data === null) return <div className="notice danger">Could not load this entry: {q.error ?? 'unknown error'}</div>;

  const { lookup, detail } = q.data;
  const tx = lookup.tx;

  return (
    <>
      <div className="small muted">
        <a href="#/record">← The record</a>
      </div>

      <section className="card">
        <div className="spread">
          <h1 className="page-title">Record entry</h1>
          <span className={`chip ${txChipClass(tx.type)}`}>{txTypeLabel(tx.type)}</span>
        </div>
        <p className="small">
          Recorded on <a href={`#/page/${lookup.blockHeight}`}>page #{fmtNum(lookup.blockHeight)}</a>, entry{' '}
          {lookup.txIndex}.
        </p>
        <p className="mono small">{lookup.txHash}</p>
        <TxDetails tx={tx} detail={detail} />
      </section>

      <section className="card">
        <h2>Exactly what was recorded</h2>
        <p className="hint">
          Nothing here is a summary written for you. This is the entry itself, byte for byte, and it is what an
          independent recount reads.
        </p>
        <pre className="mono">{JSON.stringify(tx, null, 2)}</pre>
      </section>
    </>
  );
}

function electionLink(electionId: string, title?: string) {
  return <a href={`#/election/${encodeURIComponent(electionId)}`}>{title ?? electionId}</a>;
}

function TxDetails({ tx, detail }: { tx: Tx; detail: ElectionDetail | null }) {
  switch (tx.type) {
    case 'VOTE_CAST': {
      const answers = resolveAnswers(detail, tx.answers);
      return (
        <>
          <div className="table-scroll">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Election</th>
                  <td>{electionLink(tx.electionId, detail?.definition.title)}</td>
                </tr>
                <tr>
                  <th scope="row">Ballot token</th>
                  <td className="mono">{tx.token}</td>
                </tr>
                <tr>
                  <th scope="row">Version</th>
                  <td className="mono">{tx.nonce}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>Ballot answers</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Answer</th>
                </tr>
              </thead>
              <tbody>
                {answers.map((a, i) => (
                  <tr key={i}>
                    <td>{a.question}</td>
                    <td>{a.answer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="notice info">
            This token is an anonymous one-time credential; it cannot be linked to a person.
          </div>
        </>
      );
    }
    case 'ELECTION_CREATE':
      return (
        <div className="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Title</th>
                <td>{electionLink(tx.election.electionId, tx.election.title)}</td>
              </tr>
              <tr>
                <th scope="row">Election id</th>
                <td className="mono">{tx.election.electionId}</td>
              </tr>
              <tr>
                <th scope="row">Voting window</th>
                <td>
                  {fmtDateTime(tx.election.startTime)} → {fmtDateTime(tx.election.endTime)}
                </td>
              </tr>
              <tr>
                <th scope="row">Questions</th>
                <td>{tx.election.questions.length}</td>
              </tr>
              <tr>
                <th scope="row">Eligible voters</th>
                <td className="mono">{fmtNum(tx.election.eligibleCount)}</td>
              </tr>
              <tr>
                <th scope="row">Rules</th>
                <td>
                  {tx.election.resultsVisibility === 'live' ? 'live results' : 'results after close'} ·{' '}
                  {tx.election.allowRevote ? 'revoting allowed' : 'one vote only'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    case 'ELECTION_CANCEL':
      return (
        <div className="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Election</th>
                <td>{electionLink(tx.electionId, detail?.definition.title)}</td>
              </tr>
              <tr>
                <th scope="row">Reason</th>
                <td>{tx.reason ?? '–'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    case 'ISSUANCE_COMMIT':
      return (
        <>
          <div className="table-scroll">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Election</th>
                  <td>{electionLink(tx.electionId, detail?.definition.title)}</td>
                </tr>
                <tr>
                  <th scope="row">Credentials issued</th>
                  <td className="mono">{fmtNum(tx.issuedCount)}</td>
                </tr>
                <tr>
                  <th scope="row">Audited resets</th>
                  <td className="mono">{fmtNum(tx.resetCount)}</td>
                </tr>
                <tr>
                  <th scope="row">Issuance fingerprint</th>
                  <td className="mono">{tx.issuanceRoot}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            The registrar's public commitment: distinct ballots in this election must never exceed this issued count.
          </p>
        </>
      );
  }
}
