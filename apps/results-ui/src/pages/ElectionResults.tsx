import {
  questionOutcome,
  type ElectionDetail,
  type IntegrityInfo,
  type QuestionTally,
  type ResultsResponse,
} from '@votechain/protocol';
import { BarChart } from '../components/BarChart';
import { RecountPanel } from '../components/RecountPanel';
import { useNodeQuery } from '../lib/api';
import { fmtDateTime, fmtNum, pct } from '../lib/format';

/** "A", "A and B", "A, B and C" — for naming the options in a tie. */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The result of one question, in a sentence.
 *
 * Deliberately reports rather than rules. We know the counts; we do not know
 * whether this organization needs a majority, a quorum, or a second round, so
 * "has the most votes" is the strongest honest claim and "wins" is not ours to
 * make. Until every page holding a ballot is confirmed the wording stays
 * provisional, because the totals genuinely can still move.
 */
function OutcomeLine({ question, isFinal }: { question: QuestionTally; isFinal: boolean }) {
  const outcome = questionOutcome(question);
  if (outcome.kind === 'no-answers') return null;

  const share = pct(outcome.topCount, question.totalAnswers);
  const of = `${fmtNum(outcome.topCount)} of ${fmtNum(question.totalAnswers)} answers (${share})`;

  if (outcome.kind === 'tied') {
    const names = nameList(outcome.leaders.map((l) => l.text));
    return (
      <p className="outcome">
        <span className="outcome-lead">Tied:</span> {names}, on {of} each.
        {isFinal ? ' The organization decides how a tie is resolved.' : ' Counting is not finished.'}
      </p>
    );
  }

  const leader = outcome.leaders[0]!;
  return (
    <p className="outcome">
      <span className="outcome-lead">{isFinal ? 'Most votes:' : 'Leading:'}</span> {leader.text}, with {of}.
      {outcome.margin > 0 && ` ${fmtNum(outcome.margin)} ahead of the next.`}
      {!isFinal && ' Counting is not finished.'}
    </p>
  );
}

interface Loaded {
  results: ResultsResponse;
  detail: ElectionDetail | null;
}

