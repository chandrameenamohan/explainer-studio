import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const FOLDER_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

export type BriefFields = { folder: string; topic: string; outline: string; sharedBrief: string | null; extraRules: string; repoRoot: string; videoDir: string; studioDir: string };

export function loadTemplate(studioDir: string): string {
  return readFileSync(path.join(studioDir, 'brief.template.md'), 'utf8');
}

// Each `<briefsDir>/<name>.md` is a shared brief, labelled by its file stem. The path handed to the
// build agent is relative to repoRoot (where the agent runs) when the file is inside it, else absolute.
export function listSharedBriefs(briefsDir: string, repoRoot: string): { path: string; label: string }[] {
  if (!existsSync(briefsDir)) return [];
  const out: { path: string; label: string }[] = [];
  for (const name of readdirSync(briefsDir)) {
    if (!name.endsWith('.md') || name.startsWith('.') || name.toLowerCase() === 'readme.md') continue;
    const f = path.join(briefsDir, name);
    const rel = path.relative(repoRoot, f);
    out.push({ path: rel.startsWith('..') || path.isAbsolute(rel) ? f : rel, label: name.slice(0, -3) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function fillBrief(template: string, f: BriefFields): string {
  const sharedBlock = f.sharedBrief
    ? `## Shared brief\nRead \`${f.sharedBrief}\` first and follow it. It holds the sources, truth rules and template for this series of videos; this prompt only names the folder, topic and outline.`
    : '';
  const values: Record<string, string> = {
    repo_root: f.repoRoot, video_dir: f.videoDir, studio_dir: f.studioDir, folder: f.folder, topic: f.topic.trim(), outline: f.outline.trim(),
    shared_brief_block: sharedBlock, extra_rules: f.extraRules.trim() ? `## Extra rules for this video\n${f.extraRules.trim()}` : '',
  };
  if (/\{\{(?!\w+\}\})/.test(template)) throw new Error('unfilled placeholder remains');
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder {{${key}}}`);
    return values[key];
  });
  return out.replace(/\n{3,}/g, '\n\n');
}
