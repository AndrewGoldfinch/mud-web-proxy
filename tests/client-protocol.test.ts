import { describe, test, expect } from 'bun:test';
import {
  asClientObject,
  parseTypedRequest,
  recognize,
  validateTyped,
  validateLegacy,
  safeTypeName,
  KNOWN_TYPES,
  type JsonValue,
} from '../src/client-protocol';

describe('recognize', () => {
  test('object with type field is typed', () => {
    expect(recognize({ type: 'input', text: 'hi' })).toEqual({
      kind: 'typed',
      type: 'input',
    });
  });

  test('object with connect field and no type is legacy', () => {
    expect(recognize({ connect: 1, host: 'a.example', port: 23 })).toEqual({
      kind: 'legacy',
    });
  });

  test('type wins when both type and connect are present', () => {
    expect(recognize({ type: 'input', connect: 1 })).toEqual({
      kind: 'typed',
      type: 'input',
    });
  });

  test('object with neither type nor connect is unrecognized', () => {
    expect(recognize({ foo: 'bar' })).toEqual({ kind: 'unrecognized' });
  });

  test('arrays, null, and primitives are unrecognized', () => {
    expect(recognize([1, 2])).toEqual({ kind: 'unrecognized' });
    expect(recognize(null)).toEqual({ kind: 'unrecognized' });
    expect(recognize('hello')).toEqual({ kind: 'unrecognized' });
    expect(recognize(42)).toEqual({ kind: 'unrecognized' });
  });
});

describe('KNOWN_TYPES', () => {
  test('contains exactly the seven handled types', () => {
    expect([...KNOWN_TYPES].sort()).toEqual([
      'activityToken',
      'connect',
      'disconnect',
      'input',
      'naws',
      'resume',
      'syncAck',
    ]);
  });
});

