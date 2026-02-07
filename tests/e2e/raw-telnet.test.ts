/**
 * E2E Tests: Raw Telnet Server
 * Tests: Basic connectivity on port 23
 * This tests the most minimal telnet connection possible
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const MUD_NAME = 'raw_telnet';
const TEST_PROXY_PORT = 6299;

describe('Raw Telnet Server (port 23)', () => {
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

    // Verify port is 23
    expect(config.port).toBe(23);

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

  it('should receive data without errors', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const messages = connection.getMessages();
    const errorMessages = messages.filter(
      (m) => m.type === 'error' || (m.data as { error?: string }).error,
    );

    // No errors
    expect(errorMessages.length).toBe(0);

    // Some data received
    const dataMessages = messages.filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should not require compression', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for protocol negotiation
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Should not have negotiated MCCP
    const hasMCCP = connection.isProtocolNegotiated('mccp');
    expect(hasMCCP).toBe(false);
  });

  it('should handle minimal telnet', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Send a simple command
    connection.sendCommand('help');

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');

    // Should have received data after sending command
    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should disconnect cleanly', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Close connection
    connection.close();

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Connection should be closed
    // No explicit check needed - just verify no errors
    const messages = connection.getMessages();
    const errorMessages = messages.filter(
      (m) => m.type === 'error' || (m.data as { error?: string }).error,
    );

    expect(errorMessages.length).toBe(0);
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
