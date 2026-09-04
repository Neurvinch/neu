import { useEffect, useRef, useState } from 'react';

export interface ApiError extends Error {
  status: number;
  code: string;
}

let token: string | null = localStorage.getItem('seal.token');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('seal.token', t);
  else localStorage.removeItem('seal.token');
}

export function getToken() {
  return token;
}

export async function api<T = unknown>(
  path: string,
  /**
   * `token` overrides the signed-in session for one call. The vishing lab uses
   * it to drive both ends of a caller challenge from a single screen; nothing
   * in the real flows passes it.
   */
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const bearer = opts.token ?? token;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      (data as { message?: string })?.message ?? (data as { error?: string })?.error ?? res.statusText,
    ) as ApiError;
    err.status = res.status;
    err.code = (data as { error?: string })?.error ?? String(res.status);
    throw err;
  }
  return data as T;
}

/**
 * One event stream for the whole app. Every screen renders from the same
 * server-pushed state, so an approver is never looking at a stale escrow.
 */
export function useEvents(onEvent: (type: string, data: unknown) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const es = new EventSource('/api/events');
    const types = [
      'intent.signed',
      'intent.rejected',
      'escrow.opened',
      'escrow.updated',
      'escrow.expired',
      'enrollment.changed',
      'rail.refused',
      'signing.requested',
      'signing.resolved',
      'caller.raised',
      'caller.resolved',
      'impersonation.alert',
      'evidence.captured',
    ];
    const listeners = types.map((t) => {
      const fn = (e: MessageEvent) => handler.current(t, JSON.parse(e.data));
      es.addEventListener(t, fn as EventListener);
      return [t, fn] as const;
    });
    return () => {
      for (const [t, fn] of listeners) es.removeEventListener(t, fn as EventListener);
      es.close();
    };
  }, []);
}

/** Poll-free data hook: fetch once, then refetch whenever `dep` changes. */
export function useApi<T>(path: string | null, dep: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError((e as ApiError).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dep]);

  return { data, error, loading, setData };
}

/** A ticking clock, so countdowns move without hammering the server. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
