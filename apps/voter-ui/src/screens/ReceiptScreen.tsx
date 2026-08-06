import { useEffect, useState } from 'react';
import type { Receipt, ReturnCodeLookup } from '@votechain/protocol';
import { RegistrarClient, HttpError } from '@votechain/protocol';
import { pickHealthyNode } from '../lib/nodes';
import { downloadReceipt } from '../lib/receipts';
import { REGISTRAR_URL, RESULTS_URL } from '../lib/config';
import { keeperLabel, keeperName, trackBallot, type BallotWhereabouts } from '../lib/tracking';

export function ReceiptScreen(props: { receipt: Receipt; onVoteAgain?: () => void; onDone: () => void }) {
  const { receipt } = props;
  const [where, setWhere] = useState<BallotWhereabouts | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /* The poll used to stop after four minutes and say nothing, leaving
     "waiting…" on screen indefinitely. Now running out is a state the voter
     is told about, with something to do about it. */
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      // Every record-keeper, not the first one that answers. A ballot one node
      // has is a claim; a ballot all of them have is the thing that makes it
      // hard to lose quietly, and it is the voter's to check.
      const result = await trackBallot(receipt);
      if (cancelled) return;
      setWhere(result);
      // Stop once every record-keeper that can answer holds it AND it has
      // settled: anything less and there is still something to watch.
      if (result.isFinal && result.answered > 0 && result.holding === result.answered) return;
      if (attempts++ < 120) {
        setTimeout(() => void poll(), 2000);
      } else {
        setGaveUp(true);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [receipt.electionId, receipt.token, receipt.txHash]);

  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const recorded = (where?.holding ?? 0) > 0;
  const isFinal = recorded && (where?.isFinal ?? false);
  const superseded = where?.superseded ?? false;

  /*
   * One state, in words.
   *
   * This was two chips a voter had to reconcile — "in the public record" and
   * "confirmed" — flipping independently over a poll that ran silently for
   * four minutes and then gave up, leaving the first message on screen
   * forever. They are really one journey with three stops, so it now reads as
   * one, and the stalled case says so instead of pretending to still be
   * working.
   */
  const stage: 'sending' | 'written' | 'settled' | 'stalled' = superseded
    ? 'settled'
    : isFinal
      ? 'settled'
      : recorded
        ? 'written'
        : gaveUp
          ? 'stalled'
          : 'sending';

  return (
    <div>
      <div className="card">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1 className="page-title" style={{ fontSize: 'clamp(21px, 3vw, 27px)' }}>
              {stage === 'settled' ? 'Your vote is counted.' : 'Your vote is in.'}
            </h1>
            <p className="muted" style={{ marginTop: 6 }}>
              {receipt.electionTitle}
            </p>
          </div>
          {stage === 'settled' && !superseded && (
            <span className="stamp">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 10.5l4 4 8-9" />
              </svg>
              Counted
            </span>
          )}
        </div>

        <ol className="track" aria-live="polite">
          <li className="done">
            <span className="track-mark" aria-hidden="true">✓</span>
            <span>Sent from this device</span>
          </li>
          <li className={recorded ? 'done' : stage === 'stalled' ? 'stuck' : 'doing'}>
            <span className="track-mark" aria-hidden="true">{recorded ? '✓' : stage === 'stalled' ? '!' : '·'}</span>
            <span>
              {/*
                Counted from what the record-keepers say they hold, not from
                what we think we sent them. A node that answered 409 at
                submission already had the ballot by gossip and would have been
                counted as a refusal; one that accepted might still drop it.
              */}
              {recorded
                ? `Written down by ${where?.holding} of ${where?.total} record-keepers, on page ${where?.blockHeight ?? '…'}`
                : stage === 'stalled'
                  ? 'Not written down yet'
                  : 'Being written down'}
            </span>
          </li>
          <li className={isFinal ? 'done' : recorded ? 'doing' : ''}>
            <span className="track-mark" aria-hidden="true">{isFinal ? '✓' : '·'}</span>
            <span>
              {isFinal
                ? 'Agreed by the record-keepers, so it can no longer change'
                : 'Waiting for the record-keepers to agree'}
            </span>
          </li>
        </ol>

        {where !== null && (
          <ul className="keepers" aria-label="What each record-keeper says">
            {where.keepers.map((k) => (
              <li key={k.url} className={`keeper-line ${k.state}`}>
                <span className="keeper-who">{keeperName(k)}</span>
                <span className="keeper-what">{keeperLabel(k)}</span>
              </li>
            ))}
          </ul>
        )}

        {where !== null && where.answered < where.total && (
          <p className="hint">
            {where.total - where.answered} record-keeper
            {where.total - where.answered === 1 ? ' did' : 's did'} not answer just now. That does not mean your
            ballot is missing from {where.total - where.answered === 1 ? 'it' : 'them'}; a browser cannot tell a
            record-keeper that is down from one that is quiet.
          </p>
        )}

        {stage === 'sending' && (
          <p className="hint">This usually takes a few seconds. You can close this page; your vote is already sent.</p>
        )}
        {stage === 'stalled' && (
          <div className="notice warn" role="status">
            Your ballot has not appeared in the record yet. It was sent, so it may still arrive. Keep your receipt
            below and check it on the results site in a few minutes.
          </div>
        )}
        {superseded && (
          <div className="notice info">
            This ballot was replaced by a later one you cast. Only your most recent ballot is counted.
          </div>
        )}
      </div>

      <div className="card">
        <h2>Your receipt</h2>
        <p className="small muted">
          The <em>token</em> is your anonymous ballot key. It is published in the public record, but nothing
          cryptographically ties it to you or your voter code. Keep this receipt to check your ballot at any time.
        </p>
        <label>Token (anonymous ballot key)</label>
        <div className="row">
          <code style={{ flex: 1 }}>{receipt.token}</code>
          <button className="btn secondary small" onClick={() => copy('token', receipt.token)}>
            {copied === 'token' ? 'copied ✓' : 'copy'}
          </button>
        </div>
        <label>Ballot entry id</label>
        <div className="row">
          <code style={{ flex: 1 }}>{receipt.txHash}</code>
          <button className="btn secondary small" onClick={() => copy('tx', receipt.txHash)}>
            {copied === 'tx' ? 'copied ✓' : 'copy'}
          </button>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => downloadReceipt(receipt)}>
            Download receipt (.json)
          </button>
          <a
            className="btn secondary"
            href={`${RESULTS_URL}/#/verify/${receipt.electionId}/${encodeURIComponent(receipt.token)}`}
            target="_blank"
            rel="noreferrer"
          >
            Verify on the public results site
          </a>
        </div>
        <div className="notice warn" style={{ marginTop: 14 }}>
          Anyone holding this receipt can see how this ballot voted once results are visible. Share it only if
          you are comfortable proving your vote.
        </div>
      </div>

      <ReturnCodePanel receipt={receipt} />

      <div className="row">
        {props.onVoteAgain && (
          <button className="btn secondary" onClick={props.onVoteAgain}>
            Change my vote (revote)
          </button>
        )}
        <button className="btn" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Cast-as-intended verification. The voter enters the Sheet ID printed on the
 * paper return-code sheet mailed by the commission; we ask the registrar (acting
 * as Return-Code Authority) for the secret code(s) of the option(s) actually
 * recorded for this ballot, and the voter compares them to their sheet.
 * Only the sheetId and the already-public token ever leave the device — never the
 * voter code or any identity, so anonymity is preserved.
 */
function ReturnCodePanel(props: { receipt: Receipt }) {
  const { receipt } = props;
  const [sheetId, setSheetId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [result, setResult] = useState<ReturnCodeLookup | null>(null);
  /*
   * Question text, so the comparison can be made at all. This panel used to
   * print the raw question id beside each code and ask the voter to check it
   * against a paper sheet, which shows the question in words. On a ballot with
   * more than one question there was no way to tell which code belonged where.
   */
  const [questionText, setQuestionText] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void pickHealthyNode()
      .then(({ client }) => client.election(receipt.electionId))
      .then((d) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const q of d.definition.questions) map[q.id] = q.text;
        setQuestionText(map);
      })
      .catch(() => {
        /* Falls back to the id below: worse, but not blocking. */
      });
    return () => {
      cancelled = true;
    };
  }, [receipt.electionId]);

  const lookup = async () => {
    const id = sheetId.trim();
    if (id.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setResult(null);
    try {
      const client = new RegistrarClient(REGISTRAR_URL);
      const lookupResult = await client.getReturnCodes(receipt.electionId, id, receipt.token);
      if (lookupResult.found) {
        setResult(lookupResult);
      } else {
        setNotFound(true);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        setError('That Sheet ID was not recognized for this election. Check for typos.');
      } else {
        // Never the raw exception: a voter has no use for "Failed to fetch".
        setError('We could not reach the code service. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2>Check your ballot against a paper sheet</h2>
      {/*
        The alarming half of this used to be stated up front, before the voter
        had done anything: "your device may have altered your vote". It belongs
        with the codes, where there is something to compare and act on, not as
        a greeting.
      */}
      <p className="small">
        Only if your organization mailed you a return-code sheet. Enter the Sheet ID printed on it and we will
        show the code for the option actually recorded, so you can check it matches the one printed beside your
        intended choice.
      </p>
      <p className="hint">Optional. Most elections do not use these sheets.</p>

      <label htmlFor="return-code-sheet-id">Sheet ID</label>
      <div className="row">
        <input
          id="return-code-sheet-id"
          type="text"
          className="mono"
          style={{ flex: 1 }}
          value={sheetId}
          placeholder="e.g. SHEET-1A2B-3C4D"
          onChange={(e) => setSheetId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void lookup();
          }}
        />
        <button className="btn" onClick={() => void lookup()} disabled={loading || sheetId.trim().length === 0}>
          {loading ? 'Looking up…' : 'Get my return code'}
        </button>
      </div>

      {notFound && (
        <div className="notice warn">
          No ballot is recorded for this receipt yet. Wait a few seconds for it to be written down and try again.
        </div>
      )}

      {error !== null && <div className="notice danger" role="alert">{error}</div>}

      {result && (
        <div className="notice ok" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Codes for your recorded ballot</strong>
            <span className={`chip ${result.isFinal ? 'ok' : 'warn'}`}>
              {result.isFinal ? 'confirmed ✓' : 'not yet confirmed'}
            </span>
          </div>

          {result.answers.map((answer) => (
            <div key={`${answer.questionId}:${answer.optionId}`} className="return-code-answer">
              <div className="small muted">{questionText[answer.questionId] ?? answer.questionId}</div>
              <div className="return-code">{answer.code}</div>
            </div>
          ))}

          {result.castCode !== null && (
            <div style={{ marginTop: 12 }}>
              <div className="small muted">Confirmation code</div>
              <div className="mono">{result.castCode}</div>
              <div className="hint">This confirms we're reading a real recorded ballot.</div>
            </div>
          )}

          <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
            Compare each code to the code printed next to your intended choice on your mailed sheet. They must
            match.
          </p>

          <div className="notice danger" style={{ marginTop: 12 }}>
            If any code does NOT match your intended choice, your vote may have been altered. Do not trust this
            device; report it to the commission.
          </div>
        </div>
      )}
    </div>
  );
}
