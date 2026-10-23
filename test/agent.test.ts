import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, isFakeAgent, type AgentEvent } from '../lib/agent.ts';

process.env.STUDIO_FAKE_AGENT = '1';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> { const out: AgentEvent[] = []; for await (const e of gen) out.push(e); return out; }

test('fake agent streams init, deltas with a timestamp citation, and a result', async () => {
  assert.equal(isFakeAgent(), true);
  const ev = await collect(runAgent({ prompt: 'Why a reverse index?', cwd: process.cwd(), permissionMode: 'dontAsk', abort: new AbortController() }));
  const init = ev.find(e => e.type === 'init');
  assert.ok(init && init.type === 'init' && init.sessionId.startsWith('fake-'));
  const text = ev.filter(e => e.type === 'delta').map(e => (e as { text: string }).text).join('');
  assert.match(text, /@0:05/);
  assert.match(text, /reverse index/);
  const res = ev.at(-1);
  assert.ok(res && res.type === 'result' && res.isError === false && res.costUsd === 0 && res.sessionId === init.sessionId);
});

test('fake agent with resume keeps the session id and mentions it was resumed', async () => {
  const ev = await collect(runAgent({ prompt: 'and then?', cwd: process.cwd(), permissionMode: 'dontAsk', resume: 'fake-123', abort: new AbortController() }));
  const init = ev.find(e => e.type === 'init');
  assert.ok(init && init.type === 'init' && init.sessionId === 'fake-123');
  assert.match(ev.filter(e => e.type === 'delta').map(e => (e as { text: string }).text).join(''), /resumed/);
});

test('fake agent in bypass mode emits tool and text events like a build job', async () => {
  const ev = await collect(runAgent({ prompt: 'build video x', cwd: process.cwd(), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, abort: new AbortController() }));
  const tools = ev.filter(e => e.type === 'tool').map(e => (e as { name: string }).name);
  assert.ok(tools.includes('Bash'));
  assert.ok(ev.some(e => e.type === 'text' && /tts\.py/.test((e as { text: string }).text)));
});

test('abort stops the fake stream early', async () => {
  const abort = new AbortController();
  const out: AgentEvent[] = [];
  for await (const e of runAgent({ prompt: 'x', cwd: process.cwd(), permissionMode: 'dontAsk', abort })) { out.push(e); if (e.type === 'delta') abort.abort(); }
  assert.ok(out.length < 8);
  assert.equal(out.at(-1)?.type, 'result');
});

const SEED_PROMPT = [
  '[studio:seed] Extract concepts.', '# Video sd-model-serving', '## Scene 1: Hand-over',
  '  [0.0] @0:00 Opening line.', '  [0.1] @0:04 Second opening line.', '## Scene 2: Numbers',
  '  [1.0] @0:43 One GPU serves 100 requests a second.', '  [1.1] @0:50 In batches of 16, 500.', '  [1.2] @0:58 Third.',
].join('\n');

test('fake agent answers a [studio:seed] prompt with JSON whose quotes come from the prompt', async () => {
  const ev = await collect(runAgent({ prompt: SEED_PROMPT, cwd: process.cwd(), permissionMode: 'dontAsk', abort: new AbortController() }));
  assert.equal(ev[0].type, 'init');
  assert.ok(ev.some(e => e.type === 'text'));
  const res = ev.at(-1);
  assert.ok(res && res.type === 'result' && !res.isError && res.costUsd === 0 && res.resultText);
  const out = JSON.parse(res.resultText) as { concepts: { slug: string; quote: string; line: string; related: string[] }[] };
  assert.equal(out.concepts.length, 2);
  assert.deepEqual(out.concepts.map(c => c.slug), ['dynamic-batching', 'warm-replicas']);
  assert.deepEqual(out.concepts.map(c => c.line), ['1.0', '1.1']);
  for (const c of out.concepts) assert.ok(SEED_PROMPT.includes(c.quote) && c.quote.length > 0);
  assert.deepEqual(out.concepts[1].related, ['dynamic-batching']);
});

test('fake seed falls back to the first two keyed lines when there is no scene 2', async () => {
  const p = '[studio:seed] x\n  [0.0] @0:00 Alpha line.\n  [0.1] @0:03 Beta line.';
  const ev = await collect(runAgent({ prompt: p, cwd: process.cwd(), permissionMode: 'dontAsk', abort: new AbortController() }));
  const res = ev.at(-1) as { resultText: string };
  assert.deepEqual((JSON.parse(res.resultText) as { concepts: { quote: string }[] }).concepts.map(c => c.quote), ['Alpha line.', 'Beta line.']);
});

test('fake agent answers a [studio:draft] prompt with a draft concept JSON', async () => {
  const ev = await collect(runAgent({ prompt: '[studio:draft] Draft a concept from this answer.', cwd: process.cwd(), permissionMode: 'dontAsk', abort: new AbortController() }));
  assert.equal(ev[0].type, 'init');
  const res = ev.at(-1);
  assert.ok(res && res.type === 'result' && !res.isError && res.resultText);
  assert.deepEqual(JSON.parse(res.resultText), { title: 'Fake concept', slug: 'fake-concept', definition: 'A concept the fake agent drafted.', quote: '', related: [], companies: [] });
});
