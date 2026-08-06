import { useEffect, useMemo, useState } from 'react';
import type { ElectionDetail, Receipt, VoteLookupResponse } from '@votechain/protocol';
import { useNodeQuery } from '../lib/api';
import { fmtDateTime, resolveAnswers, shortHash } from '../lib/format';
import { navigate } from '../lib/hashRouter';

interface ParsedReceipt {
  receipt: Receipt | null;
  error: string | null;
}

function parseReceipt(text: string): ParsedReceipt {
  if (text.trim().length === 0) return { receipt: null, error: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { receipt: null, error: 'Not valid JSON. Paste the exact contents of your downloaded receipt file.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { receipt: null, error: 'A receipt is a JSON object with electionId and token fields.' };
  }
  const raw = value as Partial<Record<keyof Receipt, unknown>>;
  if (typeof raw.electionId !== 'string' || raw.electionId.length === 0 || typeof raw.token !== 'string' || raw.token.length === 0) {
    return { receipt: null, error: 'Receipt is missing its electionId or token field.' };
  }
  return {
    receipt: {
      chainId: typeof raw.chainId === 'string' ? raw.chainId : '',
      electionId: raw.electionId,
      electionTitle: typeof raw.electionTitle === 'string' ? raw.electionTitle : '',
      token: raw.token,
      txHash: typeof raw.txHash === 'string' ? raw.txHash : '',
      nonce: typeof raw.nonce === 'number' ? raw.nonce : 0,
      castAt: typeof raw.castAt === 'number' ? raw.castAt : 0,
      nodeUrls: Array.isArray(raw.nodeUrls) ? raw.nodeUrls.filter((u): u is string => typeof u === 'string') : [],
    },
    error: null,
  };
}

interface LookupData {
  lookup: VoteLookupResponse;
  detail: ElectionDetail | null;
}

export function VerifyPage({ electionId, token, tick }: { electionId: string; token: string; tick: number }) {
  const active = electionId !== '' && token !== '';

  const electionsQ = useNodeQuery(true, [tick], (client) => client.elections());

  const [receiptText, setReceiptText] = useState('');
  const parsed = useMemo(() => parseReceipt(receiptText), [receiptText]);
  const [formElection, setFormElection] = useState(electionId);
  const [formToken, setFormToken] = useState(token);

  // Prefill the form when arriving on a #/verify/:electionId/:token link.
  useEffect(() => {
    if (electionId !== '') setFormElection(electionId);
    if (token !== '') setFormToken(token);
  }, [electionId, token]);

  // A successfully parsed receipt fills the form fields.
  useEffect(() => {
    if (parsed.receipt !== null) {
      setFormElection(parsed.receipt.electionId);
      setFormToken(parsed.receipt.token);
    }
  }, [parsed.receipt]);

  const lookupQ = useNodeQuery<LookupData>(active, [electionId, token, tick], async (client) => {
    const lookup = await client.voteLookup(electionId, token);
    let detail: ElectionDetail | null = null;
    try {
      detail = await client.election(electionId);
    } catch {
      detail = null;
    }
    return { lookup, detail };
  });

  const canSubmit = formElection !== '' && formToken.trim() !== '';
  const submit = () => {
    if (canSubmit) navigate(`#/verify/${encodeURIComponent(formElection)}/${encodeURIComponent(formToken.trim())}`);
  };

  const receiptForLookup =
    parsed.receipt !== null && parsed.receipt.electionId === electionId && parsed.receipt.token === token
      ? parsed.receipt
      : null;

  const elections = electionsQ.data?.elections ?? [];
  const hasCurrentOption = elections.some((e) => e.electionId === formElection);

  return (
    <>
      <section className="card">
        <h1 className="page-title">Verify a ballot</h1>
        <p>Paste your receipt file or enter your election + token to confirm your ballot is recorded and counted.</p>
        <div className="grid two">
          <div>
            <label htmlFor="verify-receipt">Receipt JSON</label>
            <textarea
              id="verify-receipt"
              className="mono"
              rows={7}
              value={receiptText}
              placeholder='{ "electionId": "…", "token": "…", "txHash": "…", … }'
              onChange={(e) => setReceiptText(e.target.value)}
            />
            {parsed.error !== null && <p className="hint">⚠ {parsed.error}</p>}
            {parsed.receipt !== null && (
              <p className="hint">
                ✓ Receipt parsed
                {parsed.receipt.electionTitle !== '' ? `: “${parsed.receipt.electionTitle}”` : ''}
                {parsed.receipt.castAt > 0 ? `, cast ${fmtDateTime(parsed.receipt.castAt)}` : ''}.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="verify-election">Election</label>
            <select id="verify-election" value={formElection} onChange={(e) => setFormElection(e.target.value)}>
              <option value="">Choose an election</option>
              {!hasCurrentOption && formElection !== '' && <option value={formElection}>{formElection}</option>}
              {elections.map((e) => (
                <option key={e.electionId} value={e.electionId}>
                  {e.title}
                </option>
              ))}
            </select>
            <label htmlFor="verify-token">Ballot token</label>
            <input
              id="verify-token"
              type="text"
              value={formToken}
              placeholder="anonymous token from your receipt"
              onChange={(e) => setFormToken(e.target.value)}
            />
            <p>
              <button type="button" className="btn" onClick={submit} disabled={!canSubmit}>
                Check my ballot
              </button>
            </p>
          </div>
        </div>
        <p className="hint">The lookup uses only your anonymous one-time token; it never reveals who you are.</p>
      </section>

      {active && lookupQ.notFound && lookupQ.data === null && (
        <div className="notice danger">
          Unknown election <code>{electionId}</code>: there is no such election in the record.
        </div>
      )}
      {active && lookupQ.loading && <p className="muted">Looking up ballot…</p>}
      {active && !lookupQ.loading && !lookupQ.notFound && lookupQ.data === null && lookupQ.error !== null && (
        <div className="notice danger">Lookup failed: {lookupQ.error}</div>
      )}
      {active && lookupQ.data !== null && <LookupResult data={lookupQ.data} receipt={receiptForLookup} />}
    </>
  );
}

function LookupResult({ data, receipt }: { data: LookupData; receipt: Receipt | null }) {
  const { lookup, detail } = data;
  if (!lookup.found) {
    return (
      <div className="notice danger">
        No ballot recorded for this token in this election. If you voted seconds ago, wait for the next page of the
        record and it will appear; otherwise your vote never reached the record-keepers.
      </div>
    );
  }

  const receiptTxHash = receipt !== null ? receipt.txHash : '';
  const receiptStatus =
    receiptTxHash === ''
      ? null
      : lookup.countedTxHash === receiptTxHash
        ? 'counted'
        : lookup.records.some((r) => r.txHash === receiptTxHash)
          ? 'superseded'
          : 'missing';

  return (
    <section className="card">
      <div className="spread">
        <h2>Ballot record</h2>
        <div className="row">
          <span className="chip ok">✓ in the public record</span>
          {lookup.isFinal ? <span className="chip ok">confirmed</span> : <span className="chip warn">not yet confirmed</span>}
        </div>
      </div>

      {receiptStatus === 'counted' && (
        <div className="notice ok">
          The ballot on your receipt (<code>{shortHash(receiptTxHash, 16)}</code>) is in the record, and it is the one
          being counted.
        </div>
      )}
      {receiptStatus === 'superseded' && (
        <div className="notice info">
          The ballot on your receipt is in the record, but you voted again later and that newer ballot replaced it.
        </div>
      )}
      {receiptStatus === 'missing' && (
        <div className="notice warn">
          The ballot on your receipt is not among the ones recorded for this token. Check again with a different
          record-keeper before trusting this result.
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>Entry</th>
              <th>Version</th>
              <th>Status</th>
              <th>Ballot</th>
            </tr>
          </thead>
          <tbody>
            {lookup.records.map((record) => (
              <tr key={record.txHash}>
                <td>
                  <a className="mono" href={`#/page/${record.blockHeight}`}>
                    #{record.blockHeight}
                  </a>
                </td>
                <td>
                  <a className="mono" href={`#/entry/${record.txHash}`}>
                    {shortHash(record.txHash, 12)}
                  </a>
                </td>
                <td className="mono">{record.nonce}</td>
                <td>
                  {record.counted ? (
                    <span className="chip ok">✓ counted</span>
                  ) : record.supersededByTxHash !== null ? (
                    <a className="small" href={`#/entry/${record.supersededByTxHash}`}>
                      replaced by {shortHash(record.supersededByTxHash, 12)}
                    </a>
                  ) : (
                    <span className="chip closed">not counted</span>
                  )}
                </td>
                <td className="small">
                  {record.answers !== null ? (
                    resolveAnswers(detail, record.answers)
                      .map((a) => `${a.question}: ${a.answer}`)
                      .join(' · ')
                  ) : (
                    <span className="muted">hidden until results unlock</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!lookup.answersVisible && (
        <p className="hint">
          This election reveals ballot contents only after it closes; the records above still prove your vote is
          included.
        </p>
      )}
      {!lookup.isFinal && (
        <p className="hint">
          Not yet confirmed: a page holding one of these ballots is still waiting for enough record-keepers to build on
          it. Check back shortly.
        </p>
      )}
    </section>
  );
}
