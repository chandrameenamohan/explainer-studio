import path from 'node:path';
import type { StudioServer, RouteCtx } from '../server.ts';
import type { StudioConfig } from './config.ts';
import type { Catalog, CatalogRecord } from './catalog.ts';
import type { KnowledgeStore } from './knowledge-index.ts';
import type { JobLog, JobRunner } from './jobs.ts';
import { runAgent } from './agent.ts';
import { json, readJson } from './http.ts';
import { SLUG_RE, companyKey, fmtTime, newConcept, slugify } from './knowledge.ts';

export type SeedItem = { title: string; slug: string; definition: string; quote: string; line: string; related: string[]; why_for_company: string };
export type ValidSeedItem = SeedItem & { t: number | null };
type Existing = { title: string; slug: string; aliases: string[] }[];

const NO_TOOLS = ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

export function buildSeedPrompt(record: CatalogRecord, existing: Existing, companyTitle: string): string {
  const script = record.scenes.flatMap(s => [`Scene: ${s.chip}`, ...s.lines.map(l => `  [${l.key}] @${fmtTime(l.start ?? 0)} ${l.text}`)]);
  const known = existing.map(e => `- ${e.title} (${e.slug})${e.aliases.length ? ` aka ${e.aliases.join(', ')}` : ''}`);
  return [
    '[studio:seed]',
    `Video: ${record.title}`, `Company: ${companyTitle}`, '',
    'Script (each line is [key] @time text):', ...script, '',
    'Concepts already in the vault (reuse these slugs in "related"; do not propose them again under another name):',
    ...(known.length ? known : ['(none)']), '',
    'Pick the 4-8 concepts this video teaches that are worth remembering for an interview at this company.',
    'Reply with JSON only, no prose:',
    '{"concepts":[{"title","slug" (lowercase-hyphen),"definition" (one sentence),"quote" (copied verbatim from ONE script line above, the whole line),"line" (that line\'s key, e.g. "1.0"),"related" (slugs from the existing list only),"why_for_company" (one short clause, or "")}]}',
  ].join('\n');
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()) : []);

/** Extracts the first {...} JSON object (``` fences tolerated); throws on anything that is not { concepts: [{ title, ... }] }. */
export function parseSeedOutput(text: string): SeedItem[] {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) throw new Error('seed: agent returned no JSON');
  let j: unknown;
  try { j = JSON.parse(m[0]); } catch { throw new Error('seed: agent returned invalid JSON'); }
  const concepts = (j as { concepts?: unknown } | null)?.concepts;
  if (!Array.isArray(concepts)) throw new Error('seed: "concepts" is not a list');
  return concepts.map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    if (!str(o.title)) throw new Error(`seed: concept ${i} has no title`);
    return { title: str(o.title), slug: str(o.slug), definition: str(o.definition), quote: str(o.quote), line: str(o.line), related: strs(o.related), why_for_company: str(o.why_for_company) };
  });
}

/** Whitespace collapsed, lower-cased, quote marks and trailing punctuation stripped. */
export const normQuote = (s: string) => s.replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s.,;:!?…-]+$/, '');

export function validateSeedItems(items: SeedItem[], record: CatalogRecord): { ok: ValidSeedItem[]; dropped: { item: SeedItem; reason: string }[] } {
  const lines = record.scenes.flatMap(s => s.lines);
  const ok: ValidSeedItem[] = []; const dropped: { item: SeedItem; reason: string }[] = [];
  for (const item of items) {
    const slug = SLUG_RE.test(item.slug) ? item.slug : slugify(item.title);
    if (!SLUG_RE.test(slug)) { dropped.push({ item, reason: 'no usable slug' }); continue; }
    const q = normQuote(item.quote);
    const hit = q ? lines.find(l => normQuote(l.text) === q) : undefined;
    if (!hit) { dropped.push({ item, reason: 'quote not found in the script' }); continue; }
    const keyed = lines.find(l => l.key === item.line);
    // keep the script's own words, cleaned the way the concept API cleans quotes
    const quote = hit.text.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
    ok.push({ ...item, slug, quote, related: item.related.filter(r => SLUG_RE.test(r)), t: (keyed ?? hit).start });
  }
  return { ok, dropped };
}

