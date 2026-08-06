import { blockHash, txHash, type Tx } from '@votechain/protocol';
import { useNodeQuery } from '../lib/api';
import { fmtDateTime, fmtNum, shortHash, txChipClass, txSummary, txTypeLabel, validatorName } from '../lib/format';

export function BlockPage({ height, tick }: { height: number; tick: number }) {
  const valid = Number.isSafeInteger(height) && height >= 1;
  const q = useNodeQuery(valid, [height, tick], (client) => client.block(height));

  if (!valid) {
    return (
      <div className="notice danger">
        That is not a valid page number. Try <a href="#/record">browsing the record</a>.
      </div>
    );
  }
  if (q.notFound && q.data === null) {
    return (
      <div className="notice danger">
        There is no page {fmtNum(height)} yet; the record may not have reached it.{' '}
        <a href="#/record">Back to the record</a>
      </div>
    );
  }
  if (q.loading) return <p className="muted">Loading page…</p>;
  if (q.data === null) return <div className="notice danger">Could not load this page: {q.error ?? 'unknown error'}</div>;

  const block = q.data;
  const status = q.nodeStatus;
  const finalized = status !== null && block.height <= status.finalizedHeight;

  return (
    <>
      <div className="small muted">
        <a href="#/record">← The record</a>
      </div>

      <section className="card">
        <div className="spread">
          <h1 className="page-title">Page #{fmtNum(block.height)}</h1>
          <div className="row">
            {finalized ? <span className="chip ok">confirmed</span> : <span className="chip warn">not yet confirmed</span>}
            {block.height > 1 && (
              <a className="small" href={`#/page/${block.height - 1}`}>
                ← #{fmtNum(block.height - 1)}
              </a>
            )}
            {status !== null && block.height < status.height && (
              <a className="small" href={`#/page/${block.height + 1}`}>
                #{fmtNum(block.height + 1)} →
              </a>
            )}
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Fingerprint</th>
                <td className="mono">{blockHash(block)}</td>
              </tr>
              <tr>
                <th scope="row">Written</th>
                <td>{fmtDateTime(block.timestamp)}</td>
              </tr>
              <tr>
                <th scope="row">Written by</th>
                <td>
                  {status !== null ? validatorName(status.validators, block.proposer) : 'a record-keeper'}{' '}
                  <span className="mono muted small">{block.proposer}</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Previous page</th>
                <td className="mono">
                  {block.height > 1 ? (
                    <a href={`#/page/${block.height - 1}`}>{block.prevHash}</a>
                  ) : (
                    <>
                      {block.prevHash} <span className="muted small">(the opening page of this record)</span>
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Entries fingerprint</th>
                <td className="mono">{block.txRoot}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          This page locks in the fingerprint of the one before it. Change anything on any earlier page and every page
          after it stops matching, in public, on every copy.
        </p>
      </section>

      <section className="card">
        <h2>Entries on this page ({block.txs.length})</h2>
        {block.txs.length === 0 ? (
          <p className="muted">No entries on this page.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Summary</th>
                  <th>Entry id</th>
                </tr>
              </thead>
              <tbody>
                {block.txs.map((tx, index) => (
                  <TxRow key={index} tx={tx} index={index} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function TxRow({ tx, index }: { tx: Tx; index: number }) {
  const hash = txHash(tx);
  return (
    <tr>
      <td className="mono">{index}</td>
      <td>
        <span className={`chip ${txChipClass(tx.type)}`}>{txTypeLabel(tx.type)}</span>
      </td>
      <td className="small">{txSummary(tx)}</td>
      <td>
        <a className="mono" href={`#/entry/${hash}`}>
          {shortHash(hash, 14)}
        </a>
      </td>
    </tr>
  );
}
