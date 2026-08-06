import { useEffect, useRef, useState } from 'react';

/**
 * Telling somebody the page changed when there was no page load to notice.
 *
 * A hash-routed app swaps its whole content and leaves the browser none the
 * wiser: focus falls back to the document body, nothing is announced, and a
 * screen-reader user is silently dropped at the top of a document that is no
 * longer the one they were reading. Sighted keyboard users get the matching
 * problem, tabbing through the entire header again on every navigation.
 *
 * Two small things fix both. The document title changes, which is what a
 * screen reader reads on navigation and what a browser puts in history and on
 * a bookmark. And focus moves to the main landmark, so the next Tab starts at
 * the content.
 *
 * The first render is deliberately exempt: a page that steals focus the moment
 * it loads is its own bug.
 */
export function useRouteChange(routeKey: string, title: string): { announcement: string } {
  const [announcement, setAnnouncement] = useState('');
  const first = useRef(true);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.focus();
    // Re-set through empty so an identical consecutive title is still spoken.
    setAnnouncement('');
    const t = setTimeout(() => setAnnouncement(title), 60);
    return () => clearTimeout(t);
  }, [routeKey, title]);

  return { announcement };
}
