/**
 * Hand-off from the code-retrieval page.
 *
 * A voter who retrieved their code from an emailed link arrives here with the
 * code in the URL **fragment** (`#code=…`). The fragment is deliberate: unlike
 * a path or query string it is never transmitted to any server — not in the
 * request line, not in a Referer header — so the code cannot land in a web
 * server access log, a proxy log, or an analytics referrer on the way in.
 *
 * It is read once and stripped from the address bar immediately, so it does not
 * survive in the visible URL, a bookmark, or a screenshot of the tab.
 *
 * The code is *prefilled*, never auto-submitted: the voter still sees it and
 * presses Continue. That keeps a wrongly-delivered link visible to the person
 * holding it before it is spent, and keeps the act of voting deliberate.
 *
 * **This has to be called from two places, and both are load-bearing.**
 *
 * Once at module scope before React starts (main.tsx), which is what keeps the
 * scrub from racing the router's first read of the hash, and what means a
 * throw between page load and first paint still leaves no code in the address
 * bar.
 *
 * And again on `hashchange` (App.tsx), because a voter who already has this
 * app open in a tab and clicks their emailed link a second time gets a
 * same-document fragment navigation: no reload, so module scope never runs
 * again. Without the second call their code would sit visibly in the address
 * bar above an empty form, which is the exact thing this file exists to
 * prevent. Calling it on every hash change is safe: it only rewrites the URL
 * when it actually found a code.
 */
export function takeCodeFromUrl(): string | null {
  const hash = window.location.hash;
  if (hash.length <= 1) return null;

  let code: string | null = null;
  try {
    code = new URLSearchParams(hash.slice(1)).get('code');
  } catch {
    return null;
  }
  if (code === null || code.trim().length === 0) return null;

  // Scrub before returning — if anything below throws, the code is already gone
  // from the URL rather than left sitting in the address bar.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return code.trim();
}
