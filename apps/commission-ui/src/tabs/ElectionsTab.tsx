import { Fragment, useCallback, useEffect, useState } from 'react';
import { buildElectionCancelTx, HttpError } from '@votechain/protocol';
import type { ElectionDetail, ElectionSummary, ReturnCodeSheet } from '@votechain/protocol';
import { SettingsRequiredNotice, useApp } from '../App';
import {
  errorMessage,
  makeNodeClient,
  makeRegistrarClient,
  missingSettings,
  resultsAppElectionUrl,
} from '../lib/settings';
import { CreateElectionWizard } from './CreateElectionWizard';

interface ActionNotice {
  kind: 'ok' | 'warn' | 'danger';
  text: string;
}

interface SheetResult {
  election: ElectionSummary;
  sheets: ReturnCodeSheet[];
}

function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Human-readable, printable sheets — one block per voter, divider-separated. */
function sheetsToText(result: SheetResult): string {
  const divider = '='.repeat(72);
  const blocks = result.sheets.map((sheet) => {
    const lines: string[] = [];
    lines.push('Plainvote Return-Code Sheet');
    lines.push(`Election: ${sheet.electionTitle}`);
    lines.push(`Sheet ID: ${sheet.sheetId}`);
    lines.push(`Cast code: ${sheet.castCode}`);
    lines.push('');
    sheet.questions.forEach((q, qi) => {
      lines.push(`Question ${qi + 1}: ${q.text}`);
      for (const opt of q.options) {
        lines.push(`  ${opt.text}: ${opt.code}`);
      }
      lines.push('');
    });
    lines.push(
      'After voting, enter your Sheet ID in the voter app to reveal the return codes',
    );
    lines.push('for the options you chose, then check them against this sheet.');
    return lines.join('\n');
  });
  return `${blocks.join(`\n${divider}\n\n`)}\n`;
}

