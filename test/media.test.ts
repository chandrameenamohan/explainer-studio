import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { statSync } from 'node:fs';
import { loadConfig } from '../lib/config.ts';
import { serveFileWithRanges } from '../lib/media.ts';

const cfg = loadConfig();
const file = path.join(cfg.videoRoot, 'sd-model-serving', 'sd-model-serving-explainer.mp4');
const size = statSync(file).size;
const server = http.createServer((req, res) => serveFileWithRanges(req, res, file, 'video/mp4'));
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
after(() => server.close());

test('full GET returns 200 with Accept-Ranges and the whole length', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(r.headers.get('content-length')), size);
  await r.arrayBuffer();
});

test('range GET returns 206 with the requested slice', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${size}`);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
});

test('open-ended range and HEAD', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: `bytes=${size - 5}-` } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 5);
  const h = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(Number(h.headers.get('content-length')), size);
});

test('suffix range returns the last N bytes', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: 'bytes=-7' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes ${size - 7}-${size - 1}/${size}`);
  assert.equal((await r.arrayBuffer()).byteLength, 7);
});

test('bad range returns 416 with Content-Range bytes */size', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: `bytes=${size + 10}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${size}`);
  await r.arrayBuffer();
  const r2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: 'bytes=-' } });
  assert.equal(r2.status, 416);
  await r2.arrayBuffer();
});
