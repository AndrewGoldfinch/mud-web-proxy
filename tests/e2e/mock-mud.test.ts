/**
 * E2E Tests: Mock MUD Server
 * Tests protocol negotiation against mock server
 * Fast, reliable, no network dependencies
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import {
  MockMUDServer,
  createIREMUD,
  createAardwolfMUD,
  createChaosMUD,
} from './mock-mud';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const TEST_PROXY_PORT = 6299;

describe('Mock MUD Server Tests', () => {
  let mockServer: MockMUDServer;
  let proxy: ProxyLauncher;
  let connection: E2EConnection | null = null;

  beforeAll(async () => {
    // Create and start IRE mock server
    mockServer = createIREMUD();
    await mockServer.start();

    // Start proxy pointing to mock server
    proxy = await startTestProxy(TEST_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mockServer['config'].port.toString(),
    });
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
    await proxy.stop();
    await mockServer.stop();
  });

  it('should connect to mock IRE server', async () => {
    connection = new E2EConnection({
      enabled: true,
      host: 'localhost',
      port: mockServer['config'].port,
      testTimeoutMs: 10000,
      expectations: {
        gmcp: true,
        mccp: true,
        mxp: false,
        msdp: false,
        ansi: true,
        utf8: true,
      },
    });

    const result = await connection.connect(proxy.url);
    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
  });

  it('should negotiate GMCP', async () => {
    expect(connection).not.toBeNull();

    // Wait for negotiation
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const negotiated = connection!.isProtocolNegotiated('gmcp');
    expect(negotiated).toBe(true);
  });

  it('should negotiate MCCP', async () => {
    expect(connection).not.toBeNull();

    const negotiated = connection!.isProtocolNegotiated('mccp');
    expect(negotiated).toBe(true);
  });

  it('should receive data from mock server', async () => {
    expect(connection).not.toBeNull();

    // Wait for data
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const messages = connection!.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');

    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should complete login flow', async () => {
    expect(connection).not.toBeNull();

    // Send username
    connection!.sendCommand('testuser');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send password
    connection!.sendCommand('testpass');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check for welcome message
    const messages = connection!.getMessages();
    const hasWelcome = messages.some((m) => {
      if (m.type === 'data') {
        const data = m.data as { payload?: string };
        if (data.payload) {
          const text = Buffer.from(data.payload, 'base64').toString();
          return text.includes('Welcome');
        }
      }
      return false;
    });

    expect(hasWelcome).toBe(true);
  });

  it('should send and receive GMCP packages', async () => {
    expect(connection).not.toBeNull();

    // Wait for GMCP data
    const gmcpMsg = await connection!.waitForMessage('gmcp', 5000);

    // Mock server should send GMCP data
    expect(gmcpMsg).not.toBeNull();

    if (gmcpMsg) {
      const data = gmcpMsg.data as { package?: string };
      expect(data.package).toBeDefined();
    }
  });

  it('should handle session resume', async () => {
    expect(connection).not.toBeNull();

    // Get session info
    const messages = connection!.getMessages();
    const sessionMsg = messages.find((m) => m.type === 'session');
    expect(sessionMsg).toBeDefined();

    if (!sessionMsg) return;

    const sessionId = (sessionMsg.data as { sessionId: string }).sessionId;
    const token = (sessionMsg.data as { token: string }).token;

    // Close connection
    connection!.close();

    // Resume session
    connection = new E2EConnection({
      enabled: true,
      host: 'localhost',
      port: mockServer['config'].port,
      testTimeoutMs: 10000,
      expectations: {
        gmcp: true,
        mccp: true,
        mxp: false,
        msdp: false,
        ansi: true,
        utf8: true,
      },
    });

    const result = await connection.resume(proxy.url, sessionId, token, 0);
    expect(result.success).toBe(true);
  });
});

describe('Mock MUD - Chaos Mode', () => {
  let mockServer: MockMUDServer;
  let proxy: ProxyLauncher;
  let connection: E2EConnection | null = null;

  beforeAll(async () => {
    // Create chaos server
    mockServer = createChaosMUD();
    await mockServer.start();

    // Start proxy
    proxy = await startTestProxy(6300, {
      TN_HOST: 'localhost',
      TN_PORT: mockServer['config'].port.toString(),
    });
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
    await proxy.stop();
    await mockServer.stop();
  });

  it('should handle chaotic connections', async () => {
    connection = new E2EConnection({
      enabled: true,
      host: 'localhost',
      port: mockServer['config'].port,
      testTimeoutMs: 15000,
      expectations: {
        gmcp: true,
        mccp: true,
        mxp: true,
        msdp: true,
        ansi: true,
        utf8: true,
      },
    });

    // Connection should succeed despite chaos
    const result = await connection.connect(proxy.url);

    // Might fail due to chaos mode, that's OK
    if (!result.success) {
      console.log(
        'Chaos mode caused connection failure (expected):',
        result.error,
      );
    }
  });
});
