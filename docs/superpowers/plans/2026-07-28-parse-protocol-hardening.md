# Parse Protocol Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop malformed and unrecognized JSON control messages from being typed into the MUD as player input, and restore the legacy `{host, port, connect}` protocol through the same policy path as the typed protocol.

**Architecture:** `SessionIntegration.parseNewMessage` currently returns a `boolean` that conflates "not my message, forward to the MUD" with "my message, but I could not handle it". Replace it with a tri-state `ParseOutcome`. A new pure module `src/client-protocol.ts` owns shape recognition and field validation with no socket dependency. `handleConnect`'s policy sequence is extracted into `openTelnetSession(socket, ctx)`, which both protocols call; `ctx.flavor` changes only the success frame and the error rendering.

**Tech Stack:** TypeScript (ES2022, strict), Bun runtime and test framework, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-07-28-parse-protocol-hardening-design.md`

**Issues:** MWP-90, MWP-91. Task 2 completes MWP-91; Task 4 completes MWP-90.

## Global Constraints

- Base branch: `develop` at `038feb6`. This worktree is already based on it.
- Formatting: Prettier — 79 char width, 2-space indent, single quotes, semicolons.
- Naming: camelCase vars/functions, PascalCase types, UPPER_SNAKE_CASE constants, `_` prefix for unused params.
- Logging: use `srv.log*` helpers, never `console.log`, in `wsproxy.ts`.
- Errors in catch blocks: cast as `(err as Error)`.
- Imports: ES module style; `import type` for type-only imports.
- Every task ends with `bun run typecheck` and `bun run lint` clean, in addition to its tests.
- Baseline before any change: 779 tests pass, 0 fail (`bun test tests/*.test.ts`). No task may reduce that count.
- Do not delete `initT`, `newSocket`, or their tests. Out of scope per the spec.
- Do not change what `formatMissingTypeLogMessage` returns — `tests/wsproxy-utils.test.ts:151` asserts it.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/client-protocol.ts` (create) | Pure shape recognition + field validation. No socket, no I/O. |
| `tests/client-protocol.test.ts` (create) | Unit tests for the above. |
| `src/session-integration.ts` (modify) | `parseNewMessage` returns `ParseOutcome`; `openTelnetSession` extracted from `handleConnect`; legacy flavor. |
| `wsproxy.ts` (modify) | `parse()` three-way switch; log-level downgrade. |
| `tests/parse-protocol.test.ts` (create) | Parse-level behaviour + parity table. |
| `tests/e2e/legacy-protocol.test.ts` (create) | Process-level tests against a live server. |
| `docs/mud-proxy-guide.md` (modify) | Legacy protocol documented as supported but frozen. |

---

### Task 1: Pure recognition and validation module

**Files:**
- Create: `src/client-protocol.ts`
- Test: `tests/client-protocol.test.ts`

**Interfaces:**
- Consumes: `ClientMessage` and the request interfaces in `src/types/index.ts:104-149`.
- Produces:
  - `type ParseOutcome = { kind: 'handled' } | { kind: 'not-ours'; parsedObject?: Record<string, unknown> } | { kind: 'invalid'; code: string; field?: string; reason: string }`
  - `KNOWN_TYPES: readonly string[]`, `type KnownType`
  - `recognize(parsed: unknown): Recognition`
  - `validateTyped(type: string, o: Record<string, unknown>): FieldValidation`
  - `validateLegacy(o: Record<string, unknown>): LegacyValidation`
  - `safeTypeName(value: unknown): string`

- [ ] **Step 1: Write the failing test**

Create `tests/client-protocol.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
  recognize,
  validateTyped,
  validateLegacy,
  safeTypeName,
  KNOWN_TYPES,
} from '../src/client-protocol';

describe('recognize', () => {
  test('object with type field is typed', () => {
    expect(recognize({ type: 'input', text: 'hi' })).toEqual({
      shape: 'typed',
      type: 'input',
    });
  });

  test('object with connect field and no type is legacy', () => {
    expect(recognize({ connect: 1, host: 'a.example', port: 23 })).toEqual({
      shape: 'legacy',
    });
  });

  test('type wins when both type and connect are present', () => {
    expect(recognize({ type: 'input', connect: 1 })).toEqual({
      shape: 'typed',
      type: 'input',
    });
  });

  test('object with neither type nor connect is unrecognized', () => {
    expect(recognize({ foo: 'bar' })).toEqual({ shape: 'unrecognized' });
  });

  test('arrays, null, and primitives are unrecognized', () => {
    expect(recognize([1, 2])).toEqual({ shape: 'unrecognized' });
    expect(recognize(null)).toEqual({ shape: 'unrecognized' });
    expect(recognize('hello')).toEqual({ shape: 'unrecognized' });
    expect(recognize(42)).toEqual({ shape: 'unrecognized' });
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
      validateTyped('connect', { type: 'connect', host: 'a.example', port: 23 }),
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
    expect(safeTypeName('a\u001B[31mb\n')).toBe('a[31mb');
  });

  test('renders a non-string as its type', () => {
    expect(safeTypeName(42)).toBe('<number>');
    expect(safeTypeName(null)).toBe('<object>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/client-protocol.test.ts`
Expected: FAIL — cannot resolve module `../src/client-protocol`.

- [ ] **Step 3: Write the implementation**

Create `src/client-protocol.ts`:

```typescript
/**
 * Pure shape recognition and field validation for client messages.
 *
 * This module has no socket or I/O dependency so that the recognition rules
 * and the per-type field checks can be unit tested directly. `parse()` in
 * wsproxy.ts and SessionIntegration.parseNewMessage are its only consumers.
 */

/** Outcome of attempting to handle one client message. */
export type ParseOutcome =
  | { kind: 'handled' }
  | { kind: 'not-ours'; parsedObject?: Record<string, unknown> }
  | { kind: 'invalid'; code: string; field?: string; reason: string };

