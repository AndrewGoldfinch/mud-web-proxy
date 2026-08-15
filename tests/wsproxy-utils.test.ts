import { asDouble } from './support/doubles';
import { describe, expect, test } from 'bun:test';
import { getRuntimeConfig } from '../src/runtime-config.js';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  authorizeApnsDebugRequest,
  encodeTelnetOutbound,
  formatMissingTypeLogMessage,
  readLimitedRequestBody,
  sendBase64IfOpen,
} from '../src/wsproxy-utils.js';

class MockRequest extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class MockResponse {
  writeHeadCalls: Array<{
    statusCode: number;
    headers: Record<string, string>;
  }> = [];
  endCalls: string[] = [];

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.writeHeadCalls.push({ statusCode, headers });
    return this;
  }

  end(data?: string): this {
    this.endCalls.push(data ?? '');
    return this;
  }
}

describe('wsproxy utility regressions', () => {
  test('an unparseable push interval aborts startup, it is not dropped', () => {
    // This replaces a test that asserted the opposite: that
    // ACTIVITY_PUSH_ACK_TIMEOUT_MS='not-a-number' silently became undefined.
    // That test described a second, laxer parser for six variables the config
    // module already owned — and blessed the silent fallback MWP-80 exists to
    // remove. An operator who mistypes a timing value should be told, not have
    // the setting quietly vanish.
    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        ACTIVITY_PUSH_ACK_TIMEOUT_MS: 'not-a-number',
      }),
    ).toThrow(/ACTIVITY_PUSH_ACK_TIMEOUT_MS/);
  });

  test('an explicit zero is preserved, not treated as unset', () => {
    // The one property worth keeping from the removed test: 0 is a meaningful
    // value for an interval and must survive the optional-integer path.
    const { backgroundPush } = getRuntimeConfig({
      INBOUND_TLS_MODE: 'off',
      SILENT_PUSH_INTERVAL_MS: '0',
      ACTIVITY_PUSH_INTERVAL_MS: '1500',
    });
    expect(backgroundPush).toMatchObject({
      silentPushIntervalMs: 0,
      activityPushIntervalMs: 1500,
    });
  });

  test('requires authenticated diagnostics and APNS secret', () => {
    const config = { diagnosticsEnabled: true, adminToken: 'admin-secret' };

    expect(
      authorizeApnsDebugRequest(
        { 'x-apns-test-secret': 'debug-secret' },
        config,
        'debug-secret',
      ),
    ).toBe('diagnosticUnauthorized');

    expect(
      authorizeApnsDebugRequest(
        {
          'x-admin-token': 'admin-secret',
          'x-apns-test-secret': 'debug-secret',
        },
        config,
        'debug-secret',
      ),
    ).toBe('authorized');

    expect(
      authorizeApnsDebugRequest(
        {
          authorization: 'Bearer admin-secret',
          'x-apns-test-secret': 'wrong-secret',
        },
        config,
        'debug-secret',
      ),
    ).toBe('invalidSecret');

    expect(authorizeApnsDebugRequest({}, config, '')).toBe('disabled');
  });

  test('oversized HTTP bodies send only one 413 response', async () => {
    const req = new MockRequest();
    const res = new MockResponse();
    const seenSizes: number[] = [];

    const bodyPromise = readLimitedRequestBody(
      asDouble<IncomingMessage>()(req),
      asDouble<ServerResponse>()(res),
      8,
      (bodySize) => seenSizes.push(bodySize),
    );

    req.emit('data', Buffer.alloc(9));
    req.emit('data', Buffer.alloc(9));
    req.emit('end');

    await expect(bodyPromise).resolves.toBeNull();
    expect(req.destroyed).toBe(true);
    expect(seenSizes).toEqual([9]);
    expect(res.writeHeadCalls).toHaveLength(1);
    expect(res.writeHeadCalls[0]).toMatchObject({ statusCode: 413 });
    expect(res.endCalls).toHaveLength(1);
  });

  test('encodes legacy telnet sends as UTF-8 after negotiation', () => {
    expect(encodeTelnetOutbound('漢字', true)).toEqual(
      Buffer.from('漢字', 'utf8'),
    );
    expect(encodeTelnetOutbound('é', false)).toEqual(Buffer.from([0xe9]));
    const raw = Buffer.from([0, 255, 42]);
    expect(encodeTelnetOutbound(raw, true)).toEqual(raw);
  });

  test('does not send base64 data to non-open sockets', () => {
    const sent: string[] = [];

    expect(
      sendBase64IfOpen(
        {
          readyState: 3,
          send: (data) => sent.push(data),
        },
        Buffer.from('closed'),
      ),
    ).toBe(false);
    expect(sent).toEqual([]);

    expect(
      sendBase64IfOpen(
        {
          readyState: 1,
          send: (data) => sent.push(data),
        },
        Buffer.from('open'),
      ),
    ).toBe(true);
    expect(sent).toEqual([Buffer.from('open').toString('base64')]);
  });

  test('missing-type logs avoid raw client message content', () => {
    const message = formatMissingTypeLogMessage(
      { username: 'player', password: 'super-secret' },
      49,
      '{"username":"player","password":"super-secret"}',
    );

    expect(message).toContain('Ignoring JSON message without type field');
    expect(message).toContain('bytes=49');
    expect(message).toContain('keys=username,password');
    expect(message).not.toContain('super-secret');
  });
});
