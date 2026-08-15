import { parseFrame, type ProxyFrame } from './support/frames';
import { asDouble } from './support/doubles';
import { describe, test, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { PROTOCOL_CONSTANTS } from '../src/protocol-constants.js';
import {
  escapeDiagnosticHtml,
  getRuntimeConfig,
  isDiagnosticRequestAuthorized,
  resolveTlsSettings,
} from '../src/runtime-config.js';
import { SessionIntegration } from '../src/session-integration.js';
import { validateTarget } from '../src/target-policy.js';
import type { SocketExtended } from '../src/types/index.js';

interface MockSocket extends SocketExtended {
  messages: string[];
}

const integrations: SessionIntegration[] = [];

function makeSocket(): MockSocket {
  const messages: string[] = [];
  const socket = asDouble<MockSocket>()(new EventEmitter());

  socket.readyState = 1;
  socket.remoteAddress = '127.0.0.1';
  socket.messages = messages;
  socket.ttype = [];
  socket.compressed = 0;
  socket.sendUTF = (data: string | Buffer) => {
    messages.push(String(data));
  };
  socket.send = (data: Parameters<MockSocket['send']>[0]) => {
    messages.push(String(data));
  };
  socket.terminate = () => {};
  socket.req = asDouble<MockSocket['req']>()({
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    url: '/',
    method: 'GET',
  });

  return socket;
}

function parseLastMessage(socket: MockSocket): ProxyFrame {
  const raw = socket.messages.at(-1);
  if (!raw) throw new Error('socket has no messages');
  return parseFrame(raw);
}

function makeSessionIntegration(): SessionIntegration {
  const integration = new SessionIntegration({
    sessions: { timeoutHours: 24, maxPerDevice: 5, maxPerIP: 10 },
    targets: {
      targetMode: 'fixed' as const,
      defaultHost: 'allowed.example.com',
      defaultPort: 4000,
    },
  });
  integrations.push(integration);
  return integration;
}

afterEach(() => {
  for (const integration of integrations.splice(0)) {
    integration.shutdown();
  }
});

describe('open-source release regression coverage', () => {
  test('session connect rejects non-default target host', () => {
    const integration = makeSessionIntegration();
    const socket = makeSocket();

    const handled = integration.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'blocked.example.com',
          port: 4000,
          deviceToken: 'dev-1',
        }),
      ),
    );

    // The message is recognized and dispatched; handleConnect then rejects
    // the target. parseNewMessage returns a ParseOutcome, not a boolean.
    expect(handled.kind).toBe('handled');
    expect(parseLastMessage(socket)).toMatchObject({
      type: 'error',
      code: 'invalid_request',
    });
    expect(integration.sessionManager.getActiveCount()).toBe(0);
  });

  test('session connect rejects non-default target port', () => {
    const integration = makeSessionIntegration();
    const socket = makeSocket();

    integration.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'allowed.example.com',
          port: 4001,
          deviceToken: 'dev-1',
        }),
      ),
    );

    expect(parseLastMessage(socket)).toMatchObject({
      type: 'error',
      code: 'invalid_request',
    });
    expect(integration.sessionManager.getActiveCount()).toBe(0);
  });

  test('target allowlist rejects targets not explicitly listed', () => {
    const policy = {
      targetMode: 'allowlist' as const,
      defaultHost: 'default.example.com',
      defaultPort: 4000,
      allowedTargets: ['aardmud.org:4000', 'achaea.com:23'],
    };

    expect(validateTarget('aardmud.org', 4000, policy)).toMatchObject({
      allowed: true,
    });
    expect(validateTarget('example.net', 4000, policy)).toMatchObject({
      allowed: false,
      reason: 'Target is not in ALLOWED_TARGETS',
    });
  });

  test('diagnostic HTML escaping handles user-controlled values', () => {
    expect(escapeDiagnosticHtml(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
  });

  test('diagnostic auth is disabled by default and accepts admin tokens only', () => {
    const config = { diagnosticsEnabled: true, adminToken: 'secret-token' };

    expect(isDiagnosticRequestAuthorized({}, config)).toBe(false);
    expect(
      isDiagnosticRequestAuthorized({ 'x-admin-token': 'wrong' }, config),
    ).toBe(false);
    expect(
      isDiagnosticRequestAuthorized(
        { 'x-admin-token': 'secret-token' },
        config,
      ),
    ).toBe(true);
    expect(
      isDiagnosticRequestAuthorized(
        { authorization: 'Bearer secret-token' },
        config,
      ),
    ).toBe(true);
    expect(
      isDiagnosticRequestAuthorized(
        { 'x-admin-token': 'secret-token' },
        { diagnosticsEnabled: false, adminToken: 'secret-token' },
      ),
    ).toBe(false);
  });

  test('protocol constants use valid MXP ESC and CHARSET ACCEPTED UTF-8 bytes', () => {
    expect(PROTOCOL_CONSTANTS.ESC).toBe(27);
    expect(PROTOCOL_CONSTANTS.ACCEPT_UTF8).toEqual(
      Buffer.from([255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240]),
    );
  });

  test('bare defaults refuse to start without usable TLS material', () => {
    // INBOUND_TLS_MODE defaults to `required` (MWP-81). Previously that
    // default was not enforced — startup succeeded and served plain HTTP,
    // so the setting was accepted and then ignored. Serving plaintext is now
    // something an operator has to ask for.
    expect(() =>
      getRuntimeConfig({ TLS_CERT_PATH: '/nonexistent/cert.pem' }),
    ).toThrow(/TLS/i);
  });

  test('runtime environment defaults are safe for private self-hosting', () => {
    // TLS is opted out of here so the remaining defaults can be asserted;
    // the default TLS posture is covered by the test above.
    expect(getRuntimeConfig({ INBOUND_TLS_MODE: 'off' })).toMatchObject({
      wsPort: 6200,
      tnHost: 'muds.maldorne.org',
      tnPort: 5010,
      onlyAllowDefaultServer: true,
      requireAppAuth: false,
      diagnosticsEnabled: false,
      adminToken: '',
      inboundTlsMode: 'off',
      bindHost: '127.0.0.1',
    });
  });

  test('tracked real-MUD env examples are opt-in', () => {
    const examples = [
      '.env.aardwolf.example',
      '.env.achaea.example',
      '.env.discworld.example',
      '.env.ire.example',
      '.env.raw.example',
      '.env.rom.example',
    ];

    for (const example of examples) {
      const contents = readFileSync(example, 'utf8');
      expect(contents).toContain('ENABLED=false');
      expect(contents).not.toContain('ENABLED=true');
    }
  });

  test('cannot silently run without TLS', () => {
    // The refusal moved to getRuntimeConfig, which runs first and is the only
    // place that decides whether plaintext is acceptable. MWP-95 removed
    // resolveTlsSettings' NODE_ENV-keyed copy of the same rule.
    expect(() =>
      getRuntimeConfig({ TLS_CERT_PATH: '/nonexistent/cert.pem' }),
    ).toThrow(/TLS/i);

    expect(() => getRuntimeConfig({ DISABLE_TLS: '1' })).toThrow(
      /DISABLE_TLS has been removed/,
    );
  });

  test('resolveTlsSettings reports material without judging the environment', () => {
    // It answers "what certificates are there", not "is this allowed" — so
    // the same inputs give the same answer whatever NODE_ENV says.
    const existsSync = () => false;

    for (const nodeEnv of ['production', 'development', undefined]) {
      expect(
        resolveTlsSettings({ NODE_ENV: nodeEnv }, '/app', existsSync),
      ).toMatchObject({ useTls: false, reason: 'missing_certs' });

      expect(
        resolveTlsSettings(
          { NODE_ENV: nodeEnv, DISABLE_TLS: '1' },
          '/app',
          existsSync,
        ),
      ).toMatchObject({ useTls: false, reason: 'disabled' });
    }
  });

  test('finds TLS files beside the project when running from dist', () => {
    const existingFiles = new Set([
      '/srv/mud-proxy/cert.pem',
      '/srv/mud-proxy/privkey.pem',
    ]);
    const existsSync = (filePath: string) => existingFiles.has(filePath);

    expect(
      resolveTlsSettings({}, '/srv/mud-proxy/dist', existsSync),
    ).toMatchObject({
      useTls: true,
      certPath: '/srv/mud-proxy/cert.pem',
      keyPath: '/srv/mud-proxy/privkey.pem',
      reason: 'configured',
    });
  });
});
