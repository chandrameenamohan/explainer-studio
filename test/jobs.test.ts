import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { JobRunner, installJobRoutes, type Job } from '../lib/jobs.ts';
import { createStudioServer } from '../server.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const H = { 'content-type': 'application/json', 'x-studio': '1' };
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-jobs-')) };
const folder = `e2e-fake-job-${process.pid}`;
const dir = path.join(cfg.videoRoot, folder);
after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(cfg.stateDir, { recursive: true, force: true }); });

test('JobRunner runs one fake job to completion, logs JSONL, refuses a second', async () => {
  let finished: unknown = null;
  const runner = new JobRunner(cfg, j => { finished = j; });
  const lines: string[] = [];
  runner.subscribe(l => lines.push(l));
  const job = runner.startCreate(folder, 'build it');
  assert.equal(job.status, 'running');
  assert.equal(job.kind, 'create'); assert.equal(job.folder, folder); assert.match(job.id, /^create-[a-z0-9]+$/);
  assert.equal(job.logPath, path.join(cfg.videoRoot, folder, 'studio-job.jsonl')); assert.deepEqual(job.detail, {});
  assert.throws(() => runner.startCreate('other-folder-x', 'x'), /already running/);
  while (!finished) await new Promise(r => setTimeout(r, 20));
  assert.equal((finished as { status: string }).status, 'failed'); // fake job writes no mp4
  assert.match((finished as { error: string }).error, /no mp4/);
  const log = readFileSync(runner.logPath(folder), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string });
  assert.ok(log.some(l => l.type === 'tool')); assert.ok(log.some(l => l.type === 'result')); assert.equal(log.at(-1)?.type, 'status');
  assert.ok(lines.length >= log.length - 1);
  assert.equal(runner.current()?.status, 'failed');
});

test('routes: briefs, start, status, events, 409 while running, cancel', async () => {
  const app = createStudioServer(cfg); const routesRunner = installJobRoutes(app, cfg);
  assert.ok(routesRunner instanceof JobRunner);
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const f2 = `${folder}-b`; const d2 = path.join(cfg.videoRoot, f2);
  try {
    const briefs = await (await fetch(`${base}/api/briefs`)).json() as { path: string }[];
    assert.ok(briefs.some(b => b.path.endsWith('briefs/acme.md')));
    const bad = await fetch(`${base}/api/job`, { method: 'POST', headers: H, body: JSON.stringify({ folder: 'Bad!', topic: 't', outline: 'o' }) });
    assert.equal(bad.status, 400); await bad.text();
    const exists = await fetch(`${base}/api/job`, { method: 'POST', headers: H, body: JSON.stringify({ folder: 'basics-pagination-worked', topic: 't', outline: 'o' }) });
    assert.equal(exists.status, 409); await exists.text();
    const ok = await fetch(`${base}/api/job`, { method: 'POST', headers: H, body: JSON.stringify({ folder: f2, topic: 'SSE basics', outline: '1. hook', sharedBrief: null, extraRules: '' }) });
    assert.equal(ok.status, 200);
    const started = await ok.json() as { job: { folder: string; status: string } };
    assert.equal(started.job.folder, f2); assert.ok(existsSync(path.join(d2, 'brief.md')));
    const ev = await fetch(`${base}/api/job/events`);
    assert.match(ev.headers.get('content-type') ?? '', /event-stream/);
    const reader = ev.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    while (!/"status":"(failed|done)"/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    await reader.cancel();
    assert.match(buf, /event: line\n/); assert.match(buf, /tts\.py/);
    const cur = await (await fetch(`${base}/api/job`)).json() as { job: { status: string } };
    assert.equal(cur.job.status, 'failed');
    const del = await fetch(`${base}/api/job`, { method: 'DELETE', headers: H }); assert.equal(del.status, 409); await del.text();
    assert.ok(app.catalog().records.some(r => r.folder === f2 && r.hasBrief && r.mp4 === null));
    const retry = await fetch(`${base}/api/job/retry`, { method: 'POST', headers: H, body: JSON.stringify({ folder: f2 }) });
    assert.equal(retry.status, 200); await retry.text();
    while (((await (await fetch(`${base}/api/job`)).json()) as { job: { status: string } }).job.status === 'running') await new Promise(r => setTimeout(r, 20));
    const noBrief = await fetch(`${base}/api/job/retry`, { method: 'POST', headers: H, body: JSON.stringify({ folder: 'sd-model-serving' }) });
    assert.equal(noBrief.status, 400); await noBrief.text();
  } finally { await app.close(); rmSync(d2, { recursive: true, force: true }); }
});

test('R01: a throwing onFinished or a vanished folder never leaves the job running or rejects', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-jobs-root-'));
  const rejections: unknown[] = []; const onRej = (e: unknown) => { rejections.push(e); };
  process.on('unhandledRejection', onRej);
  try {
    const r1 = new JobRunner({ ...cfg, videoRoot: root }, () => { throw new Error('rescan blew up'); });
    r1.startCreate('throwing-finish', 'x');
    while (r1.current()?.status === 'running') await new Promise(r => setTimeout(r, 20));
    assert.equal(r1.current()?.status, 'failed');
    let done = false;
    const r2 = new JobRunner({ ...cfg, videoRoot: root }, () => { done = true; });
    r2.startCreate('vanishing-folder', 'x');
    rmSync(path.join(root, 'vanishing-folder'), { recursive: true, force: true });
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 20));
    assert.ok(done, 'onFinished called'); assert.notEqual(r2.current()?.status, 'running');
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(rejections, []);
  } finally { process.off('unhandledRejection', onRej); rmSync(root, { recursive: true, force: true }); }
});

