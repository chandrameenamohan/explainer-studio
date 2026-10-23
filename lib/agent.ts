import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type AgentEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'notice'; text: string }
  | { type: 'result'; sessionId: string | null; costUsd: number; isError: boolean; errors: string[]; startupFailure: string | null; resultText: string | null }
  | { type: 'raw'; message: unknown };

export type AgentRun = {
  prompt: string; cwd: string; systemPrompt?: string;
  allowedTools?: string[]; disallowedTools?: string[];
  permissionMode: 'dontAsk' | 'bypassPermissions'; allowDangerouslySkipPermissions?: boolean;
  settingSources?: ('user' | 'project' | 'local')[]; maxTurns?: number; maxBudgetUsd?: number;
  resume?: string; model?: string; claudePath?: string; env?: Record<string, string>;
  abort: AbortController;
};

export function isFakeAgent(): boolean { return process.env.STUDIO_FAKE_AGENT === '1'; }

export async function* runAgent(run: AgentRun): AsyncGenerator<AgentEvent> {
  if (isFakeAgent()) return yield* fakeAgent(run);
  const options: Options = {
    cwd: run.cwd,
    abortController: run.abort,
    permissionMode: run.permissionMode,
    includePartialMessages: true,
    ...(run.systemPrompt ? { systemPrompt: { type: 'custom', prompt: run.systemPrompt } } : {}),
    ...(run.allowedTools ? { allowedTools: run.allowedTools } : {}),
    ...(run.disallowedTools ? { disallowedTools: run.disallowedTools } : {}),
    ...(run.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(run.settingSources ? { settingSources: run.settingSources } : {}),
    ...(run.maxTurns ? { maxTurns: run.maxTurns } : {}),
    ...(run.maxBudgetUsd ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
    ...(run.resume ? { resume: run.resume } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.claudePath ? { pathToClaudeCodeExecutable: run.claudePath } : {}),
    ...(run.env ? { env: run.env } : {}),
  };
  let sessionId: string | null = null;
  let sawResult = false;
  try {
    for await (const msg of query({ prompt: run.prompt, options }) as AsyncIterable<SDKMessage>) {
      yield { type: 'raw', message: msg };
      const m = msg as { type: string; subtype?: string; session_id?: string; [k: string]: unknown };
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id ?? null;
        yield { type: 'init', sessionId: sessionId ?? '', model: String(m.model ?? '') };
      } else if (m.type === 'stream_event') {
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'delta', text: ev.delta.text };
      } else if (m.type === 'assistant') {
        const content = (m.message as { content?: { type: string; text?: string; name?: string; input?: unknown }[] }).content ?? [];
        for (const b of content) {
          if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
          if (b.type === 'tool_use') yield { type: 'tool', name: b.name ?? '?', input: b.input };
        }
      } else if (m.type === 'result') {
        sawResult = true;
        yield {
          type: 'result', sessionId: m.session_id ?? sessionId,
          costUsd: Number(m.total_cost_usd ?? 0), isError: Boolean(m.is_error),
          errors: Array.isArray(m.errors) ? (m.errors as string[]) : [],
          startupFailure: typeof m.startup_failure_reason === 'string' ? m.startup_failure_reason : null,
          resultText: typeof m.result === 'string' ? m.result : null,
        };
      }
    }
  } catch (e) {
    if (!sawResult) yield { type: 'result', sessionId, costUsd: 0, isError: true, errors: [(e as Error).message], startupFailure: null, resultText: null };
    return;
  }
  if (!sawResult) yield { type: 'result', sessionId, costUsd: 0, isError: run.abort.signal.aborted, errors: run.abort.signal.aborted ? ['aborted'] : [], startupFailure: null, resultText: null };
}