export type Recognition =
  | { shape: 'typed'; type: string }
  | { shape: 'legacy' }
  | { shape: 'unrecognized' };

export type FieldValidation =
  | { ok: true }
  | { ok: false; field: string; reason: string };

export type LegacyConnect = { host?: string; port?: number };

export type LegacyValidation =
  | { ok: true; value: LegacyConnect }
  | { ok: false; field: string; reason: string };

/** The message types SessionIntegration dispatches. */
export const KNOWN_TYPES = [
  'connect',
  'resume',
  'activityToken',
  'syncAck',
  'input',
  'naws',
  'disconnect',
] as const;

export type KnownType = (typeof KNOWN_TYPES)[number];

const MAX_TYPE_NAME_LENGTH = 32;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 65535;

/**
 * Render a client-supplied type value for an error message. The value is
 * attacker-controlled, so it is stripped of control characters and bounded
 * before it reaches a response or a log line.
 */
export const safeTypeName = (value: unknown): string => {
  if (typeof value !== 'string') return `<${typeof value}>`;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '');
  return cleaned.slice(0, MAX_TYPE_NAME_LENGTH);
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isString = (v: unknown): v is string => typeof v === 'string';

const isIntegerInRange = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const isNonNegativeInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

const isAbsent = (o: Record<string, unknown>, key: string): boolean =>
  !(key in o) || o[key] === undefined || o[key] === null;

const bad = (field: string, reason: string): FieldValidation => ({
  ok: false,
  field,
  reason,
});

const PORT_REASON = `port must be an integer between ${MIN_PORT} and ${MAX_PORT}`;
const DIMENSION_REASON = `must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`;

/**
 * Classify a parsed JSON value. A recognized shape is dispatched or rejected;
 * an unrecognized one is ordinary player input and goes to the MUD.
 *
 * `type` takes precedence over `connect` so a typed message carrying an
 * incidental `connect` field is never mistaken for the legacy protocol.
 */
export const recognize = (parsed: unknown): Recognition => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { shape: 'unrecognized' };
  }
  const o = parsed as Record<string, unknown>;
  if ('type' in o) return { shape: 'typed', type: safeTypeName(o.type) };
  if ('connect' in o) return { shape: 'legacy' };
  return { shape: 'unrecognized' };
};

/** Validate the fields of a known typed message. */
export const validateTyped = (
  type: string,
  o: Record<string, unknown>,
): FieldValidation => {
  switch (type) {
    case 'connect':
      if (!isNonEmptyString(o.host)) {
        return bad('host', 'host must be a non-empty string');
      }
      if (!isIntegerInRange(o.port, MIN_PORT, MAX_PORT)) {
        return bad('port', PORT_REASON);
      }
      if (
        !isAbsent(o, 'width') &&
        !isIntegerInRange(o.width, MIN_DIMENSION, MAX_DIMENSION)
      ) {
        return bad('width', `width ${DIMENSION_REASON}`);
      }
      if (
        !isAbsent(o, 'height') &&
        !isIntegerInRange(o.height, MIN_DIMENSION, MAX_DIMENSION)
      ) {
        return bad('height', `height ${DIMENSION_REASON}`);
      }
      if (!isAbsent(o, 'deviceToken') && !isNonEmptyString(o.deviceToken)) {
        return bad('deviceToken', 'deviceToken must be a non-empty string');
      }
      return { ok: true };

    case 'resume':
      if (!isNonEmptyString(o.sessionId)) {
        return bad('sessionId', 'sessionId must be a non-empty string');
      }
      if (!isNonEmptyString(o.token)) {
        return bad('token', 'token must be a non-empty string');
      }
      if (!isNonNegativeInteger(o.lastSeq)) {
        return bad('lastSeq', 'lastSeq must be a non-negative integer');
      }
      return { ok: true };

    case 'activityToken':
      if (!isNonEmptyString(o.token)) {
        return bad('token', 'token must be a non-empty string');
      }
      return { ok: true };

    case 'syncAck':
      if (!isNonEmptyString(o.sessionId)) {
        return bad('sessionId', 'sessionId must be a non-empty string');
      }
      if (!isNonNegativeInteger(o.lastSeq)) {
        return bad('lastSeq', 'lastSeq must be a non-negative integer');
      }
      return { ok: true };

    case 'input':
      // An empty line is legitimate: the player pressed enter.
      if (!isString(o.text)) return bad('text', 'text must be a string');
      return { ok: true };

    case 'naws':
      if (!isIntegerInRange(o.width, MIN_DIMENSION, MAX_DIMENSION)) {
        return bad('width', `width ${DIMENSION_REASON}`);
      }
      if (!isIntegerInRange(o.height, MIN_DIMENSION, MAX_DIMENSION)) {
        return bad('height', `height ${DIMENSION_REASON}`);
      }
      return { ok: true };

    case 'disconnect':
      return { ok: true };

    default:
      return bad('type', `Unknown message type: ${safeTypeName(type)}`);
  }
};

/**
 * Validate a legacy connect object.
 *
 * `host` and `port` are both optional: a bare `{connect: 1}` means the
 * default target, matching initT's `s.host || srv.tn_host` fallback. The
 * default is still subject to validateTarget, so under allowlist mode it is
 * denied unless TN_HOST is itself listed.
 */
