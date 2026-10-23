import type { StudioServer, RouteCtx } from '../server.ts';
import type { StudioConfig } from './config.ts';
import type { CatalogRecord } from './catalog.ts';
import { runAgent } from './agent.ts';
import { readJson, json } from './http.ts';
import { SLUG_RE, companyKey, fmtTime, slugify } from './knowledge.ts';

export type Draft = { title: string; slug: string; definition: string; quote: string; t: number | null; related: string[]; companies: string[] };
type Existing = { title: string; slug: string }[];
/** The part of KnowledgeStore the draft routes need. */
export type DraftStore = { index(): { concepts: Existing } };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function scriptWindow(record: CatalogRecord, t: number | null) {
  const all = record.scenes.flatMap(s => s.lines);
  if (t == null) return all.slice(0, 6);
  let cur = 0;
  all.forEach((l, i) => { if (l.start != null && l.start <= t) cur = i; });
  const from = Math.max(0, Math.min(cur - 3, all.length - 6));
  return all.slice(from, from + 6);
}

export function buildDraftPrompt(record: CatalogRecord, t: number | null, question: string, answer: string, existing: Existing): string {
  const lines = scriptWindow(record, t).map(l => `  [${l.key}] @${fmtTime(l.start ?? 0)} ${l.text}`).join('\n');
  return [
    '[studio:draft]',
    `Video: ${record.title}${t != null ? ` (viewer at @${fmtTime(t)})` : ''}`,
    'Script around that moment:', lines, '',
    `Viewer question: ${question}`, 'Answer given:', answer, '',
    `Existing concept slugs: ${existing.map(e => e.slug).join(', ') || '(none)'}`, '',
    'Draft one concept card for what the answer explains. Reply with JSON only, no prose:',
    '{"title","slug" (lowercase-hyphen),"definition" (one sentence),"quote" (copied verbatim from one script line above, or ""),"line" (that line\'s key, e.g. "0.1", or ""),"related" (existing slugs only),"companies":[]}',
  ].join('\n');
}

function parseJson(text: string): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) throw new Error('draft: agent returned no JSON');
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { throw new Error('draft: agent returned invalid JSON'); }
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function draftFromAnswer(args: { config: StudioConfig; record: CatalogRecord; t: number | null; question: string; answer: string; existing: Existing; abort: AbortController }): Promise<Draft> {
  const { config, record, t, question, answer, existing, abort } = args;
  let out = ''; let err: string | null = null;
  for await (const e of runAgent({
    cwd: config.videoRoot, prompt: buildDraftPrompt(record, t, question, answer, existing), permissionMode: 'dontAsk',
    settingSources: [], allowedTools: [], disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
    maxTurns: 1, maxBudgetUsd: config.draftBudgetUsd,
    ...(config.model ? { model: config.model } : {}), ...(config.claudePath ? { claudePath: config.claudePath } : {}), abort,
  })) {
    if (e.type === 'result') { out = e.resultText ?? out; if (e.isError) err = e.errors.join('; ') || e.startupFailure || 'agent error'; }
    else if (e.type === 'text' && !out) out = e.text;
  }
  if (err) throw new Error(err);
  const j = parseJson(out);
  const title = typeof j.title === 'string' && j.title.trim() ? j.title.trim() : '';
  if (!title) throw new Error('draft: agent returned no title');
  const slug = typeof j.slug === 'string' && SLUG_RE.test(j.slug) ? j.slug : slugify(title);
  const lines = record.scenes.flatMap(s => s.lines);
  const quoteIn = typeof j.quote === 'string' ? j.quote.trim() : '';
  const quote = quoteIn && lines.some(l => norm(l.text).includes(norm(quoteIn))) ? quoteIn : '';
  const ln = typeof j.line === 'string' ? lines.find(l => l.key === j.line) : undefined;
  const slugs = new Set(existing.map(e => e.slug));
  const companies = strs(j.companies).filter(c => SLUG_RE.test(c));
  return {
    title, slug, definition: typeof j.definition === 'string' ? j.definition.trim() : '', quote,
    t: ln?.start != null ? ln.start : t, related: [...new Set(strs(j.related).filter(s => slugs.has(s) && s !== slug))],
    companies: companies.length ? companies : [companyKey(record)],
  };
}

export function installDraftRoutes(app: StudioServer, config: StudioConfig, store: DraftStore): void {
  app.hooks.extra.push(async (ctx: RouteCtx): Promise<boolean> => {
    const { req, res, url } = ctx;
    if (req.method !== 'POST' || url.pathname !== '/api/knowledge/draft') return false;
    type Body = { folder?: unknown; t?: unknown; question?: unknown; answer?: unknown };
    const body = await readJson<Body>(req, 262_144).catch((): Body => ({}));
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!answer) { json(res, 400, { error: 'answer required' }); return true; }
    const record = typeof body.folder === 'string' ? ctx.record(body.folder) : undefined;
    if (!record) { json(res, 404, { error: 'no such video' }); return true; }
    const t = typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : null;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const existing = store.index().concepts.map(c => ({ title: c.title, slug: c.slug }));
      const draft = await draftFromAnswer({ config, record, t, question: typeof body.question === 'string' ? body.question : '', answer, existing, abort });
      json(res, 200, { draft });
    } catch (e) { json(res, 502, { error: (e as Error).message }); }
    return true;
  });
}
