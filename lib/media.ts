import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';

export function serveFileWithRanges(req: IncomingMessage, res: ServerResponse, filePath: string, contentType: string): void {
  const size = statSync(filePath).size;
  const range = req.headers.range;
  const base = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': size });
    if (req.method === 'HEAD') return void res.end();
    return void pipeline(createReadStream(filePath), res, () => {});
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  let start = m[1] === '' ? NaN : Number(m[1]);
  let end = m[2] === '' ? size - 1 : Number(m[2]);
  if (Number.isNaN(start)) { // suffix range: bytes=-N
    const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1;
  }
  if (start >= size || start > end || Number.isNaN(end)) {
    return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  }
  end = Math.min(end, size - 1);
  res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return void res.end();
  pipeline(createReadStream(filePath, { start, end }), res, () => {});
}