export const validateLegacy = (
  o: Record<string, unknown>,
): LegacyValidation => {
  if (!o.connect) {
    return { ok: false, field: 'connect', reason: 'connect must be truthy' };
  }

  let host: string | undefined;
  if (!isAbsent(o, 'host')) {
    if (!isNonEmptyString(o.host)) {
      return {
        ok: false,
        field: 'host',
        reason: 'host must be a non-empty string',
      };
    }
    host = o.host;
  }

  let port: number | undefined;
  if (!isAbsent(o, 'port')) {
    if (!isIntegerInRange(o.port, MIN_PORT, MAX_PORT)) {
      return { ok: false, field: 'port', reason: PORT_REASON };
    }
    port = o.port as number;
  }

  return { ok: true, value: { host, port } };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/client-protocol.test.ts`
Expected: PASS, all tests.

Then: `bun run typecheck && bun run lint`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/client-protocol.ts tests/client-protocol.test.ts
git commit -m "feat(protocol): add pure client message recognition and validation

Shape recognition and per-type field checks with no socket dependency, so
the rules are unit testable directly. Not yet wired into parse()."
```

---

### Task 2: Wire the tri-state outcome through parse() — completes MWP-91

**Files:**
- Modify: `src/session-integration.ts:181-233` (`parseNewMessage`), and add `sendProtocolError`
- Modify: `wsproxy.ts:1902-1923` (`parse`)
- Test: `tests/parse-protocol.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:
  - `SessionIntegration.parseNewMessage(socket, data): ParseOutcome` — signature changed from `boolean`.
  - `SessionIntegration.sendProtocolError(socket: SocketExtended, outcome: { code: string; field?: string; reason: string }): void` — public, so `wsproxy.ts` can render a typed error.

- [ ] **Step 1: Write the failing test**

Create `tests/parse-protocol.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { SessionIntegration } from '../src/session-integration';
import type { SocketExtended } from '../src/types';

type Sent = string[];

const makeSocket = (sent: Sent): SocketExtended =>
  ({
    sendUTF: (s: string) => sent.push(s),
    send: (s: string) => sent.push(s),
    req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    remoteAddress: '127.0.0.1',
  }) as unknown as SocketExtended;

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('parseNewMessage outcomes', () => {
  let integration: SessionIntegration;
  let sent: Sent;
  let socket: SocketExtended;

  beforeEach(() => {
    integration = new SessionIntegration({});
    sent = [];
    socket = makeSocket(sent);
  });

  test('an unknown type is invalid, not forwarded', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ type: 'challenge' }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.code).toBe('invalid_request');
      expect(outcome.field).toBe('type');
      expect(outcome.reason).toContain('challenge');
    }
  });

  test('a known type with a bad field is invalid', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ type: 'naws', width: 80 }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.field).toBe('height');
  });

  test('a JSON object with neither type nor connect is not-ours', () => {
    const outcome = integration.parseNewMessage(socket, buf({ foo: 'bar' }));
    expect(outcome.kind).toBe('not-ours');
    if (outcome.kind === 'not-ours') {
      expect(outcome.parsedObject).toEqual({ foo: 'bar' });
    }
  });

  test('non-JSON is not-ours', () => {
    const outcome = integration.parseNewMessage(
      socket,
      Buffer.from('{not json at all'),
    );
    expect(outcome.kind).toBe('not-ours');
  });

  test('the error names the type and field but not the body', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ type: 'resume', sessionId: 'SECRET_ID', token: 'SECRET', lastSeq: -5 }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.field).toBe('lastSeq');
      expect(outcome.reason).not.toContain('SECRET');
    }
  });

  test('sendProtocolError emits a typed error frame', () => {
    integration.sendProtocolError(socket, {
      code: 'invalid_request',
      field: 'height',
      reason: 'height must be an integer between 1 and 65535',
    });
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('invalid_request');
    expect(parsed.field).toBe('height');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse-protocol.test.ts`
Expected: FAIL — `parseNewMessage` returns a boolean, `sendProtocolError` is not a function.

- [ ] **Step 3: Rewrite parseNewMessage**

In `src/session-integration.ts`, add to the imports at the top of the file:

```typescript
import {
  recognize,
  validateTyped,
  KNOWN_TYPES,
  type ParseOutcome,
  type KnownType,
} from './client-protocol';
```

Replace the body of `parseNewMessage` (currently `src/session-integration.ts:181-233`) with:

```typescript
  parseNewMessage(socket: SocketExtended, data: Buffer): ParseOutcome {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (_err) {
      // Not JSON: ordinary player input, belongs to the MUD.
      return { kind: 'not-ours' };
    }

    const recognition = recognize(parsed);
    if (recognition.shape === 'unrecognized') {
      return {
        kind: 'not-ours',
        parsedObject:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
      };
    }

    const o = parsed as Record<string, unknown>;

    if (recognition.shape === 'legacy') {
      // Wired in Task 4. Until then a legacy message is rejected rather than
      // forwarded, which is already an improvement on the current behaviour.
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: 'connect',
        reason: 'Legacy connect is not yet supported',
      };
    }

    if (!(KNOWN_TYPES as readonly string[]).includes(recognition.type)) {
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: 'type',
        reason: `Unknown message type: ${recognition.type}`,
      };
    }

    const validation = validateTyped(recognition.type, o);
    if (!validation.ok) {
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: validation.field,
        reason: validation.reason,
      };
    }

    const clientMsg = parsed as ClientMessage;

    if (socket.debug) {
      // Redact sensitive fields before logging
      const sanitized = { ...o };
      if ('token' in sanitized) sanitized.token = '***';
      if ('deviceToken' in sanitized) sanitized.deviceToken = '***';
      this.log(
        `client msg: ${JSON.stringify(sanitized)}`,
        this.getClientIP(socket),
      );
    }

    switch (recognition.type as KnownType) {
      case 'connect':
        void this.handleConnect(socket, clientMsg as ConnectRequest);
        return { kind: 'handled' };
      case 'resume':
        this.handleResume(socket, clientMsg as ResumeRequest);
        return { kind: 'handled' };
      case 'activityToken':
        this.handleActivityToken(socket, clientMsg as ActivityTokenRequest);
        return { kind: 'handled' };
      case 'syncAck':
        this.handleSyncAck(socket, clientMsg as SyncAckRequest);
        return { kind: 'handled' };
      case 'input':
        this.handleInput(socket, clientMsg as InputRequest);
        return { kind: 'handled' };
      case 'naws':
        this.handleNAWS(socket, clientMsg as NAWSRequest);
        return { kind: 'handled' };
      case 'disconnect':
        this.handleDisconnect(socket);
        return { kind: 'handled' };
    }
  }

  /**
   * Render a protocol-level rejection to a typed client. Legacy clients are
   * handled separately in openTelnetSession, which writes plaintext into the
   * telnet stream instead.
   */
  sendProtocolError(
    socket: SocketExtended,
    outcome: { code: string; field?: string; reason: string },
  ): void {
    const response = {
      type: 'error',
      code: outcome.code,
      field: outcome.field,
      message: outcome.reason,
    };
    try {
      socket.sendUTF(JSON.stringify(response));
    } catch (_err) {
      // Socket might be closed
    }
  }
