import { useCallback, useEffect, useState } from 'react';
import type { CodeInfo, RegistrarStats } from '@votechain/protocol';
import { SettingsRequiredNotice, useApp } from '../App';
import { errorMessage, makeRegistrarClient, missingSettings } from '../lib/settings';

interface ActionNotice {
  kind: 'ok' | 'danger';
  text: string;
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function CodesTab() {
  const { settings } = useApp();
  const missing = missingSettings(settings, ['registrarUrl', 'registrarAdminKey']);
  const ready = missing.length === 0;

  const [stats, setStats] = useState<RegistrarStats | null>(null);
  const [codes, setCodes] = useState<CodeInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [genCount, setGenCount] = useState('10');
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [regenerated, setRegenerated] = useState<{ codeHash: string; code: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [resetCodeHash, setResetCodeHash] = useState('');
  const [resetElectionId, setResetElectionId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const registrar = makeRegistrarClient(settings);
      const [statsRes, codesRes] = await Promise.all([registrar.stats(), registrar.listCodes()]);
      setStats(statsRes);
      setCodes(codesRes.codes);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [settings]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  function copyToClipboard(which: string, text: string) {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(which);
        window.setTimeout(() => {
          setCopied((current) => (current === which ? null : current));
        }, 2000);
      },
      () => setNotice({ kind: 'danger', text: 'Could not write to the clipboard. Copy the codes manually.' }),
    );
  }

  async function generate() {
    const count = Math.trunc(Number(genCount));
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      setNotice({ kind: 'danger', text: 'Count must be between 1 and 1000.' });
      return;
    }
    setBusy('generate');
    setNotice(null);
    try {
      const res = await makeRegistrarClient(settings).generateCodes(count);
      setGenerated(res.codes);
      await refresh();
    } catch (e) {
      setNotice({ kind: 'danger', text: `Generating codes failed: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(codeHash: string) {
    const shortHash = `${codeHash.slice(0, 16)}…`;
    if (
      !window.confirm(
        `Revoke code ${shortHash}? A voter holding this code will no longer be able to obtain credentials.`,
      )
    ) {
      return;
    }
    setBusy(`revoke:${codeHash}`);
    setNotice(null);
    try {
      await makeRegistrarClient(settings).revokeCode(codeHash);
      setNotice({ kind: 'ok', text: `Code ${shortHash} revoked.` });
      await refresh();
    } catch (e) {
      setNotice({ kind: 'danger', text: `Revoke failed: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function regenerate(codeHash: string) {
    setBusy(`regen:${codeHash}`);
    setNotice(null);
    try {
      const res = await makeRegistrarClient(settings).regenerateCode(codeHash);
      setRegenerated({ codeHash, code: res.code });
      await refresh();
    } catch (e) {
      setNotice({ kind: 'danger', text: `Regenerate failed: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function submitReset() {
    const codeHash = resetCodeHash.trim();
    const electionId = resetElectionId.trim();
    if (codeHash.length === 0 || electionId.length === 0) {
      setNotice({ kind: 'danger', text: 'An issuance reset needs both a code hash and an election id.' });
      return;
    }
    setBusy('reset');
    setNotice(null);
    try {
      const res = await makeRegistrarClient(settings).resetIssuance(codeHash, electionId);
      setNotice({
        kind: 'ok',
        text: `Issuance reset recorded. This election now has ${res.resetCount} audited reset(s), publicly counted in its issuance commitment in the record.`,
      });
      setResetCodeHash('');
      setResetElectionId('');
      await refresh();
    } catch (e) {
      setNotice({ kind: 'danger', text: `Issuance reset failed: ${errorMessage(e)}` });
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

  return (
    <section>
      {loadError && <div className="notice danger">Registrar unreachable: {loadError}</div>}
      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <div className="grid two">
        <div className="card">
          <h2>Active codes</h2>
          <div className="stat-number">{stats ? stats.activeCodes : '–'}</div>
          <p className="muted small">Codes voters can still redeem for credentials.</p>
        </div>
        <div className="card">
          <h2>Revoked codes</h2>
          <div className="stat-number">{stats ? stats.revokedCodes : '–'}</div>
          <p className="muted small">Withdrawn or replaced codes; hashes are kept for the audit trail.</p>
        </div>
        <div className="card">
          <h2>Per-election issuance</h2>
          {stats === null && <p className="muted small">Loading…</p>}
          {stats !== null && stats.elections.length === 0 && (
            <p className="muted small">No credentials issued yet.</p>
          )}
          {stats !== null && stats.elections.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Election</th>
                    <th>Issued</th>
                    <th>Resets</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.elections.map((entry) => (
                    <tr key={entry.electionId}>
                      <td>
                        <span className="mono">{entry.electionId.slice(0, 8)}…</span>
                      </td>
                      <td>{entry.credentialsIssued}</td>
                      <td>{entry.resets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Generate voter codes</h2>
        <p className="muted small">
          Each code is a one-time bearer secret handed to a voter over a trusted channel. The registrar stores
          only a hash of it.
        </p>
        <div className="row">
          <input
            type="number"
            className="count-input"
            min={1}
            max={1000}
            value={genCount}
            onChange={(e) => setGenCount(e.target.value)}
            aria-label="Number of codes to generate"
          />
          <button type="button" className="btn" onClick={() => void generate()} disabled={busy !== null}>
            {busy === 'generate' ? 'Generating…' : 'Generate codes'}
          </button>
        </div>
      </div>

      {generated && (
        <div className="card">
          <div className="spread">
            <h2>New voter codes ({generated.length})</h2>
            <button type="button" className="btn secondary small" onClick={() => setGenerated(null)}>
              Dismiss
            </button>
          </div>
          <div className="notice warn">
            <strong>These codes are shown ONCE.</strong> Download or copy them now: only hashes are stored on
            the registrar, and there is no way to display them again.
          </div>
          <pre className="code-list">{generated.join('\n')}</pre>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadText(
                  `plainvote-codes-${new Date().toISOString().slice(0, 10)}.txt`,
                  generated.join('\n') + '\n',
                )
              }
            >
              Download .txt
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => copyToClipboard('generated', generated.join('\n'))}
            >
              {copied === 'generated' ? 'Copied' : 'Copy all'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="spread">
          <h2>Voter codes{codes !== null ? ` (${codes.length})` : ''}</h2>
          <button
            type="button"
            className="btn secondary small"
            onClick={() => void refresh()}
            disabled={busy !== null}
          >
            Refresh
          </button>
        </div>
        {regenerated && (
          <div className="notice ok">
            Replacement for <span className="mono">{regenerated.codeHash.slice(0, 16)}…</span>: new code
            (shown once): <code>{regenerated.code}</code>{' '}
            <button
              type="button"
              className="btn secondary small"
              onClick={() => copyToClipboard('regenerated', regenerated.code)}
            >
              {copied === 'regenerated' ? 'Copied' : 'Copy'}
            </button>{' '}
            <button type="button" className="btn secondary small" onClick={() => setRegenerated(null)}>
              Dismiss
            </button>
          </div>
        )}
        {codes === null && !loadError && <p className="muted">Loading codes…</p>}
        {codes !== null && codes.length === 0 && <p className="muted">No codes yet. Generate some above.</p>}
        {codes !== null && codes.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Code hash</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Issued elections</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.codeHash}>
                    <td>
                      <span className="mono">{c.codeHash.slice(0, 16)}…</span>
                    </td>
                    <td>
                      <span className={`chip ${c.status === 'active' ? 'ok' : 'danger'}`}>{c.status}</span>
                      {c.replacedBy && (
                        <div className="small muted">
                          replaced by <span className="mono">{c.replacedBy.slice(0, 8)}…</span>
                        </div>
                      )}
                    </td>
                    <td className="small">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>{c.issuedElections.length}</td>
                    <td>
                      {c.status === 'active' ? (
                        <div className="row">
                          <button
                            type="button"
                            className="btn danger small"
                            disabled={busy !== null}
                            onClick={() => void revoke(c.codeHash)}
                          >
                            {busy === `revoke:${c.codeHash}` ? 'Revoking…' : 'Revoke'}
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            disabled={busy !== null}
                            onClick={() => void regenerate(c.codeHash)}
                          >
                            {busy === `regen:${c.codeHash}` ? 'Regenerating…' : 'Regenerate'}
                          </button>
                        </div>
                      ) : (
                        <span className="muted small">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <details className="advanced">
          <summary>Advanced: audited issuance reset</summary>
          <div className="notice warn">
            Resets let a voter who lost their device obtain a second credential for an election. Every reset is
            publicly counted in the registrar's public issuance commitment, so observers can audit how often this power
            is used.
          </div>
          <div className="grid two">
            <div>
              <label htmlFor="reset-code-hash">Code hash</label>
              <input
                id="reset-code-hash"
                type="text"
                className="mono"
                value={resetCodeHash}
                onChange={(e) => setResetCodeHash(e.target.value)}
                placeholder="64-character hex code hash"
              />
            </div>
            <div>
              <label htmlFor="reset-election-id">Election id</label>
              <input
                id="reset-election-id"
                type="text"
                className="mono"
                value={resetElectionId}
                onChange={(e) => setResetElectionId(e.target.value)}
                placeholder="election id (uuid)"
              />
            </div>
          </div>
          <div className="row actions-row">
            <button
              type="button"
              className="btn secondary"
              onClick={() => void submitReset()}
              disabled={busy !== null}
            >
              {busy === 'reset' ? 'Recording reset…' : 'Record audited reset'}
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}
