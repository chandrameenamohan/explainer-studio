import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { buildCatalog, loadOverrides, type Catalog } from '../lib/catalog.ts';
import { companyKey, newConcept, parseCompany, parseConcept, serializeConcept } from '../lib/knowledge.ts';
import { KnowledgeStore } from '../lib/knowledge-index.ts';
import { JobRunner } from '../lib/jobs.ts';
import { installKnowledgeRoutes } from '../lib/knowledge-routes.ts';
import { createStudioServer } from '../server.ts';

const base = loadConfig();
const cat: Catalog = buildCatalog(base.videoRoot, loadOverrides(path.join(base.studioDir, 'catalog.overrides.json')));
const roots: string[] = [];
function fresh() {
  const knowledgeRoot = mkdtempSync(path.join(tmpdir(), 'kg-'));
  roots.push(knowledgeRoot);
  const cfg = { ...base, knowledgeRoot };
  return { cfg, store: new KnowledgeStore(cfg, () => cat), root: knowledgeRoot };
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const someVideo = cat.records.find(r => r.series === 'globex')!;
const acmeVideo = cat.records.find(r => r.series === 'acme')!;

test('constructor does no I/O; rescan writes stubs, company notes and the obsidian config', () => {
  const { store, root } = fresh();
  assert.deepEqual(readdirSync(root), []);
  assert.equal(store.root(), root);
  const idx = store.rescan();
  assert.deepEqual(idx.concepts, []);
  const stubs = readdirSync(path.join(root, 'videos')).sort();
  assert.deepEqual(stubs, cat.records.map(r => `${r.folder}.md`).sort());
  const keys = new Set(cat.records.map(companyKey));
  assert.ok(keys.has('acme') && keys.has('general'));
  for (const k of keys) assert.ok(existsSync(path.join(root, 'companies', `${k}.md`)), k);
  const acme = parseCompany('acme', readFileSync(path.join(root, 'companies', 'acme.md'), 'utf8'));
  assert.equal(acme.title, 'Acme');
  assert.equal(acme.generated, true);
  assert.match(acme.body, /## What they care about/);
  assert.match(acme.body, new RegExp(`## Rounds\\n\\n- \\[\\[${acmeVideo.folder}\\]\\]`));
  assert.equal(parseCompany('general', readFileSync(path.join(root, 'companies', 'general.md'), 'utf8')).title, 'General');
  assert.deepEqual(idx.companies.map(c => c.key).sort(), [...keys].sort());
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.obsidian', 'app.json'), 'utf8')), { newFileLocation: 'folder', newFileFolderPath: 'concepts' });
});

test('second rescan rewrites nothing; stale stubs are deleted; user-owned company notes are kept', () => {
  const { store, root } = fresh();
  store.rescan();
  const old = Date.now() / 1000 - 3600;
  const files = [...readdirSync(path.join(root, 'videos')).map(f => path.join(root, 'videos', f)),
    ...readdirSync(path.join(root, 'companies')).map(f => path.join(root, 'companies', f)), path.join(root, '.obsidian', 'app.json')];
  for (const f of files) utimesSync(f, old, old);
  const before = files.map(f => statSync(f).mtimeMs);
  writeFileSync(path.join(root, 'videos', 'gone-folder.md'), '---\ntitle: "x"\ngenerated: true\n---\n');
  const owned = '---\ntitle: Globex\nkind: company\ngenerated: false\n---\n## What they care about\n\nmine\n';
  writeFileSync(path.join(root, 'companies', 'globex.md'), owned);
  store.rescan();
  assert.ok(!existsSync(path.join(root, 'videos', 'gone-folder.md')));
  assert.equal(readFileSync(path.join(root, 'companies', 'globex.md'), 'utf8'), owned);
  files.forEach((f, i) => { if (!f.endsWith('globex.md')) assert.equal(statSync(f).mtimeMs, before[i], f); });
});

test('generated company notes keep the user text and regenerate Rounds', () => {
  const { store, root } = fresh();
  store.rescan();
  const f = path.join(root, 'companies', 'acme.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('## What they care about\n', '## What they care about\n\nmulti-tenant\n').replace(/## Rounds[\s\S]*$/, '## Rounds\n\n- stale\n'));
  store.rescan();
  const t = readFileSync(f, 'utf8');
  assert.match(t, /multi-tenant/);
  assert.doesNotMatch(t, /stale/);
  assert.match(t, new RegExp(`\\[\\[${acmeVideo.folder}\\]\\]`));
});

test('create indexes byVideo, byCompany, backlinks and unresolved', () => {
  const { store } = fresh();
  store.create(newConcept({ slug: 'gpu-utilization', title: 'GPU utilization' }));
  const c = store.create(newConcept({
    slug: 'dynamic-batching', title: 'Dynamic batching',
    sources: [{ folder: someVideo.folder, t: 43, quote: 'q', raw: '' }],
    companies: [{ company: 'globex', why: 'ingest', raw: '' }],
    related: [{ type: 'prerequisite', to: 'gpu-utilization', raw: '' }, { type: 'contrast', to: 'nowhere-yet', raw: '' }],
  }));
  assert.equal(c.slug, 'dynamic-batching');
  const idx = store.index();
  assert.deepEqual(idx.byVideo[someVideo.folder], ['dynamic-batching']);
  assert.deepEqual(idx.byCompany.globex, ['dynamic-batching']);
  assert.deepEqual(store.get('gpu-utilization')!.backlinks, ['dynamic-batching']);
  assert.deepEqual(store.get('dynamic-batching')!.unresolved, ['nowhere-yet']);
  assert.equal(store.exists('dynamic-batching'), 'concept');
  assert.equal(store.exists(someVideo.folder), 'video');
  assert.equal(store.exists('general'), 'company');
  assert.equal(store.exists('nothing-here'), null);
  assert.ok(existsSync(store.get('dynamic-batching')!.file));
  assert.throws(() => store.create(newConcept({ slug: 'dynamic-batching', title: 'Again' })), (e: any) => e.code === 409);
});

test('namespace: a concept slug may not be a video folder or a company key', () => {
  const { store } = fresh();
  assert.throws(() => store.create(newConcept({ slug: someVideo.folder, title: 'x' })),
    (e: any) => e.code === 409 && e.suggestion === `${someVideo.folder}-concept`);
  assert.throws(() => store.create(newConcept({ slug: 'acme', title: 'Acme' })), (e: any) => e.code === 409);
  assert.equal(store.get('acme'), undefined);
});

test('update promotes fuzzy to learning, bumps updated, keeps the slug; stale mtime is 409', () => {
  const { store } = fresh();
  store.create(newConcept({ slug: 'hash-ring', title: 'Hash ring', created: '2020-01-01', updated: '2020-01-01' }));
  const before = store.get('hash-ring')!;
  const u = store.update('hash-ring', c => { c.inMyWords = 'Keys map to points on a circle.'; c.slug = 'evil'; }, before.mtimeMs);
  assert.equal(u.status, 'learning');
  assert.equal(u.slug, 'hash-ring');
  assert.notEqual(u.updated, '2020-01-01');
  assert.equal(parseConcept('hash-ring', readFileSync(u.file, 'utf8')).inMyWords, 'Keys map to points on a circle.');
  assert.throws(() => store.update('hash-ring', c => { c.title = 'x'; }, before.mtimeMs - 5000), (e: any) => e.code === 409);
  const k = store.update('hash-ring', c => { c.status = 'known'; });
  assert.equal(k.status, 'known');
  const f = store.update('hash-ring', c => { c.status = 'fuzzy'; });
  assert.equal(f.status, 'fuzzy', 'explicit downgrade is kept');
  const a = store.update('hash-ring', c => { c.aliases = ['ring']; });
  assert.equal(a.status, 'fuzzy', 'an edit that does not change the words does not promote');
  assert.throws(() => store.update('no-such', () => {}), (e: any) => e.code === 404);
});

test('update keeps text the studio does not own', () => {
  const { store, root } = fresh();
  const file = path.join(root, 'concepts', 'cap-theorem.md');
  store.rescan();
  writeFileSync(file, '---\ntitle: CAP\nstatus: fuzzy\n---\n## In my words\n\n## Related\n\n- related: [[x-thing]]\n> keep me\n\n## My notes\n\nfree text\n');
  const u = store.update('cap-theorem', c => { c.title = 'CAP theorem'; });
  const t = readFileSync(u.file, 'utf8');
  assert.match(t, /> keep me/);
  assert.match(t, /## My notes\n\nfree text/);
});

test('trash moves the file and the index drops it', () => {
  const { store, root } = fresh();
  store.create(newConcept({ slug: 'to-remove', title: 'To remove' }));
  const p = store.trash('to-remove');
  assert.ok(p.startsWith(path.join(root, '.trash') + path.sep));
  assert.match(path.basename(p), /^to-remove-.+\.md$/);
  assert.ok(existsSync(p));
  assert.ok(!existsSync(path.join(root, 'concepts', 'to-remove.md')));
  assert.equal(store.get('to-remove'), undefined);
  assert.throws(() => store.trash('to-remove'), (e: any) => e.code === 404);
});

test('lazy rescan picks up files edited on disk; bad file names are unreadable', () => {
  const { store, root } = fresh();
  store.create(newConcept({ slug: 'edited-later', title: 'Before' }));
  assert.equal(store.get('edited-later')!.title, 'Before');
  const file = path.join(root, 'concepts', 'edited-later.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('title: Before', 'title: After'));
  const future = Date.now() / 1000 + 60;
  utimesSync(file, future, future);
  assert.equal(store.get('edited-later')!.title, 'After');
  writeFileSync(path.join(root, 'concepts', 'Dynamic batching.md'), serializeConcept(newConcept({ slug: 'dynamic-batching', title: 'Dynamic batching' })));
  writeFileSync(path.join(root, 'concepts', 'broken.md'), 'no frontmatter here');
  const idx = store.index();
  assert.ok(idx.unreadable.some(u => u.file.endsWith('Dynamic batching.md') && u.reason === 'rename to a slug'));
  assert.ok(idx.unreadable.some(u => u.file.endsWith('broken.md')));
  assert.equal(idx.concepts.length, 1);
});

test('similar finds token-set and alias matches, excluding the exact slug', () => {
  const { store } = fresh();
  store.create(newConcept({ slug: 'consistent-hash-ring', title: 'Consistent hash ring' }));
  store.create(newConcept({ slug: 'consistent-hashing', title: 'Consistent hashing', aliases: ['consistent hash ring'] }));
  store.create(newConcept({ slug: 'ring-hash', title: 'Ring hash consistent' }));
  store.create(newConcept({ slug: 'unrelated', title: 'Leader election' }));
  assert.deepEqual(store.similar('Consistent hash ring').map(c => c.slug).sort(), ['consistent-hashing', 'ring-hash']);
  assert.deepEqual(store.similar('consistent hashing').map(c => c.slug), []);
});

test('summaryForVideo returns concepts for the video and its company', () => {
  const { store } = fresh();
  store.create(newConcept({ slug: 'on-video', title: 'On video', definition: 'd', inMyWords: 'w', status: 'learning',
    sources: [{ folder: someVideo.folder, t: 1, quote: '', raw: '' }], related: [{ type: 'related', to: 'on-company', raw: '' }] }));
  store.create(newConcept({ slug: 'on-company', title: 'On company', companies: [{ company: companyKey(someVideo), why: '', raw: '' }] }));
  store.create(newConcept({ slug: 'elsewhere', title: 'Elsewhere', companies: [{ company: 'acme', why: '', raw: '' }] }));
  const s = store.summaryForVideo(someVideo.folder);
  assert.deepEqual(s.map(x => x.slug), ['on-video', 'on-company']);
  assert.deepEqual(s[0], { slug: 'on-video', title: 'On video', status: 'learning', inMyWords: 'w', definition: 'd', related: ['on-company'], companies: [] });
  assert.deepEqual(s[1].companies, [companyKey(someVideo)]);
  assert.deepEqual(store.summaryForVideo('no-such-folder'), []);
});

test('installKnowledgeRoutes exposes the store', () => {
  const { cfg } = fresh();
  const app = createStudioServer(cfg);
  const { store } = installKnowledgeRoutes(app, cfg, new JobRunner(cfg, () => {}));
  assert.ok(store instanceof KnowledgeStore);
  assert.equal(store.root(), cfg.knowledgeRoot);
});

test('lazy rescan also sees an edit after a future-dated file and a deleted file', () => {
  const { store, root } = fresh();
  store.create(newConcept({ slug: 'first-one', title: 'First' }));
  store.create(newConcept({ slug: 'second-one', title: 'Second' }));
  const f1 = path.join(root, 'concepts', 'first-one.md');
  const future = Date.now() / 1000 + 600;
  utimesSync(f1, future, future);
  store.index();
  const f2 = path.join(root, 'concepts', 'second-one.md');
  writeFileSync(f2, readFileSync(f2, 'utf8').replace('title: Second', 'title: Second edited'));
  assert.equal(store.get('second-one')!.title, 'Second edited');
  rmSync(f2);
  assert.equal(store.get('second-one'), undefined);
});
