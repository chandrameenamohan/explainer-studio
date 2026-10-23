import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from './config.ts';
import { runAgent } from './agent.ts';
import { pickMp4 } from './catalog.ts';
import { fillBrief, loadTemplate, listSharedBriefs, FOLDER_RE } from './brief.ts';
import { openSse } from './sse.ts';
import { json, readJson } from './http.ts';
import type { StudioServer, RouteCtx } from '../server.ts';

// videoRoot as the build agent sees it from repoRoot: relative when inside, absolute otherwise.
function videoDirFor(c: StudioConfig): string {
  const rel = path.relative(c.repoRoot, c.videoRoot);
  return rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? c.videoRoot : rel;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type JobKind = 'create' | 'seed';
export type Job = { id: string; kind: JobKind; folder: string | null; logPath: string; startedAt: string; endedAt: string | null; status: JobStatus; costUsd: number; error: string | null; detail: Record<string, unknown> };
export type JobLog = (entry: Record<string, unknown>) => void;
export type JobWork = (job: Job, log: JobLog, abort: AbortController) => Promise<void>;

export class JobRunner {
  #config: StudioConfig; #onFinished: (job: Job) => void;
  #job: Job | null = null; #abort: AbortController | null = null;
  #listeners = new Set<(line: string) => void>(); #lastIdMs = 0;
  constructor(config: StudioConfig, onFinished: (job: Job) => void) { this.#config = config; this.#onFinished = onFinished; }
  current(): Job | null { return this.#job; }
  /** Log path of a create job for `folder`. */
  logPath(folder: string): string { return path.join(this.#config.videoRoot, folder, 'studio-job.jsonl'); }
  subscribe(listener: (line: string) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #log(job: Job, entry: Record<string, unknown>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(job.logPath, `${line}\n`);
    for (const l of this.#listeners) l(line);
  }
  cancel(): boolean {
    if (!this.#job || this.#job.status !== 'running' || !this.#abort) return false;
    this.#abort.abort(); return true;
  }
  #begin(kind: JobKind, folder: string | null, logPath: string): { job: Job; abort: AbortController } {
    this.#lastIdMs = Math.max(Date.now(), this.#lastIdMs + 1); // ids stay unique when two jobs start in the same ms
    const job: Job = { id: `${kind}-${this.#lastIdMs.toString(36)}`, kind, folder, logPath, startedAt: new Date().toISOString(), endedAt: null, status: 'running', costUsd: 0, error: null, detail: {} };
    const abort = new AbortController();
    this.#job = job; this.#abort = abort;
    this.#log(job, { type: 'status', job });
    return { job, abort };
  }
  #finish(job: Job): void {
    try { this.#log(job, { type: 'status', job }); } catch { /* log file gone; status still final in memory */ }
    try { this.#onFinished(job); } catch { /* a failed rescan must not leave a rejected promise */ }
  }
  #refuseIfRunning(): void { if (this.#job?.status === 'running') throw new Error('a job is already running'); }
  /** Video create job: writes brief.md, runs the agent with bypassPermissions, done only when an mp4 lands. */
  startCreate(folder: string, prompt: string): Job {
    this.#refuseIfRunning();
    const dir = path.join(this.#config.videoRoot, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'brief.md'), prompt);
    const { job, abort } = this.#begin('create', folder, this.logPath(folder));
    void this.#run(job, prompt, abort).catch(() => {}); // #run never rejects; belt and braces
    return job;
  }
  /** Any other job: runs `work`; done when it resolves, failed when it rejects, cancelled when aborted. Never touches videoRoot. */
  startCustom(kind: JobKind, logPath: string, work: JobWork): Job {
    this.#refuseIfRunning();
    mkdirSync(path.dirname(logPath), { recursive: true });
    const { job, abort } = this.#begin(kind, null, logPath);
    const log: JobLog = entry => { try { this.#log(job, entry); } catch { /* logging must not kill the job */ } };
    void (async () => {
      try { await work(job, log, abort); } catch (err) { job.error = err instanceof Error ? err.message : String(err); }
      job.endedAt = new Date().toISOString();
      job.status = abort.signal.aborted ? 'cancelled' : job.error ? 'failed' : 'done';
      this.#finish(job);
    })().catch(() => {});
    return job;
  }
  async #run(job: Job, prompt: string, abort: AbortController): Promise<void> {
    const c = this.#config;
    try {
      for await (const e of runAgent({
        prompt, cwd: c.repoRoot, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
        maxBudgetUsd: c.jobBudgetUsd, abort, env: { ...process.env as Record<string, string> },
        ...(c.model ? { model: c.model } : {}), ...(c.claudePath ? { claudePath: c.claudePath } : {}),
      })) {
        if (e.type === 'raw' || e.type === 'delta') continue;
        if (e.type === 'tool') this.#log(job, { type: 'tool', name: e.name, input: JSON.stringify(e.input ?? '').slice(0, 500) });
        else if (e.type === 'result') { job.costUsd = e.costUsd; this.#log(job, { type: 'result', isError: e.isError, errors: e.errors, costUsd: e.costUsd, text: e.resultText ?? '' }); if (e.isError) job.error = e.errors.join('; ') || e.startupFailure || 'agent error'; }
        else if (e.type === 'init') this.#log(job, { type: 'init', sessionId: e.sessionId, model: e.model });
        else this.#log(job, { type: e.type, text: e.text });
      }
    } catch (err) { job.error = (err as Error).message; }
    const folder = job.folder ?? '';
    const dir = path.join(c.videoRoot, folder);
    let mp4: string | null = null;
    try { mp4 = existsSync(dir) ? pickMp4(folder, readdirSync(dir)) : null; } catch { /* folder vanished */ }
    job.endedAt = new Date().toISOString();
    if (abort.signal.aborted) job.status = 'cancelled';
    else if (mp4) job.status = 'done';
    else { job.status = 'failed'; job.error = job.error ?? 'finished with no mp4 in the folder'; }
    this.#finish(job);
  }
}

export function installJobRoutes(app: StudioServer, config: StudioConfig): JobRunner {
  const runner = new JobRunner(config, () => app.rescan());
  app.hooks.extra.push(async (ctx: RouteCtx): Promise<boolean> => {
    const { req, res, url } = ctx; const p = url.pathname; const m = req.method ?? 'GET';
    if (m === 'GET' && p === '/api/briefs') { json(res, 200, listSharedBriefs(config.briefsDir, config.repoRoot)); return true; }
    if (p === '/api/job' && m === 'GET') { json(res, 200, { job: runner.current() }); return true; }
    if (p === '/api/job' && m === 'DELETE') { json(res, runner.cancel() ? 200 : 409, { job: runner.current() }); return true; }
    if (p === '/api/job' && m === 'POST') {
      type CreateBody = { folder?: unknown; topic?: unknown; outline?: unknown; sharedBrief?: unknown; extraRules?: unknown };
      const b = await readJson<CreateBody>(req).catch((): CreateBody => ({}));
      const folder = typeof b.folder === 'string' ? b.folder.trim() : '';
      const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
      const outline = typeof b.outline === 'string' ? b.outline.trim() : '';
      const sharedBrief = typeof b.sharedBrief === 'string' && b.sharedBrief ? b.sharedBrief : null;
      const extraRules = typeof b.extraRules === 'string' ? b.extraRules : '';
      if (!FOLDER_RE.test(folder) || !topic || !outline) { json(res, 400, { error: 'folder (a-z0-9-, 3 to 61 chars), topic and outline are required' }); return true; }
      if (sharedBrief && !listSharedBriefs(config.briefsDir, config.repoRoot).some(x => x.path === sharedBrief)) { json(res, 400, { error: 'unknown shared brief' }); return true; }
      const dir = path.join(config.videoRoot, folder);
      if (existsSync(dir) && pickMp4(folder, readdirSync(dir))) { json(res, 409, { error: 'that folder already has a rendered video' }); return true; }
      if (runner.current()?.status === 'running') { json(res, 409, { error: 'a job is already running', job: runner.current() }); return true; }
      const prompt = fillBrief(loadTemplate(config.studioDir), { folder, topic, outline, sharedBrief, extraRules, repoRoot: config.repoRoot, videoDir: videoDirFor(config), studioDir: config.studioDir });
      const job = runner.startCreate(folder, prompt);
      app.rescan();
      json(res, 200, { job }); return true;
    }
    if (p === '/api/job/retry' && m === 'POST') {
      const b = await readJson<{ folder?: unknown }>(req).catch((): { folder?: unknown } => ({}));
      const folder = typeof b.folder === 'string' ? b.folder.trim() : '';
      const dir = path.join(config.videoRoot, folder);
      if (!FOLDER_RE.test(folder) || !existsSync(path.join(dir, 'brief.md'))) { json(res, 400, { error: 'no brief.md to retry from' }); return true; }
      if (pickMp4(folder, readdirSync(dir))) { json(res, 409, { error: 'that folder already has a rendered video' }); return true; }
      if (runner.current()?.status === 'running') { json(res, 409, { error: 'a job is already running', job: runner.current() }); return true; }
      const job = runner.startCreate(folder, readFileSync(path.join(dir, 'brief.md'), 'utf8'));
      json(res, 200, { job }); return true;
    }
    if (p === '/api/job/events' && m === 'GET') {
      const sse = openSse(res);
      const cur = runner.current();
      if (cur && existsSync(cur.logPath)) for (const line of readFileSync(cur.logPath, 'utf8').trim().split('\n').filter(Boolean)) sse.send('line', { line });
      sse.send('status', { job: cur });
      const off = runner.subscribe(line => { sse.send('line', { line }); if (line.includes('"type":"status"')) sse.send('status', { job: runner.current() }); });
      sse.onClose(off);
      return true;
    }
    return false;
  });
  return runner;
}
