import type { NextFunction, Request, Response } from 'express';
import { randomToken } from './hash.js';
import { getUser, type UserRow } from './core/repo.js';
import { denied } from './core/errors.js';

/**
 * Demo-grade session auth: a token map in memory, seeded passwords.
 *
 * This is deliberately the weakest part of the system, and it does not matter
 * much -- which is the point of the whole design. A stolen session cannot
 * authorize anything: it cannot produce an intent signature and it cannot
 * produce an approval signature. The worst a hijacked employee session can do
 * is accept a genuine signed request into escrow, where a quorum of signatures
 * is still required. Authority comes from a key, not from a session.
 */
const sessions = new Map<string, { userId: string; issued: number }>();

export function login(userId: string, password: string): { token: string; user: UserRow } {
  const user = getUser(userId);
  if (!user || user.demo_password !== password) throw denied('BAD_CREDENTIALS');
  const token = randomToken();
  sessions.set(token, { userId, issued: Date.now() });
  return { token, user };
}

export function logout(token: string): void {
  sessions.delete(token);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const s = sessions.get(token);
    if (s) req.user = getUser(s.userId);
  }
  next();
}

export function requireUser(req: Request): UserRow {
  if (!req.user) throw denied('NOT_AUTHENTICATED');
  return req.user;
}

export function requireRole(req: Request, roles: string[]): UserRow {
  const user = requireUser(req);
  if (!roles.includes(user.role)) {
    throw denied('WRONG_ROLE', `This action requires one of: ${roles.join(', ')}`);
  }
  return user;
}
