import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from './config.ts';
import type { CatalogRecord, Scene, Line } from './catalog.ts';
import { loadState, saveState } from './state.ts';
import { runAgent, type AgentEvent } from './agent.ts';
import { openSse } from './sse.ts';
import { json, readJson, safeDecode } from './http.ts';
import type { StudioServer, RouteCtx } from '../server.ts';

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const RULES = `You are a tutor for one explainer video the viewer is watching right now. The viewer is preparing for software engineering interviews.
Answer questions about this video's concepts, the design decisions it shows, and how to use them in an interview.
Rules:
- Cite moments as @m:ss (for example @1:32) using the timestamps in the script below, so the viewer can jump there.
- Say plainly when something is not in the script or sources; do not invent facts, numbers, people or outcomes.
- Keep answers short: under 150 words unless the viewer asks for depth. Short sentences, one idea each.
- You may Read explainer.html (the diagram code) or source.md in the current folder when a question needs them. Do not read anything else.
- If the viewer asks for a sayable answer, write it in first person, sayable in under 60 seconds.
- Build on the concepts the viewer already saved (listed at the end, if any). Say so when the viewer's own words conflict with the video.
- When you explain something that is not in the saved list, end with one line: Save this as a concept: <title>`;

export type SavedConcept = { slug: string; title: string; status: string; inMyWords: string; definition: string; related: string[]; companies: string[] };

const SAVED_HEAD = '# What you already saved (your knowledge graph)';
const SAVED_CAP = 6000;

function savedSection(saved: SavedConcept[]): string {
  const out = [SAVED_HEAD]; let len = SAVED_HEAD.length;
  for (let i = 0; i < saved.length; i++) {
    const c = saved[i]!;
    const words = (c.inMyWords || c.definition || '').replace(/\s+/g, ' ').trim();
    let bullet = `- **${c.title}** (${c.status})`;
    if (words) bullet += ` — in your words: "${words}"`;
    if (c.related.length) bullet += ` — related: ${c.related.join(', ')}`;
    if (c.companies.length) bullet += ` — companies: ${c.companies.join(', ')}`;
    const more = `- … and ${saved.length - i} more`;
    const reserve = i < saved.length - 1 ? more.length + 1 : 0;
    if (len + 1 + bullet.length + reserve > SAVED_CAP) { out.push(`- … and ${saved.length - i} more`); break; }
    out.push(bullet); len += 1 + bullet.length;
  }
  return out.join('\n');
}

export function buildSystemPrompt(record: CatalogRecord, sourceMd: string | null, saved: SavedConcept[] = []): string {
  const lines: string[] = [RULES, '', `# Video: ${record.title}`, `Folder: ${record.folder}. Duration: ${record.durationSec ? fmtTime(record.durationSec) : 'unknown'}.`, '', '# Script with timestamps'];
  record.scenes.forEach((s, i) => {
    lines.push('', `## Scene ${i + 1}: ${s.chip}`);
    for (const l of s.lines) lines.push(`  @${l.start == null ? '?:??' : fmtTime(l.start)} ${l.text}`);
  });
  if (sourceMd) lines.push('', '# Sources (source.md)', '', sourceMd);
  if (saved.length) lines.push('', savedSection(saved));
  return lines.join('\n');
}

export function currentLine(record: CatalogRecord, t: number | null): { scene: Scene; line: Line } | null {
  if (t == null) return null;
  let best: { scene: Scene; line: Line } | null = null;
  for (const scene of record.scenes) for (const line of scene.lines) if (line.start != null && line.start <= t) best = { scene, line };
  return best;
}

export function buildUserMessage(record: CatalogRecord, t: number | null, question: string): string {
  const cl = currentLine(record, t);
  const head = t == null ? '[viewer has not started the video]'
    : cl ? `[viewer at @${fmtTime(t)}, scene "${cl.scene.chip}", current line @${fmtTime(cl.line.start ?? t)}: "${cl.line.text}"]`
    : `[viewer at @${fmtTime(t)}]`;
  return `${head}\n${question.trim()}`;
}

