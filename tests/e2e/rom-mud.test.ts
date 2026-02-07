/**
 * E2E Tests: ROM-based MUD
 * Tests: Basic telnet, minimal protocols
 * ROM MUDs are typically simpler with basic telnet support
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const MUD_NAME = 'rom';
const TEST_PROXY_PORT = 6299;

describe('ROM MUD (basic telnet)', () => {
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

  it('should connect via basic telnet', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Should receive data
    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should receive login prompt', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for login prompt - look for common ROM prompts
    const promptFound = await connection.waitForText('login:', 15000);
    expect(promptFound).toBe(true);
  });

  it('should handle basic commands', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Send 'look' command
    connection.sendCommand('look');

    // Wait for response
    const responseFound = await connection.waitForText('here', 10000);
    expect(responseFound).toBe(true);
  });

  it('should not require advanced protocols', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Should work without GMCP/MCCP/MXP
    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');

    // Should have received data
    expect(dataMessages.length).toBeGreaterThan(0);

    // Should not have negotiated GMCP
    expect(connection.isProtocolNegotiated('gmcp')).toBe(false);

    // Should not have negotiated MCCP
    expect(connection.isProtocolNegotiated('mccp')).toBe(false);
  });

  it('should handle disconnect gracefully', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Close connection
    connection.close();

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Session should still exist server-side (tested via resume)
    const messages = connection.getMessages();
    const sessionMsg = messages.find((m) => m.type === 'session');

    if (sessionMsg) {
      const sessionId = (sessionMsg.data as { sessionId: string }).sessionId;
      const token = (sessionMsg.data as { token: string }).token;

      // Create new connection
      connection = new E2EConnection(config!);
      const result = await connection.resume(proxy!.url, sessionId, token, 0);

      expect(result.success).toBe(true);
    }
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
