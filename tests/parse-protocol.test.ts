import { describe, test, expect, beforeEach } from 'bun:test';
import { SessionIntegration } from '../src/session-integration';
import { validateTarget } from '../src/target-policy';
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
      buf({
        type: 'resume',
        sessionId: 'SECRET_ID',
        token: 'SECRET',
        lastSeq: -5,
      }),
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

describe('legacy connect recognition', () => {
  let integration: SessionIntegration;
  let socket: SocketExtended;

  beforeEach(() => {
    integration = new SessionIntegration({
      targets: {
        targetMode: 'fixed',
        defaultHost: 'mud.example.org',
        defaultPort: 4000,
      },
    });
    socket = makeSocket([]);
  });

  test('a well-formed legacy connect yields legacy-connect, not handled', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ connect: 1, host: 'mud.example.org', port: 4000 }),
    );
    expect(outcome.kind).toBe('legacy-connect');
    if (outcome.kind === 'legacy-connect') {
      expect(outcome.host).toBe('mud.example.org');
      expect(outcome.port).toBe(4000);
    }
  });

  test('a bare connect yields legacy-connect with no host or port', () => {
    // The caller substitutes TN_HOST/TN_PORT; parse does not invent them.
    const outcome = integration.parseNewMessage(socket, buf({ connect: 1 }));
    expect(outcome.kind).toBe('legacy-connect');
    if (outcome.kind === 'legacy-connect') {
      expect(outcome.host).toBeUndefined();
      expect(outcome.port).toBeUndefined();
    }
  });

  test('a partially matching legacy object is invalid, and carries the legacy flavor', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ connect: 1, host: 'mud.example.org', port: 'not-a-port' }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.field).toBe('port');
      // The flavor is what makes parse() render plaintext rather than a JSON
      // frame a legacy client would print into the player's terminal.
      expect(outcome.flavor).toBe('legacy');
    }
  });

  test('a typed message carries the typed flavor', () => {
    const outcome = integration.parseNewMessage(
      socket,
      buf({ type: 'naws', width: 80 }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.flavor).toBe('typed');
  });

  test('a legacy connect never creates a session', () => {
    integration.parseNewMessage(
      socket,
      buf({ connect: 1, host: 'mud.example.org', port: 4000 }),
    );
    // The legacy protocol dials raw telnet in wsproxy.ts. A Session here
    // would mean typed JSON envelopes and a resume token it cannot use.
    expect(integration.sessionManager.getActiveCount()).toBe(0);
  });
});

describe('authorizeConnect: the one policy path', () => {
  // Both protocols call this exact function, so parity is structural rather
  // than a property two implementations have to be checked against. These
  // cases pin the decisions themselves.
  const settle = (d: unknown) =>
    d instanceof Promise ? d : Promise.resolve(d);

  const build = (mode: 'fixed' | 'allowlist' | 'arbitrary') =>
    new SessionIntegration({
      targets: {
        targetMode: mode,
        defaultHost: 'mud.example.org',
        defaultPort: 4000,
        allowedTargets: ['mud.example.org:4000'],
        arbitraryAllowedPorts: ['4000'],
      },
      resolveTarget: async (host: string) =>
        host === 'mud.example.org'
          ? { allowed: true, address: '127.0.0.1' }
          : { allowed: false, reason: 'blocked by test resolver' },
    });

  for (const mode of ['fixed', 'allowlist', 'arbitrary'] as const) {
    test(`${mode}: the configured target is allowed`, async () => {
      const si = build(mode);
      const decision = await settle(
        si.authorizeConnect(makeSocket([]), {
          host: 'mud.example.org',
          port: 4000,
        }),
      );
      expect(decision.allowed).toBe(true);
    });

    test(`${mode}: an unlisted target is denied`, async () => {
      const si = build(mode);
      const decision = await settle(
        si.authorizeConnect(makeSocket([]), {
          host: 'evil.example',
          port: 4000,
        }),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBeTruthy();
    });
  }

  test('fixed and allowlist decide synchronously', () => {
    // Rejections must reach the socket in the tick the message was parsed.
    for (const mode of ['fixed', 'allowlist'] as const) {
      const si = build(mode);
      const decision = si.authorizeConnect(makeSocket([]), {
        host: 'evil.example',
        port: 4000,
      });
      expect(decision).not.toBeInstanceOf(Promise);
    }
  });

  test('arbitrary defers only for the DNS rebinding guard', () => {
    const si = build('arbitrary');
    const decision = si.authorizeConnect(makeSocket([]), {
      host: 'mud.example.org',
      port: 4000,
    });
    expect(decision).toBeInstanceOf(Promise);
  });

  test('a denied target releases the dial reservation', async () => {
    const si = build('arbitrary');
    const socket = makeSocket([]);
    const decision = await settle(
      si.authorizeConnect(socket, { host: 'evil.example', port: 4000 }),
    );
    expect(decision.allowed).toBe(false);
    // A leaked reservation is capacity that never returns (MWP-92).
    expect(si.sessionManager.pendingDials('127.0.0.1')).toBe(0);
  });
});
