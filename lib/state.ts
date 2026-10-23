import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ChatMessage = { role: 'user' | 'assistant'; text: string; t: number | null; line: string | null; at: string };
export type VideoState = {
  positionSec: number; watched: boolean; updatedAt: string;
  chat: { sessionId: string | null; messages: ChatMessage[] };
};

export function defaultState(): VideoState {
  return { positionSec: 0, watched: false, updatedAt: new Date().toISOString(), chat: { sessionId: null, messages: [] } };
}

function fileFor(stateDir: string, folder: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(folder)) throw new Error(`bad folder name: ${folder}`);
  return path.join(stateDir, `${folder}.json`);
}

export function loadState(stateDir: string, folder: string): VideoState {
  const f = fileFor(stateDir, folder);
  if (!existsSync(f)) return defaultState();
  const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<VideoState>;
  const d = defaultState();
  return {
    positionSec: raw.positionSec ?? d.positionSec,
    watched: raw.watched ?? d.watched,
    updatedAt: raw.updatedAt ?? d.updatedAt,
    chat: { sessionId: raw.chat?.sessionId ?? null, messages: raw.chat?.messages ?? [] },
  };
}

export function saveState(stateDir: string, folder: string, state: VideoState): void {
  const f = fileFor(stateDir, folder);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, f);
}

export function updateState(stateDir: string, folder: string, patch: Partial<Pick<VideoState, 'positionSec' | 'watched'>>): VideoState {
  const s = loadState(stateDir, folder);
  if (typeof patch.positionSec === 'number' && Number.isFinite(patch.positionSec)) s.positionSec = Math.max(0, patch.positionSec);
  if (typeof patch.watched === 'boolean') s.watched = patch.watched;
  saveState(stateDir, folder, s);
  return loadState(stateDir, folder);
}