```

Ensure the request types used in the casts are imported at the top of the file — `ConnectRequest`, `ResumeRequest`, `ActivityTokenRequest`, `SyncAckRequest`, `InputRequest`, `NAWSRequest` — adding any that are missing to the existing `import type` block.

- [ ] **Step 4: Rewire parse() in wsproxy.ts**

Replace `parse` (currently `wsproxy.ts:1902-1923`) with:

```typescript
  parse: function (s: SocketExtended, d: Buffer): number {
    if (d[0] !== '{'.charCodeAt(0)) return 0;

    const outcome = sessionIntegration.parseNewMessage(s, d);

    if (outcome.kind === 'handled') return 1;

    if (outcome.kind === 'invalid') {
      sessionIntegration.sendProtocolError(s, outcome);
      srv.logWarn(
        `rejected client message: field=${outcome.field ?? '-'} ${outcome.reason}`,
        s,
        'parse',
      );
      // Returning 1 is what stops the caller forwarding this to the MUD.
      return 1;
    }

    if (outcome.parsedObject) {
      // A JSON object carrying neither `type` nor `connect` is player input
      // that happens to be JSON, so this is debug rather than error.
      srv.logDebug(
        formatMissingTypeLogMessage(outcome.parsedObject, d.length),
        s,
        'parse',
      );
    }

    return 0;
  },
