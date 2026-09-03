/**
 * RFC 8785 (JCS) JSON Canonicalization.
 *
 * The hash that the executive signs must be reproducible byte-for-byte on the
 * signer's device, on the server, on every approver's device, and inside the
 * bank's independent verifier. Plain JSON.stringify is not enough: key order
 * differs between implementations. JCS fixes the order and the escaping.
 *
 * JSON.stringify already matches JCS for strings (minimal escaping) and for
 * numbers (ECMAScript number-to-string). The only thing we add is recursive
 * key sorting by UTF-16 code unit, which is exactly what Array#sort does by
 * default.
 */
export function canonicalize(value: unknown): string {
  return ser(value);
}

function ser(v: unknown): string {
  if (v === null) return 'null';

  const t = typeof v;

  if (t === 'boolean') return v ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(v as number)) {
      throw new Error('canonicalize: non-finite number is not serializable');
    }
    return JSON.stringify(v);
  }

  if (t === 'string') return JSON.stringify(v);

  if (Array.isArray(v)) {
    return '[' + v.map((el) => ser(el === undefined ? null : el)).join(',') + ']';
  }

  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(); // UTF-16 code unit order, per RFC 8785
    const parts = keys.map((k) => JSON.stringify(k) + ':' + ser(obj[k]));
    return '{' + parts.join(',') + '}';
  }

  throw new Error(`canonicalize: unsupported type "${t}"`);
}
