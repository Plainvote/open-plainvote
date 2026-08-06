import { useEffect, useMemo, useState } from 'react';
import {
  buildVoteCastTx,
  type ElectionDetail,
  type Receipt,
} from '@votechain/protocol';
import { allNodeClients, pickHealthyNode } from '../lib/nodes';
import { ensureCredential, findCredential, type StoredCredential } from '../lib/credential';
import { latestReceiptFor, receiptForToken, saveReceipt } from '../lib/receipts';
import { NODE_URLS } from '../lib/config';
import { navigate } from '../lib/router';
import { clearDraft, draftAnswers, getCode, getDraft, setDraft } from '../lib/session';

/**
 * Choosing, then confirming, then casting.
 *
 * One component spans both the ballot and its review because they are one act:
 * routing between them must not refetch the election, re-mint the credential,
 * or lose the answers already chosen. The review exists because a cast is
 * irreversible in an election without revoting, and until now the last thing
 * between a voter and that was a single button with no summary of what it was
 * about to submit.
 */

type CredState =
  | { phase: 'loading' }
  | { phase: 'ready'; credential: StoredCredential }
  /** No credential on this device and no code in memory: usually a fresh tab. */
  | { phase: 'needs-code' }
  | { phase: 'failed'; message: string; elsewhere?: boolean };

