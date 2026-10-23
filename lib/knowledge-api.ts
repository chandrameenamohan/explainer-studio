import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { StudioServer, RouteCtx } from '../server.ts';
import type { StudioConfig } from './config.ts';
import { json, text, readJson, safeDecode } from './http.ts';
import { EDGE_TYPES, SLUG_RE, companyKey, newConcept, slugify, type Concept, type ConceptStatus, type EdgeType } from './knowledge.ts';
import type { KnowledgeError, KnowledgeStore } from './knowledge-index.ts';
import { COMPANIES } from './names.ts';

const STATUSES = ['fuzzy', 'learning', 'known'];
const MAX_WORDS = 20_000;
const BODY_LIMIT = 262_144;

class Bad extends Error {}
const bad = (m: string): never => { throw new Bad(m); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown, name: string, max = 2000): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return bad(`${name} must be a string`);
  const s = v.trim();
  if (s.length > max) return bad(`${name} too long`);
  return s;
};

export function installConceptRoutes(app: StudioServer, config: StudioConfig, store: KnowledgeStore): void {
  const page = (res: RouteCtx['res'], name: string) => {
    const f = path.join(config.studioDir, 'public', name);
    if (!existsSync(f)) return text(res, 404, 'page missing');
    return text(res, 200, readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
  };
  const folders = () => new Set(app.catalog().records.map(r => r.folder));
  const companyKeys = () => new Set(app.catalog().records.map(companyKey).concat('general'));
  const companiesInCatalog = () => {
    const idx = store.index();
    return [...companyKeys()].sort().map(key => ({ key, title: idx.companies.find(c => c.key === key)?.title ?? (key === 'general' ? 'General' : COMPANIES[key] ?? key) }));
  };
  const titles = () => Object.fromEntries(app.catalog().records.map(r => [r.folder, r.title]));
  const kinds = () => Object.fromEntries(app.catalog().records.map(r => [r.folder, r.kind]));

  const summary = () => {
    const idx = store.index();
    return {
      concepts: idx.concepts.map(({ otherSections: _o, ...c }) => c), companies: idx.companies,
      byVideo: idx.byVideo, byCompany: idx.byCompany, unreadable: idx.unreadable, builtAt: idx.builtAt,
      companiesInCatalog: companiesInCatalog(), videoKinds: kinds(), sourceTitles: titles(), vaultName: config.vaultName,
    };
  };

  const source = (v: unknown, name: string, needQuote: boolean) => {
    if (!isObj(v)) return bad(`${name} must be an object`);
    const folder = optStr(v.folder, `${name}.folder`) ?? '';
    if (!folders().has(folder)) bad(`${name}.folder is not a known video`);
    let t: number | null = null;
    if (v.t != null) { if (typeof v.t !== 'number' || !Number.isFinite(v.t) || v.t < 0) bad(`${name}.t must be a number`); t = Math.round(v.t as number); }
    const quote = needQuote ? (optStr(v.quote, `${name}.quote`, 1000) ?? '').replace(/\s+/g, ' ').replace(/"/g, "'") : '';
    return { folder, t, quote, raw: '' };
  };
  const companyRef = (v: unknown, name: string) => {
    if (!isObj(v)) return bad(`${name} must be an object`);
    const company = optStr(v.company, `${name}.company`) ?? '';
    if (!companyKeys().has(company)) bad(`${name}.company is not a known company`);
    return { company, why: (optStr(v.why, `${name}.why`, 500) ?? '').replace(/\s+/g, ' '), raw: '' };
  };
  const edge = (v: unknown, name: string) => {
    if (!isObj(v)) return bad(`${name} must be an object`);
    if (!EDGE_TYPES.includes(v.type as EdgeType)) bad(`${name}.type must be one of ${EDGE_TYPES.join(', ')}`);
    const to = optStr(v.to, `${name}.to`) ?? '';
    if (!SLUG_RE.test(to)) bad(`${name}.to must be a slug`);
    return { type: v.type as EdgeType, to, raw: '' };
  };
  const arr = <T>(v: unknown, name: string, f: (x: unknown, n: string) => T): T[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return bad(`${name} must be an array`);
    return v.map((x, i) => f(x, `${name}[${i}]`));
  };
  const status = (v: unknown): ConceptStatus | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !STATUSES.includes(v)) return bad('status must be fuzzy, learning or known');
    return v as ConceptStatus;
  };
  const words = (v: unknown) => optStr(v, 'inMyWords', MAX_WORDS);
  const aliases = (v: unknown) => arr(v, 'aliases', (x, n) => optStr(x, n, 200) ?? '')?.filter(Boolean);
  const sameSource = (a: { folder: string; t: number | null }, b: { folder: string; t: number | null }) =>
    a.folder === b.folder && (a.t == null ? null : Math.round(a.t)) === (b.t == null ? null : Math.round(b.t));

  const full = (slug: string) => {
    const c = store.get(slug)!;
    return {
      concept: c, markdown: readFileSync(c.file, 'utf8'),
      similar: store.similar(c.title, c.slug).map(s => ({ slug: s.slug, title: s.title })),
      obsidianUrl: `obsidian://open?vault=${encodeURIComponent(config.vaultName)}&file=${encodeURIComponent(`concepts/${slug}`)}`,
      sourceTitles: titles(), videoKinds: kinds(), vaultName: config.vaultName,
    };
  };

  app.hooks.extra.push(async (ctx: RouteCtx): Promise<boolean> => {
    const { req, res, url } = ctx; const p = url.pathname; const m = req.method ?? 'GET';
    let mm: RegExpExecArray | null;
    if (m === 'GET' && p === '/knowledge') { page(res, 'knowledge.html'); return true; }
    if (m === 'GET' && (mm = /^\/k\/([^/]+)$/.exec(p))) {
      const slug = safeDecode(mm[1]);
      if (!SLUG_RE.test(slug) || !store.get(slug)) { text(res, 404, 'no such concept'); return true; }
      page(res, 'concept.html'); return true;
    }
    if (!p.startsWith('/api/knowledge')) return false;
    const body = async (): Promise<Record<string, unknown>> => {
      let b: unknown;
      try { b = await readJson<unknown>(req, BODY_LIMIT); } catch (e) { return bad((e as Error).message === 'body too large' ? 'body too large' : 'body must be JSON'); }
      return isObj(b) ? b : bad('body must be a JSON object');
    };
    try {
      if (m === 'GET' && p === '/api/knowledge') { json(res, 200, summary()); return true; }
      if (m === 'POST' && p === '/api/knowledge/rescan') { store.rescan(); json(res, 200, summary()); return true; }
      if (m === 'POST' && p === '/api/knowledge/concepts') {
        const b = await body();
        const title = optStr(b.title, 'title', 200) ?? '';
        if (!title) bad('title required');
        const slug = optStr(b.slug, 'slug') ?? slugify(title);
        if (!SLUG_RE.test(slug)) bad('slug must match a-z0-9 and dashes, 2 to 61 chars');
        const inMyWords = words(b.inMyWords) ?? '';
        const st = status(b.status);
        if (b.origin !== undefined && b.origin !== 'manual' && b.origin !== 'seed') bad('origin must be manual or seed');
        const c: Concept = newConcept({
          slug, title, inMyWords, status: st ?? (inMyWords ? 'learning' : 'fuzzy'), origin: (b.origin as 'manual' | 'seed' | undefined) ?? 'manual',
          definition: optStr(b.definition, 'definition', 1000) ?? '', aliases: aliases(b.aliases) ?? [],
          sources: arr(b.sources, 'sources', (x, n) => source(x, n, true)) ?? [],
          companies: arr(b.companies, 'companies', companyRef) ?? [], related: arr(b.related, 'related', edge) ?? [],
        });
        json(res, 201, { concept: store.create(c) }); return true;
      }
      if ((mm = /^\/api\/knowledge\/concepts\/([^/]+)$/.exec(p))) {
        const slug = safeDecode(mm[1]);
        if (!SLUG_RE.test(slug) || !store.get(slug)) { json(res, 404, { error: 'no such concept' }); return true; }
        if (m === 'GET') { json(res, 200, full(slug)); return true; }
        if (m === 'DELETE') { json(res, 200, { trashed: store.trash(slug) }); return true; }
        if (m === 'PATCH') {
          const b = await body();
          const w = words(b.inMyWords); const st = status(b.status);
          const title = optStr(b.title, 'title', 200); if (title === '') bad('title cannot be empty');
          const al = aliases(b.aliases);
          const addSource = b.addSource === undefined ? undefined : source(b.addSource, 'addSource', true);
          const removeSource = b.removeSource === undefined ? undefined : source(b.removeSource, 'removeSource', false);
          const addCompany = b.addCompany === undefined ? undefined : companyRef(b.addCompany, 'addCompany');
          const removeCompany = optStr(b.removeCompany, 'removeCompany');
          const addRelated = b.addRelated === undefined ? undefined : edge(b.addRelated, 'addRelated');
          const removeRelated = b.removeRelated === undefined ? undefined : edge(b.removeRelated, 'removeRelated');
          if (b.expectMtimeMs !== undefined && typeof b.expectMtimeMs !== 'number') bad('expectMtimeMs must be a number');
          const c = store.update(slug, c => {
            if (w !== undefined) c.inMyWords = w;
            if (st) c.status = st;
            if (title) c.title = title;
            if (al) c.aliases = al;
            if (removeSource) c.sources = c.sources.filter(s => !sameSource(s, removeSource));
            if (addSource && !c.sources.some(s => sameSource(s, addSource))) c.sources.push(addSource);
            if (removeCompany) c.companies = c.companies.filter(x => x.company !== removeCompany);
            if (addCompany && !c.companies.some(x => x.company === addCompany.company)) c.companies.push(addCompany);
            if (removeRelated) c.related = c.related.filter(r => !(r.type === removeRelated.type && r.to === removeRelated.to));
            if (addRelated && !c.related.some(r => r.type === addRelated.type && r.to === addRelated.to)) c.related.push(addRelated);
          }, b.expectMtimeMs as number | undefined);
          json(res, 200, { concept: c }); return true;
        }
      }
    } catch (e) {
      if (e instanceof Bad) { json(res, 400, { error: e.message }); return true; }
      const k = e as KnowledgeError;
      if (typeof k.code === 'number') {
        const existing = k.code === 409 && /^concept .* exists$/.test(k.reason) ? (e as Error).message.replace(/^concept (.*) exists$/, '$1') : undefined;
        json(res, k.code, { error: k.reason, ...(existing ? { existing } : {}), ...(k.suggestion ? { suggestion: k.suggestion } : {}) }); return true;
      }
      throw e;
    }
    return false;
  });
}
