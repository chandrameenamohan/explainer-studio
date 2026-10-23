import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type StudioConfig } from './lib/config.ts';
import { buildCatalog, loadOverrides, type Catalog, type CatalogRecord } from './lib/catalog.ts';
import { loadState, updateState, type VideoState } from './lib/state.ts';
import { serveFileWithRanges } from './lib/media.ts';
import { json, text, readJson, safeDecode } from './lib/http.ts';
import { installChatRoutes } from './lib/chat.ts';
import { installJobRoutes } from './lib/jobs.ts';
import { installKnowledgeRoutes } from './lib/knowledge-routes.ts';

export type RouteCtx = {
  req: IncomingMessage; res: ServerResponse; url: URL; config: StudioConfig;
  catalog: () => Catalog; rescan: () => Catalog; record: (folder: string) => CatalogRecord | undefined;
};
export type RouteHooks = { extra: Array<(ctx: RouteCtx) => Promise<boolean>> };
export type StudioServer = {
  server: http.Server; catalog: () => Catalog; rescan: () => Catalog;
  listen: (port?: number) => Promise<number>; close: () => Promise<void>; hooks: RouteHooks;
};

const PAGES: Record<string, string> = { '/': 'library.html', '/create': 'create.html' };
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function createStudioServer(config: StudioConfig): StudioServer {
  const overridesFile = path.join(config.studioDir, 'catalog.overrides.json');
  let cat = buildCatalog(config.videoRoot, loadOverrides(overridesFile));
  let byFolder = new Map(cat.records.map(r => [r.folder, r]));
  const rescan = () => { cat = buildCatalog(config.videoRoot, loadOverrides(overridesFile)); byFolder = new Map(cat.records.map(r => [r.folder, r])); return cat; };
  const hooks: RouteHooks = { extra: [] };
  const pub = (name: string) => path.join(config.studioDir, 'public', name);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${config.host}`);
    const ctx: RouteCtx = { req, res, url, config, catalog: () => cat, rescan, record: f => byFolder.get(f) };
    const p = url.pathname; const m = req.method ?? 'GET';
    try {
      if (!hostAllowed(req)) return json(res, 403, { error: 'foreign Host header' });
      if (m !== 'GET' && m !== 'HEAD' && !mutationAllowed(req)) return json(res, 403, { error: 'missing X-Studio header or foreign origin' });
      if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true, records: cat.records.length, builtAt: cat.builtAt });
      if (m === 'GET' && PAGES[p]) return text(res, 200, readFileSync(pub(PAGES[p]), 'utf8'), 'text/html; charset=utf-8');
      if (m === 'GET' && p === '/studio.css') return text(res, 200, readFileSync(pub('studio.css'), 'utf8'), 'text/css; charset=utf-8');
      let mm: RegExpExecArray | null;
      if (m === 'GET' && (mm = /^\/v\/([^/]+)$/.exec(p))) {
        if (!byFolder.has(safeDecode(mm[1]))) return text(res, 404, 'no such video');
        return text(res, 200, readFileSync(pub('watch.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (m === 'GET' && p === '/api/catalog') return json(res, 200, { ...cat, records: cat.records.map(r => ({ ...r, watched: watchedOf(config.stateDir, r.folder) })) });
      if ((mm = /^\/api\/video\/([^/]+)\/joblog$/.exec(p)) && m === 'GET') {
        const r = folderOr404(mm[1], byFolder, res); if (!r) return;
        const f = path.join(config.videoRoot, r.folder, 'studio-job.jsonl');
        const lines = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-20) : [];
        return json(res, 200, { lines });
      }
      if (m === 'POST' && p === '/api/catalog/rescan') return json(res, 200, rescan());
      if ((mm = /^\/api\/video\/([^/]+)$/.exec(p)) && m === 'GET') {
        const r = folderOr404(mm[1], byFolder, res); if (!r) return;
        return json(res, 200, { record: r, state: loadState(config.stateDir, r.folder), neighbours: neighbours(cat, r.folder) });
      }
      if ((mm = /^\/api\/video\/([^/]+)\/state$/.exec(p)) && m === 'PUT') {
        const r = folderOr404(mm[1], byFolder, res); if (!r) return;
        let patch: unknown;
        try { patch = await readJson<unknown>(req); } catch { return json(res, 400, { error: 'body must be a JSON object' }); }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return json(res, 400, { error: 'body must be a JSON object' });
        return json(res, 200, updateState(config.stateDir, r.folder, patch as Partial<Pick<VideoState, 'positionSec' | 'watched'>>));
      }
      if ((mm = /^\/media\/([^/]+)\/video\.mp4$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
        const r = folderOr404(mm[1], byFolder, res); if (!r) return;
        if (!r.mp4) return text(res, 404, 'not rendered');
        return serveFileWithRanges(req, res, path.join(config.videoRoot, r.folder, r.mp4), 'video/mp4');
      }
      for (const h of hooks.extra) if (await h(ctx)) return;
      return text(res, 404, 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      return json(res, 500, { error: (e as Error).message });
    }
  };

  const server = http.createServer((req, res) => { void handle(req, res); });
  return {
    server, hooks, catalog: () => cat, rescan,
    listen: (port = config.port) => new Promise(resolve => server.listen(port, config.host, () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** DNS-rebinding guard: a page on a foreign name that resolves to 127.0.0.1 sends its own Host. */
export function hostAllowed(req: IncomingMessage): boolean {
  const h = req.headers.host;
  if (!h) return false;
  try { return LOOPBACK.has(new URL(`http://${h}`).hostname); } catch { return false; }
}

function watchedOf(stateDir: string, folder: string): boolean {
  try { return loadState(stateDir, folder).watched; } catch { return false; } // one odd name or bad file must not 500 the library
}

export function mutationAllowed(req: IncomingMessage): boolean {
  if (req.headers['x-studio'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const h = new URL(origin).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch { return false; }
}

function folderOr404(raw: string, byFolder: Map<string, CatalogRecord>, res: ServerResponse): CatalogRecord | undefined {
  const folder = safeDecode(raw);
  const r = FOLDER_RE.test(folder) ? byFolder.get(folder) : undefined;
  if (!r) text(res, 404, 'no such video');
  return r;
}

function neighbours(cat: Catalog, folder: string): { prev: string | null; next: string | null } {
  const i = cat.records.findIndex(r => r.folder === folder);
  return { prev: i > 0 ? cat.records[i - 1].folder : null, next: i >= 0 && i < cat.records.length - 1 ? cat.records[i + 1].folder : null };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const app = createStudioServer(config);
  const runner = installJobRoutes(app, config);
  const { store } = installKnowledgeRoutes(app, config, runner);
  installChatRoutes(app, config, store.summaryForVideo);
  const port = await app.listen();
  console.log(`Video Studio: http://${config.host}:${port}  (${app.catalog().records.length} videos, ${app.catalog().unreadable.length} unreadable)`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}server.ts`)) {
  if (!existsSync(path.join(loadConfig().studioDir, 'public', 'library.html'))) console.error('public/ pages missing');
  void main();
}
