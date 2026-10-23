import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSse } from '../lib/sse.ts';

test('formatSse frames one event with JSON data', () => {
  assert.equal(formatSse('delta', { text: 'hi\nthere' }), 'event: delta\ndata: {"text":"hi\\nthere"}\n\n');
});

test('openSse marks closed and runs onClose when the client disconnects', async () => {
  const http = await import('node:http');
  const { openSse } = await import('../lib/sse.ts');
  let closedSeen = false; let writer: ReturnType<typeof openSse> | null = null;
  const server = http.createServer((_req, res) => { writer = openSse(res); writer.onClose(() => { closedSeen = true; }); writer.send('hello', { n: 1 }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
  await r.body!.getReader().read();
  ac.abort();
  for (let i = 0; i < 50 && !closedSeen; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(closedSeen, true);
  assert.equal(writer!.closed, true);
  server.close();
});
