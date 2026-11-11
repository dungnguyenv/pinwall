// The server behind the annotator's browser tests: a real Pinwall (single-domain, throwaway data
// directory) holding a two-frame artifact plus a few hostile pages, and a minimal viewer page that
// frames a review grant of it the way the review page does (`/?page=<file>` frames that page).
// Started by playwright.config.ts.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/load.ts';
import { contentUrl, createGrant } from '../../src/content/grants.ts';
import { closeDeps, createDeps } from '../../src/deps.ts';
import { newId } from '../../src/lib/ids.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { ingestFiles } from '../../src/publish/ingest.ts';
import { ensureAnnotatorBuilt } from '../../test/helpers/annotator-build.ts';

const PINWALL_PORT = 18471;
const VIEWER_PORT = 18472;
const HOST = '127.0.0.1';

/** An outer page with a frame the annotator can work in and one whose own CSP stops it. */
const FILES: Record<string, string> = {
  'index.html':
    '<h1>Outer page</h1><iframe id="inner" src="inner.html" width="600" height="220"></iframe><iframe id="locked" src="locked.html" width="600" height="120"></iframe>',
  'inner.html':
    '<p style="font:20px/1.5 sans-serif;margin:40px">The nested frame says <span id="target">hello to Pinwall</span> today.</p>',
  'locked.html':
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><title>Locked</title></head><body><p>No scripts run here.</p></body></html>',
  // Text and elements that inner scrollers clip: a carousel slide far to the right, a panel's
  // paragraph far below. Nothing drawn for them may grow the page's scroll size.
  'clipped.html': `<!doctype html><html><head><title>Clipped</title><style>
body { margin: 8px; font: 16px/1.5 sans-serif; }
#track-box { width: 300px; height: 120px; overflow: hidden; }
#track { width: 4000px; height: 120px; white-space: nowrap; }
#far { margin-left: 3000px; }
#tall-box { width: 300px; height: 80px; overflow: hidden; }
#tall { position: relative; height: 3000px; }
#deep { position: absolute; top: 2900px; margin: 0; }
</style></head><body><h1>Clipped content</h1>
<div id="track-box"><div id="track"><span id="near">Visible slide text</span><span id="far">Offscreen slide words</span></div></div>
<div id="tall-box"><div id="tall"><p>Top of a tall panel</p><p id="deep">Deep panel words</p></div></div>
</body></html>`,
  // A page that clicks its own button every 50 ms, as auto-advancing carousels do.
  'autoclick.html': `<!doctype html><html><head><title>Auto click</title></head><body>
<p id="text" style="font:20px/1.5 sans-serif">Click me for real</p><button id="next" type="button">next</button>
<script>
window.pageClicks = 0; window.ticks = 0;
const next = document.getElementById('next');
next.addEventListener('click', () => { window.pageClicks++; });
setInterval(() => { next.click(); window.ticks++; }, 50);
</script></body></html>`,
};

const dataDir = await mkdtemp(join(tmpdir(), 'pinwall-annotator-e2e-'));
await ensureAnnotatorBuilt();

const config = loadConfig({
  PINWALL_DATA_DIR: dataDir,
  PINWALL_PUBLIC_ORIGIN: `http://${HOST}:${PINWALL_PORT}`,
  PINWALL_HOST: HOST,
  PINWALL_PORT: String(PINWALL_PORT),
  PINWALL_METRICS_PORT: '0',
});
const deps = await createDeps(config, { logger: createLogger('silent') });

// An owner row, as a finished setup leaves one: the grant and the version need a person.
await deps.db.db
  .insertInto('users')
  .values({
    id: newId('usr'),
    kind: 'owner',
    name: 'Ada',
    email: null,
    email_verified: 0,
    idp_role: null,
    role_override: null,
    oidc_issuer: null,
    oidc_subject: null,
    idp_checked_at: null,
    created_at: deps.clock.now(),
  })
  .execute();
const owner = await deps.db.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();

const { version } = await ingestFiles(
  deps,
  { kind: 'new_artifact', projectId: null, name: null, tags: [] },
  Object.entries(FILES).map(([path, content]) => ({ path, data: Buffer.from(content) })),
  { actor: owner, source: 'api', message: null },
);
const grant = await createGrant(deps, { versionId: version.id, mode: 'review', user: owner });

const viewerTemplate = await readFile(join(import.meta.dirname, 'viewer.html'), 'utf8');
/** The viewer framing `page` of the artifact (the entry page when empty). */
const viewer = (page: string) =>
  viewerTemplate.replace('__CONTENT_URL__', contentUrl(config, grant.token, page));

function listening(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve());
  });
}

const pinwall = serve({
  fetch: buildApp(deps).fetch,
  hostname: HOST,
  port: PINWALL_PORT,
}) as Server;
await new Promise<void>((resolve) => pinwall.once('listening', () => resolve()));

const viewerServer = createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? '/', `http://${HOST}`);
  const page = searchParams.get('page') ?? '';
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else if (pathname === '/' && (page === '' || Object.hasOwn(FILES, page))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(viewer(page));
  } else {
    res.writeHead(404).end();
  }
});
await listening(viewerServer, VIEWER_PORT);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  deps.liveStreams.closeAll();
  viewerServer.closeAllConnections();
  pinwall.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => viewerServer.close(resolve)),
    new Promise((resolve) => pinwall.close(resolve)),
  ]);
  await closeDeps(deps);
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
