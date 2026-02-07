/**
 * E2E Tests: IRE MUD
 * Tests: Heavy GMCP traffic, Achaea/Imperian/Lusternia/Aetolia
 * These MUDs use Iron Realms Engine with extensive GMCP
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const MUD_NAME = 'ire';
const TEST_PROXY_PORT = 6299;

describe('IRE MUD (heavy GMCP)', () => {
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

  it('should negotiate GMCP', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check if GMCP was negotiated
    const negotiated = connection.isProtocolNegotiated('gmcp');
    expect(negotiated).toBe(true);
  });

  it('should receive GMCP packages', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for GMCP data
    const gmcpMsg = await connection.waitForMessage('gmcp', 10000);

    expect(gmcpMsg).not.toBeNull();

    // Check for Char package (IRE sends Char.Vitals)
    if (gmcpMsg) {
      const data = gmcpMsg.data as { package?: string; data?: unknown };
      const hasCharPackage =
        data.package?.startsWith('Char.') ||
        JSON.stringify(data).includes('Char.');
      expect(hasCharPackage).toBe(true);
    }
  });

  it('should handle high GMCP volume', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait and collect GMCP messages
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const messages = connection.getMessages();
    const gmcpMessages = messages.filter((m) => m.type === 'gmcp');

    // IRE MUDs send lots of GMCP
    expect(gmcpMessages.length).toBeGreaterThan(3);
  });

  it('should handle GMCP without errors', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    const messages = connection.getMessages();
    const errorMessages = messages.filter(
      (m) => m.type === 'error' || (m.data as { error?: string }).error,
    );

    // No protocol errors
    expect(errorMessages.length).toBe(0);
  });

  it('should display login prompt', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for login prompt
    const promptFound = await connection.waitForText('name', 15000);
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