export function VoteFlow(props: { chainId: string; electionId: string; phase: 'choose' | 'review' }) {
  const { chainId, electionId } = props;
  const [detail, setDetail] = useState<ElectionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cred, setCred] = useState<CredState>({ phase: 'loading' });
  const [selections, setSelectionsState] = useState<Record<string, string>>(() => getDraft(electionId));
  const [casting, setCasting] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);

  /** Answers live in the module-level draft so a step to the review keeps them. */
  function updateSelections(next: Record<string, string>): void {
    setSelectionsState(next);
    setDraft(electionId, next);
  }

  useEffect(() => {
    let cancelled = false;

    /*
     * Recovery first, and synchronously: if this device already holds a
     * credential for this election, the voter is resumed without their code
     * and without a round trip. This is what makes a refresh, a Back, or
     * reopening the tab tomorrow land the voter back on their ballot.
     */
    const existing = findCredential(chainId, electionId);
    if (existing !== null) setCred({ phase: 'ready', credential: existing });

    void (async () => {
      try {
        const { client } = await pickHealthyNode();
        const d = await client.election(electionId);
        if (cancelled) return;
        setDetail(d);

        if (existing !== null) return;

        const code = getCode();
        if (code === null) {
          setCred({ phase: 'needs-code' });
          return;
        }

        const outcome = await ensureCredential(chainId, d.definition.electionId, d.definition.credentialPublicKeyJwk, code);
        if (cancelled) return;
        if (outcome.status === 'ok') {
          setCred({ phase: 'ready', credential: outcome.credential });
        } else if (outcome.status === 'already_issued') {
          setCred({
            phase: 'failed',
            elsewhere: true,
            message: 'It looks like you started voting on another device.',
          });
        } else {
          setCred({ phase: 'failed', message: outcome.message });
        }
      } catch (e) {
        if (!cancelled) setDetailError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chainId, electionId]);

  const existingReceipt = useMemo(
    () => (cred.phase === 'ready' ? receiptForToken(electionId, cred.credential.token) : undefined),
    [cred, electionId],
  );

  async function cast(): Promise<void> {
    if (cred.phase !== 'ready' || detail === null) return;
    setCasting(true);
    setCastError(null);
    try {
      const c = cred.credential;
      const tx = buildVoteCastTx({
        chainId,
        electionId: detail.definition.electionId,
        answers: draftAnswers(electionId),
        tokenSecretKey: c.tokenSecretKey,
        tokenPrefix: c.tokenPrefix,
        credentialSig: c.credentialSig,
        nonce: Date.now(), // revote ordering: highest nonce counts
      });
      const results = await Promise.allSettled(allNodeClients().map((n) => n.submitTx(tx)));
      const accepted = results.filter((r) => r.status === 'fulfilled' && r.value.accepted);
      if (accepted.length === 0) {
        throw new Error('Your ballot did not reach the record-keepers.');
      }
      const first = accepted[0] as PromiseFulfilledResult<{ accepted: boolean; txHash?: string }>;
      const receipt: Receipt = {
        chainId,
        electionId: detail.definition.electionId,
        electionTitle: detail.definition.title,
        token: c.token,
        txHash: first.value.txHash ?? '',
        nonce: tx.nonce,
        castAt: Date.now(),
        nodeUrls: NODE_URLS,
      };
      saveReceipt(receipt);
      clearDraft(electionId);
      // replace, not push: Back from a receipt must not return to a live ballot
      // still holding the answers that were just submitted.
      navigate({ name: 'receipt', electionId }, { replace: true });
    } catch (e) {
      setCastError(
        (e as Error).message === 'Your ballot did not reach the record-keepers.'
          ? 'Your ballot did not reach the record-keepers, so nothing was recorded. Your answers are still here. Check your connection and try again.'
          : 'Something went wrong sending your ballot, so nothing was recorded. Your answers are still here. Try again.',
      );
    } finally {
      setCasting(false);
    }
  }

  if (detailError !== null) {
    return (
      <div className="card">
        <div className="notice danger">We could not open this ballot. Check your connection and try again.</div>
        <div className="row actions-row">
          <button className="btn" onClick={() => window.location.reload()}>Try again</button>
          <a className="btn secondary" href="#/elections">Back to elections</a>
        </div>
      </div>
    );
  }

  if (cred.phase === 'needs-code') {
    return (
      <div className="card">
        <h2>Enter your code to open this ballot</h2>
        <p className="muted">
          Your voting code is never saved, so it is gone when the tab closes. Enter it again and you will come
          straight back here.
        </p>
        <div className="row actions-row">
          <a className="btn" href="#/">Enter my code</a>
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="card" aria-busy="true">
        <span className="skeleton" style={{ width: '64%', height: 19 }}>Opening</span>
        <div style={{ height: 12 }} />
        <span className="skeleton" style={{ width: '40%', height: 13 }}>Opening</span>
        <div style={{ height: 18 }} />
        <span className="skeleton" style={{ width: '100%', height: 44 }}>Opening</span>
      </div>
    );
  }

  const def = detail.definition;
  const answeredCount = Object.keys(selections).length;
  const alreadyVotedFinal = existingReceipt !== undefined && !def.allowRevote;
  const canCast =
    cred.phase === 'ready' && answeredCount > 0 && !casting && detail.status === 'open' && !alreadyVotedFinal;

  return (
    <div>
      <div className="page-head">
        <div className="spread">
          <h1 className="page-title">{def.title}</h1>
          <span className={`chip ${detail.status}`}>{detail.status}</span>
        </div>
      </div>

      <div className="card">
        {def.description !== undefined && <p style={{ marginTop: 0 }}>{def.description}</p>}
        <p className="small muted">
          Voting closes {new Date(def.endTime).toLocaleString()} ·{' '}
          {def.allowRevote
            ? 'you may vote again later, and only your latest ballot counts'
            : 'one ballot per voter, and it cannot be changed'}
          {' · '}
          {def.resultsVisibility === 'live' ? 'results are visible live' : 'results are revealed after close'}
        </p>

        {cred.phase === 'loading' && (
          <div className="notice info" role="status">Getting your anonymous voting pass…</div>
        )}
        {cred.phase === 'failed' && cred.elsewhere === true && (
          <div className="notice danger" role="alert">
            <strong>{cred.message}</strong>
            <br />
            Finish there and your vote will count. If you cannot get back to that device, ask the organization
            running this election for a new code. Issuing one cancels this code, so nobody can vote twice.
          </div>
        )}
        {cred.phase === 'failed' && cred.elsewhere !== true && (
          <div className="notice danger" role="alert">{cred.message}</div>
        )}
        {existingReceipt !== undefined && def.allowRevote && (
          <div className="notice warn">
            You already voted in this election on {new Date(existingReceipt.castAt).toLocaleString()}. Voting
            again replaces that ballot; only your latest one counts.
          </div>
        )}
        {alreadyVotedFinal && (
          <div className="notice warn">
            You already voted in this election, and it does not allow changing a vote.{' '}
            <a href={`#/receipt/${encodeURIComponent(electionId)}`}>See your receipt</a>.
          </div>
        )}
      </div>

      {props.phase === 'review' ? (
        <ReviewView
          detail={detail}
          selections={selections}
          canCast={canCast}
          casting={casting}
          castError={castError}
          isReplacement={existingReceipt !== undefined && def.allowRevote}
          onCast={() => void cast()}
          electionId={electionId}
        />
      ) : (
        <ChooseView
          detail={detail}
          selections={selections}
          onChange={updateSelections}
          onReview={() => navigate({ name: 'review', electionId })}
          disabled={cred.phase !== 'ready' || alreadyVotedFinal || detail.status !== 'open'}
        />
      )}
    </div>
  );
}

function ChooseView(props: {
  detail: ElectionDetail;
  selections: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onReview: () => void;
  disabled: boolean;
}) {
  const { detail, selections } = props;
  const def = detail.definition;
  const answered = Object.keys(selections).length;

  return (
    <>
      {def.questions.map((q, qi) => (
        <div className="card" key={q.id} id={`q-${q.id}`}>
          <h3>
            {qi + 1}. {q.text}
          </h3>
          <div className="stack">
            {q.options.map((o) => {
              const selected = selections[q.id] === o.id;
              return (
                <label key={o.id} className={`option${selected ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name={q.id}
                    checked={selected}
                    onChange={() => props.onChange({ ...selections, [q.id]: o.id })}
                  />
                  <span>{o.text}</span>
                </label>
              );
            })}
          </div>
          {selections[q.id] !== undefined && (
            <button
              className="btn secondary small"
              style={{ marginTop: 10 }}
              onClick={() => {
                const next = { ...selections };
                delete next[q.id];
                props.onChange(next);
              }}
            >
              Clear answer
            </button>
          )}
        </div>
      ))}

      <div className="card">
        {answered < def.questions.length && (
          <p className="small muted">
            {answered === 0
              ? 'Choose at least one answer to continue.'
              : `You have answered ${answered} of ${def.questions.length}. You can leave the rest blank.`}
          </p>
        )}
        <div className="row actions-row">
          <button className="btn" disabled={props.disabled || answered === 0} onClick={props.onReview}>
            Review your ballot
          </button>
          <a className="btn secondary" href="#/elections">← Back</a>
        </div>
        <p className="hint">Nothing is submitted yet. You will see your answers before anything is recorded.</p>
      </div>
    </>
  );
}

function ReviewView(props: {
  detail: ElectionDetail;
  selections: Record<string, string>;
  canCast: boolean;
  casting: boolean;
  castError: string | null;
  isReplacement: boolean;
  onCast: () => void;
  electionId: string;
}) {
  const def = props.detail.definition;
  const back = `#/vote/${encodeURIComponent(props.electionId)}`;

  return (
    <>
      <div className="card">
        <h2>Check your ballot</h2>
        <p className="muted">
          This is what will be recorded. Nothing has been submitted yet.
        </p>

        <dl className="review">
          {def.questions.map((q, qi) => {
            const chosenId = props.selections[q.id];
            const chosen = q.options.find((o) => o.id === chosenId);
            return (
              <div className="review-row" key={q.id}>
                <dt>
                  {qi + 1}. {q.text}
                </dt>
                <dd>
                  {chosen !== undefined ? (
                    <span className="review-answer">{chosen.text}</span>
                  ) : (
                    <span className="review-answer none">No answer</span>
                  )}
                  <a className="btn secondary small" href={back}>
                    Change
                  </a>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="card">
        <p className="small">
          {def.allowRevote
            ? 'You can vote again later if you change your mind. Only your latest ballot counts.'
            : 'This election does not allow changing a vote. Once you record this ballot it is final.'}
          {' '}
          {def.resultsVisibility === 'live'
            ? 'Results are visible as votes come in.'
            : 'Results are revealed after voting closes.'}
        </p>
        {props.castError !== null && (
          <div className="notice danger" role="alert">{props.castError}</div>
        )}
        <div className="row actions-row">
          <button className="btn" disabled={!props.canCast} onClick={props.onCast}>
            {props.casting ? 'Recording your ballot…' : props.isReplacement ? 'Replace my ballot' : 'Record my ballot'}
          </button>
          <a className="btn secondary" href={back}>
            ← Change something
          </a>
        </div>
        <p className="hint">
          Your ballot goes to all {NODE_URLS.length} record-keepers at once, so no single one of them can quietly
          discard it.
        </p>
      </div>
    </>
  );
}

/** Exported for the elections list, which links straight to a finished receipt. */
export function hasReceipt(electionId: string): boolean {
  return latestReceiptFor(electionId) !== undefined;
}
