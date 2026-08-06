import { blockHash, type Block } from '@votechain/protocol';
import { NODE_URLS, useNodeQuery } from '../lib/api';
import { fmtNum, fmtTime, shortHash, validatorName } from '../lib/format';

export function ExplorerPage({ tick }: { tick: number }) {
  const q = useNodeQuery(true, [tick], (client) => client.blocks());
  const status = q.nodeStatus;
  const blocks: Block[] | null = q.data !== null ? [...q.data.blocks].reverse() : null;

  return (
    <>
      <section className="card">
        <div className="spread">
          <h1 className="page-title">The public record</h1>
          {status !== null && (
            <span className="small muted">
              read from {status.nodeName} · record <code>{shortHash(status.chainId, 12)}</code>
            </span>
          )}
        </div>
        <p className="small">
          Everything this election system does is written here, in the open: every ballot, every election, every
          signature. The record is a numbered sequence of <strong>pages</strong>, and each page holds one or more{' '}
          <strong>entries</strong>. Several independent record-keepers hold their own copy, and each page names the one
          that wrote it and locks in the fingerprint of the page before it, so a page cannot be rewritten after the
          fact without every later page visibly failing to match.
        </p>
        {status !== null && (
          <div className="stats">
            <div className="stat">
              <span className="num">{fmtNum(status.height)}</span>
              <span className="lbl">pages written</span>
            </div>
            <div className="stat">
              <span className="num">{fmtNum(status.finalizedHeight)}</span>
              <span className="lbl">confirmed</span>
            </div>
            <div className="stat">
              <span className="num">{fmtNum(status.validators.length)}</span>
              <span className="lbl">record-keepers</span>
            </div>
            <div className="stat">
              <span className="num">{fmtNum(status.peerCount)}</span>
              <span className="lbl">connections</span>
            </div>
            <div className="stat">
              <span className="num">{fmtNum(status.mempoolSize)}</span>
              <span className="lbl">waiting to be recorded</span>
            </div>
          </div>
        )}
        {status !== null && status.equivocations.length === 0 && (
          <p className="hint">
            No contradictions found: no record-keeper has signed two different versions of the same page.
          </p>
        )}
      </section>

      {status !== null &&
        status.equivocations.map((eq) => (
          /* Appears mid-session when evidence lands, so it has to interrupt. */
          <div className="notice danger" role="alert" key={`${eq.height}:${eq.proposer}`}>
            <strong>Contradiction detected.</strong> Record-keeper {validatorName(status.validators, eq.proposer)}{' '}
            signed {eq.blockHashes.length} conflicting versions of page {fmtNum(eq.height)}:{' '}
            {eq.blockHashes.map((h) => shortHash(h, 12)).join(', ')}. Treat recent results as suspect until this is
            resolved.
          </div>
        ))}

      {q.loading && (
        <p className="muted" role="status" aria-live="polite">
          Loading the record…
        </p>
      )}
      {q.error !== null && q.data === null && !q.loading && (
        <div className="notice danger" role="alert">
          We could not reach a record-keeper.
          {/* The addresses were printed to every visitor on any outage, which
              exposes the deployment's topology and means nothing to a reader. */}
          <div className="small">Try again in a moment, or name a record-keeper of your own on an election page.</div>
        </div>
      )}
      {q.error !== null && q.data !== null && (
        <div className="notice warn">Live refresh failed ({q.error}); showing the last pages received.</div>
      )}

      {blocks !== null && (
        <section className="card">
          <h2>Most recent pages</h2>
          {/* Scrolls rather than hiding columns: this is the page whose whole
              job is showing the record in full, so dropping the fingerprint or
              the record-keeper on a phone would withhold exactly the evidence
              a reader came for. */}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Time</th>
                  <th>Written by</th>
                  <th>Entries</th>
                  <th>Fingerprint</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((block) => (
                  <tr key={block.height}>
                    <td>
                      <a className="mono" href={`#/page/${block.height}`}>
                        #{fmtNum(block.height)}
                      </a>
                    </td>
                    <td title={new Date(block.timestamp).toLocaleString()}>{fmtTime(block.timestamp)}</td>
                    <td>{status !== null ? validatorName(status.validators, block.proposer) : shortHash(block.proposer, 12)}</td>
                    <td className="mono">{block.txs.length}</td>
                    <td className="mono">{shortHash(blockHash(block), 16)}</td>
                  </tr>
                ))}
                {blocks.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Nothing recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
