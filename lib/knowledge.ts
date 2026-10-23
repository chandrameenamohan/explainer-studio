import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { CatalogRecord } from './catalog.ts';
import { COMPANIES, GENERAL_SERIES } from './names.ts';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const EDGE_TYPES = ['prerequisite', 'contrast', 'example', 'part-of', 'related'] as const;
export type EdgeType = typeof EDGE_TYPES[number];
export type ConceptStatus = 'fuzzy' | 'learning' | 'known';
export type Source = { folder: string; t: number | null; quote: string; raw: string };
export type CompanyRef = { company: string; why: string; raw: string };
export type Related = { type: EdgeType; to: string; raw: string };
export type Concept = {
  slug: string; title: string; aliases: string[]; tags: string[]; status: ConceptStatus; origin: 'seed' | 'manual';
  definition: string; created: string; updated: string; inMyWords: string;
  sources: Source[]; companies: CompanyRef[]; related: Related[];
  extra: { sources: string[]; companies: string[]; related: string[] };
  otherSections: string;
  frontmatterExtra: Record<string, unknown>;
};
export type CompanyNote = { key: string; title: string; generated: boolean; body: string; frontmatterExtra: Record<string, unknown> };

const STATUSES: ConceptStatus[] = ['fuzzy', 'learning', 'known'];
const CONCEPT_KEYS = new Set(['title', 'aliases', 'tags', 'status', 'origin', 'definition', 'created', 'updated']);
const COMPANY_KEYS = new Set(['title', 'kind', 'generated']);
const HEADINGS = { words: 'In my words', sources: 'From the videos', companies: 'Companies', related: 'Related' } as const;
type SectionId = keyof typeof HEADINGS;
const HEADING_IDS: Record<string, SectionId> = { 'in my words': 'words', 'from the videos': 'sources', companies: 'companies', related: 'related' };
const SOURCE_RE = /^- (\[\[[^\]]+\]\])(?: @(\d+):(\d\d))?(?: — "(.*)")?$/;
const COMPANY_RE = /^- (\[\[[^\]]+\]\])(?: — (.*))?$/;
const RELATED_RE = /^- (prerequisite|contrast|example|part-of|related): (\[\[[^\]]+\]\])$/;
const YAML_OPTS = { lineWidth: 0 } as const;

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61).replace(/-+$/, '');
}

export function parseLink(text: string): string | null {
  const m = /^\[\[([^\]]*)\]\]$/.exec(text.trim());
  if (!m) return null;
  const target = m[1].split('|')[0].split('#')[0].trim();
  const last = target.split('/').filter(Boolean).at(-1) ?? '';
  return last || null;
}

export function companyKey(r: Pick<CatalogRecord, 'series' | 'unsorted'>): string {
  // series is a company only when names.ts knows it; override-only folders (company: General) fall back to general
  return r.unsorted || !(Object.hasOwn(COMPANIES, r.series) || GENERAL_SERIES.has(r.series)) ? 'general' : r.series;
}

function splitFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  const text = md.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new Error('no frontmatter');
  const end = text.indexOf('\n---', 3);
  if (end < 0 || (text[end + 4] !== undefined && text[end + 4] !== '\n')) throw new Error('no frontmatter');
  const raw = text.slice(4, end + 1);
  const fm = yamlParse(raw) as unknown;
  if (fm != null && (typeof fm !== 'object' || Array.isArray(fm))) throw new Error('frontmatter is not a map');
  return { fm: (fm ?? {}) as Record<string, unknown>, body: text.slice(end + 5) };
}

const str = (v: unknown, d = ''): string => (v == null ? d : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.filter(x => x != null).map(x => str(x)) : [str(v)]);
const extras = (fm: Record<string, unknown>, known: Set<string>) => Object.fromEntries(Object.entries(fm).filter(([k]) => !known.has(k)));

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseConcept(slug: string, md: string): Concept {
  const { fm, body } = splitFrontmatter(md);
  const status = STATUSES.includes(fm.status as ConceptStatus) ? (fm.status as ConceptStatus) : 'fuzzy';
  const c: Concept = {
    slug, title: str(fm.title).trim() || slug, aliases: list(fm.aliases), tags: list(fm.tags), status,
    origin: fm.origin === 'seed' ? 'seed' : 'manual', definition: str(fm.definition),
    created: str(fm.created), updated: str(fm.updated), inMyWords: '',
    sources: [], companies: [], related: [], extra: { sources: [], companies: [], related: [] },
    otherSections: '', frontmatterExtra: extras(fm, CONCEPT_KEYS),
  };
  // chunk the body on level-2 headings
  const chunks: { id: SectionId | null; heading: string | null; lines: string[] }[] = [{ id: null, heading: null, lines: [] }];
  for (const line of body.split('\n')) {
    const h = /^## (.*)$/.exec(line);
    if (h) chunks.push({ id: HEADING_IDS[h[1].trim().toLowerCase()] ?? null, heading: line, lines: [] });
    else chunks.at(-1)!.lines.push(line);
  }
  const other: string[] = [];
  const words: string[] = [];
  for (const ch of chunks) {
    if (!ch.id) {
      const t = (ch.heading ? [ch.heading, ...ch.lines] : ch.lines).join('\n');
      const v = ch.heading ? t.trimEnd() : t.trim();
      if (v) other.push(v);
      continue;
    }
    if (ch.id === 'words') { words.push(ch.lines.join('\n').trim()); continue; }
    for (const line of ch.lines) {
      const l = line.trim();
      if (!l) continue;
      if (ch.id === 'sources') {
        const m = SOURCE_RE.exec(l); const folder = m && parseLink(m[1]);
        if (m && folder) { c.sources.push({ folder, t: m[2] ? Number(m[2]) * 60 + Number(m[3]) : null, quote: m[4] ?? '', raw: m[1] }); continue; }
      } else if (ch.id === 'companies') {
        const m = COMPANY_RE.exec(l); const company = m && parseLink(m[1]);
        if (m && company) { c.companies.push({ company, why: (m[2] ?? '').trim(), raw: m[1] }); continue; }
      } else {
        const m = RELATED_RE.exec(l); const to = m && parseLink(m[2]);
        if (m && to) { c.related.push({ type: m[1] as EdgeType, to, raw: m[2] }); continue; }
      }
      c.extra[ch.id].push(line.trimEnd());
    }
  }
  c.inMyWords = words.filter(Boolean).join('\n\n');
  c.otherSections = other.join('\n\n');
  return c;
}

