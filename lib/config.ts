import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNames } from './names.ts';

export type StudioConfig = {
  studioDir: string;
  repoRoot: string;
  videoRoot: string;
  stateDir: string;
  port: number;
  host: string;
  model: string | null;
  claudePath: string | null;
  chatConcurrency: number;
  chatBudgetUsd: number;
  jobBudgetUsd: number;
  knowledgeRoot: string;
  seedModel: string | null;
  seedBudgetUsd: number;
  draftBudgetUsd: number;
  vaultName: string;
  briefsDir: string;
  companies: Record<string, string>;
  generalSeries: string[];
};

export const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type RawConfig = Partial<Omit<StudioConfig, 'studioDir'>>;

export function loadConfig(file?: string): StudioConfig {
  const configFile = file ?? process.env.STUDIO_CONFIG ?? path.join(STUDIO_DIR, 'studio.config.json');
  const base = path.dirname(configFile);
  const raw = JSON.parse(readFileSync(configFile, 'utf8')) as RawConfig;
  const abs = (p: string | undefined, fallback: string) => path.resolve(base, p ?? fallback);
  const config: StudioConfig = {
    studioDir: STUDIO_DIR,
    repoRoot: abs(raw.repoRoot, '.'),
    videoRoot: abs(raw.videoRoot, './videos'),
    stateDir: abs(raw.stateDir, './state'),
    port: raw.port ?? 4310,
    host: raw.host ?? '127.0.0.1',
    model: raw.model ?? null,
    claudePath: raw.claudePath ?? null,
    chatConcurrency: raw.chatConcurrency ?? 2,
    chatBudgetUsd: raw.chatBudgetUsd ?? 0.5,
    jobBudgetUsd: raw.jobBudgetUsd ?? 15,
    knowledgeRoot: abs(raw.knowledgeRoot, './knowledge'),
    seedModel: raw.seedModel === undefined ? 'sonnet' : raw.seedModel,
    seedBudgetUsd: raw.seedBudgetUsd ?? 15,
    draftBudgetUsd: raw.draftBudgetUsd ?? 0.1,
    vaultName: raw.vaultName ?? 'knowledge',
    briefsDir: abs(raw.briefsDir, './briefs'),
    companies: raw.companies ?? {},
    generalSeries: raw.generalSeries ?? ['basics'],
  };
  configureNames(config);
  return config;
}
