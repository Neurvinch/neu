export class SealError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code);
  }
}

export const bad = (code: string, message?: string, detail?: unknown) =>
  new SealError(400, code, message, detail);
export const denied = (code: string, message?: string, detail?: unknown) =>
  new SealError(403, code, message, detail);
export const missing = (code: string, message?: string) => new SealError(404, code, message);
export const conflict = (code: string, message?: string, detail?: unknown) =>
  new SealError(409, code, message, detail);