async function* fakeAgent(run: AgentRun): AsyncGenerator<AgentEvent> {
  if (run.resume && !run.resume.startsWith('fake-')) {
    // like the real SDK: a session id this login never created fails at startup
    yield { type: 'result', sessionId: null, costUsd: 0, isError: true, errors: [`No conversation found with session ID: ${run.resume}`], startupFailure: null, resultText: null };
    return;
  }
  const sessionId = run.resume ?? `fake-${Math.random().toString(36).slice(2, 10)}`;
  yield { type: 'init', sessionId, model: 'fake' };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const structured = run.prompt.startsWith('[studio:seed]') ? fakeSeed(run.prompt) : run.prompt.startsWith('[studio:draft]') ? FAKE_DRAFT : null;
  if (structured) {
    const out = JSON.stringify(structured);
    yield { type: 'text', text: out };
    yield { type: 'result', sessionId, costUsd: 0, isError: false, errors: [], startupFailure: null, resultText: out };
    return;
  }
  if (run.permissionMode === 'bypassPermissions') {
    const steps: AgentEvent[] = [
      { type: 'text', text: 'Reading brief.md and the template folder.' },
      { type: 'tool', name: 'Read', input: { file_path: 'brief.md' } },
      { type: 'tool', name: 'Write', input: { file_path: 'script.json' } },
      { type: 'tool', name: 'Bash', input: { command: '../heavy.sh uv run python tts.py' } },
      { type: 'text', text: 'tts.py done, narration.wav 240 s. Rendering stills.' },
      { type: 'tool', name: 'Bash', input: { command: 'node render.mjs --stills stills 10 20' } },
      { type: 'text', text: 'Fake job finished without producing an mp4.' },
    ];
    for (const s of steps) { if (run.abort.signal.aborted) break; yield { type: 'raw', message: s }; yield s; await sleep(20); }
    yield { type: 'result', sessionId, costUsd: 0, isError: false, errors: [], startupFailure: null, resultText: 'fake job done' };
    return;
  }
  const q = run.prompt.split('\n').at(-1) ?? run.prompt;
  const words = `${run.resume ? 'Picking up the resumed thread. ' : ''}You asked: ${q.trim()} The video explains this at @0:05 and returns to it at @1:30. Say the one-line version aloud: the keystone decision is the ${/reverse index/i.test(q) ? 'reverse index' : 'first design call'} because it keeps reads cheap.`.split(' ');
  let acc = '';
  for (const w of words) { if (run.abort.signal.aborted) break; yield { type: 'delta', text: `${w} ` }; acc += `${w} `; await sleep(5); }
  if (!run.abort.signal.aborted) yield { type: 'text', text: acc.trim() };
  yield { type: 'result', sessionId, costUsd: 0, isError: false, errors: [], startupFailure: null, resultText: acc.trim() };
}

const FAKE_DRAFT = { title: 'Fake concept', slug: 'fake-concept', definition: 'A concept the fake agent drafted.', quote: '', related: [], companies: [] };

// Seed prompt lines look like `  [<scene>.<line>] @m:ss <text>`; quotes are copied from them so validation passes.
function fakeSeed(prompt: string) {
  const lines = [...prompt.matchAll(/^\s*\[(\d+\.\d+)\] @\S+ (.*)$/gm)].map(m => ({ key: m[1], text: m[2].trim() }));
  const scene2 = lines.filter(l => l.key.startsWith('1.'));
  const [a, b] = scene2.length >= 2 ? scene2 : lines;
  return { concepts: [
    { title: 'Dynamic batching', slug: 'dynamic-batching', definition: 'Grouping requests so one GPU pass serves many.', quote: a?.text ?? '', line: a?.key ?? '1.0', related: [], why_for_company: 'ingest batches writes' },
    { title: 'Warm replicas', slug: 'warm-replicas', definition: 'Keep spare replicas loaded so a spike does not wait.', quote: b?.text ?? '', line: b?.key ?? '1.3', related: ['dynamic-batching'], why_for_company: '' },
  ] };
}
