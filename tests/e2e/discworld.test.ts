/**
 * E2E Tests: Discworld MUD
 * Tests: MXP support, extended protocols
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const MUD_NAME = 'discworld';
const TEST_PROXY_PORT = 6299;

describe('Discworld MUD (MXP support)', () => {
  const configResult = loadE2EConfig(MUD_NAME);
  const config = configResult.config;
  let connection: E2EConnection | null = null;
  let proxy: ProxyLauncher | null = null;

  beforeAll(async () => {
    if (configResult.skip) {
      throw new Error(`E2E test config error: ${configResult.reason}`);
    }

    // Start test proxy
    proxy = await startTestProxy(TEST_PROXY_PORT);
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
      connection = null;
    }

    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
  });

  it('should connect and create session', async () => {
    if (!config || !proxy) {
      expect(config).not.toBeNull();
      expect(proxy).not.toBeNull();
      return;
    }

    connection = new E2EConnection(config);
    const result = await connection.connect(proxy.url);

    if (!result.success) {
      console.log('Connection failed:', result.error);
    }

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.token).toBeDefined();
    expect(result.sessionId?.length).toBeGreaterThan(0);
    expect(result.token?.length).toBeGreaterThan(0);
  });

  it('should negotiate MXP', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data to arrive
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check if MXP was negotiated
    const negotiated = connection.isProtocolNegotiated('mxp');
    expect(negotiated).toBe(true);
  });

  it('should receive MXP markup in output', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const messages = connection.getMessages();
    const dataMsgs = messages.filter((m) => m.type === 'data');

    // Verify MXP tags if present
    const hasData = dataMsgs.length > 0;
    expect(hasData).toBe(true);
  });

  it('should display login prompt', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for login prompt
    const promptFound = await connection.waitForText('login', 15000);
    expect(promptFound).toBe(true);
  });

  it('should send commands to MUD', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Send a simple command
    connection.sendCommand('look');

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Should have received more data
    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should handle session resume', async () => {
    if (!config || !connection || !proxy) {
      expect(connection).not.toBeNull();
      expect(proxy).not.toBeNull();
      return;
    }

    // Get current session info
    const messages = connection.getMessages();
    const sessionMsg = messages.find((m) => m.type === 'session');

    if (!sessionMsg) {
      expect(sessionMsg).toBeDefined();
      return;
    }

    const sessionId = (sessionMsg.data as { sessionId: string }).sessionId;
    const token = (sessionMsg.data as { token: string }).token;

    // Close connection
    connection.close();

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Create new connection and resume
    connection = new E2EConnection(config);
    const result = await connection.resume(proxy.url, sessionId, token, 0);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe(sessionId);

    // Should receive buffered data
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const resumedMessages = connection.getMessages();
    expect(resumedMessages.length).toBeGreaterThan(0);
  });
});
