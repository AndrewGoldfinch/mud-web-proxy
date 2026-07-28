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
  const socket = new EventEmitter() as MockSocket;

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
  socket.req = {
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    url: '/',
    method: 'GET',
  } as MockSocket['req'];

  return socket;
}

function parseLastMessage(socket: MockSocket): Record<string, unknown> {
  const raw = socket.messages.at(-1);
  if (!raw) throw new Error('socket has no messages');
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeSessionIntegration(): SessionIntegration {
  const integration = new SessionIntegration({
    sessions: { timeoutHours: 24, maxPerDevice: 5, maxPerIP: 10 },
    targets: {
      onlyAllowDefaultServer: true,
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

    expect(handled).toBe(true);
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
      onlyAllowDefaultServer: false,
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

  test('runtime environment defaults are safe for private self-hosting', () => {
    expect(getRuntimeConfig({})).toMatchObject({
      wsPort: 6200,
      tnHost: 'muds.maldorne.org',
      tnPort: 5010,
      onlyAllowDefaultServer: true,
      requireAppAuth: false,
      diagnosticsEnabled: false,
      adminToken: '',
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

  test('production cannot silently run without TLS', () => {
    const existsSync = () => false;

    expect(() =>
      resolveTlsSettings({ NODE_ENV: 'production' }, '/app', existsSync),
    ).toThrow('TLS certificate and key are required in production');

    expect(() =>
      resolveTlsSettings(
        { NODE_ENV: 'production', DISABLE_TLS: '1' },
        '/app',
        existsSync,
      ),
    ).toThrow('DISABLE_TLS=1 is not allowed in production');
  });

  test('production finds TLS files beside the project when running from dist', () => {
    const existingFiles = new Set([
      '/srv/mud-proxy/cert.pem',
      '/srv/mud-proxy/privkey.pem',
    ]);
    const existsSync = (filePath: string) => existingFiles.has(filePath);

    expect(
      resolveTlsSettings(
        { NODE_ENV: 'production' },
        '/srv/mud-proxy/dist',
        existsSync,
      ),
    ).toMatchObject({
      useTls: true,
      certPath: '/srv/mud-proxy/cert.pem',
      keyPath: '/srv/mud-proxy/privkey.pem',
      reason: 'configured',
    });
  });

  test('explicit override is required for insecure production no-TLS mode', () => {
    const existsSync = () => false;

    expect(
      resolveTlsSettings(
        {
          NODE_ENV: 'production',
          DISABLE_TLS: '1',
          ALLOW_INSECURE_PRODUCTION_NO_TLS: 'true',
        },
        '/app',
        existsSync,
      ),
    ).toMatchObject({ useTls: false, reason: 'disabled' });
  });
});
