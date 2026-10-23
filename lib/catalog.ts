import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseName, KIND_ORDER, type Kind, type ParsedName } from './names.ts';

export type Line = { key: string; text: string; start: number | null; end: number | null };
export type Scene = { chip: string; start: number | null; end: number | null; lines: Line[] };
export type CatalogRecord = ParsedName & {
  title: string; durationSec: number | null; mp4: string | null;
  hasSource: boolean; hasBrief: boolean; mtime: number; scenes: Scene[];
};
export type Overrides = Record<string, { company?: string; kind?: Kind; title?: string; hidden?: boolean }>;
export type Catalog = { records: CatalogRecord[]; unreadable: { folder: string; reason: string }[]; builtAt: string };

type TimelineJson = { title?: string; duration?: number; scenes?: { chip?: string; start?: number; end?: number; lines?: { text?: string; start?: number; end?: number }[] }[] };
type ScriptJson = { title?: string; scenes?: { chip?: string; lines?: { text?: string }[] }[] };

export function pickMp4(folder: string, files: string[]): string | null {
  const visible = files.filter(f => f.endsWith('.mp4') && !f.startsWith('.'));
  if (visible.includes(`${folder}-explainer.mp4`)) return `${folder}-explainer.mp4`;
  if (visible.includes(`${folder}.mp4`)) return `${folder}.mp4`;
  return visible.length === 1 ? visible[0] : null;
}

export function loadOverrides(file: string): Overrides {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Overrides;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function scenesFromTimeline(t: TimelineJson): Scene[] {
  return (t.scenes ?? []).map((s, si) => ({
    chip: s.chip ?? '', start: s.start ?? null, end: s.end ?? null,
    lines: (s.lines ?? []).map((l, li) => ({ key: `${si}.${li}`, text: l.text ?? '', start: l.start ?? null, end: l.end ?? null })),
  }));
}

function scenesFromScript(s: ScriptJson): Scene[] {
  return (s.scenes ?? []).map((sc, si) => ({
    chip: sc.chip ?? '', start: null, end: null,
    lines: (sc.lines ?? []).map((l, li) => ({ key: `${si}.${li}`, text: l.text ?? '', start: null, end: null })),
  }));
}

export function readRecord(videoRoot: string, folder: string, overrides: Overrides): CatalogRecord | null {
  const dir = path.join(videoRoot, folder);
  const st = statSync(dir); // throws if missing
  if (!st.isDirectory()) throw new Error('not a directory');
  const files = readdirSync(dir);
  const timeline = readJson<TimelineJson>(path.join(dir, 'timeline.json'));
  const script = timeline ? null : readJson<ScriptJson>(path.join(dir, 'script.json'));
  const hasBrief = files.includes('brief.md');
  if (!timeline && !script && !hasBrief) throw new Error('no timeline.json, script.json or brief.md');
  const o = overrides[folder] ?? {};
  if (o.hidden) return null;
  const parsed = parseName(folder);
  const scenes = timeline ? scenesFromTimeline(timeline) : script ? scenesFromScript(script) : [];
  const title = o.title ?? timeline?.title ?? script?.title ?? folder;
  return {
    ...parsed,
    unsorted: parsed.unsorted && !o.company && !o.kind,
    company: o.company ?? parsed.company,
    kind: o.kind ?? parsed.kind,
    title,
    durationSec: timeline?.duration ?? null,
    mp4: pickMp4(folder, files),
    hasSource: files.includes('source.md'),
    hasBrief,
    mtime: st.mtimeMs,
    scenes,
  };
}

export function sortKey(r: ParsedName): string {
  const k = String(KIND_ORDER.indexOf(r.kind)).padStart(2, '0');
  return `${r.unsorted ? 'zz' : r.series}|${k}|${r.nn ?? '99'}|${r.slug}`;
}

export function buildCatalog(videoRoot: string, overrides: Overrides): Catalog {
  const records: CatalogRecord[] = [];
  const unreadable: Catalog['unreadable'] = [];
  for (const name of readdirSync(videoRoot)) {
    if (name.startsWith('.')) continue;
    let st; try { st = statSync(path.join(videoRoot, name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    try {
      const r = readRecord(videoRoot, name, overrides);
      if (r) records.push(r);
    } catch (e) {
      unreadable.push({ folder: name, reason: (e as Error).message });
    }
  }
  records.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return { records, unreadable, builtAt: new Date().toISOString() };
}