export function ElectionResultsPage({ electionId, tick }: { electionId: string; tick: number }) {
  const q = useNodeQuery<Loaded>(electionId !== '', [electionId, tick], async (client) => {
    const results = await client.results(electionId);
    let detail: ElectionDetail | null = null;
    try {
      detail = await client.election(electionId);
    } catch {
      detail = null;
    }
    return { results, detail };
  });

  if (electionId === '') {
    return (
      <div className="notice danger">
        Missing election id. Go back to <a href="#/">the elections list</a>.
      </div>
    );
  }
  if (q.notFound && q.data === null) {
    return (
      <div className="notice danger">
        Unknown election <code>{electionId}</code>: there is no such election in the record.{' '}
        <a href="#/">Back to all elections</a>
      </div>
    );
  }
  if (q.loading) return <p className="muted">Loading election…</p>;
  if (q.data === null) return <div className="notice danger">Could not load election: {q.error ?? 'unknown error'}</div>;

  const { results: r, detail } = q.data;
  const supersededVotes = r.turnout.voteTxCount - r.turnout.distinctTokens;

  return (
    <>
      <div className="small muted">
        <a href="#/">← All elections</a>
      </div>

      <section className="card">
        <div className="spread">
          {/* The page's own heading, and the only h1 on it. */}
          <h1 className="page-title">{r.title}</h1>
          <span className={`chip ${r.status}`}>{r.status}</span>
        </div>
        {detail !== null && detail.definition.description !== undefined && (
          <p className="muted">{detail.definition.description}</p>
        )}
        <p className="small muted">
          {fmtDateTime(r.startTime)} → {fmtDateTime(r.endTime)} · election id <code>{r.electionId}</code>
        </p>
        <div className="row">
          {r.finality.tallyIsFinal ? (
            <span className="chip ok">results final</span>
          ) : (
            <span className="chip warn">not yet final</span>
          )}
          <span className="small muted">
            {fmtNum(r.finality.finalizedHeight)} of {fmtNum(r.finality.height)} pages confirmed
            {r.finality.tallyIsFinal ? '' : '; the totals can still change until every page holding a ballot is confirmed'}
          </span>
          <span className="chip info">{r.resultsVisibility === 'live' ? 'live results' : 'results after close'}</span>
          <span className="chip info">{r.allowRevote ? 'revoting allowed' : 'one vote only'}</span>
        </div>
        {detail !== null && detail.cancelled && (
          <div className="notice danger">
            This election was cancelled by the commission
            {detail.cancelReason !== undefined ? ` (${detail.cancelReason})` : ''}.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Turnout</h2>
        <div className="stats">
          <div className="stat">
            <span className="num">{fmtNum(r.turnout.distinctTokens)}</span>
            <span className="lbl">distinct ballots counted</span>
          </div>
          <div className="stat">
            <span className="num">{fmtNum(r.turnout.voteTxCount)}</span>
            <span className="lbl">ballots recorded</span>
          </div>
          <div className="stat">
            <span className="num">{fmtNum(r.integrity.eligibleCount)}</span>
            <span className="lbl">eligible voters</span>
          </div>
          <div className="stat">
            <span className="num">{pct(r.turnout.distinctTokens, r.integrity.eligibleCount)}</span>
            <span className="lbl">turnout</span>
          </div>
        </div>
        {supersededVotes > 0 && (
          <p className="hint">
            {fmtNum(supersededVotes)} of the recorded ballots {supersededVotes === 1 ? 'was' : 'were'} replaced by a
            later {supersededVotes === 1 ? 'revote' : 'revote'}; only each voter's most recent ballot is counted.
          </p>
        )}
      </section>

      {q.error !== null && (
        <div className="notice warn">Live refresh failed ({q.error}); showing the last data received.</div>
      )}

      {!r.resultsVisible ? (
        <div className="notice info">
          This election reveals results after it closes: turnout is visible now, totals unlock at{' '}
          {fmtDateTime(r.endTime)}. The ballots themselves are already public in{' '}
          <a href="#/record">the record</a>; only the presented totals are withheld until then.
        </div>
      ) : (
        (r.questions ?? []).map((question) => (
          <section className="card" key={question.questionId}>
            <div className="spread">
              <h2>{question.text}</h2>
              <span className="small muted mono tabular">{fmtNum(question.totalAnswers)} answers</span>
            </div>
            <OutcomeLine question={question} isFinal={r.finality.tallyIsFinal} />
            <BarChart question={question} />
          </section>
        ))
      )}

      <IntegrityPanel integrity={r.integrity} />
      <RecountPanel results={r} />
    </>
  );
}

function IntegrityPanel({ integrity }: { integrity: IntegrityInfo }) {
  const { distinctTokens, issuedCount, resetCount, eligibleCount, exceedsEligible, commitBlockHeight } = integrity;
  return (
    <section className="card">
      <h2>Integrity: public reconciliation</h2>
      <p className="small">
        Every counted ballot spends a one-time anonymous credential. The registrar publicly commits to how many
        credentials it issued, and the size of the eligible roll is fixed in the record when the election is created.
        Stuffing this election would have to break this run of inequalities, in public:
      </p>

      {/* The loudest thing this app can say, and it was silent to a screen
          reader: no role, no live region, just a red box appearing. */}
      {exceedsEligible && (
        <div className="notice danger" role="alert">
          <strong>MORE BALLOTS THAN AUTHORIZED.</strong> This election fails public reconciliation:{' '}
          {fmtNum(distinctTokens)} distinct ballots exceed the eligible roll of {fmtNum(eligibleCount)}. Do not trust
          these results.
        </div>
      )}

      <div className="recon">
        <div className="stat">
          <span className="num">{fmtNum(distinctTokens)}</span>
          <span className="lbl">distinct ballots</span>
        </div>
        <span className="cmp">≤</span>
        <div className="stat">
          <span className="num">{issuedCount === null ? '–' : fmtNum(issuedCount)}</span>
          <span className="lbl">credentials issued</span>
        </div>
        <span className="cmp">≤</span>
        <div className="stat">
          <span className="num">{fmtNum(eligibleCount)}</span>
          <span className="lbl">eligible voters</span>
        </div>
      </div>

      <div className="row">
        {issuedCount !== null ? (
          <>
            {distinctTokens <= issuedCount ? (
              <span className="chip ok">✓ ballots ≤ credentials issued</span>
            ) : (
              <span className="chip danger">✗ ballots exceed credentials issued</span>
            )}
            {issuedCount <= eligibleCount ? (
              <span className="chip ok">✓ credentials issued ≤ eligible roll</span>
            ) : (
              <span className="chip danger">✗ credentials exceed eligible roll</span>
            )}
          </>
        ) : (
          <>
            <span className="chip warn">awaiting registrar issuance commitment</span>
            {distinctTokens <= eligibleCount ? (
              <span className="chip ok">✓ ballots ≤ eligible roll</span>
            ) : (
              <span className="chip danger">✗ ballots exceed eligible roll</span>
            )}
          </>
        )}
      </div>

      {resetCount !== null && resetCount > 0 && (
        <p className="hint">
          {fmtNum(resetCount)} audited credential {resetCount === 1 ? 'reset' : 'resets'}: a reset re-issues a
          credential to a voter who lost access to their device. Every reset is part of the registrar's public
          commitment, so replacements cannot be minted silently.
        </p>
      )}
      {commitBlockHeight !== null && (
        <p className="small">
          <a href={`#/page/${commitBlockHeight}`}>
            The registrar's issuance commitment is on page #{fmtNum(commitBlockHeight)}
          </a>
        </p>
      )}
    </section>
  );
}
