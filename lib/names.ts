export type Kind = 'sd' | 'beh' | 'code' | 'hm' | 'mgr' | 'loop' | 'next' | 'primer' | 'other';

export const KIND_LABELS: Record<Kind, string> = {
  primer: 'Primer', sd: 'System design', beh: 'Behavioral', code: 'Coding',
  hm: 'Hiring manager', mgr: 'Manager round', loop: 'Loop', next: 'Next round', other: 'Other',
};
export const KIND_ORDER: Kind[] = ['primer', 'sd', 'code', 'beh', 'hm', 'mgr', 'loop', 'next', 'other'];

// Filled from studio.config.json (`companies`, `generalSeries`) by loadConfig via configureNames.
// Mutated in place so every importer sees the configured values.
export const COMPANIES: Record<string, string> = {};
export const GENERAL_SERIES = new Set<string>(['basics']);

export function configureNames(cfg: { companies: Record<string, string>; generalSeries: string[] }): void {
  for (const k of Object.keys(COMPANIES)) delete COMPANIES[k];
  Object.assign(COMPANIES, cfg.companies);
  GENERAL_SERIES.clear();
  for (const s of cfg.generalSeries) GENERAL_SERIES.add(s);
}

export type ParsedName = {
  folder: string; series: string; company: string; kind: Kind; nn: string | null; slug: string; unsorted: boolean;
};

const RE = /^([a-z0-9]+)(?:-(sd|beh|code|hm|mgr|loop|next|00))?(?:-(\d{2}[a-z]?))?(?:-(.+))?$/;

export function parseName(folder: string): ParsedName {
  const m = RE.exec(folder);
  const series = m?.[1] ?? '';
  const known = Object.hasOwn(COMPANIES, series) || GENERAL_SERIES.has(series);
  if (!m || !known) {
    return { folder, series: folder, company: 'General', kind: 'other', nn: null, slug: folder, unsorted: true };
  }
  const tok = m[2];
  const kind: Kind = tok === '00' ? 'primer' : tok ? (tok as Kind) : 'other';
  return { folder, series, company: COMPANIES[series] ?? 'General', kind, nn: m[3] ?? null, slug: m[4] ?? '', unsorted: false };
}
