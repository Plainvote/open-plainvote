import { useEffect, useRef, useState } from 'react';
import type { NodeStatusInfo } from '@votechain/protocol';
import { pickHealthyNode } from './lib/nodes';
import { navigate, useRoute, type Route } from './lib/router';
import { clearCode, setCode } from './lib/session';
import { takeCodeFromUrl } from './lib/handoff';
import { latestReceiptFor } from './lib/receipts';
import { BrandLockup, TallyProgress } from './components/Brand';
import { EnterCode } from './screens/EnterCode';
import { ElectionList } from './screens/ElectionList';
import { VoteFlow } from './screens/VoteFlow';
import { ReceiptScreen } from './screens/ReceiptScreen';

/* Named for what the voter is doing, not for what the system is holding. */
const STEPS = ['Your code', 'Choose an election', 'Fill in your ballot', 'Your receipt'];

function stepIndexFor(route: Route): number {
  switch (route.name) {
    case 'code':
      return 0;
    case 'elections':
      return 1;
    case 'ballot':
    case 'review':
      return 2;
    case 'receipt':
      return 3;
  }
}

export function App() {
  const route = useRoute();
  /*
   * The record-keeper connection is resolved once, here, rather than by the
   * first screen. Every route below needs the chain id — including a voter who
   * lands directly on a ballot after a refresh, who never passes through the
   * code screen at all.
   */
  const [status, setStatus] = useState<NodeStatusInfo | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  /*
   * A code arriving after the app is already running.
   *
   * main.tsx consumes the emailed hand-off before React starts, which covers
   * the ordinary case of opening the link fresh. It does not cover a voter who
   * already has this tab open and clicks the link a second time: that is a
   * same-document fragment navigation, so nothing reloads and module scope
   * never runs again. Their code would then sit in the address bar above an
   * empty form.
   *
   * The counter is what forces the code screen to re-read the session. Its
   * input is seeded from `getCode()` once at mount, so without a remount a
   * late arrival would be held but never shown.
   */
  const [handoffEpoch, setHandoffEpoch] = useState(0);
  useEffect(() => {
    const onHashChange = (): void => {
      const late = takeCodeFromUrl();
      if (late === null) return;
      setCode(late);
      setHandoffEpoch((n) => n + 1);
      // No navigate: an unrecognized `#code=…` already parses to the code
      // route, so the voter is on the right screen either way.
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void pickHealthyNode()
      .then(({ status: s }) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setStatusError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stepIndex = stepIndexFor(route);

  /*
   * A hash-routed flow changes everything on screen and tells the browser
   * nothing: no load event, so a screen reader announces nothing and focus
   * falls back to the body at the top of a document that is no longer the one
   * being read. Moving focus to the landmark and naming the step fixes both.
   */
  const [announcement, setAnnouncement] = useState('');
  const firstRender = useRef(true);
  useEffect(() => {
    document.title = `${STEPS[stepIndex] ?? 'Vote'} · Plainvote`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.focus();
    setAnnouncement('');
    const t = setTimeout(() => setAnnouncement(STEPS[stepIndex] ?? ''), 60);
    return () => clearTimeout(t);
  }, [stepIndex, route.name]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the ballot
      </a>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <header className="app-header">
        <div className="container">
          <BrandLockup />
          <span className="tagline">anonymous, verifiable voting from your own device</span>
        </div>
      </header>
      <main className="container" id="main" tabIndex={-1}>
        <TallyProgress step={stepIndex} labels={STEPS} />

        {route.name === 'code' && (
          <EnterCode
            key={handoffEpoch}
            status={status}
            statusError={statusError}
            onContinue={() => navigate({ name: 'elections' })}
          />
        )}

        {route.name === 'elections' && (
          <ElectionList
            onOpenBallot={(election) => navigate({ name: 'ballot', electionId: election.electionId })}
            onBack={() => {
              clearCode();
              navigate({ name: 'code' });
            }}
          />
        )}

        {(route.name === 'ballot' || route.name === 'review') &&
          (status === null ? (
            <ConnectionGate error={statusError} />
          ) : (
            /* One instance across both routes, keyed by election: stepping to
               the review and back must not refetch the ballot, re-mint the
               credential, or lose the answers already chosen. */
            <VoteFlow
              key={route.electionId}
              chainId={status.chainId}
              electionId={route.electionId}
              phase={route.name === 'review' ? 'review' : 'choose'}
            />
          ))}

        {route.name === 'receipt' && <ReceiptRoute electionId={route.electionId} />}
      </main>
      <footer className="app-footer">
        <div className="container">
          Plainvote is open-source voting with a result anyone can recount. Your code proves you are eligible; a
          blind signature makes your ballot impossible to link back to it. AGPL-3.0.
        </div>
      </footer>
    </>
  );
}

function ConnectionGate({ error }: { error: string | null }) {
  if (error === null) return <p className="muted">Connecting to the election…</p>;
  return (
    <div className="card">
      <div className="notice danger">
        We cannot reach the election right now. Check your connection and try again.
      </div>
      <div className="row actions-row">
        <button className="btn" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * The receipt is addressed by election, then resolved to the newest one held on
 * this device — so the token never travels in a URL. A voter who follows a
 * receipt link on a device that never voted gets an honest empty state rather
 * than a blank screen.
 */
function ReceiptRoute({ electionId }: { electionId: string }) {
  const receipt = latestReceiptFor(electionId);
  /*
   * Whether a revote is possible is a property of the election, not of the
   * receipt, so it has to be looked up: offering "change my vote" on an
   * election that forbids it would send the voter to a ballot whose submission
   * the registrar refuses.
   */
  const [allowRevote, setAllowRevote] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void pickHealthyNode()
      .then(({ client }) => client.election(electionId))
      .then((d) => {
        if (!cancelled) setAllowRevote(d.definition.allowRevote);
      })
      .catch(() => {
        // Unknown: leave the option hidden rather than offer a dead end.
        if (!cancelled) setAllowRevote(false);
      });
    return () => {
      cancelled = true;
    };
  }, [electionId]);

  if (receipt === undefined) {
    return (
      <div className="card">
        <h2>No receipt on this device</h2>
        <p className="muted">
          Receipts are kept only in the browser that cast the ballot. If you voted somewhere else, open this page
          there.
        </p>
        <div className="row actions-row">
          <a className="btn secondary" href="#/elections">
            Back to elections
          </a>
        </div>
      </div>
    );
  }
  return (
    <ReceiptScreen
      receipt={receipt}
      {...(allowRevote === true ? { onVoteAgain: () => navigate({ name: 'ballot', electionId }) } : {})}
      onDone={() => navigate({ name: 'elections' })}
    />
  );
}
