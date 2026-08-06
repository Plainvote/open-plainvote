import { GateMark } from '@plainvote/ui';
import { ORG_LOGO_URL, ORG_NAME } from '../lib/config';

/** Initials for an organization with a name but no logo, set like a seal. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * The header identity.
 *
 * Org-forward when a deployment names one, Plainvote alone when it does not.
 * The endorsement line is deliberate: the organization is who the voter trusts,
 * and Plainvote is the reason the result can be checked. Neither claim works
 * without the other being visible.
 */
export function BrandLockup() {
  /*
   * A `p`, not an `h1`: the wordmark names the product, not the page. The page
   * heading belongs to whatever the voter is being asked to do, which is what
   * a screen reader should find at the top of the outline.
   */
  if (ORG_NAME === undefined || ORG_NAME.trim().length === 0) {
    return (
      <p className="wordmark">
        <GateMark />
        Plainvote
      </p>
    );
  }

  return (
    <p className="wordmark brand-lockup">
      {ORG_LOGO_URL !== undefined ? (
        <img className="org-mark" src={ORG_LOGO_URL} alt="" />
      ) : (
        <span className="org-mark initials" aria-hidden="true">
          {initialsOf(ORG_NAME)}
        </span>
      )}
      <span className="names">
        <span className="org-name">{ORG_NAME}</span>
        <span className="by-line">
          <GateMark size={11} />
          Voting on Plainvote
        </span>
      </span>
    </p>
  );
}

/**
 * Progress as the tally mark being drawn.
 *
 * The site uses this device for its three steps; here it carries four, and the
 * fifth stroke — the diagonal that closes a gate of five — lands only when the
 * ballot is recorded. The mark completes at the moment the vote does.
 */
export function TallyProgress({ step, labels }: { step: number; labels: string[] }) {
  const xs = [5, 12, 19, 26];
  const complete = step >= labels.length - 1;

  return (
    <nav className="tally-progress" aria-label="Progress">
      <svg width="46" height="30" viewBox="0 0 32 32" fill="none" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
        {xs.map((x, i) => (
          <line
            key={x}
            x1={x}
            y1="5"
            x2={x}
            y2="27"
            className={i <= step ? 'tally-on' : 'tally-off'}
          />
        ))}
        <line x1="2" y1="25" x2="30" y2="7" className={complete ? 'tally-on' : 'tally-off'} />
      </svg>
      <span className="tally-label">
        <span className="tally-step">
          Step {Math.min(step + 1, labels.length)} of {labels.length}
        </span>
        <span className="tally-now">{labels[Math.min(step, labels.length - 1)]}</span>
      </span>
    </nav>
  );
}