```

- [ ] **Step 5: Run the new tests, then the whole suite**

Run: `bun test tests/parse-protocol.test.ts`
Expected: PASS.

Run: `bun test tests/*.test.ts`
Expected: 779 baseline tests still pass plus the new ones. If `tests/client-request.test.ts` fails, it is asserting on the old boolean contract — update those assertions to the `ParseOutcome` shape; do not change production code to satisfy them.

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/session-integration.ts src/client-protocol.ts wsproxy.ts tests/parse-protocol.test.ts tests/client-request.test.ts
git commit -m "fix(parse): return invalid_request instead of forwarding to the MUD

parseNewMessage returned a boolean that conflated 'not my message, forward
to the MUD' with 'my message, but I could not handle it'. An unknown type or
a malformed field was therefore typed into the game as player input.

Replaces it with a tri-state ParseOutcome. An invalid recognized message now
returns 1 from parse(), which is what stops the caller forwarding it.

Also downgrades the no-type log from error to debug: under the new contract
that branch is legitimate player input that happens to be a JSON object, so
at error level every such keystroke logged an error.

Closes MWP-91."
```

---

### Task 3: Extract openTelnetSession — pure refactor, no behaviour change

**Files:**
- Modify: `src/session-integration.ts:244-402` (`handleConnect`)

**Interfaces:**
- Produces:
  - `type ConnectFlavor = 'typed' | 'legacy'`
  - `type ConnectCtx = { flavor: ConnectFlavor; host?: string; port?: number; deviceToken?: string; width?: number; height?: number; debug?: boolean }`
  - `SessionIntegration.openTelnetSession(socket: SocketExtended, ctx: ConnectCtx): Promise<void>` — private.
- `handleConnect` becomes a thin adapter that builds a `ConnectCtx` with `flavor: 'typed'` and calls it.

This task changes no behaviour. Its gate is that the existing suite still passes untouched.

- [ ] **Step 1: Confirm the current suite is green before refactoring**

Run: `bun test tests/*.test.ts`
Expected: PASS. Record the count; it must not drop in step 4.

- [ ] **Step 2: Add the types and extract the method**

In `src/session-integration.ts`, add near the other type declarations at the top:

```typescript
export type ConnectFlavor = 'typed' | 'legacy';

export interface ConnectCtx {
  flavor: ConnectFlavor;
  host?: string;
  port?: number;
  deviceToken?: string;
  width?: number;
  height?: number;
  debug?: boolean;
}
```

Replace `handleConnect` with the adapter plus the extracted method. The body of `openTelnetSession` is the current `handleConnect` body verbatim, with `msg.` replaced by `ctx.` and the two flavor-dependent points marked. Keep every comment already in that block — they document the reservation ordering and the DNS rebinding guard.

```typescript
  private async handleConnect(
    socket: SocketExtended,
    msg: ConnectRequest,
  ): Promise<void> {
    await this.openTelnetSession(socket, {
      flavor: 'typed',
      host: msg.host,
      port: msg.port,
      deviceToken: msg.deviceToken,
      width: msg.width,
      height: msg.height,
      debug: msg.debug,
    });
  }

  /**
   * Open a telnet session under the target policy, connection limits, and
   * DNS-rebinding guard. Both wire protocols come through here; ctx.flavor
   * changes only the success frame and how a rejection is rendered.
   */
  private async openTelnetSession(
    socket: SocketExtended,
    ctx: ConnectCtx,
  ): Promise<void> {
    const ip = this.getClientIP(socket);

    this.log(`connect request to ${ctx.host}:${ctx.port}`, ip);

    // Enable per-client debug logging if requested.
    // NOTE: this is a client-reachable verbosity toggle. MWP-94 item 1
    // removes it; carried across verbatim here to keep this a pure refactor.
    if (ctx.debug) socket.debug = ctx.debug;

    const target = validateTarget(ctx.host, ctx.port, this.config.targets);
    if (!target.allowed || !target.host || !target.port) {
      const reason = target.reason || 'Target not allowed';
      this.log(`connect rejected: ${reason}`, ip);
      this.rejectConnect(socket, ctx.flavor, 'invalid_request', reason);
      return;
    }

    if (ctx.deviceToken) {
      const limits = this.sessionManager.enforceConnectionLimits(
        ctx.deviceToken,
        ip,
      );
      if (!limits.allowed) {
        const reason = limits.reason || 'Connection limit exceeded';
        this.log(`connect rejected: ${reason}`, ip);
        this.rejectConnect(socket, ctx.flavor, 'rate_limited', reason);
        return;
      }
    }

    // Reserve capacity BEFORE any DNS or TCP work. enforceConnectionLimits
    // above consults counters that are only incremented once a dial
    // succeeds, so without this a client could issue many concurrent connect
    // frames and pass every check — and omitting deviceToken skipped the
    // device limit entirely. The reservation is released on every path out
    // of here; a leaked one is capacity that never returns (MWP-92).
    const reservation = this.sessionManager.reservePendingDial(ip);
    if (!reservation.allowed) {
      const reason = reservation.reason || 'Connection limit exceeded';
      this.log(`connect rejected: ${reason}`, ip);
      this.rejectConnect(socket, ctx.flavor, 'rate_limited', reason);
      return;
    }

    // In arbitrary mode the hostname is client-supplied, so resolve it and
    // confirm every answer is publicly routable before dialling. Resolution
    // happens once and we dial the address it returned — re-resolving between
    // validation and connect is the DNS rebinding hole.
    //
    // Deliberately last of the three checks: policy and connection limits are
    // both cheap and must gate the expensive step, so a client cannot drive
    // unbounded DNS lookups without consuming quota (MWP-92). Skipped entirely
    // in fixed and allowlist mode, where the target is operator-configured
    // rather than client-supplied.
    let dialAddress = target.host;
    if (this.config.targets?.targetMode === 'arbitrary') {
      const resolve = this.config.resolveTarget ?? resolveTargetAddress;
      const resolved = await resolve(target.host);
      if (!resolved.allowed || !resolved.address) {
        this.sessionManager.releasePendingDial(ip);
        const reason = resolved.reason || 'Target address is not permitted';
        this.log(`connect rejected: ${reason}`, ip);
        this.rejectConnect(socket, ctx.flavor, 'invalid_request', reason);
        return;
      }
      dialAddress = resolved.address;
    }

    const session = this.sessionManager.create(
      target.host,
      target.port,
      ctx.deviceToken,
      this.config.buffer.sizeKB * 1024,
      dialAddress,
      this.config.mudTlsMode ?? 'prefer',
    );
    // The session now owns this client's capacity; hand off from the
    // reservation so it is not counted twice.
    this.sessionManager.releasePendingDial(ip);

    if (ctx.deviceToken) {
      session.setDeviceToken(ctx.deviceToken);
    }
    if (ctx.width && ctx.height) {
      session.updateWindowSize(ctx.width, ctx.height);
    }

    this.sessionManager.attachWebSocket(session.id, socket);
    session.markClientForegrounded();
    this.backgroundPushScheduler.untrackSession(session.id);

    // Flavor difference 1 of 2: a legacy client has no session concept, so it
    // gets no frame at all — telnet data simply starts flowing.
    if (ctx.flavor === 'typed') {
      const response = {
        type: 'session',
        sessionId: session.id,
        token: session.authToken,
        capabilities: ['activityToken', 'syncAck', 'echoState'],
      };
      socket.sendUTF(JSON.stringify(response));
    }

    this.log(
      `session created for ${target.host}:${target.port}`,
      ip,
      session.id,
    );

    try {
      // Set up data and close handlers BEFORE connecting so no initial
      // MUD output (welcome banners, login prompts) is lost.
      session.onData((data: Buffer) => {
        this.processMudData(session, socket, data);
      });

      session.onClose(() => {
        this.handleMudTermination(session, 'MUD connection closed');
      });

      await session.connect();

      // Count this IP only after a successful connection; clientIp on the
      // session is what removeSession uses to decrement on teardown.
      if (ctx.deviceToken && ip !== 'unknown') {
        session.clientIp = ip;
        this.sessionManager.incrementIPCount(ip);
      }

      session.onError((err: Error) => {
        this.handleMudTermination(session, err.message);
      });
    } catch (err) {
      this.log(`connect failed: ${(err as Error).message}`, ip, session.id);
      this.rejectConnect(
        socket,
        ctx.flavor,
        'connection_failed',
        (err as Error).message,
      );
      this.removeSessionAndCleanup(session.id);
    }
  }

  /**
   * Flavor difference 2 of 2: render a rejection. The decision is already
   * made and identical for both protocols; only the rendering differs.
   * Legacy is filled in by Task 4.
   */
  private rejectConnect(
    socket: SocketExtended,
    flavor: ConnectFlavor,
    code: string,
    reason: string,
  ): void {
    if (flavor === 'typed') {
      this.sendError(socket, code, reason);
    }
  }