export function ElectionsTab() {
  const { settings } = useApp();
  const missing = missingSettings(settings);
  const ready = missing.length === 0;

  const [view, setView] = useState<'list' | 'create'>('list');
  const [elections, setElections] = useState<ElectionSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, ElectionDetail>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [sheetCount, setSheetCount] = useState('10');
  const [sheetResult, setSheetResult] = useState<SheetResult | null>(null);

  const refresh = useCallback(async () => {
    const node = makeNodeClient(settings);
    try {
      const res = await node.elections();
      // Fetch details for closed elections so we know whether the issuance
      // commitment has been posted yet (commit is null until then).
      const closed = res.elections.filter((e) => e.status === 'closed');
      const detailPairs = await Promise.all(
        closed.map(async (e): Promise<readonly [string, ElectionDetail] | null> => {
          try {
            return [e.electionId, await node.election(e.electionId)] as const;
          } catch {
            return null;
          }
        }),
      );
      const map: Record<string, ElectionDetail> = {};
      for (const pair of detailPairs) {
        if (pair) map[pair[0]] = pair[1];
      }
      setElections([...res.elections].sort((a, b) => b.createdAtHeight - a.createdAtHeight));
      setDetails(map);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [settings]);

  useEffect(() => {
    if (!ready || view !== 'list') return;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(id);
  }, [ready, view, refresh]);

  async function confirmCancel(election: ElectionSummary) {
    setBusy(`cancel:${election.electionId}`);
    setNotice(null);
    try {
      const node = makeNodeClient(settings);
      const status = await node.status();
      const reason = cancelReason.trim().normalize('NFC');
      const tx = buildElectionCancelTx(
        status.chainId,
        election.electionId,
        settings.commissionSecretKey.trim(),
        reason.length > 0 ? reason : undefined,
      );
      const result = await node.submitTx(tx);
      if (result.accepted) {
        setNotice({
          kind: 'ok',
          text: `Election "${election.title}" cancelled (entry ${result.txHash ?? 'unknown'}).`,
        });
        setCancelFor(null);
        setCancelReason('');
        await refresh();
      } else {
        setNotice({ kind: 'danger', text: `Cancellation refused: ${result.reason ?? 'no reason given'}` });
      }
    } catch (e) {
      setNotice({ kind: 'danger', text: `Cancel failed: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function postCommitment(election: ElectionSummary) {
    setBusy(`commit:${election.electionId}`);
    setNotice(null);
    try {
      const registrar = makeRegistrarClient(settings);
      const res = await registrar.commitIssuance(election.electionId);
      if (res.accepted) {
        setNotice({
          kind: 'ok',
          text: `Issuance commitment published for "${election.title}" (entry ${res.txHash}): ${res.issuedCount} credential(s) issued, ${res.resetCount} audited reset(s).`,
        });
      } else {
        setNotice({
          kind: 'warn',
          text: `Issuance commitment for "${election.title}" was sent (entry ${res.txHash}) but has not been accepted yet.`,
        });
      }
      await refresh();
    } catch (e) {
      setNotice({ kind: 'danger', text: `Issuance commitment failed: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function generateSheets(election: ElectionSummary) {
    const count = Math.trunc(Number(sheetCount));
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      setNotice({ kind: 'danger', text: 'Count must be between 1 and 1000.' });
      return;
    }
    setBusy(`sheets:${election.electionId}`);
    setNotice(null);
    try {
      const res = await makeRegistrarClient(settings).generateReturnCodeSheets(election.electionId, count);
      setSheetResult({ election, sheets: res.sheets });
      setSheetFor(null);
    } catch (e) {
      if (e instanceof HttpError) {
        const body = e.body as { error?: string } | null;
        if (e.status === 502 && body?.error === 'election_unavailable') {
          setNotice({
            kind: 'warn',
            text: "This election isn't readable from the record yet. Make sure it was created and written down, then retry.",
          });
        } else if (e.status === 401) {
          setNotice({ kind: 'danger', text: 'Check your registrar admin key in Setup.' });
        } else {
          setNotice({ kind: 'danger', text: `Return-code sheets failed: ${errorMessage(e)}` });
        }
      } else {
        setNotice({ kind: 'danger', text: `Return-code sheets failed: ${errorMessage(e)}` });
      }
    } finally {
      setBusy(null);
    }
  }

  if (!ready) {
    return (
      <section>
        <SettingsRequiredNotice missing={missing} />
      </section>
    );
  }

  if (view === 'create') {
    return (
      <CreateElectionWizard
        onClose={() => {
          setView('list');
          void refresh();
        }}
      />
    );
  }

  return (
    <section>
      <div className="card">
        <div className="spread">
          <h2>Elections</h2>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setNotice(null);
              setView('create');
            }}
          >
            New election
          </button>
        </div>
        {loadError && <div className="notice danger">Record-keeper unreachable: {loadError}</div>}
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {elections === null && !loadError && <p className="muted">Loading elections…</p>}
        {elections !== null && elections.length === 0 && (
          <p className="muted">No elections in the record yet. Create the first one.</p>
        )}
        {elections !== null && elections.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Election</th>
                  <th>Status</th>
                  <th>Schedule</th>
                  <th>Results</th>
                  <th>Revote</th>
                  <th>Turnout</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {elections.map((e) => {
                  const detail = details[e.electionId];
                  const canCommit = e.status === 'closed' && detail !== undefined && detail.commit === null;
                  const committed = e.status === 'closed' && detail !== undefined && detail.commit !== null;
                  return (
                    <Fragment key={e.electionId}>
                      <tr>
                        <td>
                          <div>{e.title}</div>
                          <div className="small muted">
                            <span className="mono">{e.electionId.slice(0, 8)}…</span> ·{' '}
                            {e.questionCount} question{e.questionCount === 1 ? '' : 's'}
                          </div>
                        </td>
                        <td>
                          <span className={`chip ${e.status}`}>{e.status}</span>
                        </td>
                        <td className="small">
                          <div>{new Date(e.startTime).toLocaleString()}</div>
                          <div className="muted">to {new Date(e.endTime).toLocaleString()}</div>
                        </td>
                        <td className="small">{e.resultsVisibility === 'live' ? 'live' : 'after close'}</td>
                        <td className="small">{e.allowRevote ? 'allowed' : 'no'}</td>
                        <td>
                          {e.turnout} / {e.eligibleCount}
                        </td>
                        <td>
                          <div className="actions-cell">
                            {e.status === 'upcoming' && cancelFor !== e.electionId && (
                              <button
                                type="button"
                                className="btn danger small"
                                disabled={busy !== null}
                                onClick={() => {
                                  setCancelFor(e.electionId);
                                  setCancelReason('');
                                  setNotice(null);
                                }}
                              >
                                Cancel…
                              </button>
                            )}
                            {canCommit && (
                              <button
                                type="button"
                                className="btn small"
                                disabled={busy !== null}
                                onClick={() => void postCommitment(e)}
                              >
                                {busy === `commit:${e.electionId}` ? 'Posting…' : 'Post issuance commitment'}
                              </button>
                            )}
                            {committed && <span className="chip info">issuance committed</span>}
                            {sheetFor !== e.electionId && (
                              <button
                                type="button"
                                className="btn secondary small"
                                disabled={busy !== null}
                                onClick={() => {
                                  setSheetFor(e.electionId);
                                  setSheetCount('10');
                                  setNotice(null);
                                }}
                              >
                                Return-code sheets…
                              </button>
                            )}
                            <a
                              className="small"
                              href={resultsAppElectionUrl(e.electionId)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Public results
                            </a>
                          </div>
                        </td>
                      </tr>
                      {cancelFor === e.electionId && (
                        <tr>
                          <td colSpan={7}>
                            <div className="row">
                              <input
                                type="text"
                                className="flex-input"
                                maxLength={1024}
                                placeholder="Cancellation reason (optional; published in the public record)"
                                value={cancelReason}
                                onChange={(ev) => setCancelReason(ev.target.value)}
                              />
                              <button
                                type="button"
                                className="btn danger small"
                                disabled={busy !== null}
                                onClick={() => void confirmCancel(e)}
                              >
                                {busy === `cancel:${e.electionId}` ? 'Cancelling…' : 'Confirm cancel'}
                              </button>
                              <button
                                type="button"
                                className="btn secondary small"
                                disabled={busy !== null}
                                onClick={() => {
                                  setCancelFor(null);
                                  setCancelReason('');
                                }}
                              >
                                Keep election
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {sheetFor === e.electionId && (
                        <tr>
                          <td colSpan={7}>
                            <div className="row">
                              <label className="small muted" htmlFor={`sheet-count-${e.electionId}`}>
                                How many voter sheets?
                              </label>
                              <input
                                id={`sheet-count-${e.electionId}`}
                                type="number"
                                className="count-input"
                                min={1}
                                max={1000}
                                value={sheetCount}
                                onChange={(ev) => setSheetCount(ev.target.value)}
                                aria-label="Number of return-code sheets to generate"
                              />
                              <button
                                type="button"
                                className="btn small"
                                disabled={busy !== null}
                                onClick={() => void generateSheets(e)}
                              >
                                {busy === `sheets:${e.electionId}` ? 'Generating…' : 'Generate sheets'}
                              </button>
                              <button
                                type="button"
                                className="btn secondary small"
                                disabled={busy !== null}
                                onClick={() => setSheetFor(null)}
                              >
                                Cancel
                              </button>
                            </div>
                            <p className="hint">
                              One secret sheet per voter, shown once. 1–1000.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          Refreshes automatically every 5 seconds. Elections can only be cancelled before they start; the
          issuance commitment can be posted once an election closes.
        </p>
      </div>

      {sheetResult && (
        <div className="card">
          <div className="spread">
            <h2>Return-code sheets ({sheetResult.sheets.length})</h2>
            <button type="button" className="btn secondary small" onClick={() => setSheetResult(null)}>
              Dismiss
            </button>
          </div>
          <div className="notice warn">
            <strong>These return-code sheets are shown ONCE.</strong> Download them now: the secret codes are
            stored nowhere and cannot be retrieved again. Mail each sheet to the corresponding voter.
          </div>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadText(
                  `plainvote-return-code-sheets-${sheetResult.election.electionId.slice(0, 8)}-${new Date()
                    .toISOString()
                    .slice(0, 10)}.txt`,
                  sheetsToText(sheetResult),
                )
              }
            >
              Download sheets (.txt)
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() =>
                downloadText(
                  `plainvote-return-code-sheets-${sheetResult.election.electionId.slice(0, 8)}-${new Date()
                    .toISOString()
                    .slice(0, 10)}.json`,
                  JSON.stringify(sheetResult.sheets, null, 2) + '\n',
                  'application/json',
                )
              }
            >
              Download (.json)
            </button>
          </div>

          {sheetResult.sheets[0] && (
            <div className="stack">
              <div className="small muted">
                Preview of the first sheet: Sheet ID{' '}
                <span className="mono">{sheetResult.sheets[0].sheetId}</span>, cast code{' '}
                <span className="mono">{sheetResult.sheets[0].castCode}</span>.
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Option</th>
                      <th>Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetResult.sheets[0].questions.flatMap((q) =>
                      q.options.map((opt) => (
                        <tr key={`${q.questionId}:${opt.optionId}`}>
                          <td className="small">{q.text}</td>
                          <td className="small">{opt.text}</td>
                          <td>
                            <span className="mono">{opt.code}</span>
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="hint">
            Give each voter their Sheet ID (on their sheet). They enter it in the voter app after voting to
            verify their ballot.
          </p>
          <div className="notice info">
            Return codes let voters detect a compromised device; they are optional per election, and
            distributing sheets by the same trusted channel as voter codes is required for the guarantee.
          </div>
        </div>
      )}
    </section>
  );
}
