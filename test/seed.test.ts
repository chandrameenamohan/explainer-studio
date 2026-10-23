import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { buildCatalog, loadOverrides, type Catalog } from '../lib/catalog.ts';
import { KnowledgeStore } from '../lib/knowledge-index.ts';
import { newConcept } from '../lib/knowledge.ts';
import { buildSeedPrompt, parseSeedOutput, validateSeedItems, applySeedItems, runSeed, type SeedItem } from '../lib/seed.ts';
import { createStudioServer } from '../server.ts';
import { installJobRoutes } from '../lib/jobs.ts';
import { installKnowledgeRoutes } from '../lib/knowledge-routes.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const base0 = loadConfig();
const catalog: Catalog = buildCatalog(base0.videoRoot, loadOverrides(path.join(base0.studioDir, 'catalog.overrides.json')));
const rec = catalog.records.find(r => r.folder === 'sd-model-serving')!;
const other = catalog.records.find(r => r.folder !== rec.folder && r.scenes.length > 1 && r.scenes[1].lines.length >= 2)!;
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function vault() {
  const knowledgeRoot = mkdtempSync(path.join(tmpdir(), 'kg-'));
  dirs.push(knowledgeRoot);
  const config = { ...base0, knowledgeRoot };
  return { config, store: new KnowledgeStore(config, () => catalog) };
}
const item = (over: Partial<SeedItem>): SeedItem => ({ title: 'X', slug: 'x-thing', definition: 'd', quote: '', line: '', related: [], why_for_company: '', ...over });
const lineOf = (key: string) => rec.scenes.flatMap(s => s.lines).find(l => l.key === key)!;