```

- [ ] **Step 3: Run the full suite — it must be unchanged**

Run: `bun test tests/*.test.ts`
Expected: the same pass count as step 1, 0 fail. Any difference means the extraction changed behaviour; find it before continuing.

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/session-integration.ts
git commit -m "refactor(session): extract openTelnetSession from handleConnect

Pure refactor, no behaviour change. handleConnect becomes an adapter that
builds a typed ConnectCtx; the policy sequence — validateTarget, connection
limits, reservePendingDial, DNS rebinding guard, session creation — moves to
openTelnetSession so the legacy protocol can share it rather than growing a
parallel implementation.

Carries the client-reachable debug toggle across verbatim; MWP-94 removes it."
```

---

### Task 4: Legacy connect flavor and second-connect rejection — completes MWP-90

**Files:**
- Modify: `src/session-integration.ts` — `rejectConnect`, `openTelnetSession`, `parseNewMessage`
- Test: `tests/parse-protocol.test.ts` (extend)

**Interfaces:**
- Consumes: `validateLegacy` from Task 1, `openTelnetSession` / `ConnectCtx` / `rejectConnect` from Task 3.
- Produces: legacy dispatch inside `parseNewMessage`; `SessionIntegration.setLegacyDefaults(host: string, port: number): void` so `wsproxy.ts` can supply `srv.tn_host` / `srv.tn_port` for the bare-connect case.

- [ ] **Step 1: Write the failing tests**

Append to `tests/parse-protocol.test.ts`:

```typescript
describe('legacy connect', () => {
  let integration: SessionIntegration;
  let sent: Sent;
  let socket: SocketExtended;

  beforeEach(() => {
    integration = new SessionIntegration({
      targets: {
        targetMode: 'fixed',
        defaultHost: 'mud.example.org',
        defaultPort: 4000,
      },
    });
    integration.setLegacyDefaults('mud.example.org', 4000);
    sent = [];
    socket = makeSocket(sent);
  });

  test('a well-formed legacy connect is handled, not forwarded', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ connect: 1, host: 'mud.example.org', port: 4000 }),
    );
    expect(outcome.kind).toBe('handled');
  });

  test('a bare connect is handled and uses the default target', () => {
    const outcome = integration.parseNewMessage(socket, buf({ connect: 1 }));
    expect(outcome.kind).toBe('handled');
  });

  test('a partially matching legacy object is invalid, not forwarded', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ connect: 1, host: 'mud.example.org', port: 'not-a-port' }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.field).toBe('port');
  });

  test('a legacy rejection writes plaintext, never a JSON error frame', async () => {
    const strict = new SessionIntegration({
      targets: {
        targetMode: 'fixed',
        defaultHost: 'mud.example.org',
        defaultPort: 4000,
      },
    });
    strict.setLegacyDefaults('mud.example.org', 4000);
    const legacySent: Sent = [];
    const legacySocket = makeSocket(legacySent);

    strict.parseNewMessage(
      legacySocket,
      buf({ connect: 1, host: 'evil.example', port: 4000 }),
    );
    await new Promise((r) => setTimeout(r, 50));

    for (const frame of legacySent) {
      expect(frame).not.toContain('"type":"error"');
    }
  });
});

describe('parity between protocols', () => {
  const cases = [
    { host: 'mud.example.org', port: 4000, expectAllowed: true },
    { host: 'evil.example', port: 4000, expectAllowed: false },
  ];

  for (const mode of ['fixed', 'allowlist', 'arbitrary'] as const) {
    for (const c of cases) {
      test(`${mode}: ${c.host}:${c.port} decides the same on both protocols`, async () => {
        const config = {
          targets: {
            targetMode: mode,
            defaultHost: 'mud.example.org',
            defaultPort: 4000,
            allowedTargets: ['mud.example.org:4000'],
            arbitraryAllowedPorts: [4000],
          },
          resolveTarget: async () => ({ allowed: false, reason: 'blocked' }),
        };

        const typedSent: Sent = [];
        const typed = new SessionIntegration(config);
        typed.setLegacyDefaults('mud.example.org', 4000);
        typed.parseNewMessage(
          makeSocket(typedSent),
          buf({ type: 'connect', host: c.host, port: c.port }),
        );

        const legacySent: Sent = [];
        const legacy = new SessionIntegration(config);
        legacy.setLegacyDefaults('mud.example.org', 4000);
        legacy.parseNewMessage(
          makeSocket(legacySent),
          buf({ connect: 1, host: c.host, port: c.port }),
        );

        await new Promise((r) => setTimeout(r, 50));

        const typedDenied = typedSent.some((f) => f.includes('"type":"error"'));
        const legacyDenied = legacySent.some((f) => f.includes('denied') || f.includes('not allow'));

        // The rendering differs; the decision must not.
        expect(typedDenied).toBe(legacyDenied);
      });
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/parse-protocol.test.ts`
Expected: FAIL — `setLegacyDefaults` is not a function, and legacy messages return `invalid` with "not yet supported".

- [ ] **Step 3: Implement the legacy flavor**

In `src/session-integration.ts`:

Add the import for `validateLegacy` to the `./client-protocol` import added in Task 2.

Add the field and setter to the class:

```typescript
  private legacyDefaultHost = '';
  private legacyDefaultPort = 0;

  /**
   * Supply the default target used when a legacy client sends a bare
   * `{connect: 1}` with no host or port. wsproxy.ts passes srv.tn_host and
   * srv.tn_port, matching initT's historical fallback.
   */
  setLegacyDefaults(host: string, port: number): void {
    this.legacyDefaultHost = host;
    this.legacyDefaultPort = port;
  }
```

Replace the legacy placeholder in `parseNewMessage` (added in Task 2) with:

```typescript
    if (recognition.shape === 'legacy') {
      const legacy = validateLegacy(o);
      if (!legacy.ok) {
        return {
          kind: 'invalid',
          code: 'invalid_request',
          field: legacy.field,
          reason: legacy.reason,
        };
      }
      void this.openTelnetSession(socket, {
        flavor: 'legacy',
        host: legacy.value.host ?? this.legacyDefaultHost,
        port: legacy.value.port ?? this.legacyDefaultPort,
      });
      return { kind: 'handled' };
    }
```

Complete `rejectConnect` so the legacy branch renders plaintext:

```typescript
  private rejectConnect(
    socket: SocketExtended,
    flavor: ConnectFlavor,
    code: string,
    reason: string,
  ): void {
    if (flavor === 'typed') {
      this.sendError(socket, code, reason);
      return;
    }
    // A legacy client renders whatever bytes arrive, so a JSON frame would
    // be printed into the player's terminal — the failure MWP-91 exists to
    // prevent. Write a human-readable line instead, then close.
    try {
      socket.sendUTF(`\r\n${reason}\r\n`);
    } catch (_err) {
      // Socket might be closed
    }
    setTimeout(() => {
      try {
        socket.terminate();
      } catch (_err) {
        // Already gone
      }
    }, LEGACY_REJECT_CLOSE_DELAY_MS);
  }
