import type { ServerResponse } from 'node:http';

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type SseWriter = {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
};

export function openSse(res: ServerResponse): SseWriter {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  const closeFns: (() => void)[] = [];
  let keepAlive: NodeJS.Timeout | null = null;
  const markClosed = () => { if (!closed) { closed = true; if (keepAlive) clearInterval(keepAlive); for (const f of closeFns) f(); } };
  res.on('close', markClosed);
  keepAlive = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  return {
    send(event, data) { if (!closed) res.write(formatSse(event, data)); },
    close() { if (!closed) { markClosed(); res.end(); } },
    get closed() { return closed; },
    onClose(fn) { closeFns.push(fn); },
  };
}
