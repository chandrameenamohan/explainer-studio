import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { createStudioServer } from '../server.ts';
import { installJobRoutes } from '../lib/jobs.ts';
import { installChatRoutes } from '../lib/chat.ts';
import { installKnowledgeRoutes } from '../lib/knowledge-routes.ts';
import http from 'node:http';

const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-srv-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'studio-srv-kg-')) };
const app = createStudioServer(cfg);
const runner = installJobRoutes(app, cfg); const { store } = installKnowledgeRoutes(app, cfg, runner); installChatRoutes(app, cfg, store.summaryForVideo);
const port = await app.listen(0);
const base = `http://127.0.0.1:${port}`;
after(async () => { await app.close(); rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true }); });

test('health and pages', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json() as { ok: boolean }).ok, true);
  for (const p of ['/', '/v/basics-pagination-worked', '/create']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    await r.text();
  }
  assert.equal((await fetch(`${base}/studio.css`)).status, 200);
});

const H = { 'content-type': 'application/json', 'x-studio': '1' };

test('catalog lists records with watched flag and rescan rebuilds', async () => {
  const c = await (await fetch(`${base}/api/catalog`)).json() as { records: { folder: string; watched: boolean }[]; builtAt: string };
  assert.deepEqual(c.records.map(r => r.folder).sort(), ['acme-sd-01-rate-limiter', 'basics-pagination-worked', 'globex-beh-01-biggest-failure', 'sd-model-serving']);
  assert.equal(typeof c.records[0].watched, 'boolean');
  const r = await (await fetch(`${base}/api/catalog/rescan`, { method: 'POST', headers: H })).json() as { builtAt: string };
  assert.ok(r.builtAt >= c.builtAt);
});

test('mutating requests need X-Studio and a loopback origin', async () => {
  assert.equal((await fetch(`${base}/api/catalog/rescan`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/catalog/rescan`, { method: 'POST', headers: { ...H, origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/catalog/rescan`, { method: 'POST', headers: { ...H, origin: `http://localhost:${port}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/video/basics-pagination-worked/joblog`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/video/basics-pagination-worked/joblog`)).json(), { lines: [] });
});

test('video detail, state round trip, unknown folder 404', async () => {
  const v = await (await fetch(`${base}/api/video/basics-pagination-worked`)).json() as { record: { title: string }; state: { positionSec: number } };
  assert.match(v.record.title, /Pagination/);
  assert.equal(v.state.positionSec, 0);
  const put = await fetch(`${base}/api/video/basics-pagination-worked/state`, { method: 'PUT', headers: H, body: JSON.stringify({ positionSec: 42, watched: true }) });
  assert.equal(put.status, 200);
  const again = await (await fetch(`${base}/api/video/basics-pagination-worked`)).json() as { state: { positionSec: number; watched: boolean } };
  assert.equal(again.state.positionSec, 42);
  assert.equal(again.state.watched, true);
  assert.equal((await fetch(`${base}/api/video/does-not-exist`)).status, 404);
  assert.equal((await fetch(`${base}/api/video/..%2F..%2Fetc`)).status, 404);
});

test('media serves ranges and 404s for folders without an mp4', async () => {
  const r = await fetch(`${base}/media/sd-model-serving/video.mp4`, { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${base}/media/acme-sd-01-rate-limiter/video.mp4`)).status, 404);
});

test('R01: cross-origin POST /api/job and non-loopback Origin on PUT state get 403', async () => {
  // invalid bodies on purpose: if the guard ever fails these get 400, never start an agent
  const evil = await fetch(`${base}/api/job`, { method: 'POST', headers: { ...H, origin: 'http://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403); await evil.text();
  const noHeader = await fetch(`${base}/api/job`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: '{}' });
  assert.equal(noHeader.status, 403); await noHeader.text();
  const lookalike = await fetch(`${base}/api/job`, { method: 'POST', headers: { ...H, origin: 'http://localhost.evil.example' }, body: '{}' });
  assert.equal(lookalike.status, 403); await lookalike.text();
  const before = await (await fetch(`${base}/api/video/sd-model-serving`)).json() as { state: { positionSec: number } };
  for (const origin of [`http://192.168.1.5:${port}`, 'null', 'https://evil.example']) {
    const put = await fetch(`${base}/api/video/sd-model-serving/state`, { method: 'PUT', headers: { ...H, origin }, body: JSON.stringify({ positionSec: 777 }) });
    assert.equal(put.status, 403, origin); await put.text();
  }
  const after = await (await fetch(`${base}/api/video/sd-model-serving`)).json() as { state: { positionSec: number } };
  assert.equal(after.state.positionSec, before.state.positionSec);
});

function rawGet(pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject); r.end();
  });
}

test('R01: a foreign Host header (DNS rebinding) is refused on reads', async () => {
  assert.equal(await rawGet('/api/catalog', `evil.example:${port}`), 403);
  assert.equal(await rawGet('/api/video/basics-pagination-worked', `evil.example:${port}`), 403);
  assert.equal(await rawGet('/api/catalog', `127.0.0.1:${port}`), 200);
  assert.equal(await rawGet('/api/catalog', `localhost:${port}`), 200);
});

test('R01: malformed percent-encoding is a 404, not a 500', async () => {
  for (const p of ['/v/%E0%A4%A', '/api/video/%E0%A4%A', '/api/video/%E0%A4%A/joblog', '/media/%E0%A4%A/video.mp4']) {
    const r = await fetch(base + p); assert.equal(r.status, 404, p); await r.text();
  }
  const c = await fetch(`${base}/api/video/%E0%A4%A/chat`, { method: 'POST', headers: H, body: '{}' });
  assert.equal(c.status, 404); await c.text();
});

test('R01: PUT state with a bad body is a 400, not a 500', async () => {
  for (const body of ['{not json', 'null', '[1]', '"x"']) {
    const r = await fetch(`${base}/api/video/sd-model-serving/state`, { method: 'PUT', headers: H, body });
    assert.equal(r.status, 400, body); await r.text();
  }
});
