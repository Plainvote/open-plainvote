import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalByteLength } from '@votechain/protocol';

describe('canonicalJson', () => {
  it('sorts object keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } })).toBe(
      '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}',
    );
  });

  it('is insensitive to key insertion order', () => {
    const a = { x: 1, y: [true, null, 'strings'], z: { nested: 'ok' } };
    const b = { z: { nested: 'ok' }, y: [true, null, 'strings'], x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('serializes strings with JSON escaping', () => {
    expect(canonicalJson({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}');
  });

  it('rejects floats, unsafe integers, -0, NaN and Infinity', () => {
    expect(() => canonicalJson(1.5)).toThrow(/safe integers/);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integers/);
    expect(() => canonicalJson(-0)).toThrow(/-0/);
    expect(() => canonicalJson(NaN)).toThrow(/safe integers/);
    expect(() => canonicalJson(Infinity)).toThrow(/safe integers/);
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-42)).toBe('-42');
  });

  it('rejects undefined values (keys must be omitted instead)', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it('rejects non-plain objects', () => {
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/);
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
    class Foo {}
    expect(() => canonicalJson(new Foo())).toThrow(/plain objects/);
  });

  it('rejects excessive nesting', () => {
    let v: unknown = 1;
    for (let i = 0; i < 100; i++) v = [v];
    expect(() => canonicalJson(v)).toThrow(/deep/);
  });

  it('measures canonical byte length in UTF-8', () => {
    expect(canonicalByteLength({ a: 'é' })).toBe('{"a":"é"}'.length + 1); // é is 2 bytes in UTF-8
  });
});
