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
    const legacySent: Sent = [];
    const legacySocket = makeSocket(legacySent);

    integration.parseNewMessage(
      legacySocket,
      buf({ connect: 1, host: 'evil.example', port: 4000 }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(legacySent.length).toBeGreaterThan(0);
    for (const frame of legacySent) {
      expect(frame).not.toContain('"type":"error"');
    }
  });
});

describe('parity between protocols', () => {
  const cases = [
    { host: 'mud.example.org', port: 4000, label: 'allowed target' },
    { host: 'evil.example', port: 4000, label: 'disallowed target' },
  ];

  for (const mode of ['fixed', 'allowlist', 'arbitrary'] as const) {
    for (const c of cases) {
      test(`${mode}: ${c.label} decides the same on both protocols`, async () => {
        const config = {
          targets: {
            targetMode: mode,
            defaultHost: 'mud.example.org',
            defaultPort: 4000,
            allowedTargets: ['mud.example.org:4000'],
            // Ports-and-ranges entries are strings, not numbers.
            arbitraryAllowedPorts: ['4000'],
          },
          // In arbitrary mode the resolver is a second policy gate, applied
          // after validateTarget. It mirrors the host decision so the oracle
          // below can model both gates.
          resolveTarget: async (host: string) =>
            host === 'mud.example.org'
              ? { allowed: true, address: '127.0.0.1' }
              : { allowed: false, reason: 'blocked by test resolver' },
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

        await new Promise((r) => setTimeout(r, 60));

        // validateTarget is the oracle: this asserts both protocols route
        // through it and surface its verdict, not that they merely both
        // errored. A dial failure ("getaddrinfo ENOTFOUND") is not a policy
        // denial and must not be mistaken for one.
        const verdict = validateTarget(c.host, c.port, config.targets);
        let policyReason: string | null = verdict.allowed
          ? null
          : verdict.reason || 'Target not allowed';
        // Arbitrary mode applies the rebinding guard as a second gate.
        if (!policyReason && mode === 'arbitrary') {
          const resolved = await config.resolveTarget(c.host);
          if (!resolved.allowed) {
            policyReason = resolved.reason || 'Target address is not permitted';
          }
        }

        const typedAll = typedSent.join('');
        const legacyAll = legacySent.join('');

        if (policyReason) {
          // Denied: both carry the same reason, rendered differently.
          expect(typedAll).toContain('"code":"invalid_request"');
          expect(typedAll).toContain(policyReason);
          expect(legacyAll).toContain(policyReason);
          expect(legacyAll).not.toContain('"type":"error"');
          // A denied target is never dialled.
          expect(typedAll).not.toContain('"type":"session"');
        } else {
          // Allowed: neither may report a policy denial. The typed client
          // gets a session frame; the legacy client deliberately gets none.
          expect(typedAll).not.toContain('"code":"invalid_request"');
          expect(legacyAll).not.toContain('invalid_request');
          expect(typedAll).toContain('"type":"session"');
          expect(legacyAll).not.toContain('"type":"session"');
        }
      });
    }
  }
});
