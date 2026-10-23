import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { createStudioServer } from '../server.ts';
import { installJobRoutes } from '../lib/jobs.ts';
import { installChatRoutes } from '../lib/chat.ts';
import { installKnowledgeRoutes } from '../lib/knowledge-routes.ts';

const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'kgapi-st-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'kgapi-kg-')) };
const app = createStudioServer(cfg);
const runner = installJobRoutes(app, cfg);
const { store } = installKnowledgeRoutes(app, cfg, runner);
installChatRoutes(app, cfg, store.summaryForVideo);
const base = `http://127.0.0.1:${await app.listen(0)}`;
after(async () => { await app.close(); rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true }); });

const H = { 'content-type': 'application/json', 'x-studio': '1' };
const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = H) =>
  fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const acme = app.catalog().records.find(r => r.series === 'acme')!;
const globex = app.catalog().records.find(r => r.series === 'globex')!;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('empty list payload has the extras', async () => {
  const j = await (await fetch(`${base}/api/knowledge`)).json() as J;
  assert.deepEqual(j.concepts, []);
  assert.equal(j.vaultName, cfg.vaultName);
  assert.equal(j.videoKinds[acme.folder], acme.kind);
  assert.equal(j.sourceTitles[acme.folder], acme.title);
  assert.ok(j.companiesInCatalog.some((c: J) => c.key === 'acme' && c.title === 'Acme'));
  assert.ok(j.companiesInCatalog.some((c: J) => c.key === 'general'));
  assert.ok(Array.isArray(j.unreadable) && j.byVideo && j.byCompany && j.builtAt);
});

test('create, get, patch, delete flow', async () => {
  let r = await send('POST', '/api/knowledge/concepts', {
    title: 'Dynamic Batching', inMyWords: 'group requests', aliases: ['batching'],
    sources: [{ folder: acme.folder, t: 61.4, quote: 'a "quoted"  line' }],
    companies: [{ company: 'acme', why: 'serving' }], related: [{ type: 'related', to: 'not-there-yet' }],
  });
  assert.equal(r.status, 201);
  const c = (await r.json() as J).concept;
  assert.equal(c.slug, 'dynamic-batching');
  assert.equal(c.status, 'learning');
  assert.equal(c.sources[0].t, 61);
  assert.equal(c.sources[0].quote, "a 'quoted' line");
  assert.deepEqual(c.unresolved, ['not-there-yet']);

  const g = await (await fetch(`${base}/api/knowledge/concepts/dynamic-batching`)).json() as J;
  assert.match(g.markdown, /## In my words/);
  assert.equal(g.obsidianUrl, `obsidian://open?vault=${cfg.vaultName}&file=concepts%2Fdynamic-batching`);
  assert.deepEqual(g.similar, []);
  assert.equal(g.sourceTitles[acme.folder], acme.title);

  const list = await (await fetch(`${base}/api/knowledge`)).json() as J;
  assert.equal(list.concepts.length, 1);
  assert.equal('otherSections' in list.concepts[0], false);
  assert.deepEqual(list.byVideo[acme.folder], ['dynamic-batching']);

  r = await send('PATCH', '/api/knowledge/concepts/dynamic-batching', {
    status: 'known', addSource: { folder: globex.folder, t: 5, quote: 'x' }, removeSource: { folder: acme.folder, t: 61 },
    addCompany: { company: 'globex', why: '' }, removeCompany: 'acme',
    addRelated: { type: 'prerequisite', to: 'queues' }, removeRelated: { type: 'related', to: 'not-there-yet' },
    title: 'Dynamic batching', expectMtimeMs: c.mtimeMs,
  });
  assert.equal(r.status, 200);
  const p = (await r.json() as J).concept;
  assert.equal(p.status, 'known');
  assert.deepEqual(p.sources.map((s: J) => s.folder), [globex.folder]);
  assert.deepEqual(p.companies.map((x: J) => x.company), ['globex']);
  assert.deepEqual(p.related.map((x: J) => `${x.type}:${x.to}`), ['prerequisite:queues']);

  // stale mtime
  r = await send('PATCH', '/api/knowledge/concepts/dynamic-batching', { inMyWords: 'x', expectMtimeMs: c.mtimeMs });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as J).error, 'file changed on disk');

  r = await send('PATCH', '/api/knowledge/concepts/dynamic-batching', { inMyWords: 'new words' });
  assert.equal(((await r.json()) as J).concept.inMyWords, 'new words');

  r = await send('DELETE', '/api/knowledge/concepts/dynamic-batching');
  assert.equal(r.status, 200);
  const { trashed } = await r.json() as J;
  assert.ok(existsSync(trashed) && trashed.includes(`${path.sep}.trash${path.sep}`));
  assert.equal((await fetch(`${base}/api/knowledge/concepts/dynamic-batching`)).status, 404);
  assert.deepEqual(readdirSync(path.join(cfg.knowledgeRoot, 'concepts')), []);
});