```

Add the constant near the other module constants:

```typescript
/** Grace period so a rejected legacy client can render the reason. */
const LEGACY_REJECT_CLOSE_DELAY_MS = 1000;
```

Add the second-connect guard at the very top of `openTelnetSession`, immediately after `const ip = this.getClientIP(socket);`:

```typescript
    // MWP-90: one connect per socket, on both protocols.
    if (this.sessionManager.findByWebSocket(socket)) {
      const reason = 'This connection already has a session';
      this.log(`connect rejected: ${reason}`, ip);
      this.rejectConnect(socket, ctx.flavor, 'invalid_request', reason);
      return;
    }
```

- [ ] **Step 4: Wire the defaults from wsproxy.ts**

In `wsproxy.ts`, where `sessionIntegration` is configured during `init()`, add:

```typescript
    sessionIntegration.setLegacyDefaults(srv.tn_host, srv.tn_port);
```

Locate the existing `sessionIntegration` configuration call with:

```bash
grep -n "sessionIntegration\." wsproxy.ts | head -20
```

Place the new call alongside the other setup calls, before the server begins accepting connections.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/parse-protocol.test.ts`
Expected: PASS, including the six parity cases.

Run: `bun test tests/*.test.ts`
Expected: no regressions.

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/session-integration.ts wsproxy.ts tests/parse-protocol.test.ts
git commit -m "feat(protocol): restore legacy connect under the shared policy path

A legacy {host, port, connect} message reached no handler and was forwarded
to the MUD as raw player input. It now routes through openTelnetSession, so
it gets the identical target policy, connection limits, dial reservation, and
DNS-rebinding guard as the typed protocol — one code path, not two.

Only the rendering differs: legacy clients get no session frame on success
and a plaintext line plus close on rejection, because a JSON error frame
would be printed into the player's terminal.

A bare {connect: 1} means the default target, matching initT's historical
fallback, and is still subject to validateTarget.

Rejects a second connect on a socket that already has a session, on both
protocols.

Closes MWP-90."
```

---

### Task 5: Process-level tests against a live server

**Files:**
- Create: `tests/e2e/legacy-protocol.test.ts`

**Interfaces:**
- Consumes: the e2e helpers `tests/e2e/proxy-launcher.ts`, `tests/e2e/mock-mud-helper.ts`, `tests/e2e/connection-helper.ts`.

MWP-90 requires process-level coverage: unit tests over `parse()` cannot catch a divergence in limit reservation or auth ordering, which is the failure mode that matters.

- [ ] **Step 1: Extend ProxyConfig so the auth test can set credentials**

`ProxyConfig` (`tests/e2e/proxy-launcher.ts:22-25`) declares only `TN_HOST` and `TN_PORT`, but `startTestProxy` already reads `extraEnv?.MUD_TLS_MODE` — a pre-existing gap that TypeScript does not catch because the read is on an optional. Assertion 5 needs two more, so declare all four:

```typescript
export interface ProxyConfig {
  TN_HOST?: string;
  TN_PORT?: string;
  MUD_TLS_MODE?: string;
  AUTH_MODE?: string;
  PROXY_SHARED_SECRET?: string;
}
```

Then thread the two new values through the `env` block in `startTestProxy`, next to the existing entries:

```typescript
        AUTH_MODE: extraEnv?.AUTH_MODE || 'none',
        ...(extraEnv?.PROXY_SHARED_SECRET
          ? { PROXY_SHARED_SECRET: extraEnv.PROXY_SHARED_SECRET }
          : {}),
```

- [ ] **Step 2: Write the failing tests**

Create `tests/e2e/legacy-protocol.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startMockMUDTest, type MockMUDSetup } from './mock-mud-helper';
import { startTestProxy } from './proxy-launcher';
import { createIREMUD } from './mock-mud';

const PROXY_PORT = 6321;
const SETTLE_MS = 1500;

const settle = (ms = SETTLE_MS) => new Promise((r) => setTimeout(r, ms));

/** Open a raw socket. E2EConnection hardcodes a typed connect, so the legacy
 *  protocol needs the WebSocket directly. */
const openRaw = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    };
  });

/** Collect every frame the proxy sends, as text. */
const collect = (ws: WebSocket): string[] => {
  const frames: string[] = [];
  ws.onmessage = (ev: MessageEvent) => {
    frames.push(
      typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString(),
    );
  };
  return frames;
};

