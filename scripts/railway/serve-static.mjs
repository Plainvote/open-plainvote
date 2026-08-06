import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * Dependency-free static server for a built Vite app.
 *
 * Plain JavaScript (not TypeScript) so the runtime image needs nothing but
 * `node` — no tsx, no node_modules at all.
 *
 * Its one non-obvious job is RUNTIME configuration. Vite bakes import.meta.env
 * in at build time, which would mean rebuilding all three apps whenever a
 * service URL changes — and an ordering deadlock on first deploy, since the
 * apps must be built before the services they point at have domains. Instead
 * this server injects window.__PLAINVOTE_CONFIG__ into index.html on the way
 * out, so the same image can be repointed with an environment variable.
 */

const DIST = resolve(process.env.DIST_DIR ?? './dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '::';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Only these reach the browser — never leak unrelated service env vars.
 *
 * An allow-list, so adding a setting the apps can read means adding it here on
 * purpose. ORG_NAME and ORG_LOGO_URL let a deployment put the customer's own
 * name above the ballot, which is the whole point of the voter app's brand
 * lockup: without them it silently falls back to Plainvote alone, and the
 * feature is unreachable in production no matter what is set on the service.
 */
const CONFIG_KEYS = [
  'NODE_URLS',
  'REGISTRAR_URL',
  'RESULTS_URL',
  'VOTER_URL',
  'COMMISSION_URL',
  'CONSOLE_URL',
  'ORG_NAME',
  'ORG_LOGO_URL',
];

function runtimeConfig() {
  const config = {};
  for (const key of CONFIG_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) config[key] = value;
  }
  return config;
}

/**
 * Inline the config as the first thing in <head> so it is set before the app
 * bundle evaluates. `<` is escaped so a value can never close the script tag.
 */
function injectConfig(html, config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const tag = `<script>window.__PLAINVOTE_CONFIG__=${json};</script>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : tag + html;
}

/**
 * The shell is cached after the first read because inside a deployed image the
 * file cannot change. Local previews set DEV_RELOAD=1 so that editing
 * index.html actually shows up on reload instead of silently doing nothing.
 */
const DEV_RELOAD = process.env.DEV_RELOAD === '1';
let indexHtmlCache = null;

async function indexHtml() {
  if (indexHtmlCache === null || DEV_RELOAD) {
    const raw = await readFile(join(DIST, 'index.html'), 'utf8');
    indexHtmlCache = injectConfig(raw, runtimeConfig());
  }
  return indexHtmlCache;
}

/** Resolve a URL path inside DIST, or null if it escapes the root. */
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const full = resolve(join(DIST, normalize(decoded)));
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  return full;
}

async function sendIndex(res, status = 200) {
  const html = await indexHtml();
  res.writeHead(status, {
    'content-type': MIME['.html'],
    // The shell carries the config, so it must never be cached across redeploys.
    'cache-control': 'no-store',
  });
  res.end(html);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      const urlPath = req.url ?? '/';
      if (urlPath === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }

      const full = safePath(urlPath);
      if (full === null) {
        res.writeHead(400).end('bad path');
        return;
      }

      const info = await stat(full).catch(() => null);
      if (info === null || info.isDirectory()) {
        // Unknown path: hand back the SPA shell. Both routed apps use hash
        // routing, so this is only a safety net for stray deep links.
        await sendIndex(res, info === null ? 404 : 200);
        return;
      }
      if (full === join(DIST, 'index.html')) {
        await sendIndex(res);
        return;
      }

      // Vite emits content-hashed asset filenames, so they are immutable.
      const isHashedAsset = full.startsWith(join(DIST, 'assets') + sep);
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(full).pipe(res);
    } catch (error) {
      console.error('[static] request failed:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    }
  })();
});

server.listen(PORT, HOST, () => {
  const config = runtimeConfig();
  console.log(`[static] serving ${DIST} on :${PORT}`);
  console.log(`[static] runtime config: ${JSON.stringify(config)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