const link = (raw: string, target: string) => (raw && parseLink(raw) === target ? raw : `[[${target}]]`);

export function serializeConcept(c: Concept): string {
  const fm: Record<string, unknown> = {
    title: c.title, aliases: c.aliases, tags: c.tags, status: c.status, origin: c.origin,
    definition: c.definition, created: c.created, updated: c.updated,
  };
  for (const [k, v] of Object.entries(c.frontmatterExtra)) if (!CONCEPT_KEYS.has(k)) fm[k] = v;
  const section = (id: SectionId, lines: string[]) => `## ${HEADINGS[id]}\n\n${lines.length ? `${lines.join('\n')}\n\n` : ''}`;
  const sources = c.sources.map(s => `- ${link(s.raw, s.folder)}${s.t != null ? ` @${fmtTime(s.t)}` : ''}${s.quote ? ` — "${s.quote}"` : ''}`);
  const companies = c.companies.map(x => `- ${link(x.raw, x.company)}${x.why ? ` — ${x.why}` : ''}`);
  const related = c.related.map(r => `- ${r.type}: ${link(r.raw, r.to)}`);
  // free text that came before the first heading stays before it; other sections go last
  const other = c.otherSections.trim();
  const cut = other.startsWith('## ') ? 0 : (/^## /m.exec(other)?.index ?? other.length);
  const pre = other.slice(0, cut).trim();
  const post = other.slice(cut).trim();
  const body = (pre ? `${pre}\n\n` : '')
    + section('words', c.inMyWords.trim() ? [c.inMyWords.trim()] : [])
    + section('sources', [...sources, ...c.extra.sources])
    + section('companies', [...companies, ...c.extra.companies])
    + section('related', [...related, ...c.extra.related])
    + (post ? `${post}\n` : '');
  return `---\n${yamlStringify(fm, YAML_OPTS)}---\n${body.replace(/\n+$/, '\n')}`;
}

export function newConcept(init: Partial<Concept> & { slug: string; title: string }): Concept {
  if (!SLUG_RE.test(init.slug)) throw new Error(`bad slug: ${init.slug}`);
  const d = today();
  return {
    aliases: [], tags: ['concept'], status: 'fuzzy', origin: 'manual', definition: '', created: d, updated: d, inMyWords: '',
    sources: [], companies: [], related: [], extra: { sources: [], companies: [], related: [] }, otherSections: '', frontmatterExtra: {},
    ...init,
  };
}

export function parseCompany(key: string, md: string): CompanyNote {
  const { fm, body } = splitFrontmatter(md);
  return { key, title: str(fm.title).trim() || key, generated: fm.generated === true, body, frontmatterExtra: extras(fm, COMPANY_KEYS) };
}

export function serializeCompany(n: CompanyNote): string {
  const fm: Record<string, unknown> = { title: n.title, kind: 'company', generated: n.generated };
  for (const [k, v] of Object.entries(n.frontmatterExtra)) if (!COMPANY_KEYS.has(k)) fm[k] = v;
  return `---\n${yamlStringify(fm, YAML_OPTS)}---\n${n.body}`;
}

export function videoStub(r: CatalogRecord, studioUrl: string): string {
  const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
  const chips = r.scenes.map(s => s.chip.trim()).filter(Boolean);
  return [
    '---',
    `title: ${q(r.title)}`,
    `company: ${companyKey(r)}`,
    `kind: ${r.kind}`,
    ...(r.durationSec != null ? [`duration: ${q(fmtTime(r.durationSec))}`] : []),
    `studio: ${studioUrl.replace(/\/+$/, '')}/v/${encodeURIComponent(r.folder)}`,
    'generated: true',
    '---',
    ...(chips.length ? [`Scenes: ${chips.join(' · ')}`] : []),
    '',
  ].join('\n');
}