describe('legacy connect protocol, process-level', () => {
  let setup: MockMUDSetup;

  beforeAll(async () => {
    setup = await startMockMUDTest('ire', PROXY_PORT);
  });

  afterAll(async () => {
    await setup.stop();
  });

  test('1. a legacy connect opens a telnet session', async () => {
    setup.mockServer.clearReceivedCommands();
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(
      JSON.stringify({
        connect: 1,
        host: 'localhost',
        port: setup.mockServer['config'].port,
      }),
    );
    await settle();

    // The MUD banner reaching the client proves the telnet session opened.
    expect(frames.length).toBeGreaterThan(0);
    ws.close();
  });

  test('2. a legacy connect to a disallowed target is denied in plaintext', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'evil.example', port: 4000 }));
    await settle();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    // Legacy clients render bytes, so a JSON error frame would be printed
    // into the player's terminal. It must be plaintext.
    expect(joined).not.toContain('"type":"error"');
    ws.close();
  });

  test('3. a typo\'d control message never reaches the MUD', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(
      JSON.stringify({
        type: 'connect',
        host: 'localhost',
        port: setup.mockServer['config'].port,
        deviceToken: 'e2e-legacy',
      }),
    );
    await settle();
    setup.mockServer.clearReceivedCommands();

    // `hieght` is a typo. Under the old contract the whole blob was typed
    // into the game; it must now come back as invalid_request instead.
    ws.send(JSON.stringify({ type: 'naws', width: 80, hieght: 24 }));
    await settle();

    const received = setup.mockServer.getReceivedCommands().join('\n');
    expect(received).not.toContain('hieght');
    expect(received).not.toContain('naws');

    const joined = frames.join('');
    expect(joined).toContain('invalid_request');
    ws.close();
  });

  test('4. a second connect on the same socket is rejected', async () => {
    setup.mockServer.clearReceivedCommands();
    const ws = await openRaw(setup.url);
    const frames = collect(ws);
    const port = setup.mockServer['config'].port;

    ws.send(
      JSON.stringify({
        type: 'connect',
        host: 'localhost',
        port,
        deviceToken: 'e2e-second',
      }),
    );
    await settle();

    const before = frames.length;
    ws.send(JSON.stringify({ type: 'connect', host: 'localhost', port }));
    await settle();

    const added = frames.slice(before).join('');
    expect(added).toContain('already has a session');
    ws.close();
  });

  test('4b. a second legacy connect is rejected too', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);
    const port = setup.mockServer['config'].port;

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port }));
    await settle();

    const before = frames.length;
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port }));
    await settle();

    const added = frames.slice(before).join('');
    expect(added).toContain('already has a session');
    expect(added).not.toContain('"type":"error"');
    ws.close();
  });
});

describe('legacy connect under shared-secret auth', () => {
  const AUTH_PORT = 6322;
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;

  beforeAll(async () => {
    mock = createIREMUD();
    await mock.start();
    proxy = await startTestProxy(AUTH_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mock['config'].port.toString(),
      AUTH_MODE: 'shared-secret',
      PROXY_SHARED_SECRET: 'a'.repeat(64),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('5. an unauthenticated legacy connect is rejected at the upgrade', async () => {
    mock.clearReceivedCommands();

    // MWP-90 requires the legacy path to enforce identical authentication.
    // Auth lives at the upgrade, so the socket never opens without it — and
    // the rejection must consume no session or limit capacity.
    await expect(openRaw(proxy.url)).rejects.toThrow();
    await settle(500);

    expect(mock.getReceivedCommands()).toHaveLength(0);
  });
});
```

Assertion 3 is the one MWP-91 names explicitly: the typo'd message must not reach the MUD's received-input log.

Note on assertion 4: the expected substring `already has a session` must match the `reason` string used in Task 4's second-connect guard. If you changed that wording, change it here too.

- [ ] **Step 3: Run the tests**

Run: `bun run test:mock`
Expected: the five new assertions pass alongside the existing mock suite.

If the e2e harness cannot spawn `bun` in this environment, report that rather than weakening the assertions — the memory notes E2E tests failing in dev for that reason. In that case verify by running the mock suite in CI and record the outcome.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/legacy-protocol.test.ts tests/e2e/proxy-launcher.ts
git commit -m "test(e2e): process-level coverage for both wire protocols

Drives a real WebSocket against a live server instance: legacy connect opens
a session, a disallowed legacy target is denied, a typo'd control message
never reaches the mock MUD's received-input log, a second connect is rejected
on both protocols, and an unauthenticated legacy connect is rejected at the
upgrade under AUTH_MODE=shared-secret.

The auth assertion is MWP-90's criterion, which could not be tested before
because the legacy path did not exist."
```

---

### Task 6: Document the legacy protocol as supported but frozen

**Files:**
- Modify: `docs/mud-proxy-guide.md`

MWP-90 item 6 requires the legacy protocol to be documented. Phase 3 owns the full protocol reference; this task adds the section it will absorb.

- [ ] **Step 1: Find the protocol section**

Run:

```bash
grep -n "^#\{1,3\} " docs/mud-proxy-guide.md
```

- [ ] **Step 2: Add the section**

Add a "Legacy connect protocol" section documenting:

- The wire format: `{"connect": 1, "host": "<host>", "port": <port>}`, with `host` and `port` both optional; a bare `{"connect": 1}` means the configured default target.
- That it is **supported but frozen** — it receives no new fields or message types, and new clients must use the typed protocol.
- That it is subject to identical target policy, authentication, and connection limits as the typed protocol, because both call `openTelnetSession`. Authentication is enforced at the WebSocket upgrade, so it applies to both by construction.
- That on success no frame is sent — telnet data begins flowing immediately.
- That on rejection the client receives a plaintext line followed by a close, not a JSON error frame.
- That a second connect on the same socket is rejected.

- [ ] **Step 3: Verify docs and commit**

Run: `bun run lint`
Expected: clean.

```bash
git add docs/mud-proxy-guide.md
git commit -m "docs: document the legacy connect protocol as supported but frozen"
```

---

## Pre-merge gate

Before opening the PR:

- [ ] `bun run test` — full suite with coverage, 0 fail
- [ ] `bun run test:mock` — process-level suite, 0 fail
- [ ] `bun run typecheck` — clean
- [ ] `bun run lint` — no new errors (the repo has pre-existing `_err` unused-var errors and a parsing error in `src/index.ts`; neither is yours)
- [ ] **Confirm against MUDBasher that it sends no message type outside the seven in `KNOWN_TYPES`.** Unknown-type-becomes-error is a wire-protocol behaviour change. Repo evidence says the client sends only those seven, but MUDBasher is external to this repo. If it sends anything else — including forward-compatibility probes — either fix the client first or add an ignore-list for known-benign types, which changes the recognition table in Task 1.

## Follow-ups, not this PR

- `initT` and `newSocket` are dead and, once legacy routes through the session stack, deletable — along with their coverage in `tests/socket-management.test.ts` and `tests/client-request.test.ts`. Needs its own ticket.
- The client-reachable debug toggle carried across in Task 3 (`if (ctx.debug) socket.debug = ctx.debug`) belongs to MWP-94 item 1.
- Central log redaction is MWP-94.