test('prompt shape: marker, keyed lines, scene headings, existing titles and aliases, JSON ask', () => {
  const p = buildSeedPrompt(rec, [{ title: 'Tenant isolation', slug: 'tenant-isolation', aliases: ['noisy neighbour'] }], 'General');
  assert.ok(p.startsWith('[studio:seed]\n'));
  assert.match(p, new RegExp(`^  \\[1\\.0\\] @\\d+:\\d\\d ${lineOf('1.0').text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(p.includes(rec.scenes[1].chip));
  assert.match(p, /Tenant isolation/);
  assert.match(p, /noisy neighbour/);
  assert.match(p, /"concepts"/);
  assert.match(p, /why_for_company/);
  assert.match(p, /4.8/);
});

test('parseSeedOutput tolerates fences and rejects junk', () => {
  const items = parseSeedOutput('Here:\n```json\n{"concepts":[{"title":"A b","slug":"a-b","definition":"d","quote":"q","line":"1.0","related":["c-d"],"why_for_company":"w"}]}\n```');
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'a-b');
  assert.deepEqual(items[0].related, ['c-d']);
  assert.throws(() => parseSeedOutput('no json here'));
  assert.throws(() => parseSeedOutput('{"concepts": "nope"}'));
  assert.throws(() => parseSeedOutput('{"concepts": [{"slug": "no-title"}]}'));
  assert.throws(() => parseSeedOutput('{broken'));
});

test('validateSeedItems: quote must be a script line, slug fallback, t from line or quote', () => {
  const l10 = lineOf('1.0'); const l11 = lineOf('1.1');
  const { ok, dropped } = validateSeedItems([
    item({ title: 'Good one', slug: 'Bad Slug!', quote: `  "${l10.text.toUpperCase()}"  `, line: '1.0', related: ['ok-slug', 'Not OK'] }),
    item({ title: 'Wrong key', slug: 'wrong-key', quote: l11.text, line: '99.9' }),
    item({ title: 'Made up', slug: 'made-up', quote: 'this sentence is not in the script at all', line: '1.0' }),
  ], rec);
  assert.equal(ok.length, 2);
  assert.equal(ok[0].slug, 'good-one');
  assert.equal(ok[0].t, l10.start);
  assert.deepEqual(ok[0].related, ['ok-slug']);
  assert.equal(ok[1].t, l11.start);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].item.slug, 'made-up');
  assert.match(dropped[0].reason, /quote/);
});

test('applySeedItems creates files from the fake output and is idempotent on re-apply', async () => {
  const { store } = vault();
  const { runAgent } = await import('../lib/agent.ts');
  let out = '';
  for await (const e of runAgent({ prompt: buildSeedPrompt(rec, [], 'General'), cwd: base0.studioDir, permissionMode: 'dontAsk', abort: new AbortController() })) if (e.type === 'result') out = e.resultText ?? '';
  const { ok, dropped } = validateSeedItems(parseSeedOutput(out), rec);
  assert.equal(dropped.length, 0);
  const r1 = applySeedItems(store, rec, ok, 'general');
  assert.deepEqual(r1.created.sort(), ['dynamic-batching', 'warm-replicas']);
  assert.ok(existsSync(path.join(store.root(), 'concepts', 'dynamic-batching.md')));
  const c = store.get('warm-replicas')!;
  assert.equal(c.origin, 'seed'); assert.equal(c.status, 'fuzzy'); assert.equal(c.inMyWords, '');
  assert.match(c.definition, /spare replicas/);
  assert.equal(c.sources[0].folder, rec.folder);
  assert.deepEqual(c.companies.map(x => x.company), ['general']);
  assert.deepEqual(c.related.map(x => x.to), ['dynamic-batching']);
  assert.deepEqual(store.index().byVideo[rec.folder]?.sort(), ['dynamic-batching', 'warm-replicas']);
  const r2 = applySeedItems(store, rec, ok, 'general');
  assert.deepEqual(r2, { created: [], appended: [] });
  assert.equal(store.get('dynamic-batching')!.sources.length, 1);
});

test('alias dedup: Batching appends to dynamic-batching', () => {
  const { store } = vault();
  store.create(newConcept({ slug: 'dynamic-batching', title: 'Dynamic batching', aliases: ['batching'] }));
  const l = lineOf('1.0');
  const r = applySeedItems(store, rec, [{ ...item({ title: 'Batching', slug: 'batching', quote: l.text, line: '1.0', why_for_company: 'why' }), t: l.start }], 'globex');
  assert.deepEqual(r, { created: [], appended: ['dynamic-batching'] });
  const c = store.get('dynamic-batching')!;
  assert.equal(c.sources[0].folder, rec.folder);
  assert.deepEqual(c.companies.map(x => `${x.company}:${x.why}`), ['globex:why']);
  assert.equal(existsSync(path.join(store.root(), 'concepts', 'batching.md')), false);
});

test('namespace clash: a video or company slug gets -concept', () => {
  const { store } = vault();
  const r = applySeedItems(store, rec, [
    { ...item({ title: 'Model serving', slug: rec.folder }), t: null },
    { ...item({ title: 'Globex', slug: 'globex' }), t: null },
  ], 'general');
  assert.deepEqual(r.created.sort(), [`${rec.folder}-concept`, 'globex-concept'].sort());
});

test('runSeed over two folders logs two video entries, then skips them', async () => {
  const { config, store } = vault();
  const logs: Record<string, unknown>[] = [];
  const r = await runSeed({ config, store, catalog, folders: [rec.folder, other.folder], log: e => logs.push(e), abort: new AbortController() });
  assert.deepEqual(r.seeded, [rec.folder, other.folder]);
  assert.equal(r.stoppedAt, null);
  const videos = logs.filter(e => e.type === 'video');
  assert.equal(videos.length, 2);
  assert.deepEqual(videos.map(v => v.folder), [rec.folder, other.folder]);
  assert.ok(Array.isArray(videos[0].created) && Array.isArray(videos[0].dropped));
  assert.ok(store.index().byVideo[other.folder]?.length);
  const again = await runSeed({ config, store, catalog, folders: [rec.folder, other.folder], log: () => {}, abort: new AbortController() });
  assert.deepEqual(again.seeded, []);
  assert.deepEqual(again.skipped, [rec.folder, other.folder]);
});

test('runSeed stops at the budget and reports where', async () => {
  const { config, store } = vault();
  const logs: Record<string, unknown>[] = [];
  const r = await runSeed({ config: { ...config, seedBudgetUsd: 0 }, store, catalog, folders: [rec.folder, other.folder], log: e => logs.push(e), abort: new AbortController() });
  assert.deepEqual(r.seeded, [rec.folder]);
  assert.equal(r.stoppedAt, other.folder);
  assert.equal(logs.filter(e => e.type === 'video').length, 1);
});

test('seed route: starts a seed job, status lists seeded folders, never writes under videoRoot', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'kg-st-')); dirs.push(stateDir);
  const { config } = vault();
  const cfg = { ...config, stateDir };
  const app = createStudioServer(cfg);
  const runner = installJobRoutes(app, cfg);
  installKnowledgeRoutes(app, cfg, runner);
  const base = `http://127.0.0.1:${await app.listen(0)}`;
  const H = { 'content-type': 'application/json', 'x-studio': '1' };
  const vdir = path.join(cfg.videoRoot, rec.folder);
  const before = readdirSync(vdir).sort().join(',');
  const beforeMtime = statSync(vdir).mtimeMs;
  try {
    let r = await fetch(`${base}/api/knowledge/seed`, { method: 'POST', headers: H, body: JSON.stringify({ folders: ['no-such-folder-x'] }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/knowledge/seed`, { method: 'POST', headers: H, body: '{not json' });
    assert.equal(r.status, 400, 'a malformed body must not start a seed of every video');
    r = await fetch(`${base}/api/knowledge/seed`, { method: 'POST', headers: H, body: JSON.stringify({ folders: [rec.folder, other.folder], limit: 1 }) });
    assert.equal(r.status, 200);
    const { job } = await r.json() as { job: { kind: string; folder: string | null; logPath: string } };
    assert.equal(job.kind, 'seed');
    assert.equal(job.folder, null);
    assert.equal(job.logPath, path.join(cfg.knowledgeRoot, '.studio', 'seed.jsonl'));
    let cur: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 100; i++) {
      cur = (await (await fetch(`${base}/api/job`)).json() as { job: Record<string, unknown> }).job;
      if (cur.status !== 'running') break;
      await new Promise(res => setTimeout(res, 20));
    }
    assert.equal(cur.kind, 'seed');
    assert.equal(cur.status, 'done');
    assert.deepEqual(cur.detail.seeded, [rec.folder]);
    assert.equal(cur.detail.total, 1);
    assert.equal(cur.detail.done, 1);
    assert.match(readFileSync(job.logPath, 'utf8'), /"type":"video"/);
    const st = await (await fetch(`${base}/api/knowledge/seed/status`)).json() as { seededFolders: string[]; remaining: string[] };
    assert.deepEqual(st.seededFolders, [rec.folder]);
    assert.ok(st.remaining.includes(other.folder) && !st.remaining.includes(rec.folder));
    assert.equal(readdirSync(vdir).sort().join(','), before);
    assert.equal(statSync(vdir).mtimeMs, beforeMtime);
    // everything requested is already seeded
    r = await fetch(`${base}/api/knowledge/seed`, { method: 'POST', headers: H, body: JSON.stringify({ folders: [rec.folder] }) });
    assert.equal(r.status, 400);
  } finally { await app.close(); }
});
