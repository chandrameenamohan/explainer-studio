import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { readRecord } from '../lib/catalog.ts';
import { loadState } from '../lib/state.ts';
import { type SavedConcept, fmtTime, buildSystemPrompt, currentLine, buildUserMessage, ChatLimiter, runChat, installChatRoutes } from '../lib/chat.ts';
import { createStudioServer } from '../server.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const H = { 'content-type': 'application/json', 'x-studio': '1' };
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-chat-')) };
const rec = readRecord(cfg.videoRoot, 'basics-pagination-worked', {})!;
after(() => rmSync(cfg.stateDir, { recursive: true, force: true }));

test('fmtTime', () => { assert.equal(fmtTime(0), '0:00'); assert.equal(fmtTime(92.6), '1:32'); assert.equal(fmtTime(3600), '60:00'); });

test('system prompt carries the title, every line with a timestamp, and the rules', () => {
  const p = buildSystemPrompt(rec, null);
  assert.match(p, /Pagination, worked end to end/);
  assert.match(p, /@0:00 Here is a feed/);
  assert.match(p, /cite moments as @m:ss/i);
  assert.match(p, /do not invent/i);
  const n = rec.scenes.reduce((a, s) => a + s.lines.length, 0);
  assert.equal((p.match(/^\s*@\d+:\d\d /gm) ?? []).length, n);
  assert.match(buildSystemPrompt(rec, '# Sources\nquote'), /# Sources\nquote/);
});

test('currentLine and user message', () => {
  const cl = currentLine(rec, 3)!;
  assert.equal(cl.line.key, '0.0');
  assert.equal(currentLine(rec, null), null);
  const u = buildUserMessage(rec, 3, 'why?');
  assert.match(u, /^\[viewer at @0:03, scene "The duplicate row", current line @0:00: "Here is a feed/);
  assert.match(u, /\nwhy\?$/);
  assert.equal(buildUserMessage(rec, null, 'why?'), '[viewer has not started the video]\nwhy?');
});

test('ChatLimiter per-folder and global caps', () => {
  const l = new ChatLimiter(2);
  assert.equal(l.tryAcquire('a'), 'ok'); assert.equal(l.tryAcquire('a'), 'busy-folder');
  assert.equal(l.tryAcquire('b'), 'ok'); assert.equal(l.tryAcquire('c'), 'busy-global');
  l.release('a'); assert.equal(l.tryAcquire('c'), 'ok');
});

test('runChat saves history and session id, then resumes', async () => {
  let text = '';
  for await (const e of runChat({ config: cfg, record: rec, question: 'Why a reverse index?', t: 3, abort: new AbortController() })) if (e.type === 'delta') text += e.text;
  assert.match(text, /reverse index/);
  const s = loadState(cfg.stateDir, rec.folder);
  assert.ok(s.chat.sessionId?.startsWith('fake-'));
  assert.equal(s.chat.messages.length, 2);
  assert.equal(s.chat.messages[0].role, 'user'); assert.equal(s.chat.messages[0].t, 3); assert.equal(s.chat.messages[0].line, '0.0');
  assert.equal(s.chat.messages[1].role, 'assistant');
  let text2 = '';
  for await (const e of runChat({ config: cfg, record: rec, question: 'and?', t: 10, abort: new AbortController() })) if (e.type === 'delta') text2 += e.text;
  assert.match(text2, /resumed/);
  assert.equal(loadState(cfg.stateDir, rec.folder).chat.messages.length, 4);
});

test('SSE route streams events and reset clears history', async () => {
  const app = createStudioServer(cfg); installChatRoutes(app, cfg);
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'hi', t: 1 }) });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await r.text();
    assert.match(body, /event: delta\ndata: /); assert.match(body, /event: done\ndata: \{"sessionId":"fake-/);
    const bad = await fetch(`${base}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(bad.status, 400); await bad.text();
    // limits: second POST on the same folder while one streams -> 409; over the global cap -> 429
    const slow = fetch(`${base}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'slow one', t: 1 }) });
    await new Promise(r => setTimeout(r, 30));
    const dup = await fetch(`${base}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'dup', t: 1 }) });
    assert.equal(dup.status, 409); await dup.text();
    await (await slow).text();
    const tight = { ...cfg, chatConcurrency: 1 }; const app2 = createStudioServer(tight); installChatRoutes(app2, tight);
    const port2 = await app2.listen(0);
    try {
      const ac = new AbortController();
      const first = await fetch(`http://127.0.0.1:${port2}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'hold', t: 1 }), signal: ac.signal });
      await first.body!.getReader().read();
      const other = await fetch(`http://127.0.0.1:${port2}/api/video/sd-model-serving/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'x', t: 1 }) });
      assert.equal(other.status, 429); await other.text();
      ac.abort();
      await new Promise(r => setTimeout(r, 300));
      const after = await fetch(`http://127.0.0.1:${port2}/api/video/sd-model-serving/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'x', t: 1 }) });
      assert.equal(after.status, 200); await after.text();
    } finally { await app2.close(); }
    const reset = await fetch(`${base}/api/video/${rec.folder}/chat/reset`, { method: 'POST', headers: H });
    assert.equal(reset.status, 200); await reset.text();
    assert.equal(loadState(cfg.stateDir, rec.folder).chat.messages.length, 0);
    assert.equal(loadState(cfg.stateDir, rec.folder).chat.sessionId, null);
  } finally { await app.close(); }
});

