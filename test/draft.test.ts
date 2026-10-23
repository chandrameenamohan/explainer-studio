import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { readRecord } from '../lib/catalog.ts';
import { buildDraftPrompt, draftFromAnswer, installDraftRoutes } from '../lib/draft.ts';
import { createStudioServer } from '../server.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const H = { 'content-type': 'application/json', 'x-studio': '1' };
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-draft-')) };
const rec = readRecord(cfg.videoRoot, 'basics-pagination-worked', {})!;
const existing = [{ title: 'Tenant isolation', slug: 'tenant-isolation' }];
after(() => rmSync(cfg.stateDir, { recursive: true, force: true }));

test('prompt shape: marker, keyed lines near t, existing slugs, JSON ask', () => {
  const p = buildDraftPrompt(rec, 3, 'what is X?', 'X is a thing.', existing);
  assert.ok(p.startsWith('[studio:draft]\n'));
  assert.match(p, /\[0\.0\] @0:00 Here is a feed/);
  assert.match(p, /what is X\?/);
  assert.match(p, /X is a thing\./);
  assert.match(p, /tenant-isolation/);
  assert.match(p, /"definition"/);
  assert.ok((p.match(/^\s*\[\d+\.\d+\] @/gm) ?? []).length <= 6);
  assert.ok(buildDraftPrompt(rec, null, 'q', 'a', []).startsWith('[studio:draft]\n'));
});

test('fake draft returns fake-concept with defaults', async () => {
  const d = await draftFromAnswer({ config: cfg, record: rec, t: 12, question: 'q', answer: 'a', existing, abort: new AbortController() });
  assert.equal(d.slug, 'fake-concept');
  assert.equal(d.title, 'Fake concept');
  assert.equal(d.quote, '');
  assert.equal(d.t, 12);
  assert.deepEqual(d.related, []);
  assert.deepEqual(d.companies, [rec.series]);
});

test('draft route: 400, 404, 200, 403', async () => {
  const app = createStudioServer(cfg);
  installDraftRoutes(app, cfg, { index: () => ({ concepts: existing }) });
  const port = await app.listen(0);
  const post = (body: unknown, headers: Record<string, string> = H) => fetch(`http://127.0.0.1:${port}/api/knowledge/draft`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ folder: 'basics-pagination-worked', t: 3, question: 'q', answer: '  ' })).status, 400);
    assert.equal((await post({ folder: 'nope-nope', t: 3, question: 'q', answer: 'a' })).status, 404);
    const ok = await post({ folder: 'basics-pagination-worked', t: 3, question: 'q', answer: 'a' });
    assert.equal(ok.status, 200);
    const { draft } = await ok.json() as { draft: { slug: string; t: number } };
    assert.equal(draft.slug, 'fake-concept');
    assert.equal(draft.t, 3);
    assert.equal((await post({ folder: 'x', answer: 'a' }, { 'content-type': 'application/json' })).status, 403);
  } finally { await app.close(); }
});
