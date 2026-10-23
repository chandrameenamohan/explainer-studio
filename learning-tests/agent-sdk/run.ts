// Real SDK probe. Run by hand: make learn. Spends a few cents on the Claude login.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../../lib/config.ts';
import { runAgent, type AgentEvent } from '../../lib/agent.ts';

delete process.env.STUDIO_FAKE_AGENT;
const cfg = loadConfig();
const cwd = path.join(cfg.videoRoot, 'sd-model-serving');
const common = {
  cwd, permissionMode: 'dontAsk' as const, settingSources: [] as ('user' | 'project' | 'local')[],
  allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
  maxTurns: 4, maxBudgetUsd: cfg.chatBudgetUsd, ...(cfg.model ? { model: cfg.model } : {}), ...(cfg.claudePath ? { claudePath: cfg.claudePath } : {}),
  systemPrompt: 'You are a terse tutor. Answer in one sentence. The user is watching a video whose script is in script.json in the current folder; you may Read it.',
};
const log: string[] = [];
const record = (label: string, e: AgentEvent) => { if (e.type !== 'raw') log.push(`${label}: ${JSON.stringify(e).slice(0, 400)}`); else if (log.filter(l => l.startsWith(`${label}: raw`)).length < 3) log.push(`${label}: raw ${JSON.stringify(e.message).slice(0, 600)}`); };

let sessionId: string | null = null; let first = '';
for await (const e of runAgent({ ...common, prompt: 'What is the one hard part of this design, in one sentence?', abort: new AbortController() })) {
  record('A', e); if (e.type === 'init') sessionId = e.sessionId; if (e.type === 'delta') first += e.text;
  if (e.type === 'result') { console.log('A result', e.isError, e.costUsd, e.errors, e.startupFailure); }
}
console.log('A answer:', first.trim());
if (!sessionId) throw new Error('ASSUMPTION FAILED: no session id from init message');

let second = '';
for await (const e of runAgent({ ...common, prompt: 'Repeat the question I asked you a moment ago, in quotes.', resume: sessionId, abort: new AbortController() })) {
  record('B', e); if (e.type === 'delta') second += e.text;
  if (e.type === 'result') console.log('B result', e.isError, e.costUsd, e.errors, e.startupFailure, 'same session:', e.sessionId === sessionId);
}
console.log('B answer:', second.trim());
const resumedOk = /hard part/i.test(second);
console.log('resume carried context:', resumedOk);

let bad = '';
for await (const e of runAgent({ ...common, prompt: 'hello', resume: '00000000-0000-0000-0000-000000000000', abort: new AbortController() })) {
  record('C', e); if (e.type === 'result') { bad = `isError=${e.isError} startupFailure=${e.startupFailure} errors=${e.errors.join('|')}`; }
}
console.log('C bogus resume:', bad);

writeFileSync(path.join(import.meta.dirname, 'findings.md'), `# Agent SDK findings (${new Date().toISOString()})\n\n- A streamed deltas: ${first.length > 0}\n- init carried session_id: ${Boolean(sessionId)}\n- resume carried context: ${resumedOk}\n- bogus resume result: ${bad}\n\n## Log\n\n${log.map(l => `- ${l}`).join('\n')}\n`);
if (!resumedOk) throw new Error('ASSUMPTION FAILED: resume did not carry context');
