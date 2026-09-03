import type { Response } from 'express';

/**
 * Server-sent events. Every screen shows the same countdown and the same state
 * because they all read it from here -- an approver never acts on a stale view.
 */
const clients = new Set<Response>();

export function addClient(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

export function heartbeat(): void {
  for (const res of clients) {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}
