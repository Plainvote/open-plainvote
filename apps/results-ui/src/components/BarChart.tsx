import { questionOutcome, type QuestionTally } from '@votechain/protocol';
import { fmtNum, pct } from '../lib/format';

/**
 * Hand-rolled horizontal bar chart (no chart library): one row per option, an
 * SVG rect, and the count plus share of all answers.
 *
 * The bar is scaled to the TOTAL, not to the leader. It used to be scaled to
 * the leader's count, which meant the winning bar was always full width and a
 * 40-38 race drew as 100% against 95% — beside labels reading 51% and 49%. The
 * picture and the number were answering different questions, and the picture
 * was the one people read. On a page whose entire premise is that the arithmetic
 * is checkable, the chart cannot be the thing that overstates a margin.
 *
 * The leader is marked in text as well as color, because a fill a shade darker
 * is invisible to anyone who cannot compare two greens, or who is listening.
 */
export function BarChart({ question }: { question: QuestionTally }) {
  const total = question.totalAnswers;
  const outcome = questionOutcome(question);
  const leadIds = new Set(outcome.leaders.map((l) => l.optionId));

  return (
    <div className="bar-chart">
      {question.options.map((option) => {
        const share = total > 0 ? option.count / total : 0;
        const isLeader = leadIds.has(option.optionId);
        const label = `${option.text}: ${fmtNum(option.count)} of ${fmtNum(total)} answers, ${
          total > 0 ? pct(option.count, total) : '0.0%'
        }${isLeader ? outcome.kind === 'tied' ? ', tied for most votes' : ', most votes' : ''}`;

        return (
          <div className="bar-row" key={option.optionId}>
            <div className="bar-label">
              {option.text}
              {isLeader && (
                <span className="bar-lead-mark" aria-hidden="true">
                  {outcome.kind === 'tied' ? '= tied' : '▲ most'}
                </span>
              )}
            </div>
            <svg
              className="bar-svg"
              viewBox="0 0 100 12"
              preserveAspectRatio="none"
              role="img"
              aria-label={label}
            >
              <rect className="bar-track" x="0" y="0" width="100" height="12" rx="1" />
              {option.count > 0 && (
                <rect
                  className={isLeader ? 'bar-fill leader' : 'bar-fill'}
                  x="0"
                  y="0"
                  /* A hairline for a non-zero count that would otherwise round
                     to nothing: "someone voted for this" must stay visible. */
                  width={Math.max(share * 100, 0.75)}
                  height="12"
                  rx="1"
                />
              )}
            </svg>
            <div className="bar-value mono tabular">
              {fmtNum(option.count)} · {total > 0 ? pct(option.count, total) : '0.0%'}
            </div>
          </div>
        );
      })}
      {total === 0 && <p className="hint">No ballots counted yet for this question.</p>}
    </div>
  );
}
