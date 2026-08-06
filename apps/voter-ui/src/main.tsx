import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { takeCodeFromUrl } from './lib/handoff';
import { setCode } from './lib/session';
import '@plainvote/theme/tokens.css';
import '@plainvote/theme/components.css';
import './styles.css';

/*
 * Take the handed-off code out of the URL BEFORE React exists.
 *
 * Two reasons it belongs here rather than in a component. The router reads
 * window.location.hash on its first render and the scrub rewrites that hash, so
 * running both during render makes the outcome depend on which one goes first.
 * And if anything between page load and first paint throws, doing it here means
 * the code has already left the address bar instead of sitting there.
 */
const handedOff = takeCodeFromUrl();
if (handedOff !== null) setCode(handedOff);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