test('K04: startCustom done, log lines in the given path, refuses a second, startCreate refuses while it runs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-jobs-custom-'));
  try {
    const finished: Job[] = [];
    const runner = new JobRunner({ ...cfg, videoRoot: root }, j => { finished.push(j); });
    const lines: string[] = []; runner.subscribe(l => lines.push(l));
    const logPath = path.join(root, '.studio', 'seed.jsonl');
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const job = runner.startCustom('seed', logPath, async (j, log) => { j.detail.done = 0; log({ type: 'progress', n: 1 }); await gate; j.detail.done = 1; j.costUsd = 0.25; });
    assert.equal(job.kind, 'seed'); assert.equal(job.folder, null); assert.equal(job.logPath, logPath); assert.equal(job.status, 'running');
    assert.match(job.id, /^seed-[a-z0-9]+$/);
    assert.throws(() => runner.startCreate('should-not-start', 'x'), /already running/);
    assert.throws(() => runner.startCustom('seed', logPath, async () => {}), /already running/);
    assert.ok(!existsSync(path.join(root, 'should-not-start')), 'create refused before touching videoRoot');
    release();
    while (!finished.length) await new Promise(r => setTimeout(r, 10));
    assert.equal(job.status, 'done'); assert.equal(job.error, null); assert.ok(job.endedAt); assert.deepEqual(job.detail, { done: 1 }); assert.equal(job.costUsd, 0.25);
    assert.equal(finished[0], job); assert.equal(runner.current(), job);
    const log = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; job?: Job });
    assert.deepEqual(log.map(l => l.type), ['status', 'progress', 'status']);
    assert.equal(log[0].job?.status, 'running'); assert.equal(log.at(-1)?.job?.status, 'done');
    assert.equal(lines.length, 3);
    assert.deepEqual(readdirSync(root), ['.studio'], 'custom jobs never touch videoRoot folders');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K04: startCustom failed when work rejects or throws, cancelled when aborted', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-jobs-custom-'));
  const rejections: unknown[] = []; const onRej = (e: unknown) => { rejections.push(e); };
  process.on('unhandledRejection', onRej);
  try {
    let n = 0; const runner = new JobRunner({ ...cfg, videoRoot: root }, () => { n++; });
    const wait = async (k: number) => { while (n < k) await new Promise(r => setTimeout(r, 10)); };
    const lp = path.join(root, 'k', 'seed.jsonl');
    const a = runner.startCustom('seed', lp, async () => { throw new Error('model said no'); });
    await wait(1);
    assert.equal(a.status, 'failed'); assert.equal(a.error, 'model said no'); assert.ok(a.endedAt);
    const b = runner.startCustom('seed', lp, () => { throw new Error('sync boom'); });
    await wait(2);
    assert.equal(b.status, 'failed'); assert.equal(b.error, 'sync boom');
    const c = runner.startCustom('seed', lp, (_j, _log, abort) => new Promise<void>(resolve => abort.signal.addEventListener('abort', () => resolve())));
    assert.equal(runner.cancel(), true);
    await wait(3);
    assert.equal(c.status, 'cancelled'); assert.equal(runner.cancel(), false);
    const d = runner.startCustom('seed', lp, (_j, _log, abort) => new Promise<void>((_r, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    runner.cancel(); await wait(4);
    assert.equal(d.status, 'cancelled');
    const statuses = readFileSync(lp, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; job: Job }).filter(l => l.type === 'status').map(l => `${l.job.id === a.id ? 'a' : l.job.id === b.id ? 'b' : l.job.id === c.id ? 'c' : 'd'}:${l.job.status}`);
    assert.deepEqual(statuses, ['a:running', 'a:failed', 'b:running', 'b:failed', 'c:running', 'c:cancelled', 'd:running', 'd:cancelled']);
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(rejections, []);
  } finally { process.off('unhandledRejection', onRej); rmSync(root, { recursive: true, force: true }); }
});

test('K04: GET /api/job and /api/job/events serve a custom job from its own logPath', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-jobs-custom-'));
  const app = createStudioServer({ ...cfg, videoRoot: root }); const runner = installJobRoutes(app, { ...cfg, videoRoot: root });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const lp = path.join(root, '.studio', 'seed.jsonl');
    runner.startCustom('seed', lp, async (j, log) => { j.detail.video = 'x'; log({ type: 'progress', folder: 'sd-x' }); await gate; });
    const cur = await (await fetch(`${base}/api/job`)).json() as { job: Job };
    assert.equal(cur.job.kind, 'seed'); assert.equal(cur.job.folder, null); assert.equal(cur.job.status, 'running'); assert.deepEqual(cur.job.detail, { video: 'x' });
    const busy = await fetch(`${base}/api/job`, { method: 'POST', headers: H, body: JSON.stringify({ folder: 'kg-busy-folder', topic: 't', outline: 'o' }) });
    assert.equal(busy.status, 409); await busy.text();
    const ev = await fetch(`${base}/api/job/events`);
    const reader = ev.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    setTimeout(release, 50);
    while (!/"status":"done"/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    await reader.cancel();
    assert.match(buf, /sd-x/); assert.match(buf, /"kind":"seed"/);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
