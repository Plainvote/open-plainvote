import { GateMark } from '@plainvote/ui';
import { useRouteChange } from './lib/announce';
import { useHashRoute, type Page, type Route } from './lib/hashRouter';
import { useChainTick } from './lib/ws';
import { AuditPage } from './pages/Audit';
import { BlockPage } from './pages/BlockPage';
import { ElectionResultsPage } from './pages/ElectionResults';
import { ElectionsPage } from './pages/Elections';
import { ExplorerPage } from './pages/Explorer';
import { TxPage } from './pages/TxPage';
import { VerifyPage } from './pages/Verify';

const NAV: ReadonlyArray<{ href: string; label: string; pages: readonly Page[] }> = [
  { href: '#/', label: 'Elections', pages: ['elections', 'election'] },
  { href: '#/record', label: 'The record', pages: ['explorer', 'block', 'tx'] },
  { href: '#/verify', label: 'Verify a ballot', pages: ['verify'] },
  { href: '#/audit', label: 'Recount it yourself', pages: ['audit'] },
];

function renderPage(route: Route, tick: number) {
  switch (route.page) {
    case 'elections':
      return <ElectionsPage tick={tick} />;
    case 'election': {
      const id = route.params.electionId ?? '';
      return <ElectionResultsPage key={id} electionId={id} tick={tick} />;
    }
    case 'explorer':
      return <ExplorerPage tick={tick} />;
    case 'block': {
      const height = route.params.height ?? Number.NaN;
      return <BlockPage key={String(height)} height={height} tick={tick} />;
    }
    case 'tx': {
      const hash = route.params.hash ?? '';
      return <TxPage key={hash} hash={hash} tick={tick} />;
    }
    case 'verify':
      return <VerifyPage electionId={route.params.electionId ?? ''} token={route.params.token ?? ''} tick={tick} />;
    case 'audit':
      return <AuditPage />;
  }
}

/** What this route is called, for the tab, for history, and for a share. */
function titleFor(route: Route): string {
  switch (route.page) {
    case 'elections':
      return 'Elections · Plainvote';
    case 'election':
      return 'Election result · Plainvote';
    case 'explorer':
      return 'The public record · Plainvote';
    case 'block':
      return `Page ${route.params.height ?? ''} · Plainvote`;
    case 'tx':
      return 'Record entry · Plainvote';
    case 'verify':
      return 'Verify a ballot · Plainvote';
    case 'audit':
      return 'Recount it yourself · Plainvote';
  }
}

export function App() {
  const route = useHashRoute();
  const { tick, connected, wsHeight } = useChainTick();

  const routeKey = `${route.page}|${route.params.electionId ?? ''}|${route.params.height ?? ''}|${route.params.hash ?? ''}|${route.params.token ?? ''}`;
  const { announcement } = useRouteChange(routeKey, titleFor(route));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the result
      </a>
      {/* Navigation in a hash-routed app is invisible to a screen reader
          without this: no load event fires, so nothing is otherwise spoken. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <header className="app-header">
        <div className="container">
          <p className="wordmark">
            <GateMark />
            <a href="#/">Plainvote</a>
          </p>
          <span className="tagline">public results · the full record · recount it yourself</span>
          <nav className="top-nav" aria-label="Primary">
            {NAV.map((item) => {
              const isActive = item.pages.includes(route.page);
              return (
                <a key={item.href} href={item.href} className={isActive ? 'active' : ''} aria-current={isActive ? 'page' : undefined}>
                  {item.label}
                </a>
              );
            })}
          </nav>
          <span
            className={`chip ${connected ? 'ok' : 'warn'}`}
            title={connected ? 'Updating the moment anything is recorded' : 'Live updates unavailable; refreshing every 10s'}
          >
            {connected ? (wsHeight !== null ? `live · #${wsHeight}` : 'live') : 'polling'}
          </span>
        </div>
      </header>

      {/* tabIndex -1 so a route change can move focus here without making the
          landmark itself a tab stop. */}
      <main className="container" id="main" tabIndex={-1}>
        {renderPage(route, tick)}
      </main>

      <footer className="app-footer">
        <div className="container">
          Plainvote: open-source elections that anyone can recount, with ballots nobody can trace. AGPL-3.0.
        </div>
      </footer>
    </>
  );
}