export function applySeedItems(store: KnowledgeStore, record: CatalogRecord, items: ValidSeedItem[], company: string): { created: string[]; appended: string[] } {
  const created: string[] = []; const appended: string[] = [];
  // pass 1: decide where each item lands (exact slug, then alias/title match, then a new file), so related links can follow
  const target = new Map<string, string>();
  const plan = items.map(item => {
    let slug = item.slug;
    if (!store.get(slug)) {
      const sim = store.similar(item.title, '')[0];
      if (sim) slug = sim.slug;
      else {
        const clash = store.exists(slug);
        if (clash === 'video' || clash === 'company') slug = `${slug}-concept`;
      }
    }
    target.set(item.slug, slug);
    return { item, slug };
  });
  const batch = new Set(plan.map(p => p.slug).filter(s => SLUG_RE.test(s)));
  const round = (x: number | null) => (x == null ? null : Math.round(x));
  for (const { item, slug } of plan) {
    if (!SLUG_RE.test(slug)) continue;
    const t = item.t == null ? null : Math.floor(item.t);
    const related = [...new Set(item.related.map(r => target.get(r) ?? r).filter(r => r !== slug && (batch.has(r) || store.exists(r) === 'concept')))];
    const cur = store.get(slug);
    if (!cur) {
      store.create(newConcept({
        slug, title: item.title, origin: 'seed', status: 'fuzzy', definition: item.definition,
        sources: [{ folder: record.folder, t, quote: item.quote, raw: '' }],
        companies: [{ company, why: item.why_for_company, raw: '' }],
        related: related.map(to => ({ type: 'related' as const, to, raw: '' })),
      }));
      created.push(slug);
      continue;
    }
    const addSource = !cur.sources.some(s => s.folder === record.folder && round(s.t) === round(t));
    const addCompany = !cur.companies.some(x => x.company === company);
    const addRelated = related.filter(r => !cur.related.some(x => x.to === r));
    if (!addSource && !addCompany && !addRelated.length) continue;
    store.update(slug, c => {
      if (addSource) c.sources.push({ folder: record.folder, t, quote: item.quote, raw: '' });
      if (addCompany) c.companies.push({ company, why: item.why_for_company, raw: '' });
      for (const to of addRelated) c.related.push({ type: 'related', to, raw: '' });
    });
    if (!created.includes(slug) && !appended.includes(slug)) appended.push(slug);
  }
  return { created, appended };
}

export type SeedResult = { seeded: string[]; skipped: string[]; stoppedAt: string | null; costUsd: number };

export async function runSeed(args: {
  config: StudioConfig; store: KnowledgeStore; catalog: Catalog; folders: string[]; log: JobLog; abort: AbortController;
  force?: boolean; onProgress?: (done: number, current: string | null) => void;
}): Promise<SeedResult> {
  const { config, store, catalog, folders, log, abort } = args;
  const out: SeedResult = { seeded: [], skipped: [], stoppedAt: null, costUsd: 0 };
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (abort.signal.aborted) { out.stoppedAt = folder; break; }
    args.onProgress?.(i, folder);
    const skip = (reason: string) => { out.skipped.push(folder); log({ type: 'skip', folder, reason }); args.onProgress?.(i + 1, null); };
    const record = catalog.records.find(r => r.folder === folder);
    if (!record) { skip('not in the catalog'); continue; }
    const idx = store.index();
    if (!args.force && idx.byVideo[folder]?.length) { skip('already seeded'); continue; }
    const key = companyKey(record);
    const companyTitle = idx.companies.find(c => c.key === key)?.title ?? key;
    const existing = idx.concepts.map(c => ({ title: c.title, slug: c.slug, aliases: c.aliases }));
    let text = ''; let cost = 0; let err: string | null = null;
    try {
      for await (const e of runAgent({
        prompt: buildSeedPrompt(record, existing, companyTitle), cwd: config.studioDir, permissionMode: 'dontAsk',
        settingSources: [], allowedTools: [], disallowedTools: NO_TOOLS, maxTurns: 1, maxBudgetUsd: 0.5,
        ...(config.seedModel ? { model: config.seedModel } : {}), ...(config.claudePath ? { claudePath: config.claudePath } : {}), abort,
      })) {
        if (e.type === 'result') { if (e.resultText) text = e.resultText; cost = e.costUsd; if (e.isError) err = e.errors.join('; ') || e.startupFailure || 'agent error'; }
        else if (e.type === 'text') text += e.text;
      }
    } catch (e) { err = (e as Error).message; }
    out.costUsd += cost;
    if (abort.signal.aborted) { out.stoppedAt = folder; break; }
    try {
      if (err) throw new Error(err);
      const { ok, dropped } = validateSeedItems(parseSeedOutput(text), record);
      const { created, appended } = applySeedItems(store, record, ok, key);
      out.seeded.push(folder);
      log({ type: 'video', folder, created, appended, dropped: dropped.map(d => ({ slug: d.item.slug, quote: d.item.quote, reason: d.reason })), costUsd: cost });
    } catch (e) {
      out.skipped.push(folder);
      log({ type: 'video', folder, error: (e as Error).message, created: [], appended: [], dropped: [], costUsd: cost });
    }
    args.onProgress?.(i + 1, null);
    // the cap covers the whole job; stop cleanly and say where to resume
    if (out.costUsd >= config.seedBudgetUsd && i + 1 < folders.length) {
      out.stoppedAt = folders[i + 1];
      log({ type: 'budget', costUsd: out.costUsd, seedBudgetUsd: config.seedBudgetUsd, stoppedAt: out.stoppedAt });
      break;
    }
  }
  return out;
}

