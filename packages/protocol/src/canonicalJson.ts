/**
 * Deterministic JSON serialization — the byte layer every hash and signature
 * in the protocol is computed over.
 *
 * Rules (consensus-critical):
 * - object keys sorted by UTF-16 code unit; no whitespace
 * - numbers must be safe integers (no floats, no -0, no NaN/Infinity)
 * - undefined values, non-plain objects, and non-JSON types throw
 *
 * Because every node re-serializes the *parsed* value with these rules, two
 * wire encodings of the same logical value always hash identically, and any
 * value this function rejects can never be part of consensus data.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0);
}

const MAX_DEPTH = 64;

function serialize(v: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error('canonicalJson: nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number': {
      if (!Number.isSafeInteger(v)) {
        throw new Error('canonicalJson: numbers must be safe integers');
      }
      if (Object.is(v, -0)) throw new Error('canonicalJson: -0 is not allowed');
      return String(v);
    }
    case 'object': {
      if (Array.isArray(v)) {
        let out = '[';
        for (let i = 0; i < v.length; i++) {
          if (i > 0) out += ',';
          out += serialize(v[i], depth + 1);
        }
        return out + ']';
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('canonicalJson: only plain objects are allowed');
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      let out = '{';
      let first = true;
      for (const k of keys) {
        const val = obj[k];
        if (val === undefined) {
          throw new Error(`canonicalJson: undefined value for key ${JSON.stringify(k)} (omit the key instead)`);
        }
        if (!first) out += ',';
        first = false;
        out += JSON.stringify(k) + ':' + serialize(val, depth + 1);
      }
      return out + '}';
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

/** Byte length of the canonical serialization (used for size limits). */
export function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}