test('409 on clashes, with existing and suggestion', async () => {
  let r = await send('POST', '/api/knowledge/concepts', { title: 'Tenant', slug: acme.folder });
  assert.equal(r.status, 409);
  let j = await r.json() as J;
  assert.equal(j.suggestion, `${acme.folder}-concept`);
  r = await send('POST', '/api/knowledge/concepts', { title: 'Acme' });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as J).suggestion, 'acme-concept');
  assert.equal((await send('POST', '/api/knowledge/concepts', { title: 'Sharding' })).status, 201);
  r = await send('POST', '/api/knowledge/concepts', { title: 'Sharding' });
  assert.equal(r.status, 409);
  j = await r.json() as J;
  assert.equal(j.existing, 'sharding');
});

test('similar titles are reported', async () => {
  await send('POST', '/api/knowledge/concepts', { title: 'Cache Aside', aliases: ['lazy loading'] });
  await send('POST', '/api/knowledge/concepts', { title: 'Lazy Loading' });
  const g = await (await fetch(`${base}/api/knowledge/concepts/lazy-loading`)).json() as J;
  assert.deepEqual(g.similar.map((s: J) => s.slug), ['cache-aside']);
});

test('403 without X-Studio or with a foreign origin', async () => {
  assert.equal((await send('POST', '/api/knowledge/concepts', { title: 'Nope' }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await send('POST', '/api/knowledge/rescan', undefined, { ...H, origin: 'http://evil.example' })).status, 403);
  assert.equal((await send('DELETE', '/api/knowledge/concepts/sharding', undefined, {} as never)).status, 403);
});

test('400 on bad fields', async () => {
  const bads: [string, unknown][] = [
    ['title', {}], ['title', { title: 5 }], ['slug', { title: 'Ok', slug: 'Bad Slug' }], ['status', { title: 'Ok', status: 'great' }],
    ['source folder', { title: 'Ok', sources: [{ folder: 'nope', t: 1, quote: '' }] }],
    ['company', { title: 'Ok', companies: [{ company: 'nope', why: '' }] }],
    ['related to', { title: 'Ok', related: [{ type: 'related', to: '../x' }] }],
    ['related type', { title: 'Ok', related: [{ type: 'friend', to: 'xy' }] }],
    ['words', { title: 'Ok', inMyWords: 'x'.repeat(20_001) }],
    ['array', { title: 'Ok', aliases: 'x' }], ['origin', { title: 'Ok', origin: 'robot' }],
  ];
  for (const [what, b] of bads) assert.equal((await send('POST', '/api/knowledge/concepts', b)).status, 400, what);
  assert.equal((await send('POST', '/api/knowledge/concepts', [1])).status, 400);
  const r = await fetch(`${base}/api/knowledge/concepts`, { method: 'POST', headers: H, body: '{nope' });
  assert.equal(r.status, 400);
  assert.equal((await send('PATCH', '/api/knowledge/concepts/sharding', { status: 'great' })).status, 400);
  assert.equal((await send('PATCH', '/api/knowledge/concepts/sharding', { addSource: { folder: 'nope' } })).status, 400);
  assert.equal((await send('PATCH', '/api/knowledge/concepts/sharding', { title: '  ' })).status, 400);
});

test('body over 256 KB is a 400 body too large', async () => {
  const r = await send('POST', '/api/knowledge/concepts', { title: 'Big', inMyWords: 'x'.repeat(270_000) });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as J).error, 'body too large');
});

test('unknown or malformed slugs are 404', async () => {
  for (const s of ['nope-nope', 'Bad', '..%2Fx', '%E0']) {
    assert.equal((await fetch(`${base}/api/knowledge/concepts/${s}`)).status, 404, s);
    assert.equal((await send('PATCH', `/api/knowledge/concepts/${s}`, {})).status, 404, s);
    assert.equal((await send('DELETE', `/api/knowledge/concepts/${s}`)).status, 404, s);
  }
});

test('rescan picks up a file added outside the API', async () => {
  const f = path.join(cfg.knowledgeRoot, 'concepts', 'from-obsidian.md');
  writeFileSync(f, '---\ntitle: From Obsidian\n---\n## In my words\n\nhi\n');
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const j = await (await send('POST', '/api/knowledge/rescan')).json() as J;
  assert.ok(j.concepts.some((c: J) => c.slug === 'from-obsidian'));
  assert.ok(j.videoKinds && j.companiesInCatalog);
});

test('pages: 404 for unknown concept; page missing or html otherwise', async () => {
  assert.equal((await fetch(`${base}/k/nope-nope`)).status, 404);
  assert.equal((await fetch(`${base}/k/Bad%20Slug`)).status, 404);
  for (const p of ['/knowledge', '/k/sharding']) {
    const r = await fetch(base + p);
    const t = await r.text();
    const has = existsSync(path.join(cfg.studioDir, 'public', p === '/knowledge' ? 'knowledge.html' : 'concept.html'));
    assert.equal(r.status, has ? 200 : 404, p);
    if (!has) assert.equal(t, 'page missing');
  }
});

test('store.summaryForVideo works as a bare callback', () => {
  const f = store.summaryForVideo;
  assert.ok(Array.isArray(f(acme.folder)));
});