describe('validateTyped: connect', () => {
  test('accepts a well-formed connect', () => {
    expect(
      validateTyped('connect', {
        type: 'connect',
        host: 'a.example',
        port: 23,
      }),
    ).toEqual({ ok: true });
  });

  test('rejects a missing host', () => {
    const r = validateTyped('connect', { type: 'connect', port: 23 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('host');
  });

  test('rejects a non-string host', () => {
    const r = validateTyped('connect', {
      type: 'connect',
      host: 42,
      port: 23,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('host');
  });

  test('rejects an out-of-range port', () => {
    for (const port of [0, -1, 65536, 1.5]) {
      const r = validateTyped('connect', {
        type: 'connect',
        host: 'a.example',
        port,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('port');
    }
  });

  test('accepts optional width and height when valid', () => {
    expect(
      validateTyped('connect', {
        type: 'connect',
        host: 'a.example',
        port: 23,
        width: 80,
        height: 24,
      }),
    ).toEqual({ ok: true });
  });

  test('rejects a non-integer width', () => {
    const r = validateTyped('connect', {
      type: 'connect',
      host: 'a.example',
      port: 23,
      width: 'wide',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('width');
  });

  test('ignores unknown extra fields', () => {
    expect(
      validateTyped('connect', {
        type: 'connect',
        host: 'a.example',
        port: 23,
        somethingNew: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe('validateTyped: other types', () => {
  test('resume requires sessionId, token, lastSeq', () => {
    expect(
      validateTyped('resume', {
        type: 'resume',
        sessionId: 's1',
        token: 't1',
        lastSeq: 0,
      }),
    ).toEqual({ ok: true });

    const r = validateTyped('resume', {
      type: 'resume',
      sessionId: 's1',
      token: 't1',
      lastSeq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('lastSeq');
  });

  test('input accepts an empty string', () => {
    expect(validateTyped('input', { type: 'input', text: '' })).toEqual({
      ok: true,
    });
  });

  test('input rejects a non-string text', () => {
    const r = validateTyped('input', { type: 'input', text: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('text');
  });

  test('naws requires integer width and height', () => {
    expect(
      validateTyped('naws', { type: 'naws', width: 80, height: 24 }),
    ).toEqual({ ok: true });
    const r = validateTyped('naws', { type: 'naws', width: 80 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('height');
  });

  test('activityToken requires a token', () => {
    const r = validateTyped('activityToken', { type: 'activityToken' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('token');
  });

  test('syncAck requires sessionId and lastSeq', () => {
    expect(
      validateTyped('syncAck', {
        type: 'syncAck',
        sessionId: 's1',
        lastSeq: 3,
      }),
    ).toEqual({ ok: true });
  });

  test('disconnect needs no fields', () => {
    expect(validateTyped('disconnect', { type: 'disconnect' })).toEqual({
      ok: true,
    });
  });
});

describe('validateLegacy', () => {
  test('bare connect is valid and yields no host or port', () => {
    expect(validateLegacy({ connect: 1 })).toEqual({
      ok: true,
      value: { host: undefined, port: undefined },
    });
  });

  test('connect with host and port is valid', () => {
    expect(
      validateLegacy({ connect: true, host: 'a.example', port: 4000 }),
    ).toEqual({ ok: true, value: { host: 'a.example', port: 4000 } });
  });

  test('falsy connect is invalid', () => {
    const r = validateLegacy({ connect: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('connect');
  });

  test('non-string host is invalid', () => {
    const r = validateLegacy({ connect: 1, host: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('host');
  });

  test('empty host is invalid', () => {
    const r = validateLegacy({ connect: 1, host: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('host');
  });

  test('out-of-range port is invalid', () => {
    const r = validateLegacy({ connect: 1, host: 'a.example', port: 70000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('port');
  });

  test('ignores unknown extra fields', () => {
    expect(
      validateLegacy({ connect: 1, host: 'a.example', port: 23, extra: 'x' }),
    ).toEqual({ ok: true, value: { host: 'a.example', port: 23 } });
  });
});

describe('safeTypeName', () => {
  test('passes an ordinary name through', () => {
    expect(safeTypeName('challenge')).toBe('challenge');
  });

  test('truncates a long name', () => {
    expect(safeTypeName('x'.repeat(100))).toHaveLength(32);
  });

  test('strips control characters', () => {
    // ESC and newline are stripped; the printable "[31m" survives.
    expect(safeTypeName('a\u001B[31mb\n')).toBe('a[31mb');
    expect(safeTypeName('a\u0000\u007Fb')).toBe('ab');
  });

  test('renders a non-string as its type', () => {
    expect(safeTypeName(42)).toBe('<number>');
    expect(safeTypeName(null)).toBe('<object>');
  });
});

describe('deeply nested frames do not exhaust the stack', () => {
  // Review on #155. The first zod rewrite validated the decoded value
  // recursively, so a frame of nested arrays — 40 KB, well inside the 64 KiB
  // message cap — threw a RangeError out of safeParse. parseNewMessage only
  // wraps JSON.parse, and the ws message handler wraps nothing, so an
  // unauthenticated frame could kill the process.
  const deeplyNested = (depth: number): JsonValue =>
    JSON.parse(
      `{"type":"input","text":"x","deep":${'['.repeat(depth)}${']'.repeat(depth)}}`,
    );

  test('recognize survives a frame that would overflow a recursive walk', () => {
    expect(recognize(deeplyNested(20000))).toEqual({
      kind: 'typed',
      type: 'input',
    });
  });

  test('validateTyped survives one too', () => {
    const o = asClientObject(deeplyNested(20000));
    expect(o).toBeDefined();
    expect(validateTyped('input', o!)).toEqual({ ok: true });
  });
});

describe('optional fields sent as null', () => {
  // Review on #155. `isAbsent` counts null as "not supplied", so validateTyped
  // accepts these — the decoder has to agree, or the message passes validation
  // and then fails to decode, and the client is told its type is unknown.
  const connectWithNulls = {
    type: 'connect',
    host: 'a.example',
    port: 23,
    deviceToken: null,
    width: null,
    height: null,
  };

  test('validateTyped accepts them', () => {
    expect(validateTyped('connect', connectWithNulls)).toEqual({ ok: true });
  });

  test('and parseTypedRequest decodes them as absent', () => {
    const request = parseTypedRequest('connect', connectWithNulls);
    expect(request).toBeDefined();
    expect(request).toMatchObject({ type: 'connect', host: 'a.example' });
    expect(request?.type === 'connect' && request.deviceToken).toBeUndefined();
  });

  test('resume tolerates a null deviceToken the same way', () => {
    const resume = {
      type: 'resume',
      sessionId: 's1',
      token: 't1',
      lastSeq: 0,
      deviceToken: null,
    };
    expect(validateTyped('resume', resume)).toEqual({ ok: true });
    expect(parseTypedRequest('resume', resume)).toBeDefined();
  });
});