test('R03: a refused resume retries once without it and tells the page the thread restarted', async () => {
  const folder = 'sd-model-serving';
  const r2 = readRecord(cfg.videoRoot, folder, {})!;
  const { saveState } = await import('../lib/state.ts');
  const s0 = loadState(cfg.stateDir, folder); s0.chat.sessionId = 'stale-session-from-another-login'; saveState(cfg.stateDir, folder, s0);
  const events: string[] = []; let text = '';
  for await (const e of runChat({ config: cfg, record: r2, question: 'still there?', t: 2, abort: new AbortController() })) {
    events.push(e.type === 'notice' ? `notice:${e.text}` : e.type);
    if (e.type === 'delta') text += e.text;
    if (e.type === 'result') assert.equal(e.isError, false);
  }
  assert.ok(events.some(x => /notice:.*could not be resumed/.test(x)), events.join(','));
  assert.doesNotMatch(text, /resumed thread/);
  const s = loadState(cfg.stateDir, folder);
  assert.ok(s.chat.sessionId?.startsWith('fake-'), String(s.chat.sessionId));
  assert.equal(s.chat.messages.at(-1)?.role, 'assistant');
});

const sc = (i: number, o: Partial<SavedConcept> = {}): SavedConcept => ({ slug: `c-${i}`, title: `Concept ${i}`, status: 'learning', inMyWords: 'x'.repeat(200), definition: 'd', related: ['gpu-utilization'], companies: ['globex'], ...o });

test('saved concepts section sits at the end, lists fields, and is capped', () => {
  const p = buildSystemPrompt(rec, '# Sources\nquote', [sc(1, { title: 'Dynamic batching', inMyWords: 'group requests' })]);
  assert.match(p, /# What you already saved \(your knowledge graph\)\n- \*\*Dynamic batching\*\* \(learning\) — in your words: "group requests" — related: gpu-utilization — companies: globex/);
  assert.ok(p.indexOf('# What you already saved') > p.indexOf('# Sources'));
  const big = buildSystemPrompt(rec, null, Array.from({ length: 100 }, (_, i) => sc(i)));
  const section = big.slice(big.indexOf('# What you already saved'));
  assert.ok(section.length <= 6000, String(section.length));
  assert.match(section, /- … and \d+ more$/);
  assert.match(section, /Concept 0\*\*/);
});

test('empty saved list adds no section; rules mention Save this as a concept', () => {
  assert.doesNotMatch(buildSystemPrompt(rec, null, []), /What you already saved/);
  assert.doesNotMatch(buildSystemPrompt(rec, null), /What you already saved/);
  assert.match(buildSystemPrompt(rec, null), /Save this as a concept: <title>/);
});

test('chat route calls the savedFor hook with the folder', async () => {
  const seen: string[] = [];
  const app = createStudioServer(cfg); installChatRoutes(app, cfg, f => { seen.push(f); return [sc(1)]; });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/api/video/${rec.folder}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ question: 'hi', t: 1 }) });
    await r.text();
    assert.deepEqual(seen, [rec.folder]);
  } finally { await app.close(); }
});