export class ChatLimiter {
  #max: number; #active = new Set<string>();
  constructor(max: number) { this.#max = max; }
  tryAcquire(folder: string): 'ok' | 'busy-folder' | 'busy-global' {
    if (this.#active.has(folder)) return 'busy-folder';
    if (this.#active.size >= this.#max) return 'busy-global';
    this.#active.add(folder); return 'ok';
  }
  release(folder: string): void { this.#active.delete(folder); }
}

const CHAT_TOOLS = { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'] };

export async function* runChat(args: { config: StudioConfig; record: CatalogRecord; question: string; t: number | null; abort: AbortController; saved?: SavedConcept[] }): AsyncGenerator<AgentEvent> {
  const { config, record, question, t, abort, saved } = args;
  const dir = path.join(config.videoRoot, record.folder);
  const sourceFile = path.join(dir, 'source.md');
  const systemPrompt = buildSystemPrompt(record, existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8') : null, saved ?? []);
  const state = loadState(config.stateDir, record.folder);
  const cl = currentLine(record, t);
  state.chat.messages.push({ role: 'user', text: question, t, line: cl?.line.key ?? null, at: new Date().toISOString() });
  saveState(config.stateDir, record.folder, state);

  const base = {
    cwd: dir, systemPrompt, permissionMode: 'dontAsk' as const, settingSources: [] as ('user' | 'project' | 'local')[],
    allowedTools: CHAT_TOOLS.allowed, disallowedTools: CHAT_TOOLS.disallowed, maxTurns: 6, maxBudgetUsd: config.chatBudgetUsd,
    ...(config.model ? { model: config.model } : {}), ...(config.claudePath ? { claudePath: config.claudePath } : {}),
    prompt: buildUserMessage(record, t, question), abort,
  };

  const attempt = async function* (resume: string | undefined): AsyncGenerator<AgentEvent> {
    let answer = ''; let sessionId: string | null = null; let sawDelta = false;
    for await (const e of runAgent({ ...base, ...(resume ? { resume } : {}) })) {
      if (e.type === 'init') sessionId = e.sessionId;
      if (e.type === 'delta') { sawDelta = true; answer += e.text; }
      if (e.type === 'text' && !sawDelta) answer += e.text;
      if (e.type === 'result') {
        const failedResume = Boolean(resume) && e.isError && !sawDelta;
        if (failedResume) { yield { type: 'notice', text: 'retry-without-resume' }; return; }
        const s = loadState(config.stateDir, record.folder);
        s.chat.sessionId = e.sessionId ?? sessionId;
        if (answer.trim()) s.chat.messages.push({ role: 'assistant', text: answer.trim(), t, line: cl?.line.key ?? null, at: new Date().toISOString() });
        saveState(config.stateDir, record.folder, s);
        yield { ...e, resultText: answer.trim() || e.resultText };
        return;
      }
      yield e;
    }
  };

  let retry = false;
  for await (const e of attempt(state.chat.sessionId ?? undefined)) {
    if (e.type === 'notice' && e.text === 'retry-without-resume') { retry = true; break; }
    yield e;
  }
  if (retry) {
    yield { type: 'notice', text: 'The earlier conversation could not be resumed; starting a new thread.' };
    yield* attempt(undefined);
  }
}

export function installChatRoutes(app: StudioServer, config: StudioConfig, savedFor?: (folder: string) => SavedConcept[]): void {
  const limiter = new ChatLimiter(config.chatConcurrency);
  app.hooks.extra.push(async (ctx: RouteCtx): Promise<boolean> => {
    const { req, res, url } = ctx;
    const m = /^\/api\/video\/([^/]+)\/chat(\/reset)?$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return false;
    const record = ctx.record(safeDecode(m[1]));
    if (!record) { json(res, 404, { error: 'no such video' }); return true; }
    if (m[2]) {
      const s = loadState(config.stateDir, record.folder); s.chat = { sessionId: null, messages: [] }; saveState(config.stateDir, record.folder, s);
      json(res, 200, { ok: true }); return true;
    }
    type ChatBody = { question?: unknown; t?: unknown };
    const body: ChatBody = await readJson<ChatBody>(req).catch((): ChatBody => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const t = typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : null;
    if (!question) { json(res, 400, { error: 'question required' }); return true; }
    const slot = limiter.tryAcquire(record.folder);
    if (slot === 'busy-folder') { json(res, 409, { error: 'a chat is already running for this video' }); return true; }
    if (slot === 'busy-global') { json(res, 429, { error: `at most ${config.chatConcurrency} chats at once` }); return true; }
    const abort = new AbortController();
    let sse: ReturnType<typeof openSse> | null = null;
    try {
      sse = openSse(res);
      sse.onClose(() => abort.abort());
      for await (const e of runChat({ config, record, question, t, abort, saved: savedFor?.(record.folder) ?? [] })) {
        if (e.type === 'delta') sse.send('delta', { text: e.text });
        else if (e.type === 'tool') sse.send('tool', { name: e.name, path: (e.input as { file_path?: string; pattern?: string })?.file_path ?? (e.input as { pattern?: string })?.pattern ?? '' });
        else if (e.type === 'notice') sse.send('notice', { text: e.text });
        else if (e.type === 'result') {
          if (e.isError) sse.send('error', { message: e.errors.join('; ') || e.startupFailure || 'agent error' });
          sse.send('done', { sessionId: e.sessionId, costUsd: e.costUsd, text: e.resultText ?? '' });
        }
      }
    } catch (e) {
      sse?.send('error', { message: (e as Error).message });
    } finally {
      limiter.release(record.folder);
      sse?.close();
    }
    return true;
  });
}
