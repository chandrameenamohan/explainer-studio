import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Catalog } from './catalog.ts';
import type { StudioConfig } from './config.ts';
import {
  SLUG_RE, companyKey, parseCompany, parseConcept, serializeCompany, serializeConcept, slugify, videoStub,
  type CompanyNote, type Concept, type ConceptStatus,
} from './knowledge.ts';
import { COMPANIES, KIND_LABELS } from './names.ts';

export type IndexedConcept = Concept & { file: string; mtimeMs: number; backlinks: string[]; unresolved: string[] };
export type KnowledgeIndex = {
  concepts: IndexedConcept[]; companies: CompanyNote[];
  byVideo: Record<string, string[]>; byCompany: Record<string, string[]>;
  unreadable: { file: string; reason: string }[]; builtAt: string;
};
export type SavedConcept = { slug: string; title: string; status: ConceptStatus; inMyWords: string; definition: string; related: string[]; companies: string[] };
export type KnowledgeError = Error & { code: number; reason: string; suggestion?: string };

const DIRS = ['concepts', 'companies', 'videos'] as const;
const OBSIDIAN_APP = { newFileLocation: 'folder', newFileFolderPath: 'concepts' };

function fail(code: number, reason: string, suggestion?: string): KnowledgeError {
  return Object.assign(new Error(reason), { code, reason, ...(suggestion ? { suggestion } : {}) });
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const tokens = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))].sort().join(' ');
const mdFiles = (dir: string) => { try { return readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')); } catch { return []; } };

export class KnowledgeStore {
  private config: StudioConfig;
  private catalog: () => Catalog;
  private idx: KnowledgeIndex | null = null;
  private seen = '';

  constructor(config: StudioConfig, catalog: () => Catalog) { this.config = config; this.catalog = catalog; }

  root(): string { return this.config.knowledgeRoot; }

  /** Resolve a path under the vault; refuses anything that escapes it. */
  private within(...parts: string[]): string {
    const root = path.resolve(this.root());
    const p = path.resolve(root, ...parts);
    if (!p.startsWith(root + path.sep)) throw fail(400, 'path escapes knowledgeRoot');
    return p;
  }

  private conceptPath(slug: string): string {
    if (!SLUG_RE.test(slug)) throw fail(400, `bad slug: ${slug}`);
    return this.within('concepts', `${slug}.md`);
  }

  private writeAtomic(file: string, text: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  /** Write only when the content differs. Returns true when it wrote. */
  private writeIfChanged(file: string, text: string): boolean {
    try { if (readFileSync(file, 'utf8') === text) return false; } catch { /* missing */ }
    this.writeAtomic(file, text);
    return true;
  }

  private companyKeys(): Set<string> {
    const keys = new Set(this.catalog().records.map(companyKey));
    keys.add('general');
    for (const f of mdFiles(path.join(this.root(), 'companies'))) keys.add(f.slice(0, -3));
    return keys;
  }

  /** Signature over every *.md the index reads: any edit, add or delete changes it (spec B4: stat every file). */
  private stamp(): string {
    let sum = 0; let count = 0;
    for (const d of DIRS) {
      const dir = path.join(this.root(), d);
      for (const f of mdFiles(dir)) {
        try { sum += statSync(path.join(dir, f)).mtimeMs; count++; } catch { /* raced */ }
      }
    }
    return `${count}:${sum}`;
  }

  index(): KnowledgeIndex {
    if (!this.idx) return this.rescan();
    if (this.stamp() !== this.seen) this.build();
    return this.idx!;
  }

  rescan(): KnowledgeIndex {
    this.syncVideoStubs();
    this.ensureCompanyNotes();
    this.ensureObsidianConfig();
    return this.build();
  }

  private syncVideoStubs(): void {
    const dir = this.within('videos');
    const studioUrl = `http://${this.config.host}:${this.config.port}`;
    const keep = new Set<string>();
    for (const r of this.catalog().records) {
      let file: string;
      try { file = this.within('videos', `${r.folder}.md`); } catch { continue; }
      if (path.dirname(file) !== dir) continue;
      keep.add(path.basename(file));
      this.writeIfChanged(file, videoStub(r, studioUrl));
    }
    for (const f of mdFiles(dir)) {
      if (keep.has(f)) continue;
      const file = path.join(dir, f);
      try { if (/^generated: true$/m.test(readFileSync(file, 'utf8'))) unlinkSync(file); } catch { /* leave it */ }
    }
  }

  private ensureCompanyNotes(): void {
    const groups = new Map<string, Catalog['records']>();
    for (const r of this.catalog().records) {
      const k = companyKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const [key, recs] of groups) {
      let file: string;
      try { file = this.within('companies', `${key}.md`); } catch { continue; }
      const rounds = recs.map(r => `- [[${r.folder}]] ${KIND_LABELS[r.kind].toLowerCase()}${r.nn ? ` #${r.nn}` : ''}`).join('\n');
      const roundsSection = `## Rounds\n\n${rounds}\n`;
      if (!existsSync(file)) {
        const named = recs.find(r => r.company && r.company !== 'General')?.company;
        const title = key === 'general' ? 'General' : named ?? COMPANIES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
        this.writeAtomic(file, serializeCompany({ key, title, generated: true, body: `## What they care about\n\n${roundsSection}`, frontmatterExtra: {} }));
        continue;
      }
      let note: CompanyNote;
      try { note = parseCompany(key, readFileSync(file, 'utf8')); } catch { continue; }
      if (!note.generated) continue;
      const m = /^## Rounds[ \t]*$/m.exec(note.body);
      let body: string;
      if (m) {
        const rest = note.body.slice(m.index + m[0].length);
        const next = /^## /m.exec(rest);
        body = note.body.slice(0, m.index) + roundsSection + (next ? `\n${rest.slice(next.index)}` : '');
      } else {
        body = `${note.body.replace(/\n*$/, '\n\n')}${roundsSection}`;
      }
      this.writeIfChanged(file, serializeCompany({ ...note, body }));
    }
  }

  private ensureObsidianConfig(): void {
    const file = this.within('.obsidian', 'app.json');
    if (!existsSync(file)) this.writeAtomic(file, `${JSON.stringify(OBSIDIAN_APP, null, 2)}\n`);
    mkdirSync(this.within('concepts'), { recursive: true }); // where Obsidian puts new notes
  }

  private build(): KnowledgeIndex {
    const started = Date.now();
    const seen = this.stamp(); // taken before reading, so an edit during the build triggers the next one
    const root = this.root();
    const unreadable: KnowledgeIndex['unreadable'] = [];
    const concepts: IndexedConcept[] = [];
    const cdir = path.join(root, 'concepts');
    for (const f of mdFiles(cdir).sort()) {
      const file = path.join(cdir, f);
      const slug = f.slice(0, -3);
      if (!SLUG_RE.test(slug)) { unreadable.push({ file, reason: 'rename to a slug' }); continue; }
      try {
        const mtimeMs = statSync(file).mtimeMs;
        concepts.push({ ...parseConcept(slug, readFileSync(file, 'utf8')), file, mtimeMs, backlinks: [], unresolved: [] });
      } catch (e) { unreadable.push({ file, reason: (e as Error).message }); }
    }
    const companies: CompanyNote[] = [];
    const kdir = path.join(root, 'companies');
    for (const f of mdFiles(kdir).sort()) {
      const file = path.join(kdir, f);
      try { companies.push(parseCompany(f.slice(0, -3), readFileSync(file, 'utf8'))); } catch (e) { unreadable.push({ file, reason: (e as Error).message }); }
    }
    const slugs = new Set(concepts.map(c => c.slug));
    const folders = new Set(this.catalog().records.map(r => r.folder));
    const keys = this.companyKeys();
    const byVideo: Record<string, string[]> = {};
    const byCompany: Record<string, string[]> = {};
    const push = (m: Record<string, string[]>, k: string, slug: string) => { const a = (m[k] ??= []); if (!a.includes(slug)) a.push(slug); };
    const bySlug = new Map(concepts.map(c => [c.slug, c]));
    for (const c of concepts) {
      for (const x of c.sources) push(byVideo, x.folder, c.slug);
      for (const x of c.companies) push(byCompany, x.company, c.slug);
      for (const r of c.related) {
        const t = bySlug.get(r.to);
        if (t && t.slug !== c.slug && !t.backlinks.includes(c.slug)) t.backlinks.push(c.slug);
      }
      const targets = [...c.sources.map(x => x.folder), ...c.companies.map(x => x.company), ...c.related.map(x => x.to)];
      c.unresolved = [...new Set(targets.filter(t => !slugs.has(t) && !folders.has(t) && !keys.has(t)))];
    }
    this.seen = seen;
    this.idx = { concepts, companies, byVideo, byCompany, unreadable, builtAt: new Date(started).toISOString() };
    return this.idx;
  }

  get(slug: string): IndexedConcept | undefined { return this.index().concepts.find(c => c.slug === slug); }

  exists(slug: string): 'concept' | 'video' | 'company' | null {
    if (this.get(slug) || (SLUG_RE.test(slug) && existsSync(this.conceptPath(slug)))) return 'concept';
    if (this.catalog().records.some(r => r.folder === slug)) return 'video';
    if (this.companyKeys().has(slug)) return 'company';
    return null;
  }

  create(c: Concept): IndexedConcept {
    const file = this.conceptPath(c.slug);
    const clash = this.exists(c.slug);
    if (clash === 'concept') throw fail(409, `concept ${c.slug} exists`);
    if (clash) throw fail(409, `${c.slug} is a ${clash} name`, `${c.slug}-concept`);
    this.writeAtomic(file, serializeConcept(c));
    this.build();
    return this.get(c.slug)!;
  }

  update(slug: string, mut: (c: Concept) => void, expectMtimeMs?: number): IndexedConcept {
    const file = this.conceptPath(slug);
    let mtimeMs: number; let text: string;
    try { mtimeMs = statSync(file).mtimeMs; text = readFileSync(file, 'utf8'); } catch { throw fail(404, `no concept ${slug}`); }
    if (expectMtimeMs != null && expectMtimeMs !== mtimeMs) throw fail(409, 'file changed on disk');
    const c = parseConcept(slug, text);
    const wasFuzzy = c.status === 'fuzzy'; const words0 = c.inMyWords;
    mut(c);
    c.slug = slug;
    // B6: only saving new words promotes; an aliases or source edit on a fuzzy note that already has words does not
    if (wasFuzzy && c.status === 'fuzzy' && c.inMyWords.trim() && c.inMyWords !== words0) c.status = 'learning';
    c.updated = today();
    if (statSync(file).mtimeMs !== mtimeMs) throw fail(409, 'file changed on disk');
    this.writeAtomic(file, serializeConcept(c));
    this.build();
    return this.get(slug)!;
  }

  trash(slug: string): string {
    const file = this.conceptPath(slug);
    if (!existsSync(file)) throw fail(404, `no concept ${slug}`);
    const dest = this.within('.trash', `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(file, dest);
    this.build();
    return dest;
  }

  similar(title: string, exclude: string = slugify(title)): IndexedConcept[] {
    const want = tokens(title);
    const slug = slugify(title);
    if (!want) return [];
    return this.index().concepts.filter(c => c.slug !== exclude && (
      tokens(c.title) === want || c.slug === slug
      || c.aliases.some(a => tokens(a) === want || slugify(a) === slug)));
  }

  summaryForVideo(folder: string): SavedConcept[] {
    const idx = this.index();
    const rec = this.catalog().records.find(r => r.folder === folder);
    const slugs = [...new Set([...(idx.byVideo[folder] ?? []), ...(rec ? idx.byCompany[companyKey(rec)] ?? [] : [])])];
    const bySlug = new Map(idx.concepts.map(c => [c.slug, c]));
    return slugs.map(s => bySlug.get(s)!).filter(Boolean).map(c => ({
      slug: c.slug, title: c.title, status: c.status, inMyWords: c.inMyWords, definition: c.definition,
      related: c.related.map(r => r.to), companies: c.companies.map(x => x.company),
    }));
  }
}