export function installSeedRoutes(app: StudioServer, config: StudioConfig, store: KnowledgeStore, runner: JobRunner): void {
  const seededFolders = () => { const by = store.index().byVideo; return app.catalog().records.map(r => r.folder).filter(f => by[f]?.length); };
  app.hooks.extra.push(async (ctx: RouteCtx): Promise<boolean> => {
    const { req, res, url } = ctx; const m = req.method ?? 'GET';
    if (m === 'GET' && url.pathname === '/api/knowledge/seed/status') {
      const done = new Set(seededFolders());
      json(res, 200, { seededFolders: [...done], remaining: app.catalog().records.map(r => r.folder).filter(f => !done.has(f)) });
      return true;
    }
    if (m !== 'POST' || url.pathname !== '/api/knowledge/seed') return false;
    type Body = { folders?: unknown; limit?: unknown; force?: unknown };
    let b: Body;
    // a malformed body must not fall through to "seed every video"
    try { b = await readJson<Body>(req, 262_144); } catch (e) { json(res, 400, { error: (e as Error).message === 'body too large' ? 'body too large' : 'body must be JSON' }); return true; }
    if (!b || typeof b !== 'object' || Array.isArray(b)) { json(res, 400, { error: 'body must be a JSON object' }); return true; }
    const force = b.force === true;
    const all = app.catalog().records.map(r => r.folder);
    let folders: string[];
    if (b.folders !== undefined) {
      if (!Array.isArray(b.folders) || !b.folders.every(f => typeof f === 'string' && all.includes(f))) { json(res, 400, { error: 'folders must be catalog folders' }); return true; }
      folders = [...new Set(b.folders as string[])];
    } else folders = all;
    if (!force) { const done = new Set(seededFolders()); folders = folders.filter(f => !done.has(f)); }
    if (b.limit !== undefined) {
      if (!Number.isInteger(b.limit) || (b.limit as number) < 1) { json(res, 400, { error: 'limit must be a positive integer' }); return true; }
      folders = folders.slice(0, b.limit as number);
    }
    if (!folders.length) { json(res, 400, { error: 'nothing to seed' }); return true; }
    if (runner.current()?.status === 'running') { json(res, 409, { error: 'a job is already running', job: runner.current() }); return true; }
    const job = runner.startCustom('seed', path.join(store.root(), '.studio', 'seed.jsonl'), async (job, log, abort) => {
      job.detail = { total: folders.length, done: 0, current: null };
      const r = await runSeed({
        config, store, catalog: app.catalog(), folders, log, abort, force,
        onProgress: (done, current) => { job.detail = { ...job.detail, done, current }; },
      });
      job.costUsd = r.costUsd;
      job.detail = { ...job.detail, current: null, seeded: r.seeded, skipped: r.skipped, stoppedAt: r.stoppedAt };
      log({ type: 'summary', ...r });
    });
    json(res, 200, { job }); return true;
  });
}
