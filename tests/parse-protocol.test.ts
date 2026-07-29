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
